require('console-trace');
// console.traceAlways = true;

var socketio = require('socket.io')
  , mdns = require('mdns')
  , app = require('http').createServer()
  , io = socketio.listen(app)
  , managers = require('./lib/discovery').managers
  , context  = require('zmq')
  , OnlineHelper = require('./lib/onlineHelper')
  , processingQueue = []
  , connectedTo = null
  , client
  , Workunit = require('./lib/workunit')
  , workunit
  , zmqSocket
  , zmqOnline = false
  , socketioOnline = false
  , offlineMessageQueue = [] // will cause memory to exhaust
  , packageJSON = require('./package.json')
  , appVersion = 'v' + packageJSON.version.split('.').slice(0, -1).join('-')
  , savedStates = {}
  , agent = require('webkit-devtools-agent')
  ;

io.set("log level", 0);

/**
 *  Connect to parent Manager, with port.
 */

function startSocketIO() {
  io.sockets.on('connection', function (socketio) {
    socketioOnline = true;
    socketio.on('message', function(message) {
      var socket = {};
      if (!zmqOnline) {
        socket.send = function(msg) {
          offlineMessageQueue.push(msg);
        };
      } else {
        socket = zmqSocket;
      }
      switch (message.action) {
        case 'request':
          socketio.json.send({
              "action": "workunit"
            , "workunitId": workunit.getId()
            , "data": workunit.get()
          });
          break;
        case 'getPayload':
          workunit.retrievePayload(function(payload) {
            if (savedStates[payload.id] !== undefined) {
              payload = savedStates[payload.id].state;
            }
            delete savedStates[payload.id];
            socketio.json.send({'action': 'payload', 'data': payload});
          });
          break;
        case 'completed':
          socket.send(JSON.stringify(message));
          delete savedStates[message.id];
          workunit.retrievePayload(function(payload) {
            if (savedStates[payload.id] !== undefined) {
              payload.payload = savedStates[payload.id].state;
            }
            delete savedStates[payload.id];
            socketio.json.send({'action': 'payload', 'data': payload});
          });
          break;
        case 'saveState':
          if (workunit.getId() == message.workunitId) {
            delete message.action;
            savedStates[message.id] = message;
          }
          break;
        default:
          socketio.json.send({"action": "message", "data": "Unknown action: " + message.action });
          break;
      }
    });
    socketio.on('disconnect', function () { });
  });
}

managers.on('serviceUp', function(service) {
  //if (isNaN(service.txtRecord.taskId) /* && within date && not associated with something */) {
    processingQueue.push(service);
});

function startProcess() {
  var interval = setTimeout(function() {
    if (processingQueue.length !== 0) {
      subscribeToManager();
    } else {
      managers.listAll(function(err, store) {
        Object.keys(store).forEach(function(value) {
          processingQueue.push(store[value]);
        });
      });
      subscribeToManager();
    }
  }, 3000);
}

function subscribeToManager() {
  var service = processingQueue.shift()
    , uptime = 0
    ;
  if (service !== undefined) {
    var host = service.addresses[0]
    ;

    client = OnlineHelper.createOnlineHelper(service.txtRecord.availabilityPort, host);

    client.on('notAccepting', startProcess);

    // TODO: check to see if already started
    // if it has, wait until it comes up again, by queing and sending old workunits - if timeout is reached then fetch new manager
    // else if it hasn't start looking for new unit);
    client.on('offline', function() {
      offlineMessageQueue = [];
      if (zmqOnline) {
        zmqSocket.close();
      }
      zmqOnline = false;
      startProcess();
      console.log('client down.');
    });

    client.on('init', function() {
      zmqConnect(service);
    });

  } else {
    startProcess();
  }
}

function zmqConnect(service) {
  var uri = 'tcp://' + service.addresses[0] + ':' + service.txtRecord.zmqPort
    ;
  zmqSocket = context.socket('req');
  zmqSocket.identity = 'distributor' + process.pid;
  zmqSocket.connect(uri);
  console.log('connected to -> ' + uri);
  zmqOnline = true;
  connectedTo = uri;
  //TODO: check for existing results if found send.
  process.nextTick(function(){
    while (offlineMessageQueue.length > 0) {
      zmqSocket.send(offlineMessageQueue.shift());
    }
  });
  zmqSocket.send('{"action":"requestWorkunit"}');
  zmqSocket.on('message', function(buf) {
    var obj = JSON.parse(buf.toString());
    switch(obj.action) {
      case 'workunit':
        console.time('RequestWorkunit');
        workunit = Workunit.createWorkunit(obj.id, obj.workunit, obj.payloads);
        console.timeEnd('RequestWorkunit');
        if (!socketioOnline) startSocketIO();
        break;
      case 'saved':
        workunit.completePayload(obj.data.id);
        // log that it was saved and clear queue items that saved.
        break;
      case 'notSaved':
        console.error(new Error('Could not save.'));
        // add to a queue to be sent with next iteration
        break;
      default:
        console.error(obj);
        break;
    }
  });
}
app.listen(function() {
  // need to publish somehow so others can connect.
  startDiscovery(app.address().port);
  startProcess();
});

/**
 *  Starts the Bonjour / zeroconf service for advertising up services
 *  and logs them
 */
function startDiscovery(port) {
  console.log('Running disio-distributor' + '@' + appVersion + ' on ' + '0.0.0.0:' + port);
  var ad = mdns.createAdvertisement(mdns.udp('disio-distribu', appVersion), port, {'txtRecord': { name: 'dis.io distributor' }});
  ad.start();
}

console.log('This process is pid ' + process.pid);
'use strict';
var pm2 = require('pm2');
var pmx = require('pmx');
var request = require('request');
var stripAnsi = require('strip-ansi');

// Get the configuration from PM2
var conf = pmx.initModule();

// initialize buffer and queue_max opts
// queue max can be between 10 and 100
conf.queue_max = (conf.queue_max > 10 && conf.queue_max <= 100) ? conf.queue_max : 100;

// create the message queue
var messages = [];

// create the suppressed object for sending suppression messages
var suppressed = {
  isSuppressed: false,
  date: new Date().getTime()
};


// Function to send event to Discord's Incoming Webhook
function sendToDiscord(message) {

  var description = message.description;

  // If a Discord URL is not set, we do not want to continue and nofify the user that it needs to be set
  if (!conf.discord_url) {
    return console.error("There is no Discord URL set, please set the Discord URL: 'pm2 set pm2-discord:discord_url https://[discord_url]'");
  }

  // The JSON payload to send to the Webhook
  var payload = {
    "content" : description
  };

  // Options for the post request
  var options = {
    method: 'post',
    body: payload,
    json: true,
    url: conf.discord_url
  };

  // Finally, make the post request to the Discord Incoming Webhook
  request(options, function(err, res, body) {
    if (err) {
      return console.error(err);
    }
    /* A successful POST to Discord's webhook responds with a 204 NO CONTENT */
    if (res.statusCode !== 204) {
      console.error("Error occured during the request to the Discord webhook");
      console.error(body)
    }
  });
}

// Function to get the next buffer of messages (buffer length = 1s)
function bufferMessage() {
  var nextMessage = messages.shift();

  if (!conf.buffer) { return nextMessage; }

  nextMessage.buffer = [nextMessage.description];

  
  // delete the buffer from memory
  delete nextMessage.buffer;

  return nextMessage;
}

// Function to process the message queue
function processQueue() {

  // If we have a message in the message queue, removed it from the queue and send it to discord
  if (messages.length > 0) {
    sendToDiscord(bufferMessage());
  }

  // If there are over conf.queue_max messages in the queue, send the suppression message if it has not been sent and delete all the messages in the queue after this amount (default: 100)
  if (messages.length > conf.queue_max) {
    if (!suppressed.isSuppressed) {
      suppressed.isSuppressed = true;
      suppressed.date = new Date().getTime();
      sendToDiscord({
          name: 'pm2-discord',
          event: 'suppressed',
          description: 'Messages are being suppressed due to rate limiting.'
      });
    }
    messages.splice(conf.queue_max, messages.length);
  }

  // If the suppression message has been sent over 1 minute ago, we need to reset it back to false
  if (suppressed.isSuppressed && suppressed.date < (new Date().getTime() - 60000)) {
    suppressed.isSuppressed = false;
  }

  // Wait 0.5 seconds and then process the next message in the queue
  setTimeout(function() {
    processQueue();
  }, 500);
}

function createMessage(data, eventName, block, altDescription) {
  // we don't want to output pm2-discord's logs
  if (data.process.name === 'pm2-discord') {
    return;
  }
  // if a specific process name was specified then we check to make sure only 
  // that process gets output
  if (conf.process_name !== null && data.process.name !== conf.process_name) {
    return;
  }

  var msg = altDescription || data.data;
  if (typeof msg === "object" || msg == undefined) return
  
  function split(output,len){
    const msgArray = [];
      if (!output) {
        return [];
      }
      if (Array.isArray(msg)) {
        output = output.join("\n");
      }
      if (output.length > len) {
        let str = "";
        let pos;
        while (output.length > 0) {
          pos = output.length > len ? output.lastIndexOf("\n", len) : output.length;
          if (pos > len) {
            pos = len;
          }
          str = output.substr(0, pos);
          output = output.substr(pos);
          msgArray.push(str);
        }
      }
    else {
      msgArray.push(output);
    }
    return msgArray;
  }
  
  const splitter = split(msg,1900)
  for(let splitLog of splitter){
    if (block) splitLog = `\`\`\`ps\n${splitLog}\n\`\`\``
    messages.push({
      name: data.process.name,
      event: eventName,
      description: stripAnsi(splitLog),
      timestamp: Math.floor(Date.now() / 1000),
    });
  }
}

// Start listening on the PM2 BUS
pm2.launchBus(function(err, bus) {

    // Listen for process logs
    if (conf.log) {
      bus.on('log:out', function(data) {
        createMessage(data, 'log', true);
      });
    }

    // Listen for process errors
    if (conf.error) {
      bus.on('log:err', function(data) {
        createMessage(data, 'error', true);
      });
    }

    // Listen for PM2 kill
    if (conf.kill) {
      bus.on('pm2:kill', function(data) {
        messages.push({
          name: 'PM2',
          event: 'kill',
          description: data.msg,
          timestamp: Math.floor(Date.now() / 1000),
        });
      });
    }

    // Listen for process exceptions
    if (conf.exception) {
      bus.on('process:exception', function(data) {
        createMessage(data, 'exception');
      });
    }

    // Listen for PM2 events
    bus.on('process:event', function(data) {
      if (!conf[data.event]) { return; }
      var msg = 'The following event has occured on the PM2 process ' + data.process.name + ': ' + data.event;
      createMessage(data, data.event, false, msg);
    });

    // Start the message processing
    processQueue();

});

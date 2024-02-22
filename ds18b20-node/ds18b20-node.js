/**
 * Copyright 2015, 2016 Brendan Murray
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

// See https://www.maximintegrated.com/en/app-notes/index.mvp/id/187 for
// a description of the 1-wire protocol.

// Dependency - file system access
var fs = require('fs');
var _ = require('underscore');


module.exports = function (RED) {
   "use strict";

   // The main node definition - most things happen in here
   function ds18b20Sensor(config) {

      // Create a RED node
      RED.nodes.createNode(this, config);

      // Store local copies of the node configuration (as defined in the .html)
      var node = this;

      // The root path of the sensors
      var W1PATH = "/sys/bus/w1/devices";

      // The directories location
      var W1DIRS = "/sys/devices/";

      // The devices list file
      var W1DEVICES = "/sys/devices/w1_bus_master1/w1_master_slaves";

      // Save the default device ID
      this.topic = config.topic;

      // If we are to return an array
      this.returnArray = false;

      // Load information from the devices list
      this.loadDeviceData = async function () {
         var deviceList = [];
         var fsOptions = { "encoding": "utf8", "flag": "r" };
         var dirs = fs.readdirSync(W1DIRS, "utf8");
         for (var iY = 0; iY < dirs.length; iY++) {
            if ((dirs[iY].startsWith && dirs[iY].startsWith("w1_bus_master")) ||
               (dirs[iY].indexOf("w1_bus_master") !== -1)) {
               const bulkReadPath = W1DIRS + '/' + dirs[iY] + '/therm_bulk_read';
               const supportsBatchRead = await fs.existsSync(bulkReadPath);
               if (supportsBatchRead) {
                  await new Promise((resolve, reject) => fs.writeFile(bulkReadPath, 'trigger\n', { encoding: 'utf8' }, err => { if (err) { reject(err) } else { resolve() } }));
                  let ready = false;
                  while (!ready) {
                     const batchReady = await new Promise((resolve, reject) => fs.readFile(bulkReadPath, fsOptions, (err, data) => { if (err) { reject(err) } else { resolve(data) } }));
                     if (batchReady.startsWith('1')) {
                        ready = true;
                     } else {
                        await new Promise(resolve => setTimeout(resolve, 100));
                     }
                  }
               }

               var devList = fs.readFileSync(W1DIRS + dirs[iY] +
                  "/w1_master_slaves", fsOptions).split("\n");
               const devicePackets = await Promise.all(devList.map(async deviceId => {
                  if (deviceId !== undefined && deviceId !== ""
                     && deviceId !== "not found.") {
                     var fName = W1PATH + "/" + deviceId + "/w1_slave";
                     if (fs.existsSync(fName)) {
                        var fData = await new Promise((resolve, reject) => fs.readFile(fName, fsOptions, (err, data) => { if (err) { reject(err) } else { resolve(data) } })).then(data => data.trim());
                        // Extract the numeric part
                        var tBeg = fData.indexOf("t=") + 2;
                        if (tBeg >= 0) {
                           var tEnd = tBeg + 1;
                           while (tEnd < fData.length &&
                              fData[tEnd] >= '0' && fData[tEnd] <= '9') {
                              tEnd++;
                           }
                           var temp = fData.substring(tBeg, tEnd);
                           var tmpDev = deviceId.substr(13, 2) + deviceId.substr(11, 2) +
                              deviceId.substr(9, 2) + deviceId.substr(7, 2) +
                              deviceId.substr(5, 2) + deviceId.substr(3, 2);

                           return {
                              "family": deviceId.substr(0, 2),
                              "id": tmpDev.toUpperCase(),
                              "dir": dirs[iY],
                              "file": deviceId,
                              "temp": temp / 1000.0
                           };
                        }
                     }
                  }
               }));
               deviceList.push(...devicePackets.filter(packet => packet));
            }
         }
         return deviceList;
      }

      // Return the deviceList entry, given a device ID
      this.findDevice = function (deviceList, devId) {
         devId = devId.toUpperCase();
         for (var iX = 0; iX < deviceList.length; iX++) {
            if (devId === deviceList[iX].file.substr(3).toUpperCase() ||
               devId === deviceList[iX].id) {
               return deviceList[iX];
            }
         }
         // If it's not in the normalised form
         var tmpDev = devId.substr(13, 2) + devId.substr(11, 2) +
            devId.substr(9, 2) + devId.substr(7, 2) +
            devId.substr(5, 2) + devId.substr(3, 2);
         for (var iX = 0; iX < deviceList.length; iX++) {
            if (devId === deviceList[iX].file.substr(3).toUpperCase() ||
               devId === deviceList[iX].id) {
               return deviceList[iX];
            }
         }

         return null;
      }


      // Read the data & return a message object
      this.read = async function (inMsg) {
         // Retrieve the full set of data
         var deviceList = await this.loadDeviceData();

         var msgList = [];
         var msg;

         if (this.topic != undefined && this.topic != "") {
            // Split a list into devices (or 1 if only 1)
            var sList = this.topic.split(" ");
            var retArr = [];
            for (var iX = 0; iX < sList.length; iX++) {
               // Set up the returned message
               var dev = this.findDevice(deviceList, sList[iX]);
               if (this.returnArray || sList.length > 1) {
                  retArr.push(dev);
               } else {
                  msg = _.clone(inMsg);
                  if (dev === null) {  // Device not found!
                     msg.family = 0;
                     msg.payload = "";
                  } else {
                     msg.file = dev.file;
                     msg.dir = dev.dir;
                     msg.topic = dev.id;
                     msg.family = dev.family;
                     msg.payload = dev.temp;
                  }
                  msgList.push(msg);
               }
            }
            if (this.returnArray || sList.length > 1) {
               msg = _.clone(inMsg);
               msg.topic = "";
               msg.payload = retArr;
               msgList.push(msg);
            }
         } else { // No list of devices in the topic
            if (this.returnArray) { // Return as an array?
               msg = _.clone(inMsg);
               msg.topic = "";
               msg.payload = deviceList;
               msgList.push(msg);
            } else { // Not an array - a series of messages
               for (var iX = 0; iX < deviceList.length; iX++) {
                  msg = _.clone(inMsg);
                  msg.file = deviceList[iX].file;
                  msg.dir = deviceList[iX].dir;
                  msg.topic = deviceList[iX].id;
                  msg.family = deviceList[iX].family;
                  msg.payload = deviceList[iX].temp;
                  msgList.push(msg);
               }
            }
         }
         return msgList;
      };

      // respond to inputs....
      this.on('input', async function (msg) {
         this.topic = config.topic;
         if (msg.topic !== undefined && msg.topic !== "") {
            this.topic = msg.topic;
         }
         this.returnArray = msg.array | config.array;

         var arr = await this.read(msg);

         if (arr) {
            node.send([arr]);
         }
      });

   }

   // Register the node by name.
   RED.nodes.registerType("rpi-ds18b20", ds18b20Sensor);
}


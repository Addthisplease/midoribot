const { workerData, parentPort } = require('worker_threads');
const { backupChannel } = require('./backupFunctions'); // Assume backupChannel function is exported from backupFunctions.js

const { channel, backupId } = workerData;

backupChannel(channel, backupId)
  .then(result => parentPort.postMessage(result))
  .catch(err => parentPort.postMessage({ error: err.message }));
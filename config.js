// config.js
const path = require('path');
const os = require('os');

const isPkg = typeof process.pkg !== 'undefined';
const baseDir = isPkg ? path.dirname(process.execPath) : __dirname;

// Prefer a "Downloads" subfolder next to the EXE (or next to script in dev)
const DEFAULT_DOWNLOAD_PATH = path.join(baseDir, 'Downloads');

const config = {
  DEFAULT_REMOTE_DEBUGGING_JSON: "http://127.0.0.1:9222/json/version",
  DEFAULT_DOWNLOAD_PATH: DEFAULT_DOWNLOAD_PATH + path.sep
};

module.exports = { config };

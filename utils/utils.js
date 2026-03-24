// utils.js
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// --- PKG & PATH SETUP ---
const isPkg = typeof process.pkg !== 'undefined';
const workingDir = isPkg ? path.dirname(process.execPath) : __dirname;
const logFile = path.join(workingDir, 'error.log');

// --- LOGGING ---
function log(...args) {
  try {
    const msg = `[${new Date().toISOString()}] ` + args.map(a => (typeof a === 'string' ? a : (a && a.stack) ? a.stack : JSON.stringify(a))).join(' ') + '\n';
    fs.appendFileSync(logFile, msg);
  } catch (e) { /* ignore */ }
  console.log(...args);
}

// --- INPUT & SLEEP ---
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function question(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

function waitForExit() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('\nPress Enter to Close Browser & Exit...', () => {
      rl.close();
      resolve();
    });
  });
}

// --- FILE NAMING ---
function moveToUniqueName(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const targetPath = path.join(dir, filename);
  if (!fs.existsSync(targetPath)) return filename;
  
  let counter = 1;
  while (true) {
    const newName = `${base} (${counter})${ext}`;
    const newPath = path.join(dir, newName);
    if (!fs.existsSync(newPath)) {
      fs.renameSync(targetPath, newPath);
      return newName;
    }
    counter++;
  }
}

module.exports = { log, sleep, question, waitForExit, moveToUniqueName, workingDir };
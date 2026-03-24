// download-manager.js
const fs = require('fs');
const path = require('path');
const { sleep } = require('./utils');

async function waitForCompletedDownload(dir, beforeFiles, timeoutMs) {
  const start = Date.now();
  const TEMP_SUFFIXES = ['.crdownload', '.crddonload'];

  function listAdded() {
    const all = fs.readdirSync(dir);
    return all.filter(f => !beforeFiles.includes(f));
  }

  while (true) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for new download');
    const added = listAdded();
    
    if (added.length === 0) {
      await sleep(500);
      continue;
    }

    // Sort by newest
    const candidates = added.map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }));
    candidates.sort((a, b) => b.m - a.m);
    let file = candidates[0].f;
    const fullPath = path.join(dir, file);

    // Check for temp extension
    const hasTemp = TEMP_SUFFIXES.some(suf => file.endsWith(suf));
    if (hasTemp) {
        await sleep(1000); 
        continue;
    }

    // Check for file size stability
    const size1 = fs.statSync(fullPath).size;
    await sleep(1000);
    const size2 = fs.statSync(fullPath).size;
    
    if (size1 === size2 && size1 > 0) {
        return file; 
    }
  }
}

module.exports = { waitForCompletedDownload };
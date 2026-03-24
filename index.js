// index.js
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { startChromeIfNotRunning } = require('./utils/startChromeBrowser');
const { log, sleep, question, waitForExit, moveToUniqueName } = require('./utils/utils');
const { waitForCompletedDownload } = require('./utils/download_manager');

// Global Error Handlers
process.on('uncaughtException', (err) => { log('Uncaught:', err); setTimeout(() => process.exit(1), 200); });
process.on('unhandledRejection', (r) => { log('Unhandled:', r); setTimeout(() => process.exit(1), 200); });

(async () => {
  try {
    await startChromeIfNotRunning();
    await sleep(2000);

    // --- SETUP & CONFIG ---
    const REMOTE_DEBUGGING_JSON = config.DEFAULT_REMOTE_DEBUGGING_JSON;
    const DEFAULT_TIMEOUT = 300000; // 5 mins
    const DEFAULT_URL = 'https://acc.autodesk.com/build/files/projects/c4d9bcf4-c2db-46a8-8244-406b56b6d8b6?folderUrn=urn%3Aadsk.wipprod%3Afs.folder%3Aco.cGRZ8FGqRnGs26mdK5dSlw&viewModel=detail&moduleId=folders';
    
    // --- USER INPUTS ---
    const urlInput = await question(`🔗 Enter URL (Enter for default): `);
    const url = urlInput.trim() || DEFAULT_URL;

    const targetInput = await question(`📂 TargetName (Enter for default): `);
    const targetName = targetInput.trim() || 'RSW9-GAYL-ZZ-ALL-M3-ELC';

    let targetVersion = [], isAll = false;
    while (true) {
      const verRaw = (await question(`📃 Target Versions (all or v1,v2): `)).trim();
      if (verRaw.toLowerCase() === "all") { isAll = true; break; }
      if (!verRaw) continue;
      const parts = verRaw.replace(/-/g, ",").split(",").map(v => v.trim().toUpperCase());
      if (parts.every(v => /^V\d+$/.test(v))) { targetVersion = parts; break; }
      console.log("⚠️ Invalid format.");
    }

    // --- BROWSER START ---
    const downloadDir = path.resolve(`${config.DEFAULT_DOWNLOAD_PATH}${targetName}`);
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
    
    console.log('🌐 Connecting to Chrome.');
    const resp = await fetch(REMOTE_DEBUGGING_JSON);
    const ws = (await resp.json()).webSocketDebuggerUrl;
    const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
    const page = await browser.newPage();

    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    
    console.log('Navigating...');
    await page.goto(url, { timeout: 0, waitUntil: 'domcontentloaded' });
    await sleep(10000);

    // --- DOM HELPERS ---
    const rowButtonSelector = '.styles__StyledTable-bpoqbj .MatrixTable__table-frozen-right .MatrixTable__body .MatrixTable__row button';
    const rowVersionSelector = '.ResizePanel__StyledDiv-sc-e33n1n-2 .MatrixTable__table .MatrixTable__body .VersionIndicators__StyledBaseIndicator-sc-1v5r0en-0';
    
    async function revealRows() {
      await page.waitForSelector('.styles__Wrapper-hUZiO .MatrixTable__table-frozen-left .MatrixTable__body .MatrixTable__row',{ visible: true, timeout: 30000 });
      await page.evaluate(`(function(targetName){
        var nameSpans = Array.from(document.querySelectorAll('.DocumentNamestyles__CellHighlight-dJLtHK span'));
        var match = nameSpans.find(s => s.textContent && s.textContent.trim().toLowerCase().includes(targetName.toLowerCase()));
        if (!match) return;
        var topValue = match.closest('.MatrixTable__row').style.top;
        var mainRow = Array.from(document.querySelectorAll('.MatrixTable__table-main .MatrixTable__row')).find(r => r.style.top === topValue);
        if (mainRow) { var btn = mainRow.querySelector('.FileVersionIndicator__StyledClickableVersionIndicator-sc-ko8svq-1'); if(btn) btn.click(); }
      })(${JSON.stringify(targetName)})`);
    }

    // --- PROCESSING ---
    await revealRows();
    await page.waitForSelector(rowButtonSelector, { visible: true, timeout: 15000 });
    
    const versionElements = await page.$$(rowVersionSelector);
    const pageVersions = await Promise.all(versionElements.map(el => page.evaluate(e => e.textContent.trim().toUpperCase(), el)));
    const matchedIndexes = pageVersions.map((v, i) => (targetVersion.includes(v) ? i : -1)).filter(i => i !== -1);
    
    const rowsToProcess = isAll ? (await page.$$(rowButtonSelector)).length : matchedIndexes.length;
    console.log(`✅ Processing ${rowsToProcess} versions...`);

    // --- MAIN LOOP ---
    for (let i = 0; i < rowsToProcess; i++) {
      console.log(`\n--- Processing ${i + 1} / ${rowsToProcess} ---`);
      await revealRows();
      await page.waitForSelector(rowButtonSelector, { timeout: 10000 });
      const buttons = await page.$$(rowButtonSelector);
      const btnIndex = isAll ? i : matchedIndexes[i];

      if (!buttons[btnIndex]) { console.warn(`Skipping index ${btnIndex}`); continue; }
      
      const beforeFiles = fs.readdirSync(downloadDir);
      await buttons[btnIndex].click();

      // Click Download in Menu/Modal
      try {
        await page.waitForSelector('li[data-testid="menu-item-downloadSourceFile"], li[data-testid="menu-item-download"]', { timeout: 30000 });
        await page.evaluate(() => {
            const found = Array.from(document.querySelectorAll('li')).find(n => n.innerText && n.innerText.toLowerCase().includes('download'));
            if (found) found.click();
        });
      } catch (e) { /* ignore */ }

      // Click Final Confirmation (if exists)
      try {
        await page.waitForSelector('.styles__FooterWrapper-gZifIR button', { visible: true, timeout: 5000 });
        await page.click('.styles__FooterWrapper-gZifIR button');
      } catch (e) { /* ignore */ }

      // WAIT FOR DOWNLOAD (1 by 1)
      console.log('Waiting for download... ⏳');
      try {
        const finalName = await waitForCompletedDownload(downloadDir, beforeFiles, DEFAULT_TIMEOUT);
        console.log('✅ Downloaded:', finalName);

        // Rename logic
        const finalPath = path.join(downloadDir, finalName);
        const tempPath = finalPath + '.crdownload';
        if (!fs.existsSync(finalPath) && fs.existsSync(tempPath)) fs.renameSync(tempPath, finalPath);
        
        const uniqueName = moveToUniqueName(downloadDir, path.basename(finalPath));
        console.log(`🗃️ Saved as: ${uniqueName}`);
      } catch (e) { console.error('Download Error:', e.message); }

      // Reset
      try { await page.keyboard.press('Escape'); } catch (e) {}
      console.log('Cooldown: 3s... ⏱️');
      await sleep(3000);
    }

    console.log('\nAll Done! Check folder:', downloadDir);
    await waitForExit();
    await browser.close();
    process.exit(0);

  } catch (err) {
    log('Critical Error:', err);
    await waitForExit();
    process.exit(1);
  }
})();








// // index-zip.js
// // Node 18+ recommended (global fetch).
// const puppeteer = require('puppeteer-core');
// const fs = require('fs');
// const path = require('path');
// const { config } = require('./config');
// const { startChromeIfNotRunning } = require('./startChromeBrowser');

// // --- PKG & PATH SETUP ---
// const isPkg = typeof process.pkg !== 'undefined';
// const workingDir = isPkg ? path.dirname(process.execPath) : __dirname;
// const logFile = path.join(workingDir, 'error.log');

// const readline = require('readline').createInterface({
//   input: process.stdin,
//   output: process.stdout
// });

// // --- LOGGING HELPER ---
// function log(...args) {
//   try {
//     const msg = `[${new Date().toISOString()}] ` + args.map(a => (typeof a === 'string' ? a : (a && a.stack) ? a.stack : JSON.stringify(a))).join(' ') + '\n';
//     fs.appendFileSync(logFile, msg);
//   } catch (e) { /* ignore */ }
//   console.log(...args);
// }

// process.on('uncaughtException', (err) => {
//   log('uncaughtException', err);
//   setTimeout(() => process.exit(1), 200);
// });
// process.on('unhandledRejection', (reason) => {
//   log('unhandledRejection', reason);
//   setTimeout(() => process.exit(1), 200);
// });

// // --- INPUT HELPER ---
// function question(prompt) {
//   return new Promise(resolve => {
//     readline.question(prompt, answer => resolve(answer));
//   });
// }

// // --- WAIT FOR EXIT HELPER ---
// function waitForExit() {
//   const rl = require('readline').createInterface({
//     input: process.stdin,
//     output: process.stdout
//   });
//   return new Promise(resolve => {
//     rl.question('\nPress Enter to close this window...', () => {
//       rl.close();
//       resolve();
//     });
//   });
// }

// // --- MAIN LOGIC ---
// (async () => {
//   try {
//     await startChromeIfNotRunning();
//     await new Promise(r => setTimeout(r, 2000)); 

//     // DEFAULTS
//     const REMOTE_DEBUGGING_JSON = config.DEFAULT_REMOTE_DEBUGGING_JSON;
//     const downloadPath = config.DEFAULT_DOWNLOAD_PATH;
//     const DEFAULT_TIMEOUT = 300000; // 5 Minutes Timeout per file (Safer for large files)
//     const DEFAULT_URL = 'https://acc.autodesk.com/build/files/projects/c4d9bcf4-c2db-46a8-8244-406b56b6d8b6?folderUrn=urn%3Aadsk.wipprod%3Afs.folder%3Aco.cGRZ8FGqRnGs26mdK5dSlw&viewModel=detail&moduleId=folders';
//     const DEFAULT_TARGET = 'RSW9-GAYL-ZZ-ALL-M3-ELC';

//     // USER INPUTS
//     const urlInput = await question(`🔗 Enter the URL (press Enter for default): `);
//     const url = (urlInput && urlInput.trim()) ? urlInput.trim() : DEFAULT_URL;

//     const targetInput = await question(`📂 TargetName (press Enter for default): `);
//     const targetName = (targetInput && targetInput.trim()) ? targetInput.trim() : DEFAULT_TARGET;

//     let targetVersion = [];
//     let isAll = false;

//     while (true) {
//       const targetVersionInput = await question(`📃 Target Versions (all or v1,v2,...): `);
//       const raw = targetVersionInput.trim();
//       if (raw.toLowerCase() === "all") {
//         targetVersion = [];
//         isAll = true;
//         console.log("Final targetVersion: ALL versions");
//         break;
//       }
//       if (!raw) {
//         console.log("⚠️ Value required. Please re-enter.\n");
//         continue;
//       }
//       const parts = raw.replace(/-/g, ",").split(",");
//       const formatted = parts.map(v => v.trim().toUpperCase());
//       const isValid = formatted.every(v => /^V\d+$/.test(v));
//       if (isValid) {
//         targetVersion = formatted;
//         isAll = false;
//         console.log("Final targetVersion:", targetVersion);
//         break;
//       }
//       console.log("⚠️ Invalid format! Use: v1,v2\n");
//     }
    
//     readline.close();

//     // PREPARE FOLDER
//     const downloadDir = path.resolve(`${downloadPath}${targetName}`);
//     if (!fs.existsSync(downloadDir)) {
//       fs.mkdirSync(downloadDir, { recursive: true });
//       console.log("Created folder:", downloadDir);
//     } else {
//       console.log("Folder exists:", downloadDir);
//     }

//     // CONNECT TO CHROME
//     console.log('Connecting to remote Chrome at:', REMOTE_DEBUGGING_JSON);
//     const resp = await fetch(REMOTE_DEBUGGING_JSON);
//     if (!resp.ok) throw new Error(`Failed to fetch JSON: ${resp.status}`);
//     const json = await resp.json();
//     const ws = json.webSocketDebuggerUrl;
//     if (!ws) throw new Error('webSocketDebuggerUrl not found.');

//     const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
//     const page = await browser.newPage();

//     const client = await page.target().createCDPSession();
//     await client.send('Page.setDownloadBehavior', {
//       behavior: 'allow',
//       downloadPath: downloadDir,
//     });
//     console.log('Set download folder to:', downloadDir);

//     console.log('Navigating to URL...');
//     await page.goto(url, { timeout: 0, waitUntil: 'domcontentloaded' });

//     // UTILS
//     function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
//     await sleep(10000); // Initial load wait

//     function moveToUniqueName(dir, filename) {
//       const ext = path.extname(filename);
//       const base = path.basename(filename, ext);
//       const targetPath = path.join(dir, filename);
//       if (!fs.existsSync(targetPath)) return filename;
//       let counter = 1;
//       while (true) {
//         const newName = `${base} (${counter})${ext}`;
//         const newPath = path.join(dir, newName);
//         if (!fs.existsSync(newPath)) {
//           fs.renameSync(targetPath, newPath);
//           return newName;
//         }
//         counter++;
//       }
//     }

//     // --- CRITICAL FUNCTION: Checks if download is truly finished ---
//     async function waitForCompletedDownload(dir, beforeFiles, timeoutMs) {
//       const start = Date.now();
//       const TEMP_SUFFIXES = ['.crdownload', '.crddonload'];

//       function listAdded() {
//         const all = fs.readdirSync(dir);
//         return all.filter(f => !beforeFiles.includes(f));
//       }

//       while (true) {
//         if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for new download');
//         const added = listAdded();
        
//         if (added.length === 0) {
//           await sleep(500);
//           continue;
//         }

//         // Check the most recently modified file
//         const candidates = added.map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }));
//         candidates.sort((a, b) => b.m - a.m);
//         let file = candidates[0].f;
//         const fullPath = path.join(dir, file);

//         // If it still has .crdownload, wait for it to disappear
//         const hasTemp = TEMP_SUFFIXES.some(suf => file.endsWith(suf));
//         if (hasTemp) {
//             // console.log("... still downloading (temp file found) ...");
//             await sleep(1000); 
//             continue;
//         }

//         // Ensure file size is stable (download fully written)
//         const size1 = fs.statSync(fullPath).size;
//         await sleep(1000);
//         const size2 = fs.statSync(fullPath).size;
        
//         if (size1 === size2 && size1 > 0) {
//             return file; // SUCCESS: File is done!
//         }
//       }
//     }

//     async function runProcess() {
//       await page.waitForSelector('.styles__Wrapper-hUZiO .MatrixTable__table-frozen-left .MatrixTable__body .MatrixTable__row',{ visible: true, timeout: 30000 });
//       const evalScript = `(function(targetName){
//         var nameSpans = Array.from(document.querySelectorAll('.DocumentNamestyles__CellHighlight-dJLtHK span'));
//         var match = nameSpans.find(function(s){ return s.textContent && s.textContent.trim().toLowerCase().includes(targetName.toLowerCase()); });
//         if (!match) return;
//         var leftRow = match.closest('.MatrixTable__row');
//         if (!leftRow) return;
//         var topValue = leftRow.style.top;
//         var mainRows = Array.from(document.querySelectorAll('.MatrixTable__table-main .MatrixTable__row'));
//         var mainRow = mainRows.find(function(r){ return r.style.top === topValue; });
//         if (!mainRow) return;
//         var versionBtn = mainRow.querySelector('.FileVersionIndicator__StyledClickableVersionIndicator-sc-ko8svq-1');
//         if (versionBtn) versionBtn.click();
//       })(${JSON.stringify(targetName)});`;
//       await page.evaluate(evalScript);
//     }

//     // SELECTORS
//     const rowButtonSelector = '.styles__StyledTable-bpoqbj .MatrixTable__table-frozen-right .MatrixTable__body .MatrixTable__row button';
//     const rowVersionSelector = '.ResizePanel__StyledDiv-sc-e33n1n-2 .MatrixTable__table .MatrixTable__body .VersionIndicators__StyledBaseIndicator-sc-1v5r0en-0';
//     const modalButtonSelector = 'li[data-testid="menu-item-downloadSourceFile"], li[data-testid="menu-item-download"]';
//     const downloadBtnSelector = '.styles__FooterWrapper-gZifIR button, button[data-testid="downloadButton"], button[aria-label="Download"]';

//     // GET ROWS
//     await runProcess();
//     await page.waitForSelector(rowButtonSelector, { visible: true, timeout: 15000 });
//     await page.waitForSelector(rowVersionSelector, { visible: true, timeout: 15000 });

//     let versionElements = await page.$$(rowVersionSelector);
//     let rowButtons = await page.$$(rowButtonSelector);
//     const initialRowCount = rowButtons.length;

//     const pageVersions = [];
//     for (let el of versionElements) {
//       const text = (await page.evaluate(e => e.textContent.trim().toUpperCase(), el));
//       pageVersions.push(text);
//     };

//     const matchedIndexes = pageVersions.map((v, i) => (targetVersion.includes(v) ? i : -1)).filter(i => i !== -1);
//     let rowsToProcess = isAll ? initialRowCount: matchedIndexes.length;

//     if (rowsToProcess === 0 ) {
//       console.log('No row action version 📃 found - aborting 🚫');
//       await browser.disconnect();
//       await waitForExit();
//       return;
//     }
//     console.log("Matched Indexes:", isAll ? "✅ All versions selected " : `✅ versions selected ${matchedIndexes}`);

//     // --- LOOP START: Files will process 1 by 1 here ---
//     for (let i = 0; i < rowsToProcess; i++) {
//       console.log(`\n--- Processing row 📃 ${i + 1} / ${rowsToProcess} ---`);
      
//       // 1. Refresh View
//       await runProcess();
//       await page.waitForSelector(rowButtonSelector, { visible: true, timeout: 10000 });
//       const currentButtons = await page.$$(rowButtonSelector);

//       // 2. Select Button
//       const btnIndex = isAll ? i : matchedIndexes[i];
//       if (!currentButtons[btnIndex]) {
//         console.warn(`Row button at index ${btnIndex} not found (skipping).`);
//         continue;
//       }
      
//       // 3. Snapshot files BEFORE download
//       const beforeFiles = fs.readdirSync(downloadDir);

//       // 4. Click Actions
//       await currentButtons[btnIndex].click();

//       // Click Menu Item
//       try {
//         await page.waitForSelector(modalButtonSelector, { visible: true, timeout: 30000 });
//         const modalButton = await page.$(modalButtonSelector);
//         if (modalButton) {
//           await modalButton.click();
//         } else {
//           await page.evaluate(() => {
//             const items = Array.from(document.querySelectorAll('li[role="menuitem"], li'));
//             const found = items.find(n => n.innerText && n.innerText.toLowerCase().includes('download'));
//             if (found) found.click();
//           });
//         }
//       } catch (err) {
//         console.warn('Menu click issue:', err.message);
//       }

//       // Click Modal/Footer Download
//       try {
//         await page.waitForSelector(downloadBtnSelector, { visible: true, timeout: 6000 });
//         await page.click(downloadBtnSelector);
//         console.log('Clicked final download button.');
//       } catch (err) {
//         console.log('No explicit final button; download likely started.');
//       }

//       // 5. WAIT for Download to Finish (The "Blocker")
//       // THIS IS THE LINE THAT MAKES IT 1-BY-1
//       let finalName;
//       try {
//         console.log('Waiting for download to finish... ⏳');
//         finalName = await waitForCompletedDownload(downloadDir, beforeFiles, DEFAULT_TIMEOUT);
//         console.log('Download completed! ✅ Name:', finalName);
//       } catch (err) {
//         console.warn('Download wait failed:', err.message);
//         continue;
//       }

//       // 6. Handle File Naming
//       const finalPath = path.join(downloadDir, finalName);
      
//       // Extra safety check for .crdownload rename
//       const possibleTemp = path.join(downloadDir, finalName + '.crdownload');
//       try {
//          if (!fs.existsSync(finalPath) && fs.existsSync(possibleTemp)) {
//             fs.renameSync(possibleTemp, finalPath);
//          }
         
//          const finalBaseName = path.basename(finalPath);
//          const savedName = moveToUniqueName(downloadDir, finalBaseName);
//          console.log(`Saved as 🗃️:`, savedName);
//       } catch (err) {
//          console.warn('Rename error:', err);
//       }

//       // 7. Cleanup & Cooldown
//       try { await page.keyboard.press('Escape'); } catch (e) {}
      
//       // WAIT before starting the next file loop
//       console.log('Cooldown: Waiting 3 seconds before next file... ⏱️');
//       await sleep(3000); 
//     }
//     // --- LOOP END ---

//     console.log('\nAll rows processed — check folder:', downloadDir);
//     await browser.disconnect();
    
//     // Keep window open
//     await waitForExit();
//     process.exit(0);

//   } catch (err) {
//     if (typeof log === 'function') log('Failed:', err);
//     else console.error('Failed:', err);
//     await waitForExit();
//     process.exit(1);
//   }
// })();












// // index.js
// // Node 18+ recommended (global fetch).
// const puppeteer = require('puppeteer-core');
// const fs = require('fs');
// const path = require('path');
// const { config } = require('./config');
// const { startChromeIfNotRunning } = require('./startChromeBrowser');

// // --- PKG & PATH SETUP ---
// const isPkg = typeof process.pkg !== 'undefined';
// const workingDir = isPkg ? path.dirname(process.execPath) : __dirname;
// const logFile = path.join(workingDir, 'error.log');

// const readline = require('readline').createInterface({
//   input: process.stdin,
//   output: process.stdout
// });

// // --- LOGGING HELPER ---
// function log(...args) {
//   try {
//     const msg = `[${new Date().toISOString()}] ` + args.map(a => (typeof a === 'string' ? a : (a && a.stack) ? a.stack : JSON.stringify(a))).join(' ') + '\n';
//     fs.appendFileSync(logFile, msg);
//   } catch (e) { /* ignore */ }
//   console.log(...args);
// }

// process.on('uncaughtException', (err) => {
//   log('uncaughtException', err);
//   setTimeout(() => process.exit(1), 200);
// });
// process.on('unhandledRejection', (reason) => {
//   log('unhandledRejection', reason);
//   setTimeout(() => process.exit(1), 200);
// });

// // --- INPUT HELPER ---
// function question(prompt) {
//   return new Promise(resolve => {
//     readline.question(prompt, answer => resolve(answer));
//   });
// }

// // --- WAIT FOR EXIT HELPER ---
// function waitForExit() {
//   const rl = require('readline').createInterface({
//     input: process.stdin,
//     output: process.stdout
//   });
//   return new Promise(resolve => {
//     rl.question('\nPress Enter to close this window...', () => {
//       rl.close();
//       resolve();
//     });
//   });
// }

// // --- MAIN LOGIC ---
// (async () => {
//   try {
//     await startChromeIfNotRunning();
//     await new Promise(r => setTimeout(r, 2000)); 

//     // DEFAULTS
//     const REMOTE_DEBUGGING_JSON = config.DEFAULT_REMOTE_DEBUGGING_JSON;
//     const downloadPath = config.DEFAULT_DOWNLOAD_PATH;
//     const DEFAULT_TIMEOUT = 60000;
//     const DEFAULT_URL = 'https://acc.autodesk.com/build/files/projects/c4d9bcf4-c2db-46a8-8244-406b56b6d8b6?folderUrn=urn%3Aadsk.wipprod%3Afs.folder%3Aco.cGRZ8FGqRnGs26mdK5dSlw&viewModel=detail&moduleId=folders';
//     const DEFAULT_TARGET = 'RSW9-GAYL-ZZ-ALL-M3-ELC';

//     // USER INPUTS
//     const urlInput = await question(`🔗 Enter the URL (press Enter for default): `);
//     const url = (urlInput && urlInput.trim()) ? urlInput.trim() : DEFAULT_URL;

//     const targetInput = await question(`📂 TargetName (press Enter for default): `);
//     const targetName = (targetInput && targetInput.trim()) ? targetInput.trim() : DEFAULT_TARGET;

//     let targetVersion = [];
//     let isAll = false;

//     while (true) {
//       const targetVersionInput = await question(`📃 Target Versions (all or v1,v2,...): `);
//       const raw = targetVersionInput.trim();
//       if (raw.toLowerCase() === "all") {
//         targetVersion = [];
//         isAll = true;
//         console.log("Final targetVersion: ALL versions");
//         break;
//       }
//       if (!raw) {
//         console.log("⚠️ Value required. Please re-enter.\n");
//         continue;
//       }
//       const parts = raw.replace(/-/g, ",").split(",");
//       const formatted = parts.map(v => v.trim().toUpperCase());
//       const isValid = formatted.every(v => /^V\d+$/.test(v));
//       if (isValid) {
//         targetVersion = formatted;
//         isAll = false;
//         console.log("Final targetVersion:", targetVersion);
//         break;
//       }
//       console.log("⚠️ Invalid format! Use: v1,v2\n");
//     }
    
//     readline.close();

//     // PREPARE FOLDER
//     const downloadDir = path.resolve(`${downloadPath}${targetName}`);
//     if (!fs.existsSync(downloadDir)) {
//       fs.mkdirSync(downloadDir, { recursive: true });
//       console.log("Created folder:", downloadDir);
//     } else {
//       console.log("Folder exists:", downloadDir);
//     }

//     // CONNECT TO CHROME
//     console.log('Connecting to remote Chrome at:', REMOTE_DEBUGGING_JSON);
//     const resp = await fetch(REMOTE_DEBUGGING_JSON);
//     if (!resp.ok) throw new Error(`Failed to fetch JSON: ${resp.status}`);
//     const json = await resp.json();
//     const ws = json.webSocketDebuggerUrl;
//     if (!ws) throw new Error('webSocketDebuggerUrl not found.');

//     const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
//     const page = await browser.newPage();

//     const client = await page.target().createCDPSession();
//     await client.send('Page.setDownloadBehavior', {
//       behavior: 'allow',
//       downloadPath: downloadDir,
//     });
//     console.log('Set download folder to:', downloadDir);

//     console.log('Navigating to URL...');
//     await page.goto(url, { timeout: 0, waitUntil: 'domcontentloaded' });

//     // UTILS
//     function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
//     await sleep(10000); // Initial load wait

//     function moveToUniqueName(dir, filename) {
//       const ext = path.extname(filename);
//       const base = path.basename(filename, ext);
//       const targetPath = path.join(dir, filename);
//       if (!fs.existsSync(targetPath)) return filename;
//       let counter = 1;
//       while (true) {
//         const newName = `${base} (${counter})${ext}`;
//         const newPath = path.join(dir, newName);
//         if (!fs.existsSync(newPath)) {
//           fs.renameSync(targetPath, newPath);
//           return newName;
//         }
//         counter++;
//       }
//     }

//     async function waitForCompletedDownload(dir, beforeFiles, timeoutMs = 60000) {
//       const start = Date.now();
//       const TEMP_SUFFIXES = ['.crdownload', '.crddonload'];

//       function listAdded() {
//         const all = fs.readdirSync(dir);
//         return all.filter(f => !beforeFiles.includes(f));
//       }

//       while (true) {
//         if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for new download');
//         const added = listAdded();
        
//         if (added.length === 0) {
//           await sleep(500);
//           continue;
//         }

//         // Check the most recently modified file
//         const candidates = added.map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }));
//         candidates.sort((a, b) => b.m - a.m);
//         let file = candidates[0].f;
//         const fullPath = path.join(dir, file);

//         // If it still has .crdownload, wait for it to disappear
//         const hasTemp = TEMP_SUFFIXES.some(suf => file.endsWith(suf));
//         if (hasTemp) {
//             await sleep(1000); // Just wait a bit and loop again
//             continue;
//         }

//         // Ensure file size is stable (download fully written)
//         const size1 = fs.statSync(fullPath).size;
//         await sleep(1000);
//         const size2 = fs.statSync(fullPath).size;
        
//         if (size1 === size2 && size1 > 0) {
//             return file;
//         }
//       }
//     }

//     async function runProcess() {
//       await page.waitForSelector('.styles__Wrapper-hUZiO .MatrixTable__table-frozen-left .MatrixTable__body .MatrixTable__row',{ visible: true, timeout: 30000 });
//       const evalScript = `(function(targetName){
//         var nameSpans = Array.from(document.querySelectorAll('.DocumentNamestyles__CellHighlight-dJLtHK span'));
//         var match = nameSpans.find(function(s){ return s.textContent && s.textContent.trim().toLowerCase().includes(targetName.toLowerCase()); });
//         if (!match) return;
//         var leftRow = match.closest('.MatrixTable__row');
//         if (!leftRow) return;
//         var topValue = leftRow.style.top;
//         var mainRows = Array.from(document.querySelectorAll('.MatrixTable__table-main .MatrixTable__row'));
//         var mainRow = mainRows.find(function(r){ return r.style.top === topValue; });
//         if (!mainRow) return;
//         var versionBtn = mainRow.querySelector('.FileVersionIndicator__StyledClickableVersionIndicator-sc-ko8svq-1');
//         if (versionBtn) versionBtn.click();
//       })(${JSON.stringify(targetName)});`;
//       await page.evaluate(evalScript);
//     }

//     // SELECTORS
//     const rowButtonSelector = '.styles__StyledTable-bpoqbj .MatrixTable__table-frozen-right .MatrixTable__body .MatrixTable__row button';
//     const rowVersionSelector = '.ResizePanel__StyledDiv-sc-e33n1n-2 .MatrixTable__table .MatrixTable__body .VersionIndicators__StyledBaseIndicator-sc-1v5r0en-0';
//     const modalButtonSelector = 'li[data-testid="menu-item-downloadSourceFile"], li[data-testid="menu-item-download"]';
//     const downloadBtnSelector = '.styles__FooterWrapper-gZifIR button, button[data-testid="downloadButton"], button[aria-label="Download"]';

//     // GET ROWS
//     await runProcess();
//     await page.waitForSelector(rowButtonSelector, { visible: true, timeout: 15000 });
//     await page.waitForSelector(rowVersionSelector, { visible: true, timeout: 15000 });

//     let versionElements = await page.$$(rowVersionSelector);
//     let rowButtons = await page.$$(rowButtonSelector);
//     const initialRowCount = rowButtons.length;

//     const pageVersions = [];
//     for (let el of versionElements) {
//       const text = (await page.evaluate(e => e.textContent.trim().toUpperCase(), el));
//       pageVersions.push(text);
//     };

//     const matchedIndexes = pageVersions.map((v, i) => (targetVersion.includes(v) ? i : -1)).filter(i => i !== -1);
//     let rowsToProcess = isAll ? initialRowCount: matchedIndexes.length;

//     if (rowsToProcess === 0 ) {
//       console.log('No row action version 📃 found - aborting 🚫');
//       await browser.disconnect();
//       await waitForExit();
//       return;
//     }
//     console.log("Matched Indexes:", isAll ? "✅ All versions selected " : `✅ versions selected ${matchedIndexes}`);

//     // --- LOOP: This runs ONE BY ONE ---
//     for (let i = 0; i < rowsToProcess; i++) {
//       console.log(`\n--- Processing row 📃 ${i + 1} / ${rowsToProcess} ---`);
      
//       // 1. Refresh View
//       await runProcess();
//       await page.waitForSelector(rowButtonSelector, { visible: true, timeout: 10000 });
//       const currentButtons = await page.$$(rowButtonSelector);

//       // 2. Select Button
//       const btnIndex = isAll ? i : matchedIndexes[i];
//       if (!currentButtons[btnIndex]) {
//         console.warn(`Row button at index ${btnIndex} not found (skipping).`);
//         continue;
//       }
      
//       // 3. Snapshot files BEFORE download
//       const beforeFiles = fs.readdirSync(downloadDir);

//       // 4. Click Actions
//       await currentButtons[btnIndex].click();

//       // Click Menu Item
//       try {
//         await page.waitForSelector(modalButtonSelector, { visible: true, timeout: 30000 });
//         const modalButton = await page.$(modalButtonSelector);
//         if (modalButton) {
//           await modalButton.click();
//         } else {
//           await page.evaluate(() => {
//             const items = Array.from(document.querySelectorAll('li[role="menuitem"], li'));
//             const found = items.find(n => n.innerText && n.innerText.toLowerCase().includes('download'));
//             if (found) found.click();
//           });
//         }
//       } catch (err) {
//         console.warn('Menu click issue:', err.message);
//       }

//       // Click Modal/Footer Download
//       try {
//         await page.waitForSelector(downloadBtnSelector, { visible: true, timeout: 6000 });
//         await page.click(downloadBtnSelector);
//         console.log('Clicked final download button.');
//       } catch (err) {
//         console.log('No explicit final button; download likely started.');
//       }

//       // 5. WAIT for Download to Finish (The "Blocker")
//       // The code STOPS here until the file is fully downloaded.
//       let finalName;
//       try {
//         finalName = await waitForCompletedDownload(downloadDir, beforeFiles, DEFAULT_TIMEOUT);
//         console.log('Download completed:', finalName);
//       } catch (err) {
//         console.warn('Download wait failed:', err.message);
//         continue;
//       }

//       // 6. Handle File Naming
//       const finalPath = path.join(downloadDir, finalName);
      
//       // Extra safety check for .crdownload rename
//       const possibleTemp = path.join(downloadDir, finalName + '.crdownload');
//       try {
//          if (!fs.existsSync(finalPath) && fs.existsSync(possibleTemp)) {
//             fs.renameSync(possibleTemp, finalPath);
//             console.log('Renamed .crdownload to final.');
//          }
         
//          const finalBaseName = path.basename(finalPath);
//          const savedName = moveToUniqueName(downloadDir, finalBaseName);
//          console.log(`Saved as 🗃️:`, savedName);
//       } catch (err) {
//          console.warn('Rename error:', err);
//       }

//       // 7. Cleanup & Cooldown
//       try { await page.keyboard.press('Escape'); } catch (e) {}
      
//       // WAIT before starting the next file loop
//       console.log('Waiting 2 seconds before next file...');
//       await sleep(2000); 
//     }

//     console.log('\nAll rows processed — check folder:', downloadDir);
//     await browser.disconnect();
    
//     // Keep window open
//     await waitForExit();
//     process.exit(0);

//   } catch (err) {
//     if (typeof log === 'function') log('Failed:', err);
//     else console.error('Failed:', err);
//     await waitForExit();
//     process.exit(1);
//   }
// })();








// // index-zip.js
// // Node 18+ recommended (global fetch).
// const puppeteer = require('puppeteer-core'); // connect to an externally launched Chrome
// const fs = require('fs');
// const path = require('path');
// const { config } = require('./config');
// // Check if running as a pkg executable
// const isPkg = typeof process.pkg !== 'undefined';
// // Get the actual folder where the .exe or script is running
// const workingDir = isPkg ? path.dirname(process.execPath) : __dirname;
// // Save the log file in the real folder, not inside the snapshot
// const logFile = path.join(workingDir, 'error.log');
// const {startChromeIfNotRunning} = require('./startChromeBrowser')

// const readline = require('readline').createInterface({
//   input: process.stdin,
//   output: process.stdout
// });


// // ---- error definition ----
// function log(...args) {
//   try {
//     const msg = `[${new Date().toISOString()}] ` + args.map(a => (typeof a === 'string' ? a : (a && a.stack) ? a.stack : JSON.stringify(a))).join(' ') + '\n';
//     fs.appendFileSync(logFile, msg);
//   } catch (e) { /* ignore logging errors */ }
//   console.log(...args);
// }
// process.on('uncaughtException', (err) => {
//   log('uncaughtException', err);
//   // give time to flush log then exit
//   setTimeout(() => process.exit(1), 200);
// });
// process.on('unhandledRejection', (reason) => {
//   log('unhandledRejection', reason);
//   setTimeout(() => process.exit(1), 200);
// });
// // ------------------------------------------------------


// function question(prompt) {
//   return new Promise(resolve => {
//     readline.question(prompt, answer => resolve(answer));
//   });
// }

// (async () => {
//   try {
//     await startChromeIfNotRunning()
//     await new Promise(r => setTimeout(r, 2000)); // wait 2 seconds
//     // --- DEFAULTS ---
//     const REMOTE_DEBUGGING_JSON =  config.DEFAULT_REMOTE_DEBUGGING_JSON;
//     const downloadPath = config.DEFAULT_DOWNLOAD_PATH;
//     const DEFAULT_TIMEOUT = 60000;
//     let autoDesk = "https://acc.autodesk.com/"
//     let folderLink = ""
//     const DEFAULT_URL = 'https://acc.autodesk.com/build/files/projects/c4d9bcf4-c2db-46a8-8244-406b56b6d8b6?folderUrn=urn%3Aadsk.wipprod%3Afs.folder%3Aco.cGRZ8FGqRnGs26mdK5dSlw&viewModel=detail&moduleId=folders';
//     const DEFAULT_TARGET = 'RSW9-GAYL-ZZ-ALL-M3-ELC';


//     const urlInput = await question(`🔗 Enter the URL  (press Enter for default): `);
//     const url = (urlInput && urlInput.trim()) ? urlInput.trim() : DEFAULT_URL;

//     const targetInput = await question(`📂 TargetName (press Enter for default): `);
//     const targetName = (targetInput && targetInput.trim()) ? targetInput.trim() : DEFAULT_TARGET;

//     let targetVersion = [];
//     let isAll = false

//     while (true) {
//       const targetVersionInput = await question(`📃 Target Versions (all or v1,v2,...): `);
//       const raw = targetVersionInput.trim();
//       // 🚀 If user types "all" → skip process
//       if (raw.toLowerCase() === "all") {
//         targetVersion = [];
//         isAll = true;
//         console.log("Final targetVersion: ALL versions");
//         break;
//       }
//       // ❌ Empty input NOT allowed
//       if (!raw) {
//         console.log("⚠️  Value required unless you type 'all'. Please re-enter.\n");
//         isAll = false;
//         continue;
//       }
//       const parts = raw.replace(/-/g, ",").split(",");
//       const formatted = parts.map(v => v.trim().toUpperCase());
//       // ✔ Validate format: V1, V2, V10...
//       const isValid = formatted.every(v => /^V\d+$/.test(v));
//       if (isValid) {
//         targetVersion = formatted;
//         isAll = false;
//         console.log("Final targetVersion:", targetVersion);
//         break;
//       }
//       console.log("⚠️  Invalid format! Use like: v1,v2,v3 or v1-v2-v3\nPlease re-enter.\n");
//       isAll = false;
//     }
   
//     readline.close();
//     // --- CONFIG ---
//     const downloadDir = path.resolve(`${downloadPath}${targetName}`);
//     const DOWNLOAD_TIMEOUT_MS = DEFAULT_TIMEOUT;

//     // Ensure download dir exists
//     if (!fs.existsSync(downloadDir)) {
//       fs.mkdirSync(downloadDir, { recursive: true });
//       console.log("Created folder:", downloadDir);
//     } else {
//       console.log("Folder exists:", downloadDir);
//     }

//     // Connect to remote Chrome
//     console.log('Connecting to remote Chrome at:', REMOTE_DEBUGGING_JSON);
//     const resp = await fetch(REMOTE_DEBUGGING_JSON);
//     if (!resp.ok) throw new Error(`Failed to fetch remote debugging JSON: ${resp.status} ${resp.statusText}`);
//     const json = await resp.json();
//     const ws = json.webSocketDebuggerUrl;
//     if (!ws) throw new Error('webSocketDebuggerUrl not found in remote debugging JSON.');

//     const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
//     const page = await browser.newPage();

//     // Set download behavior
//     const client = await page.target().createCDPSession();
//     await client.send('Page.setDownloadBehavior', {
//       behavior: 'allow',
//       downloadPath: downloadDir,
//     });
//     console.log('Set Chrome download folder to:', downloadDir);

//     // Navigate
//     console.log('Navigating to URL...');
//     await page.goto(url, { timeout: 0, waitUntil: 'domcontentloaded' });

//     // ---- helper utilities ----
//     function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
//     await sleep(15000);

//     function moveToUniqueName(dir, filename) {
//       const ext = path.extname(filename);
//       const base = path.basename(filename, ext);
//       const targetPath = path.join(dir, filename);

//       // If doesn't exist, keep original (first copy)
//       if (!fs.existsSync(targetPath)) return filename;

//       // Else generate "base (1).ext", "base (2).ext", ...
//       let counter = 1;
//       while (true) {
//         const newName = `${base} (${counter})${ext}`;
//         const newPath = path.join(dir, newName);
//         if (!fs.existsSync(newPath)) {
//           fs.renameSync(targetPath, newPath);
//           return newName;
//         }
//         counter++;
//       }
//     }

//     async function waitForCompletedDownload(dir, beforeFiles, timeoutMs = 60000) {
//       const start = Date.now();
//       const TEMP_SUFFIXES = ['.crdownload', '.crddonload'];

//       function listAdded() {
//         const all = fs.readdirSync(dir);
//         return all.filter(f => !beforeFiles.includes(f));
//       }

//       while (true) {
//         if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for new download');
//         const added = listAdded();
//         if (added.length === 0) {
//           await sleep(300);
//           continue;
//         }
//         const candidates = added.map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }));
//         candidates.sort((a, b) => b.m - a.m);
//         let file = candidates[0].f;
//         const fullPath = path.join(dir, file);

//         const hasTemp = TEMP_SUFFIXES.some(suf => file.endsWith(suf));
//         if (!hasTemp) {
//           const size1 = fs.statSync(fullPath).size;
//           await sleep(300);
//           const size2 = fs.statSync(fullPath).size;
//           if (size1 === size2) return file;
//           continue;
//         }

//         const matched = TEMP_SUFFIXES.find(suf => file.endsWith(suf));
//         const finalName = file.slice(0, -matched.length);
//         const finalPath = path.join(dir, finalName);

//         const innerStart = Date.now();
//         while (true) {
//           if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for download to finish');

//           if (fs.existsSync(finalPath)) {
//             const s1 = fs.statSync(finalPath).size;
//             await sleep(300);
//             const s2 = fs.statSync(finalPath).size;
//             if (s1 === s2) return finalName;
//             continue;
//           }

//           if (fs.existsSync(fullPath)) {
//             const s1 = fs.statSync(fullPath).size;
//             await sleep(800);
//             if (!fs.existsSync(fullPath)) continue;
//             const s2 = fs.statSync(fullPath).size;
//             if (s1 === s2) return finalName;
//           }

//           if (Date.now() - innerStart > timeoutMs) throw new Error('Timed out waiting for temp download to stabilize');
//           await sleep(300);
//         }
//       }
//     }

//     // function to reveal version / row actions (your logic)
//     async function runProcess() {
//       await page.waitForSelector('.styles__Wrapper-hUZiO .MatrixTable__table-frozen-left .MatrixTable__body .MatrixTable__row',{ visible: true, timeout: 30000 });
//       // await page.evaluate((targetName) => {
//       //   const nameSpans = [...document.querySelectorAll('.DocumentNamestyles__CellHighlight-dJLtHK span')]
//       //   const match = nameSpans.find(s => s.textContent && s.textContent.trim().toLowerCase().includes(targetName.toLowerCase()));
//       //   if (!match) return;
//       //   const leftRow = match.closest('.MatrixTable__row');
//       //   if (!leftRow) return;
//       //   const topValue = leftRow.style.top;
//       //   const mainRows = Array.from(document.querySelectorAll('.MatrixTable__table-main .MatrixTable__row'));
//       //   const mainRow = mainRows.find(r => r.style.top === topValue);
//       //   if (!mainRow) return;
//       //   const versionBtn = mainRow.querySelector('.FileVersionIndicator__StyledClickableVersionIndicator-sc-ko8svq-1');
//       //   if (versionBtn) versionBtn.click();
//       // console.log("Button-click",!match,!leftRow,!mainRow,!versionBtn);
//       // }, targetName);
//     // use string-based IIFE to avoid Function.prototype.toString issues after pkg
//       const evalScript = `(function(targetName){
//         var nameSpans = Array.from(document.querySelectorAll('.DocumentNamestyles__CellHighlight-dJLtHK span'));
//         var match = nameSpans.find(function(s){ return s.textContent && s.textContent.trim().toLowerCase().includes(targetName.toLowerCase()); });
//         if (!match) return;
//         var leftRow = match.closest('.MatrixTable__row');
//         if (!leftRow) return;
//         var topValue = leftRow.style.top;
//         var mainRows = Array.from(document.querySelectorAll('.MatrixTable__table-main .MatrixTable__row'));
//         var mainRow = mainRows.find(function(r){ return r.style.top === topValue; });
//         if (!mainRow) return;
//         var versionBtn = mainRow.querySelector('.FileVersionIndicator__StyledClickableVersionIndicator-sc-ko8svq-1');
//         if (versionBtn) versionBtn.click();
//       })(${JSON.stringify(targetName)});`;
//       await page.evaluate(evalScript);
//     }

//     // selectors
//     const rowButtonSelector = '.styles__StyledTable-bpoqbj .MatrixTable__table-frozen-right .MatrixTable__body .MatrixTable__row button';
//     const rowVersionSelector = '.ResizePanel__StyledDiv-sc-e33n1n-2 .MatrixTable__table .MatrixTable__body .VersionIndicators__StyledBaseIndicator-sc-1v5r0en-0';
//     const modalButtonSelector = 'li[data-testid="menu-item-downloadSourceFile"], li[data-testid="menu-item-download"]';
//     const downloadBtnSelector = '.styles__FooterWrapper-gZifIR button, button[data-testid="downloadButton"], button[aria-label="Download"]';
//     // .MatrixTable__table .MatrixTable__body .VersionIndicators__StyledBaseIndicator-sc-1v5r0en-0
//     // Wait for initial row buttons
//     await runProcess();
//     await page.waitForSelector(rowButtonSelector, { visible: true, timeout: 15000 });
//     await page.waitForSelector(rowVersionSelector, { visible: true, timeout: 15000 }); //version selector

//     let versionElements = await page.$$(rowVersionSelector);
//     let rowButtons = await page.$$(rowButtonSelector);
//     const initialRowCount = rowButtons.length;

//     const pageVersions = [];
//     for (let el of versionElements) {
//       const text = (await page.evaluate(e => e.textContent.trim().toUpperCase(), el));
//       pageVersions.push(text);
//     };

//     const matchedIndexes = pageVersions.map((v, i) => (targetVersion.includes(v) ? i : -1)).filter(i => i !== -1);
//     let rowsToProcess = isAll ? initialRowCount: matchedIndexes.length;

//     if (rowsToProcess === 0 ) {
//       console.log('No row action version 📃 found - aborting 🚫');
//       await browser.disconnect();
//       return;
//     }
//     matchedIndexes.length === 0 ? "This version 📃 Not Found ❌" : ""
//     console.log("Matched Indexes:", isAll ? "✅ All versions selected " : `✅ versions selected ${matchedIndexes}`);

//     // iterate rows
//     for (let i = 0; i < rowsToProcess; i++) {
//       console.log(`\n--- Processing row 📃 ${i + 1} / ${rowsToProcess} ---`);
//       await runProcess();

//       await page.waitForSelector(rowButtonSelector, { visible: true, timeout: 10000 });
//       const currentButtons = await page.$$(rowButtonSelector);

//       if (!currentButtons[isAll ? i : matchedIndexes[i]]) {
//         console.warn(`Row button at index ${i} not found (skipping).`);
//         continue;
//       }
//       const beforeFiles = fs.readdirSync(downloadDir);

//       // Click the action button
//       await currentButtons[isAll ? i : matchedIndexes[i]].click();

//       // Wait for the menu download item to appear and click it (tolerant)
//       try {
//         await page.waitForSelector(modalButtonSelector, { visible: true, timeout: 30000  });
//         const modalButton = await page.$(modalButtonSelector);
//         if (modalButton) {
//           await modalButton.click();
//         } else {
//           await page.evaluate(() => {
//             const items = Array.from(document.querySelectorAll('li[role="menuitem"], li'));
//             const found = items.find(n => n.innerText && n.innerText.toLowerCase().includes('download'));
//             if (found) found.click();
//           });
//         }
//       } catch (err) {
//         console.warn('Download menu item not found or click failed, continuing to try final download button.', err.message);
//       }

//       // Try to click the final download button in footer/modal (if any)
//       try {
//         await page.waitForSelector(downloadBtnSelector, { visible: true, timeout: 6000 });
//         await page.click(downloadBtnSelector);
//         console.log('Clicked final download button (if present).');
//       } catch (err) {
//         console.log('No explicit final download button visible; download may already have started by menu click.');
//       }

//       // Wait for the completed download (no .crdownload)
//       let finalName;
//       try {
//         finalName = await waitForCompletedDownload(downloadDir, beforeFiles, DOWNLOAD_TIMEOUT_MS);
//         console.log('Download completed (final name):', finalName);
//       } catch (err) {
//         console.warn('Timed out or error while waiting for completed download:', err.message);
//         continue;
//       }

//       // If Chrome left a .crdownload file (temp) and final file doesn't exist yet,
//       // rename the temp to the final name before moving
//       const finalPath = path.join(downloadDir, finalName);
//       const possibleTemp = path.join(downloadDir, finalName + '.crdownload');
//       const possibleTempMisspell = path.join(downloadDir, finalName + '.crddonload'); // just in case

//       try {
//         if (!fs.existsSync(finalPath)) {
//           if (fs.existsSync(possibleTemp)) {
//             fs.renameSync(possibleTemp, finalPath);
//             console.log('Renamed temp to final:', path.basename(finalPath));
//           } else if (fs.existsSync(possibleTempMisspell)) {
//             fs.renameSync(possibleTempMisspell, finalPath);
//             console.log('Renamed misspelled temp to final:', path.basename(finalPath));
//           } else {
//             console.warn('Expected final file not found, skipping rename.');
//             continue;
//           }
//         }

//         const finalBaseName = path.basename(finalPath);
//         const savedName = moveToUniqueName(downloadDir, finalBaseName);
//         console.log(`Saved as 🗃️:`, savedName);

//       } catch (err) {
//         console.warn('Error handling final file rename/move:', err);
//       }

//       // close any open menu/dialog
//       try { await page.keyboard.press('Escape'); } catch (e) { /* ignore */ }
//       await sleep(700);
//     }

//     console.log('\nAll rows processed — check folder:', downloadDir);
//     await browser.disconnect();
//     await waitForExit();
//     process.exit(0);

//   } catch (err) {
//      if (typeof log === 'function') log('Failed:', err);
//      else console.error('Failed:', err);
//      await waitForExit();
//      process.exit(1);
//   }
//   })();


// // Helper to keep window open
// function waitForExit() {
//   const rl = require('readline').createInterface({
//     input: process.stdin,
//     output: process.stdout
//   });
//   return new Promise(resolve => {
//     rl.question('\nPress Enter to close this window...', () => {
//       rl.close();
//       resolve();
//     });
//   });
// }













// // finshed version
// // index-zip.js
// // Node 18+ recommended (global fetch).
// const puppeteer = require('puppeteer-core');
// const fs = require('fs');
// const path = require('path');

// (async () => {
//   try {
//     // --- ====== CONFIG ====== ---
//     const REMOTE_DEBUGGING_JSON = 'http://127.0.0.1:9222/json/version';
//     const url = 'https://acc.autodesk.com/build/files/projects/c4d9bcf4-c2db-46a8-8244-406b56b6d8b6?folderUrn=urn%3Aadsk.wipprod%3Afs.folder%3Aco.cGRZ8FGqRnGs26mdK5dSlw&viewModel=detail&moduleId=folders';
//     const targetName = "Structural";
//     const downloadPath = "C:/Users/Herman/Projects/2025/Nov/AutoDesk_Multi_Download/"
    
//     // Use forward slashes to avoid escape problems on Windows
//     const downloadDir = path.resolve(`${downloadPath}${targetName}`);
//     const DOWNLOAD_TIMEOUT_MS = 60000; // how long to wait for each download (ms)
//     // --- ====== /CONFIG ======

//     // Ensure download dir exists
//     if (!fs.existsSync(downloadDir)) {
//       fs.mkdirSync(downloadDir, { recursive: true });
//       console.log("Created folder:", downloadDir);
//     } else {
//       console.log("Folder exists:", downloadDir);
//     }

//     // Fetch remote debugging info and connect Puppeteer to existing Chrome
//     const resp = await fetch(REMOTE_DEBUGGING_JSON);
//     const json = await resp.json();
//     const ws = json.webSocketDebuggerUrl;
//     const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
//     const page = await browser.newPage();

//     // Tell Chrome (CDP) to download into our folder
//     const client = await page.target().createCDPSession();
//     await client.send('Page.setDownloadBehavior', {
//       behavior: 'allow',
//       downloadPath: downloadDir,
//     });
//     console.log('Set Chrome download folder to:', downloadDir);

//     // Go to page
//     await page.goto(url, { timeout: 0, waitUntil: 'domcontentloaded' });

//     // Helper utilities
//     function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


//     function moveToUniqueName(dir, filename) {
//     const ext = path.extname(filename);           
//     const base = path.basename(filename, ext);   

//     let targetPath = path.join(dir, filename);

//     if (!fs.existsSync(targetPath)) {
//       // No rename needed
//       return filename;
//     }

//     // If filename already exists → add (1), (2), (3)...
//     let counter = 0;
//     while (true) {
//       const newName =counter === 0 ?  `${base} ${ext}` : `${base} (${counter})${ext}`;
//       const newPath = path.join(dir, newName);

//       if (!fs.existsSync(newPath)) {
//         // Rename ORIGINAL downloaded file → duplicate safe name
//         fs.renameSync(targetPath, newPath);
//         return newName;
//       }

//       counter++;
//       }
//     }


//     /**
//      * Wait for a new completed download in `dir` compared to `beforeFiles`.
//      * Handles Chrome temp files (.crdownload or common misspellings).
//      * Returns the final filename (without .crdownload) when complete.
//      */
//     async function waitForCompletedDownload(dir, beforeFiles, timeoutMs = 60000) {
//       const start = Date.now();
//       const TEMP_SUFFIXES = ['.crdownload', '.crddonload']; // include common misspelling

//       // helper: list added files
//       function listAdded() {
//         const all = fs.readdirSync(dir);
//         return all.filter(f => !beforeFiles.includes(f));
//       }

//       while (true) {
//         if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for new download');

//         const added = listAdded();
//         if (added.length === 0) {
//           await sleep(300);
//           continue;
//         }

//         // choose most recently modified added file
//         const candidates = added.map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }));
//         candidates.sort((a, b) => b.m - a.m);
//         let file = candidates[0].f;
//         const fullPath = path.join(dir, file);

//         // If file does not have a temp suffix, return it (completed)
//         const hasTemp = TEMP_SUFFIXES.some(suf => file.endsWith(suf));
//         if (!hasTemp) {
//           // double-check file size stability (small precaution)
//           const size1 = fs.statSync(fullPath).size;
//           await sleep(300);
//           const size2 = fs.statSync(fullPath).size;
//           if (size1 === size2) return file;
//           // else continue waiting
//           continue;
//         }

//         // file has temp suffix like .crdownload -> wait until Chrome finalizes
//         const matched = TEMP_SUFFIXES.find(suf => file.endsWith(suf));
//         const finalName = file.slice(0, -matched.length);
//         const finalPath = path.join(dir, finalName);

//         // Wait for either finalPath to appear OR temp file to stabilize in size
//         const innerStart = Date.now();
//         while (true) {
//           if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for download to finish');

//           // If final file exists — return it
//           if (fs.existsSync(finalPath)) {
//             // ensure final file size stable
//             const s1 = fs.statSync(finalPath).size;
//             await sleep(300);
//             const s2 = fs.statSync(finalPath).size;
//             if (s1 === s2) return finalName;
//             continue;
//           }

//           // If temp exists and is stable for short interval, assume finished
//           if (fs.existsSync(fullPath)) {
//             const s1 = fs.statSync(fullPath).size;
//             await sleep(800);
//             if (!fs.existsSync(fullPath)) {
//               // temp vanished; loop to check finalPath existence
//               continue;
//             }
//             const s2 = fs.statSync(fullPath).size;
//             if (s1 === s2) {
//               // If final doesn't exist yet but temp is stable, return finalName and caller will rename temp
//               return finalName;
//             }
//           }

//           // small backoff
//           if (Date.now() - innerStart > timeoutMs) throw new Error('Timed out waiting for temp download to stabilize');
//           await sleep(300);
//         }
//       }
//     }

//     // function to reveal version / row actions (your logic)
//     async function runProcess() {
//       await page.waitForSelector('.styles__Wrapper-hUZiO .MatrixTable__table-frozen-left .MatrixTable__body .MatrixTable__row', { timeout: 15000 });
//       await page.evaluate((targetName) => {
//         const nameSpans = Array.from(document.querySelectorAll('.DocumentNamestyles__CellHighlight-dJLtHK span'));
//         const match = nameSpans.find(s => s.textContent && s.textContent.trim().toLowerCase().includes(targetName.toLowerCase()));
//         if (!match) return;
//         const leftRow = match.closest('.MatrixTable__row');
//         if (!leftRow) return;
//         const topValue = leftRow.style.top;
//         const mainRows = Array.from(document.querySelectorAll('.MatrixTable__table-main .MatrixTable__row'));
//         const mainRow = mainRows.find(r => r.style.top === topValue);
//         if (!mainRow) return;
//         const versionBtn = mainRow.querySelector('.FileVersionIndicator__StyledClickableVersionIndicator-sc-ko8svq-1');
//         if (versionBtn) versionBtn.click();
//       }, targetName);
//     }

//     // selectors
//     const rowButtonSelector = '.styles__StyledTable-bpoqbj .MatrixTable__table-frozen-right .MatrixTable__body .MatrixTable__row button';
//     const modalButtonSelector = 'li[data-testid="menu-item-downloadSourceFile"], li[data-testid="menu-item-download"]';
//     const downloadBtnSelector = '.styles__FooterWrapper-gZifIR button, button[data-testid="downloadButton"], button[aria-label="Download"]';

//     // Wait for initial row buttons
//     await runProcess();
//     await page.waitForSelector(rowButtonSelector, { visible: true, timeout: 15000 });

//     // get initial buttons count (we'll re-query each loop)
//     let rowButtons = await page.$$(rowButtonSelector);
//     const initialRowCount = rowButtons.length;
//     if (initialRowCount === 0) {
//       console.log('No row action buttons found - aborting');
//       await browser.disconnect();
//       return;
//     }
//     console.log(`Found ${initialRowCount} row action button(s).`);

//     // iterate rows
//     for (let i = 0; i < initialRowCount; i++) {
//       console.log(`\n--- Processing row ${i + 1} / ${initialRowCount} ---`);
//       // re-run reveal (UI may have changed)
//       await runProcess();

//       // re-query action buttons
//       await page.waitForSelector(rowButtonSelector, { visible: true, timeout: 10000 });
//       const currentButtons = await page.$$(rowButtonSelector);

//       if (!currentButtons[i]) {
//         console.warn(`Row button at index ${i} not found (skipping).`);
//         continue;
//       }

//       // snapshot files before download starts
//       const beforeFiles = fs.readdirSync(downloadDir);

//       // Click the action button
//       await currentButtons[i].click();

//       // Wait for the menu download item to appear and click it (tolerant)
//       try {
//         await page.waitForSelector(modalButtonSelector, { visible: true, timeout: 8000 });
//         const modalButton = await page.$(modalButtonSelector);
//         if (modalButton) {
//           await modalButton.click();
//         } else {
//           // fallback: try to click any menu item containing "download"
//           await page.evaluate(() => {
//             const items = Array.from(document.querySelectorAll('li[role="menuitem"], li'));
//             const found = items.find(n => n.innerText && n.innerText.toLowerCase().includes('download'));
//             if (found) found.click();
//           });
//         }
//       } catch (err) {
//         console.warn('Download menu item not found or click failed, continuing to try final download button.', err.message);
//       }

//       // Try to click the final download button in footer/modal (if any)
//       try {
//         await page.waitForSelector(downloadBtnSelector, { visible: true, timeout: 6000 });
//         await page.click(downloadBtnSelector);
//         console.log('Clicked final download button (if present).');
//       } catch (err) {
//         console.log('No explicit final download button visible; download may already have started by menu click.');
//       }

//       // Wait for the completed download (no .crdownload)
//       let finalName;
//       try {
//         finalName = await waitForCompletedDownload(downloadDir, beforeFiles, DOWNLOAD_TIMEOUT_MS);
//         console.log('Download completed (final name):', finalName);
//       } catch (err) {
//         console.warn('Timed out or error while waiting for completed download:', err.message);
//         // decide to continue or retry; we'll continue to the next row
//         continue;
//       }

//       // If Chrome left a .crdownload file (temp) and final file doesn't exist yet,
//       // rename the temp to the final name before moving (waitForCompletedDownload may have indicated finalName).
//       const finalPath = path.join(downloadDir, finalName);
//       const possibleTemp = path.join(downloadDir, finalName + '.crdownload');
//       const possibleTempMisspell = path.join(downloadDir, finalName + '.crddonload'); // just in case
//       try {
//         if (!fs.existsSync(finalPath)) {
//           if (fs.existsSync(possibleTemp)) {
//             // rename temp to final (safe because we waited for stability)
//             fs.renameSync(possibleTemp, finalPath);
//             console.log('Renamed temp to final:', path.basename(finalPath));
//           } else if (fs.existsSync(possibleTempMisspell)) {
//             fs.renameSync(possibleTempMisspell, finalPath);
//             console.log('Renamed misspelled temp to final:', path.basename(finalPath));
//           } else {
//             // final not found and no temp; skip
//             console.warn('Expected final file not found, skipping rename.');
//             continue;
//           }
//         }

//         // Now move to unique name
       
//        const finalBaseName = path.basename(finalPath);
//        const savedName = moveToUniqueName(downloadDir, finalBaseName);
//        console.log("Saved as:", savedName);

//       } catch (err) {
//         console.warn('Error handling final file rename/move:', err);
//       }

//       // close any open menu/dialog
//       try { await page.keyboard.press('Escape'); } catch (e) { /* ignore */ }
//       await sleep(700);
//     }

//     console.log('\nAll rows processed — check folder:', downloadDir);
//     await browser.disconnect();
//     process.exit(0);

//   } catch (err) {
//     console.error('Failed:', err);
//     process.exit(1);
//   }
// })();









// // login manual autodesk method
// // index-zip.js
// // Node 18+ recommended
// const puppeteer = require('puppeteer'); // note: install `puppeteer`
// const fs = require('fs');
// const path = require('path');

// (async () => {
//   try {
//     // --- ====== CONFIG ====== ---
//     const url = 'https://acc.autodesk.com/build/files/projects/c4d9bcf4-c2db-46a8-8244-406b56b6d8b6?folderUrn=urn%3Aadsk.wipprod%3Afs.folder%3Aco.cGRZ8FGqRnGs26mdK5dSlw&viewModel=detail&moduleId=folders';
//     const targetName = "Structural";
//     const downloadPath = "C:/Users/Herman/Projects/2025/Nov/AutoDesk_Multi_Download/";
//     const downloadDir = path.resolve(`${downloadPath}${targetName}`);
//     const DOWNLOAD_TIMEOUT_MS = 60000; // ms per file
//     // --- ====== /CONFIG ====== ---

//     // Ensure download dir exists
//     if (!fs.existsSync(downloadDir)) {
//       fs.mkdirSync(downloadDir, { recursive: true });
//       console.log("Created folder:", downloadDir);
//     } else {
//       console.log("Folder exists:", downloadDir);
//     }

//     // Launch a Chromium instance (headless). Use 'new' headless mode for modern Chromium.
//     const browser = await puppeteer.launch({
//       // headless: 'new', // use 'new' headless; if downloads fail try headless: false
//       headless: false,
//       args: [
//         '--no-sandbox',
//         '--disable-setuid-sandbox',
//         '--disable-dev-shm-usage',
//       ],
//       defaultViewport: null,
//     });

//     const page = await browser.newPage();

//     // Tell Chrome (CDP) to download into our folder
//     const client = await page.target().createCDPSession();
//     await client.send('Page.setDownloadBehavior', {
//       behavior: 'allow',
//       downloadPath: downloadDir,
//     });
//     console.log('Download folder to:', downloadDir);



//     // Go to page
//     await page.goto(url, { timeout: 0, waitUntil: 'domcontentloaded' });

//     // Helper utilities
//     function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


//     function moveToUniqueName(dir, filename) {
//       const ext = path.extname(filename);
//       const base = path.basename(filename, ext);
//       const targetPath = path.join(dir, filename);

//       // If doesn't exist, keep original (first copy)
//       if (!fs.existsSync(targetPath)) return filename;

//       // Else generate "base (1).ext", "base (2).ext", ...
//       let counter = 1;
//       while (true) {
//         const newName = `${base} (${counter})${ext}`;
//         const newPath = path.join(dir, newName);
//         if (!fs.existsSync(newPath)) {
//           // rename original downloaded file to the available name
//           fs.renameSync(targetPath, newPath);
//           return newName;
//         }
//         counter++;
//       }
//     }

//     /**
//      * Wait for a new completed download in `dir` compared to `beforeFiles`.
//      * Handles Chrome temp files (.crdownload or .crddonload).
//      * Returns the final filename (without .crdownload) when complete.
//      */
//     async function waitForCompletedDownload(dir, beforeFiles, timeoutMs = 60000) {
//       const start = Date.now();
//       const TEMP_SUFFIXES = ['.crdownload', '.crddonload'];

//       function listAdded() {
//         const all = fs.readdirSync(dir);
//         return all.filter(f => !beforeFiles.includes(f));
//       }

//       while (true) {
//         if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for new download');

//         const added = listAdded();
//         if (added.length === 0) {
//           await sleep(300);
//           continue;
//         }

//         const candidates = added.map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }));
//         candidates.sort((a, b) => b.m - a.m);
//         let file = candidates[0].f;
//         const fullPath = path.join(dir, file);

//         const hasTemp = TEMP_SUFFIXES.some(suf => file.endsWith(suf));
//         if (!hasTemp) {
//           // double-check stability
//           const size1 = fs.statSync(fullPath).size;
//           await sleep(300);
//           const size2 = fs.statSync(fullPath).size;
//           if (size1 === size2) return file;
//           continue;
//         }

//         const matched = TEMP_SUFFIXES.find(suf => file.endsWith(suf));
//         const finalName = file.slice(0, -matched.length);
//         const finalPath = path.join(dir, finalName);

//         const innerStart = Date.now();
//         while (true) {
//           if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for download to finish');

//           if (fs.existsSync(finalPath)) {
//             const s1 = fs.statSync(finalPath).size;
//             await sleep(300);
//             const s2 = fs.statSync(finalPath).size;
//             if (s1 === s2) return finalName;
//             continue;
//           }

//           if (fs.existsSync(fullPath)) {
//             const s1 = fs.statSync(fullPath).size;
//             await sleep(800);
//             if (!fs.existsSync(fullPath)) continue;
//             const s2 = fs.statSync(fullPath).size;
//             if (s1 === s2) return finalName;
//           }

//           if (Date.now() - innerStart > timeoutMs) throw new Error('Timed out waiting for temp download to stabilize');
//           await sleep(300);
//         }
//       }
//     }

//     // await page.waitForSelector('input[name="email"]');
//     // const emailInput = await page.$('input[name="email"]');
//     // await emailInput.type('nantha@sanveotech.com');

//     // await page.waitForSelector('button[id="verify_user_btn"]');
//     // const emailNextBtn = await page.$('button[id="verify_user_btn"]');
//     // await emailNextBtn.click()

//     // await page.waitForSelector('input[name="password"]');
//     // const passInput = await page.$('input[name="password"]');
//     // await passInput.type('Ramnand@96');
    

//     // await page.waitForSelector('button[id="btnSubmit"]');
//     // const signInBtn = await page.$('button[id="btnSubmit"]');
//     // await signInBtn.click();

//     // await page.waitForSelector('div[class="css-8twc3t"]');
//     // const otpInputs = await page.$$('div[class="css-8twc3t"] Input');
//     // let otp = 123456;

//     // for (let i = 0; i < otpInputs.length; i++) {
//     // await otpInputs[i].type(otp[i]);
//     // }



//     sleep(2000)

//     // function to reveal version / row actions (your logic)
//     async function runProcess() {
//       await page.waitForSelector('.styles__Wrapper-hUZiO .MatrixTable__table-frozen-left .MatrixTable__body .MatrixTable__row', { timeout: 15000 });
//       await page.evaluate((targetName) => {
//         const nameSpans = Array.from(document.querySelectorAll('.DocumentNamestyles__CellHighlight-dJLtHK span'));
//         const match = nameSpans.find(s => s.textContent && s.textContent.trim().toLowerCase().includes(targetName.toLowerCase()));
//         if (!match) return;
//         const leftRow = match.closest('.MatrixTable__row');
//         if (!leftRow) return;
//         const topValue = leftRow.style.top;
//         const mainRows = Array.from(document.querySelectorAll('.MatrixTable__table-main .MatrixTable__row'));
//         const mainRow = mainRows.find(r => r.style.top === topValue);
//         if (!mainRow) return;
//         const versionBtn = mainRow.querySelector('.FileVersionIndicator__StyledClickableVersionIndicator-sc-ko8svq-1');
//         if (versionBtn) versionBtn.click();
//       }, targetName);
//     }

//     // selectors
//     const rowButtonSelector = '.styles__StyledTable-bpoqbj .MatrixTable__table-frozen-right .MatrixTable__body .MatrixTable__row button';
//     const modalButtonSelector = 'li[data-testid="menu-item-downloadSourceFile"], li[data-testid="menu-item-download"]';
//     const downloadBtnSelector = '.styles__FooterWrapper-gZifIR button, button[data-testid="downloadButton"], button[aria-label="Download"]';

//     // Wait for initial row buttons
//     await runProcess();
//     await page.waitForSelector(rowButtonSelector, { visible: true, timeout: 15000 });

//     // get initial buttons count
//     let rowButtons = await page.$$(rowButtonSelector);
//     const initialRowCount = rowButtons.length;
//     if (initialRowCount === 0) {
//       console.log('No row action buttons found - aborting');
//       await browser.close();
//       return;
//     }
//     console.log(`Found ${initialRowCount} row action button(s).`);

//     // iterate rows
//     for (let i = 0; i < initialRowCount; i++) {
//       console.log(`\n--- Processing row ${i + 1} / ${initialRowCount} ---`);
//       await runProcess();

//       await page.waitForSelector(rowButtonSelector, { visible: true, timeout: 10000 });
//       const currentButtons = await page.$$(rowButtonSelector);

//       if (!currentButtons[i]) {
//         console.warn(`Row button at index ${i} not found (skipping).`);
//         continue;
//       }

//       const beforeFiles = fs.readdirSync(downloadDir);

//       // Click the action button
//       await currentButtons[i].click();

//       // Wait for the menu download item to appear and click it
//       try {
//         await page.waitForSelector(modalButtonSelector, { visible: true, timeout: 8000 });
//         const modalButton = await page.$(modalButtonSelector);
//         if (modalButton) {
//           await modalButton.click();
//         } else {
//           await page.evaluate(() => {
//             const items = Array.from(document.querySelectorAll('li[role="menuitem"], li'));
//             const found = items.find(n => n.innerText && n.innerText.toLowerCase().includes('download'));
//             if (found) found.click();
//           });
//         }
//       } catch (err) {
//         console.warn('Download menu item not found or click failed, continuing to try final download button.', err.message);
//       }

//       // Try to click the final download button
//       try {
//         await page.waitForSelector(downloadBtnSelector, { visible: true, timeout: 6000 });
//         await page.click(downloadBtnSelector);
//         console.log('Clicked final download button (if present).');
//       } catch (err) {
//         console.log('No explicit final download button visible; download may already have started by menu click.');
//       }

//       // Wait for the completed download (no .crdownload)
//       let finalName;
//       try {
//         finalName = await waitForCompletedDownload(downloadDir, beforeFiles, DOWNLOAD_TIMEOUT_MS);
//         console.log('Download completed (final name):', finalName);
//       } catch (err) {
//         console.warn('Timed out or error while waiting for completed download:', err.message);
//         continue;
//       }

//       // If temp exists rename to final, then move to unique name (Chrome-style)
//       const finalPath = path.join(downloadDir, finalName);
//       const possibleTemp = path.join(downloadDir, finalName + '.crdownload');
//       const possibleTempMisspell = path.join(downloadDir, finalName + '.crddonload');

//       try {
//         if (!fs.existsSync(finalPath)) {
//           if (fs.existsSync(possibleTemp)) {
//             fs.renameSync(possibleTemp, finalPath);
//             console.log('Renamed temp to final:', path.basename(finalPath));
//           } else if (fs.existsSync(possibleTempMisspell)) {
//             fs.renameSync(possibleTempMisspell, finalPath);
//             console.log('Renamed misspelled temp to final:', path.basename(finalPath));
//           } else {
//             console.warn('Expected final file not found, skipping rename.');
//             continue;
//           }
//         }

//         const finalBaseName = path.basename(finalPath);
//         const savedName = moveToUniqueName(downloadDir, finalBaseName);
//         console.log("Saved as:", savedName);

//       } catch (err) {
//         console.warn('Error handling final file rename/move:', err);
//       }

//       // close any open menu/dialog
//       try { await page.keyboard.press('Escape'); } catch (e) { /* ignore */ }
//       await sleep(700);
//     }

//     console.log('\nAll rows processed — check folder:', downloadDir);
//     await browser.close();
//     process.exit(0);

//   } catch (err) {
//     console.error('Failed:', err);
//     process.exit(1);
//   }
// })();











// finshed version
// // index-zip.js
// // Node 18+ recommended (global fetch).
// const puppeteer = require('puppeteer-core');
// const fs = require('fs');
// const path = require('path');

// (async () => {
//   try {
//     // --- ====== CONFIG ====== ---
//     const REMOTE_DEBUGGING_JSON = 'http://127.0.0.1:9222/json/version';
//     const url = 'https://acc.autodesk.com/build/files/projects/c4d9bcf4-c2db-46a8-8244-406b56b6d8b6?folderUrn=urn%3Aadsk.wipprod%3Afs.folder%3Aco.cGRZ8FGqRnGs26mdK5dSlw&viewModel=detail&moduleId=folders';
//     const targetName = "Structural";
//     const downloadPath = "C:/Users/Herman/Projects/2025/Nov/AutoDesk_Multi_Download/"
    
//     // Use forward slashes to avoid escape problems on Windows
//     const downloadDir = path.resolve(`${downloadPath}${targetName}`);
//     const DOWNLOAD_TIMEOUT_MS = 60000; // how long to wait for each download (ms)
//     // --- ====== /CONFIG ======

//     // Ensure download dir exists
//     if (!fs.existsSync(downloadDir)) {
//       fs.mkdirSync(downloadDir, { recursive: true });
//       console.log("Created folder:", downloadDir);
//     } else {
//       console.log("Folder exists:", downloadDir);
//     }

//     // Fetch remote debugging info and connect Puppeteer to existing Chrome
//     const resp = await fetch(REMOTE_DEBUGGING_JSON);
//     const json = await resp.json();
//     const ws = json.webSocketDebuggerUrl;
//     const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
//     const page = await browser.newPage();

//     // Tell Chrome (CDP) to download into our folder
//     const client = await page.target().createCDPSession();
//     await client.send('Page.setDownloadBehavior', {
//       behavior: 'allow',
//       downloadPath: downloadDir,
//     });
//     console.log('Set Chrome download folder to:', downloadDir);

//     // Go to page
//     await page.goto(url, { timeout: 0, waitUntil: 'domcontentloaded' });

//     // Helper utilities
//     function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


//     function moveToUniqueName(dir, filename) {
//     const ext = path.extname(filename);           
//     const base = path.basename(filename, ext);   

//     let targetPath = path.join(dir, filename);

//     if (!fs.existsSync(targetPath)) {
//       // No rename needed
//       return filename;
//     }

//     // If filename already exists → add (1), (2), (3)...
//     let counter = 0;
//     while (true) {
//       const newName =counter === 0 ?  `${base} ${ext}` : `${base} (${counter})${ext}`;
//       const newPath = path.join(dir, newName);

//       if (!fs.existsSync(newPath)) {
//         // Rename ORIGINAL downloaded file → duplicate safe name
//         fs.renameSync(targetPath, newPath);
//         return newName;
//       }

//       counter++;
//       }
//     }


//     /**
//      * Wait for a new completed download in `dir` compared to `beforeFiles`.
//      * Handles Chrome temp files (.crdownload or common misspellings).
//      * Returns the final filename (without .crdownload) when complete.
//      */
//     async function waitForCompletedDownload(dir, beforeFiles, timeoutMs = 60000) {
//       const start = Date.now();
//       const TEMP_SUFFIXES = ['.crdownload', '.crddonload']; // include common misspelling

//       // helper: list added files
//       function listAdded() {
//         const all = fs.readdirSync(dir);
//         return all.filter(f => !beforeFiles.includes(f));
//       }

//       while (true) {
//         if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for new download');

//         const added = listAdded();
//         if (added.length === 0) {
//           await sleep(300);
//           continue;
//         }

//         // choose most recently modified added file
//         const candidates = added.map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }));
//         candidates.sort((a, b) => b.m - a.m);
//         let file = candidates[0].f;
//         const fullPath = path.join(dir, file);

//         // If file does not have a temp suffix, return it (completed)
//         const hasTemp = TEMP_SUFFIXES.some(suf => file.endsWith(suf));
//         if (!hasTemp) {
//           // double-check file size stability (small precaution)
//           const size1 = fs.statSync(fullPath).size;
//           await sleep(300);
//           const size2 = fs.statSync(fullPath).size;
//           if (size1 === size2) return file;
//           // else continue waiting
//           continue;
//         }

//         // file has temp suffix like .crdownload -> wait until Chrome finalizes
//         const matched = TEMP_SUFFIXES.find(suf => file.endsWith(suf));
//         const finalName = file.slice(0, -matched.length);
//         const finalPath = path.join(dir, finalName);

//         // Wait for either finalPath to appear OR temp file to stabilize in size
//         const innerStart = Date.now();
//         while (true) {
//           if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for download to finish');

//           // If final file exists — return it
//           if (fs.existsSync(finalPath)) {
//             // ensure final file size stable
//             const s1 = fs.statSync(finalPath).size;
//             await sleep(300);
//             const s2 = fs.statSync(finalPath).size;
//             if (s1 === s2) return finalName;
//             continue;
//           }

//           // If temp exists and is stable for short interval, assume finished
//           if (fs.existsSync(fullPath)) {
//             const s1 = fs.statSync(fullPath).size;
//             await sleep(800);
//             if (!fs.existsSync(fullPath)) {
//               // temp vanished; loop to check finalPath existence
//               continue;
//             }
//             const s2 = fs.statSync(fullPath).size;
//             if (s1 === s2) {
//               // If final doesn't exist yet but temp is stable, return finalName and caller will rename temp
//               return finalName;
//             }
//           }

//           // small backoff
//           if (Date.now() - innerStart > timeoutMs) throw new Error('Timed out waiting for temp download to stabilize');
//           await sleep(300);
//         }
//       }
//     }

//     // function to reveal version / row actions (your logic)
//     async function runProcess() {
//       await page.waitForSelector('.styles__Wrapper-hUZiO .MatrixTable__table-frozen-left .MatrixTable__body .MatrixTable__row', { timeout: 15000 });
//       await page.evaluate((targetName) => {
//         const nameSpans = Array.from(document.querySelectorAll('.DocumentNamestyles__CellHighlight-dJLtHK span'));
//         const match = nameSpans.find(s => s.textContent && s.textContent.trim().toLowerCase().includes(targetName.toLowerCase()));
//         if (!match) return;
//         const leftRow = match.closest('.MatrixTable__row');
//         if (!leftRow) return;
//         const topValue = leftRow.style.top;
//         const mainRows = Array.from(document.querySelectorAll('.MatrixTable__table-main .MatrixTable__row'));
//         const mainRow = mainRows.find(r => r.style.top === topValue);
//         if (!mainRow) return;
//         const versionBtn = mainRow.querySelector('.FileVersionIndicator__StyledClickableVersionIndicator-sc-ko8svq-1');
//         if (versionBtn) versionBtn.click();
//       }, targetName);
//     }

//     // selectors
//     const rowButtonSelector = '.styles__StyledTable-bpoqbj .MatrixTable__table-frozen-right .MatrixTable__body .MatrixTable__row button';
//     const modalButtonSelector = 'li[data-testid="menu-item-downloadSourceFile"], li[data-testid="menu-item-download"]';
//     const downloadBtnSelector = '.styles__FooterWrapper-gZifIR button, button[data-testid="downloadButton"], button[aria-label="Download"]';

//     // Wait for initial row buttons
//     await runProcess();
//     await page.waitForSelector(rowButtonSelector, { visible: true, timeout: 15000 });

//     // get initial buttons count (we'll re-query each loop)
//     let rowButtons = await page.$$(rowButtonSelector);
//     const initialRowCount = rowButtons.length;
//     if (initialRowCount === 0) {
//       console.log('No row action buttons found - aborting');
//       await browser.disconnect();
//       return;
//     }
//     console.log(`Found ${initialRowCount} row action button(s).`);

//     // iterate rows
//     for (let i = 0; i < initialRowCount; i++) {
//       console.log(`\n--- Processing row ${i + 1} / ${initialRowCount} ---`);
//       // re-run reveal (UI may have changed)
//       await runProcess();

//       // re-query action buttons
//       await page.waitForSelector(rowButtonSelector, { visible: true, timeout: 10000 });
//       const currentButtons = await page.$$(rowButtonSelector);

//       if (!currentButtons[i]) {
//         console.warn(`Row button at index ${i} not found (skipping).`);
//         continue;
//       }

//       // snapshot files before download starts
//       const beforeFiles = fs.readdirSync(downloadDir);

//       // Click the action button
//       await currentButtons[i].click();

//       // Wait for the menu download item to appear and click it (tolerant)
//       try {
//         await page.waitForSelector(modalButtonSelector, { visible: true, timeout: 8000 });
//         const modalButton = await page.$(modalButtonSelector);
//         if (modalButton) {
//           await modalButton.click();
//         } else {
//           // fallback: try to click any menu item containing "download"
//           await page.evaluate(() => {
//             const items = Array.from(document.querySelectorAll('li[role="menuitem"], li'));
//             const found = items.find(n => n.innerText && n.innerText.toLowerCase().includes('download'));
//             if (found) found.click();
//           });
//         }
//       } catch (err) {
//         console.warn('Download menu item not found or click failed, continuing to try final download button.', err.message);
//       }

//       // Try to click the final download button in footer/modal (if any)
//       try {
//         await page.waitForSelector(downloadBtnSelector, { visible: true, timeout: 6000 });
//         await page.click(downloadBtnSelector);
//         console.log('Clicked final download button (if present).');
//       } catch (err) {
//         console.log('No explicit final download button visible; download may already have started by menu click.');
//       }

//       // Wait for the completed download (no .crdownload)
//       let finalName;
//       try {
//         finalName = await waitForCompletedDownload(downloadDir, beforeFiles, DOWNLOAD_TIMEOUT_MS);
//         console.log('Download completed (final name):', finalName);
//       } catch (err) {
//         console.warn('Timed out or error while waiting for completed download:', err.message);
//         // decide to continue or retry; we'll continue to the next row
//         continue;
//       }

//       // If Chrome left a .crdownload file (temp) and final file doesn't exist yet,
//       // rename the temp to the final name before moving (waitForCompletedDownload may have indicated finalName).
//       const finalPath = path.join(downloadDir, finalName);
//       const possibleTemp = path.join(downloadDir, finalName + '.crdownload');
//       const possibleTempMisspell = path.join(downloadDir, finalName + '.crddonload'); // just in case
//       try {
//         if (!fs.existsSync(finalPath)) {
//           if (fs.existsSync(possibleTemp)) {
//             // rename temp to final (safe because we waited for stability)
//             fs.renameSync(possibleTemp, finalPath);
//             console.log('Renamed temp to final:', path.basename(finalPath));
//           } else if (fs.existsSync(possibleTempMisspell)) {
//             fs.renameSync(possibleTempMisspell, finalPath);
//             console.log('Renamed misspelled temp to final:', path.basename(finalPath));
//           } else {
//             // final not found and no temp; skip
//             console.warn('Expected final file not found, skipping rename.');
//             continue;
//           }
//         }

//         // Now move to unique name
       
//        const finalBaseName = path.basename(finalPath);
//        const savedName = moveToUniqueName(downloadDir, finalBaseName);
//        console.log("Saved as:", savedName);

//       } catch (err) {
//         console.warn('Error handling final file rename/move:', err);
//       }

//       // close any open menu/dialog
//       try { await page.keyboard.press('Escape'); } catch (e) { /* ignore */ }
//       await sleep(700);
//     }

//     console.log('\nAll rows processed — check folder:', downloadDir);
//     await browser.disconnect();
//     process.exit(0);

//   } catch (err) {
//     console.error('Failed:', err);
//     process.exit(1);
//   }
// })();









// // index-zip.js
// // Node 18+ recommended (global fetch).
// const puppeteer = require('puppeteer-core');
// const fs = require('fs');
// const path = require('path');

// (async () => {
//   try {
//     // --- ====== CONFIG ====== ---
//     const REMOTE_DEBUGGING_JSON = 'http://127.0.0.1:9222/json/version';
//     const url = 'https://acc.autodesk.com/build/files/projects/c4d9bcf4-c2db-46a8-8244-406b56b6d8b6?folderUrn=urn%3Aadsk.wipprod%3Afs.folder%3Aco.cGRZ8FGqRnGs26mdK5dSlw&viewModel=detail&moduleId=folders';
//     const targetName = "RSW9-GAYL-ZZ-ALL-M3-ELC";

//     // Use forward slashes to avoid escape problems on Windows
//     const downloadDir = path.resolve(`C:/Users/Herman/Projects/2025/Nov/AutoDesk_Multi_Download/${targetName}`);
//     const DOWNLOAD_TIMEOUT_MS = 30000; // how long to wait for each download
//     // --- ====== /CONFIG ====== ---

//     // Ensure download dir exists
//     if (!fs.existsSync(downloadDir)) {
//       fs.mkdirSync(downloadDir, { recursive: true });
//       console.log("Created folder:", downloadDir);
//     } else {
//       console.log("Folder exists:", downloadDir);
//     }

//     // Fetch remote debugging info and connect Puppeteer to existing Chrome
//     const resp = await fetch(REMOTE_DEBUGGING_JSON);
//     const json = await resp.json();
//     const ws = json.webSocketDebuggerUrl;
//     const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
//     const page = await browser.newPage();

//     // Tell Chrome (CDP) to download into our folder
//     const client = await page.target().createCDPSession();
//     await client.send('Page.setDownloadBehavior', {
//       behavior: 'allow',
//       downloadPath: downloadDir,
//     });
//     console.log('Set Chrome download folder to:', downloadDir);

//     // Go to page
//     await page.goto(url, { timeout: 0, waitUntil: 'domcontentloaded' });

//     // Helper functions
//     function waitForNewFile(dir, beforeFiles, timeoutMs = 30000) {
//       const start = Date.now();
//       return new Promise((resolve, reject) => {
//         (function poll() {
//           const nowFiles = fs.readdirSync(dir);
//           const added = nowFiles.filter(f => !beforeFiles.includes(f));
//           if (added.length > 0) {
//             // pick the most recently modified new file
//             const candidates = added.map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }));
//             candidates.sort((a, b) => b.m - a.m);
//             return resolve(candidates[0].f);
//           }
//           if (Date.now() - start > timeoutMs) return reject(new Error('Timed out waiting for downloaded file'));
//           setTimeout(poll, 400);
//         })();
//       });
//     }

//     function sanitizeForFilename(s) {
//       return s.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 120);
//     }

//     function moveToUniqueName(dir, filename, prefix = '') {
//       const original = path.join(dir, filename);
//       const ext = path.extname(filename) || '';
//       const base = path.basename(filename, ext) || 'file';
//       const now = new Date();
//       const ts = now.toISOString().replace(/[:.]/g, '-'); // safe timestamp
//       const p = prefix ? sanitizeForFilename(prefix) + '_' : '';
//       const newName = `${p}${sanitizeForFilename(base)}_${ts}${ext}`;
//       const dest = path.join(dir, newName);
//       fs.renameSync(original, dest);
//       return newName;
//     }

//     // function to reveal version / row actions (your logic)
//     async function runProcess() {
//       await page.waitForSelector('.styles__Wrapper-hUZiO .MatrixTable__table-frozen-left .MatrixTable__body .MatrixTable__row', { timeout: 15000 });
//       await page.evaluate((targetName) => {
//         const nameSpans = Array.from(document.querySelectorAll('.DocumentNamestyles__CellHighlight-dJLtHK span'));
//         const match = nameSpans.find(s => s.textContent && s.textContent.trim().toLowerCase().includes(targetName.toLowerCase()));
//         if (!match) return;
//         const leftRow = match.closest('.MatrixTable__row');
//         if (!leftRow) return;
//         const topValue = leftRow.style.top;
//         const mainRows = Array.from(document.querySelectorAll('.MatrixTable__table-main .MatrixTable__row'));
//         const mainRow = mainRows.find(r => r.style.top === topValue);
//         if (!mainRow) return;
//         const versionBtn = mainRow.querySelector('.FileVersionIndicator__StyledClickableVersionIndicator-sc-ko8svq-1');
//         if (versionBtn) versionBtn.click();
//       }, targetName);
//     }

//     // selectors
//     const rowButtonSelector = '.styles__StyledTable-bpoqbj .MatrixTable__table-frozen-right .MatrixTable__body .MatrixTable__row button';
//     const modalButtonSelector = 'li[data-testid="menu-item-downloadSourceFile"], li[data-testid="menu-item-download"]';
//     const downloadBtnSelector = '.styles__FooterWrapper-gZifIR button, button[data-testid="downloadButton"], button[aria-label="Download"]';

//     // Wait for initial row buttons
//     await runProcess();
//     await page.waitForSelector(rowButtonSelector, { visible: true, timeout: 15000 });

//     // get initial buttons count (we'll re-query each loop)
//     let rowButtons = await page.$$(rowButtonSelector);
//     const initialRowCount = rowButtons.length;
//     if (initialRowCount === 0) {
//       console.log('No row action buttons found - aborting');
//       await browser.disconnect();
//       return;
//     }
//     console.log(`Found ${initialRowCount} row action button(s).`);

//     // iterate rows
//     for (let i = 0; i < initialRowCount; i++) {
//       console.log(`\n--- Processing row ${i + 1} / ${initialRowCount} ---`);
//       // re-run reveal (UI may have changed)
//       await runProcess();

//       // re-query action buttons
//       await page.waitForSelector(rowButtonSelector, { visible: true, timeout: 10000 });
//       const currentButtons = await page.$$(rowButtonSelector);

//       if (!currentButtons[i]) {
//         console.warn(`Row button at index ${i} not found (skipping).`);
//         continue;
//       }

//       // snapshot files before download starts
//       const beforeFiles = fs.readdirSync(downloadDir);

//       // Click the action button
//       await currentButtons[i].click();

//       // Wait for the menu download item to appear and click it (tolerant)
//       try {
//         await page.waitForSelector(modalButtonSelector, { visible: true, timeout: 8000 });
//         const modalButton = await page.$(modalButtonSelector);
//         if (modalButton) {
//           await modalButton.click();
//         } else {
//           // fallback: try to click any menu item containing "download"
//           await page.evaluate(() => {
//             const items = Array.from(document.querySelectorAll('li[role="menuitem"], li'));
//             const found = items.find(n => n.innerText && n.innerText.toLowerCase().includes('download'));
//             if (found) found.click();
//           });
//         }
//       } catch (err) {
//         console.warn('Download menu item not found or click failed, continuing to try final download button.', err.message);
//       }

//       // Try to click the final download button in footer/modal (if any)
//       try {
//         await page.waitForSelector(downloadBtnSelector, { visible: true, timeout: 6000 });
//         await page.click(downloadBtnSelector);
//         console.log('Clicked final download button (if present).');
//       } catch (err) {
//         console.log('No explicit final download button visible; download may already have started by menu click.');
//       }

//       // Wait for new file to appear in the download dir
//       let chromeFile;
//       try {
//         chromeFile = await waitForNewFile(downloadDir, beforeFiles, DOWNLOAD_TIMEOUT_MS);
//         console.log('Detected new file written by Chrome:', chromeFile);
//       } catch (err) {
//         console.warn('Timed out waiting for new file in download directory:', err.message);
//         // attempt a small extra wait and continue if nothing
//         await new Promise(r => setTimeout(r, 1000));
//         continue;
//       }

//       // Move/rename to unique name immediately
//       try {
//         const newName = moveToUniqueName(downloadDir, chromeFile, targetName);
//         console.log('Renamed to unique file:', newName);
//       } catch (err) {
//         console.warn('Failed to rename/move downloaded file:', err);
//       }

//       // close any open menu/dialog
//       try { await page.keyboard.press('Escape'); } catch (e) { /* ignore */ }
//       await new Promise(r => setTimeout(r, 700));
//     }

//     console.log('\nAll rows processed — check folder:', downloadDir);
//     await browser.disconnect();
//     process.exit(0);

//   } catch (err) {
//     console.error('Failed:', err);
//     process.exit(1);
//   }
// })();








// // index-zip.js
// const puppeteer = require('puppeteer-core');
// const fs = require('fs');
// const path = require('path');

// (async () => {
//   try {
//     const resp = await fetch('http://127.0.0.1:9222/json/version');
//     const url = 'https://acc.autodesk.com/build/files/projects/c4d9bcf4-c2db-46a8-8244-406b56b6d8b6?folderUrn=urn%3Aadsk.wipprod%3Afs.folder%3Aco.cGRZ8FGqRnGs26mdK5dSlw&viewModel=detail&moduleId=folders';
//     const targetName = "RSW9-GAYL-ZZ-ALL-M3-ELC";
//     const downloadDir = path.resolve(`C:\\Users\\Herman\\Projects\\2025\\Nov\\AutoDesk_Multi_Download\\${targetName}`);


//       if (!fs.existsSync(downloadDir)) {
//         fs.mkdirSync(downloadDir, { recursive: true });
//         console.log("Created folder:", downloadDir);
//       } else {
//         console.log("Folder exists:", downloadDir);
//       }

//     const json = await resp.json();
//     const ws = json.webSocketDebuggerUrl;
//     const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
//     const page = await browser.newPage();
//     await page.goto(url, { timeout: 0, waitUntil: 'domcontentloaded' });
//     const client = await page.target().createCDPSession();
//     await client.send('Page.setDownloadBehavior', {
//       behavior: 'allow',
//       downloadPath: downloadDir
//     });
//     // Helper: run your function that finds/clicks version to reveal row actions
//     async function runProcess() {
//       await page.waitForSelector('.styles__Wrapper-hUZiO .MatrixTable__table-frozen-left .MatrixTable__body .MatrixTable__row');
//       // same logic you used to click version button
//       await page.evaluate((targetName) => {
//         const nameSpans = [...document.querySelectorAll('.DocumentNamestyles__CellHighlight-dJLtHK span')];
//         const match = nameSpans.find(s => s.textContent.trim().toLowerCase().includes(targetName.toLowerCase()));
//         if (!match) return;
//         const leftRow = match.closest('.MatrixTable__row');
//         if (!leftRow) return;
//         const topValue = leftRow.style.top;
//         const mainRows = [...document.querySelectorAll('.MatrixTable__table-main .MatrixTable__row')];
//         const mainRow = mainRows.find(r => r.style.top === topValue);
//         if (!mainRow) return;
//         const versionBtn = mainRow.querySelector('.FileVersionIndicator__StyledClickableVersionIndicator-sc-ko8svq-1');
//         if (versionBtn) versionBtn.click();
//       }, targetName);
//     }

//     await runProcess();

//     // Selector for the row action buttons (same as yours)
//     const rowButtonSelector = '.styles__StyledTable-bpoqbj .MatrixTable__table-frozen-right .MatrixTable__body .MatrixTable__row button';
//     await page.waitForSelector(rowButtonSelector, { visible: true });
//     const rowButtons = await page.$$(rowButtonSelector);

//     if (rowButtons.length === 0) {
//       console.log('No row action buttons found - aborting');
//       await browser.disconnect();
//       return;
//     }

//     // Function to open row menu and extract the download href + filename from modal
//     async function extractDownloadInfoForRow(rowIndex) {
//       // Re-query buttons (DOM may have changed between iterations)
//       await page.waitForSelector(rowButtonSelector, { visible: true });
//       const currentButtons = await page.$$(rowButtonSelector);
//       if (!currentButtons[rowIndex]) return null;

//       // Click the action button
//       await currentButtons[rowIndex].click();

//       // Wait for the menu options to appear
//       const modalButtonSelector = 'li[data-testid="menu-item-downloadSourceFile"]';
//       await page.waitForSelector(modalButtonSelector, { visible: true });
//       const modalButtons = await page.$(modalButtonSelector);
//       await modalButtons.click();

//       // Now wait for the download modal/footer to appear
//       const downloadBtnSelector = '.styles__FooterWrapper-gZifIR button';
//       await page.waitForSelector(downloadBtnSelector, { visible: true });
//       const downloadBtn = await page.$(downloadBtnSelector);
//       await downloadBtn.click();      
//     }

//     // Iterate over rows to collect all file links
//     const rowCount = rowButtons.length;
//     for (let i = 0; i < rowCount; i++) {
//       await runProcess();
//       await extractDownloadInfoForRow(i);
//     }

    
//     await browser.disconnect();

//   } catch (err) {
//     console.error('Failed:', err);
//     process.exit(1);
//   }
// })();








// today 27-11-25
// // index.js
// const puppeteer = require('puppeteer-core');

// (async () => {
//   try {
//     const resp = await fetch('http://127.0.0.1:9222/json/version');
//     const url = 'https://acc.autodesk.com/build/files/projects/c4d9bcf4-c2db-46a8-8244-406b56b6d8b6?folderUrn=urn%3Aadsk.wipprod%3Afs.folder%3Aco.cGRZ8FGqRnGs26mdK5dSlw&viewModel=detail&moduleId=folders';
//     const json = await resp.json();
//     const ws = json.webSocketDebuggerUrl;
//     const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
//     const page = await browser.newPage();
//     await page.goto(url, { timeout: 0, waitUntil: 'domcontentloaded' });

//     // filename
//   const targetName = "RSW9-GAYL-ZZ-ALL-M3-ELC";

//     async function runProcess(){
//         // file name list
//       await page.waitForSelector('.styles__Wrapper-hUZiO .MatrixTable__table-frozen-left .MatrixTable__body .MatrixTable__row');
//       const fileNameList = await page.evaluate(() => {
//           const els = [...document.querySelectorAll('.styles__Wrapper-hUZiO .MatrixTable__table-frozen-left .MatrixTable__body .MatrixTable__row')];
//           return els.map(e => e.textContent.trim());
//       });

//       // version btn list
//       await page.waitForSelector('.styles__Wrapper-hUZiO  .MatrixTable__row .VersionIndicators__StyledBaseIndicator-sc-1v5r0en-0');
//       const versionBtnList = await page.evaluate(() => {
//           const els = [...document.querySelectorAll('.styles__Wrapper-hUZiO  .MatrixTable__row .VersionIndicators__StyledBaseIndicator-sc-1v5r0en-0')];
//           return els.map(e => e.textContent.trim());
//       });

//       console.log("SPAN TEXT LIST:", fileNameList);
//       console.log("SPAN TEXT LIST:", versionBtnList);

//       await page.evaluate((targetName) => {
//           // 1) Find all file name spans in left frozen column
//           const nameSpans = [...document.querySelectorAll(
//               '.DocumentNamestyles__CellHighlight-dJLtHK span'
//           )];
//           // 2) Find the span that matches the given name (partial match allowed)
//           const match = nameSpans.find(s =>
//               s.textContent.trim().toLowerCase().includes(targetName.toLowerCase())
//           );
//           if (!match) {
//               console.log("Name not found:", targetName);
//               return;
//           }
//           // 3) Get the row (MatrixTable__row) for that filename
//           const leftRow = match.closest('.MatrixTable__row');
//           if (!leftRow) return;

//           // This row has a TOP style like "top: 48px;"
//           const topValue = leftRow.style.top;

//           // 4) Find the row in main table with same TOP (same row)
//           const mainRows = [...document.querySelectorAll(
//               '.MatrixTable__table-main .MatrixTable__row'
//           )];

//           const mainRow = mainRows.find(r => r.style.top === topValue);
//           if (!mainRow) return;

//           // 5) Find version button in that same row
//           const versionBtn = mainRow.querySelector('.FileVersionIndicator__StyledClickableVersionIndicator-sc-ko8svq-1');
//           if (versionBtn) {
//               versionBtn.click();
//               console.log("Clicked version button for:", targetName);
//           }
//       }, targetName);}

//       await runProcess();

//       const rowButtonSelector = '.styles__StyledTable-bpoqbj .MatrixTable__table-frozen-right .MatrixTable__body .MatrixTable__row button';
//       // wait for row buttons to render
//       await page.waitForSelector(rowButtonSelector, { visible: true });
//       // get element handles for row action buttons
//       const rowButtons = await page.$$(rowButtonSelector);
      
//       if (rowButtons.length > 0) {
//         // click first row action button
//         await rowButtons[0].click();
//         // wait for modal / menu to appear (use visible: true to ensure it's shown)
//         const modalButtonSelector = 'div[data-placement="bottom"] li';
//         await page.waitForSelector(modalButtonSelector, { visible: true });
//         // find modal buttons and click the second one (index 1) if exists
//         const modalButtons = await page.$$(modalButtonSelector);
//         if (modalButtons.length > 1) {
//           await modalButtons[1].click();
//           console.log('Clicked modal button #2');
//         const downloadBtnSelector = '.styles__FooterWrapper-gZifIR button'
//         await page.waitForSelector(downloadBtnSelector, { visible: true });
//         const downloadbtn = await page.$(downloadBtnSelector);
//         await downloadbtn.click();
//         } else {
//           console.log('Modal buttons found but less than 2:', modalButtons.length);
//         }
//       } else {
//         console.log('No row action buttons found');
//       }

//       let methodReRun = rowButtons.length;

//       for(let i = 1 ;i < methodReRun ;i++){
//             await runProcess();
//             const rowButtonSelector = '.styles__StyledTable-bpoqbj .MatrixTable__table-frozen-right .MatrixTable__body .MatrixTable__row button';
//             await page.waitForSelector(rowButtonSelector, { visible: true });
//             const rowButtons = await page.$$(rowButtonSelector);
//             await rowButtons[i].click();
//             const modalButtonSelector = 'div[data-placement="bottom"] li';
//             await page.waitForSelector(modalButtonSelector, { visible: true });
//             const modalButtons = await page.$$(modalButtonSelector);
//             if (modalButtons.length > 1) {
//             await modalButtons[1].click();
//             console.log('Clicked modal button #2');
//             const downloadBtnSelector = '.styles__FooterWrapper-gZifIR button'
//             await page.waitForSelector(downloadBtnSelector, { visible: true });
//             const downloadbtn = await page.$(downloadBtnSelector);
//             await downloadbtn.click();
//         }
//       }

//     await browser.disconnect();

//   } catch (err) {
//     console.error('Failed:', err);
//     process.exit(1);
//   }
// })();













// yesterday 26-11-25
// // index.js
// const puppeteer = require('puppeteer-core');

// (async () => {
//   try {
//     const resp = await fetch('http://127.0.0.1:9222/json/version');
//     const url = 'https://acc.autodesk.com/build/files/projects/c4d9bcf4-c2db-46a8-8244-406b56b6d8b6?folderUrn=urn%3Aadsk.wipprod%3Afs.folder%3Aco.cGRZ8FGqRnGs26mdK5dSlw&viewModel=detail&moduleId=folders';
//     const json = await resp.json();
//     const ws = json.webSocketDebuggerUrl;
//     const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
//     const page = await browser.newPage();
//     await page.goto(url, { timeout: 0, waitUntil: 'domcontentloaded' });

//     // filename
//   const targetName = "RSW9-GAYL-ZZ-ALL-M3-ELC";

//     async function runProcess(){
//         // file name list
//       await page.waitForSelector('.styles__Wrapper-hUZiO .MatrixTable__table-frozen-left .MatrixTable__body .MatrixTable__row');
//       const fileNameList = await page.evaluate(() => {
//           const els = [...document.querySelectorAll('.styles__Wrapper-hUZiO .MatrixTable__table-frozen-left .MatrixTable__body .MatrixTable__row')];
//           return els.map(e => e.textContent.trim());
//       });

//       // version btn list
//       await page.waitForSelector('.styles__Wrapper-hUZiO  .MatrixTable__row .VersionIndicators__StyledBaseIndicator-sc-1v5r0en-0');
//       const versionBtnList = await page.evaluate(() => {
//           const els = [...document.querySelectorAll('.styles__Wrapper-hUZiO  .MatrixTable__row .VersionIndicators__StyledBaseIndicator-sc-1v5r0en-0')];
//           return els.map(e => e.textContent.trim());
//       });

//       console.log("SPAN TEXT LIST:", fileNameList);
//       console.log("SPAN TEXT LIST:", versionBtnList);

//       await page.evaluate((targetName) => {
//           // 1) Find all file name spans in left frozen column
//           const nameSpans = [...document.querySelectorAll(
//               '.DocumentNamestyles__CellHighlight-dJLtHK span'
//           )];
//           // 2) Find the span that matches the given name (partial match allowed)
//           const match = nameSpans.find(s =>
//               s.textContent.trim().toLowerCase().includes(targetName.toLowerCase())
//           );
//           if (!match) {
//               console.log("Name not found:", targetName);
//               return;
//           }
//           // 3) Get the row (MatrixTable__row) for that filename
//           const leftRow = match.closest('.MatrixTable__row');
//           if (!leftRow) return;

//           // This row has a TOP style like "top: 48px;"
//           const topValue = leftRow.style.top;

//           // 4) Find the row in main table with same TOP (same row)
//           const mainRows = [...document.querySelectorAll(
//               '.MatrixTable__table-main .MatrixTable__row'
//           )];

//           const mainRow = mainRows.find(r => r.style.top === topValue);
//           if (!mainRow) return;

//           // 5) Find version button in that same row
//           const versionBtn = mainRow.querySelector('.FileVersionIndicator__StyledClickableVersionIndicator-sc-ko8svq-1');
//           if (versionBtn) {
//               versionBtn.click();
//               console.log("Clicked version button for:", targetName);
//           }
//       }, targetName);}

//       await runProcess();

//       const rowButtonSelector = '.styles__StyledTable-bpoqbj .MatrixTable__table-frozen-right .MatrixTable__body .MatrixTable__row button';
//       // wait for row buttons to render
//       await page.waitForSelector(rowButtonSelector, { visible: true });
//       // get element handles for row action buttons
//       const rowButtons = await page.$$(rowButtonSelector);
      
//       if (rowButtons.length > 0) {
//         // click first row action button
//         await rowButtons[0].click();
//         // wait for modal / menu to appear (use visible: true to ensure it's shown)
//         const modalButtonSelector = '.sc-eZkCL .sc-hIUJlX';
//         await page.waitForSelector(modalButtonSelector, { visible: true });
//         // find modal buttons and click the second one (index 1) if exists
//         const modalButtons = await page.$$(modalButtonSelector);
//         if (modalButtons.length > 1) {
//           await modalButtons[1].click();
//           console.log('Clicked modal button #2');
//         const downloadBtnSelector = '.styles__FooterWrapper-gZifIR button'
//         await page.waitForSelector(downloadBtnSelector, { visible: true });
//         const downloadbtn = await page.$(downloadBtnSelector);
//         await downloadbtn.click();
//         } else {
//           console.log('Modal buttons found but less than 2:', modalButtons.length);
//         }
//       } else {
//         console.log('No row action buttons found');
//       }

//       let methodReRun = rowButtons.length;

//       for(let i = 1 ;i < methodReRun ;i++){
//             await runProcess();
//             const rowButtonSelector = '.styles__StyledTable-bpoqbj .MatrixTable__table-frozen-right .MatrixTable__body .MatrixTable__row button';
//             await page.waitForSelector(rowButtonSelector, { visible: true });
//             const rowButtons = await page.$$(rowButtonSelector);
//             await rowButtons[i].click();
//             const modalButtonSelector = '.sc-eZkCL .sc-hIUJlX';
//             await page.waitForSelector(modalButtonSelector, { visible: true });
//             const modalButtons = await page.$$(modalButtonSelector);
//             if (modalButtons.length > 1) {
//             await modalButtons[1].click();
//             console.log('Clicked modal button #2');
//             const downloadBtnSelector = '.styles__FooterWrapper-gZifIR button'
//             await page.waitForSelector(downloadBtnSelector, { visible: true });
//             const downloadbtn = await page.$(downloadBtnSelector);
//             await downloadbtn.click();
//         }
//       }

//     await browser.disconnect();

//   } catch (err) {
//     console.error('Failed:', err);
//     process.exit(1);
//   }
// })();

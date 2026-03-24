const net = require("net");
const { exec } = require("child_process");

function isPortInUse(port) {
  return new Promise(resolve => {
    const tester = net
      .createServer()
      .once("error", () => resolve(true))   // port in use
      .once("listening", () => tester.close(() => resolve(false))) // port free
      .listen(port);
  });
}

async function startChromeIfNotRunning() {
  const chromePath = `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"`;
  const userData = `"C:\\Temp\\Chrome-Automation-Profile"`;
  const portInUse = await isPortInUse(9222);
  if (portInUse) {
    console.log("Chrome already running on port 9222. Not starting a new one.");
    return;
  }
  console.log("🚀 Starting Chrome for automation...");
  const cmd = `${chromePath} --remote-debugging-port=9222 --user-data-dir=${userData} --no-first-run`;
  exec(cmd, (err) => {
    if (err) console.log("Chrome start error:", err.message);
  });
  // wait a moment so Chrome can start
  await new Promise(r => setTimeout(r, 2000));
}


module.exports = {startChromeIfNotRunning}


// puppeteer export exe app notes:
{/*
  // add this line in pakage
  "build": {
    "appId": "com.example.myapp",
    "win": { "target": "nsis" }
  }
  // then, past this command in the terminal
  npx pkg index.js --targets node18-win-x64 --output app.exe

*/}

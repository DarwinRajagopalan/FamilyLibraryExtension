#!/usr/bin/env node
const puppeteer = require("puppeteer");
const { setTimeout } = require("node:timers/promises");
const xlsx = require("xlsx");
const fs = require("fs");
const readline = require("readline");

// ✅ Email format validation function
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ✅ Step 1: Create a function to ask input in terminal
function askQuestion(query, hidden = false, validate = null) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const prompt = () => {
      if (hidden) {
        const stdin = process.stdin;
        const onDataHandler = (char) => {
          char = char + '';
          switch (char) {
            case '\n':
            case '\r':
            case '\u0004':
              stdin.pause();
              break;
            default:
              process.stdout.clearLine(0);
              readline.cursorTo(process.stdout, 0);
              process.stdout.write(query + Array(rl.line.length + 1).join('*'));
              break;
          }
        };

        stdin.on("data", onDataHandler);

        rl.question(query, (answer) => {
          stdin.removeListener("data", onDataHandler);
          if (validate && !validate(answer)) {
            console.log("\n❌ Invalid input. Please try again.");
            rl.close();
            resolve(askQuestion(query, hidden, validate)); // retry
          } else {
            rl.close();
            resolve(answer);
          }
        });
      } else {
        rl.question(query, (answer) => {
          if (validate && !validate(answer)) {
            console.log("❌ Invalid input. Please try again.");
            rl.close();
            resolve(askQuestion(query, hidden, validate)); // retry
          } else {
            rl.close();
            resolve(answer);
          }
        });
      }
    };

    prompt();
  });
}


async function runPuppeteer() {

  console.log(`
╔══════════════════════════════════════╗
║ 🚀  EVOLVE AUTOMATION SCRIPT v1.2   ║
╚══════════════════════════════════════╝
     Automating your workflow... 💼⚙️
`);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: puppeteer.executablePath(),
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  let attempt = 1;
  let loginSuccessful = false;

  while (!loginSuccessful) {
    console.log(`🔐 Login attempt ${attempt}`);

    // Ask for email and password
    const email = await askQuestion("📧 Enter your email: ", false, isValidEmail);
    const password = await askQuestion("🔑 Enter your password: ", true);

    await page.goto("https://foresite.evolvemep.com/auth/login", { waitUntil: 'networkidle2' });
    console.log("🌐 Navigating to site...");

    // ✅ Accept cookie banner if present
    await setTimeout(3000);
    const cookieBanner = await page.$("#hs-eu-cookie-confirmation-inner");
    if (cookieBanner) {
      console.log("🍪 Cookie banner found. Clicking accept...");
      await page.click("#hs-eu-confirmation-button");
      await setTimeout(500);
    } else {
      console.log("🍪 No cookie banner found. Skipping...");
    }

    // ✅ Login
    await page.waitForSelector(".mantine-TextInput-input");
    await setTimeout(1000);
    await page.type(".mantine-TextInput-input", email, { delay: 100 });

    await page.waitForSelector(".m_87cf2631");
    await setTimeout(1000);
    await page.click(".m_87cf2631");
    console.log("🧑‍💻 Typing Username or Email...");


    await page.waitForSelector(".mantine-PasswordInput-innerInput");
    await setTimeout(1000);
    await page.type(".mantine-PasswordInput-innerInput", password, { delay: 100 });


    await page.waitForSelector(".m_77c9d27d");
    await setTimeout(1000);
    await page.click(".m_77c9d27d");
    console.log("🔒 Typing Password...");

    // Wait for response
    await setTimeout(3000);
    const loginError = await page.$(".mantine-Alert-message");
    if (loginError) {
      const errorText = await page.evaluate(el => el.textContent.trim(), loginError);
      if (errorText === "Incorrect username or password.") {
        console.log("❌ Login failed: Incorrect username or password.");
        console.log("🔄 Retrying login...");
        attempt++;
        continue;
      }
    } else {
      loginSuccessful = true;
    }
  }


  // ✅ Navigate to Members
  await page.waitForSelector('[data-testid="nav-item-members"]');
  await setTimeout(1000);
  await page.click('[data-testid="nav-item-members"]');

  // ✅ Select "eVolve Electrical for Revit"
  await page.waitForSelector(".mantine-PillsInput-input");
  await setTimeout(2000);
  await page.click(".mantine-PillsInput-input");

  await page.waitForSelector(".mantine-Combobox-option");
  await setTimeout(2000);
  const options = await page.$$(".mantine-Combobox-option");

  for (const el of options) {
    const text = await page.evaluate((el) => el.textContent.trim(), el);
    if (text === "eVolve Electrical for Revit") {
      await el.click();
      console.log("✅ Selected:", text);
      break;
    }
  }

  // ✅ Scroll table & extract data
  let previousRowCount = 0;
  let stableCounter = 0;
  const allRows = [];
  console.log("📊 Read the Table details...");
  while (stableCounter < 3) {
    await page.evaluate(() => {
      const container = document.querySelector(".ag-body-viewport");
      container.scrollBy(0, 300);
    });

    await setTimeout(500);
    const newRows = await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll('.ag-center-cols-container [role="row"]')
      );
      return rows.map((row) => {
        const getCell = (id) => {
          const cell = row.querySelector(`[col-id="${id}"]`);
          return cell?.innerText.trim() || null;
        };
        return {
          name: getCell("name"),
          email: getCell("email"),
          companyRole: getCell("companyRoleId"),
          electricalRole: getCell("electricalRoleId"),
          rowId: row.getAttribute("row-id"),
        };
      });
    });

    await setTimeout(1000);
    const existingIds = new Set(allRows.map((r) => r.rowId));
    const uniqueNewRows = newRows.filter(
      (r) => r.rowId && !existingIds.has(r.rowId)
    );
    allRows.push(...uniqueNewRows);

    const currentRowCount = await page.evaluate(() =>
      document.querySelectorAll('.ag-center-cols-container [role="row"]')
        .length
    );

    if (currentRowCount === previousRowCount) {
      stableCounter++;
    } else {
      stableCounter = 0;
      previousRowCount = currentRowCount;
    }
  }
  console.log("🛑 Closing browser...");
  console.log("🧾 Creating Excel file...");
  // await browser.close();

  // ✅ Save to Excel
  const cleanedRows = allRows.map(({ rowId, ...data }) => data);
  const worksheet = xlsx.utils.json_to_sheet(cleanedRows);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Users");

  const filePath = `output-${Date.now()}.xlsx`;
  xlsx.writeFile(workbook, filePath);

  console.log("📥 Xlsx file downloaded successfully");
  console.log(`💾 ✅ Excel file saved: ${filePath}`);
}

runPuppeteer();



/*
// working for terminal well
function askQuestion(query, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    if (hidden) {
      const stdin = process.stdin;
      const onDataHandler = (char) => {
        char = char + '';
        switch (char) {
          case '\n':
          case '\r':
          case '\u0004':
            stdin.pause();
            break;
          default:
            process.stdout.clearLine(0);
            readline.cursorTo(process.stdout, 0);
            process.stdout.write(query + Array(rl.line.length + 1).join('*'));
            break;
        }
      };

      stdin.on("data", onDataHandler);
      rl.question(query, (answer) => {
        rl.close();
        stdin.removeListener("data", onDataHandler); // remove old listener
        resolve(answer);
      });
    } else {
      rl.question(query, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}
*/


/*
const puppeteer = require("puppeteer");
const { setTimeout } = require("node:timers/promises");
const xlsx = require("xlsx");
const fs = require("fs");

let email = "nantha@sanveotech.com";
let password = "Chennai@95";

async function runPuppeteer() {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", // Or remove this line to use Chromium
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto("https://foresite.evolvemep.com/auth/login");

  // ✅ Accept cookie banner if present
  await setTimeout(3000);
  const cookieBanner = await page.$("#hs-eu-cookie-confirmation-inner");
  if (cookieBanner) {
    console.log("Cookie banner found. Clicking accept...");
    await page.click("#hs-eu-confirmation-button");
    await setTimeout(500);
  } else {
    console.log("No cookie banner found. Skipping...");
  }

  // ✅ Login
  await page.waitForSelector(".mantine-TextInput-input");
  await setTimeout(1000);
  await page.type(".mantine-TextInput-input", email);

  await page.waitForSelector(".m_87cf2631");
  await setTimeout(1000);
  await page.click(".m_87cf2631");

  await page.waitForSelector(".mantine-PasswordInput-innerInput");
  await setTimeout(1000);
  await page.type(".mantine-PasswordInput-innerInput", password);

  await page.waitForSelector(".m_77c9d27d");
  await setTimeout(1000);
  await page.click(".m_77c9d27d");

  // ✅ Navigate to Members
  await page.waitForSelector('[data-testid="nav-item-members"]');
  await setTimeout(1000);
  await page.click('[data-testid="nav-item-members"]');

  // ✅ Select "eVolve Electrical for Revit"
  await page.waitForSelector(".mantine-PillsInput-input");
  await setTimeout(2000);
  await page.click(".mantine-PillsInput-input");

  await page.waitForSelector(".mantine-Combobox-option");
  await setTimeout(2000);
  const options = await page.$$(".mantine-Combobox-option");

  for (const el of options) {
    const text = await page.evaluate((el) => el.textContent.trim(), el);
    if (text === "eVolve Electrical for Revit") {
      await el.click();
      console.log("Selected:", text);
      break;
    }
  }

  // ✅ Scroll table & extract data
  let previousRowCount = 0;
  let stableCounter = 0;
  const allRows = [];

  while (stableCounter < 3) {
    await page.evaluate(() => {
      const container = document.querySelector(".ag-body-viewport");
      container.scrollBy(0, 300);
    });

    await setTimeout(500);
    const newRows = await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll('.ag-center-cols-container [role="row"]')
      );
      return rows.map((row) => {
        const getCell = (id) => {
          const cell = row.querySelector(`[col-id="${id}"]`);
          return cell?.innerText.trim() || null;
        };
        return {
          name: getCell("name"),
          email: getCell("email"),
          companyRole: getCell("companyRoleId"),
          electricalRole: getCell("electricalRoleId"),
          rowId: row.getAttribute("row-id"),
        };
      });
    });

    await setTimeout(1000);
    const existingIds = new Set(allRows.map((r) => r.rowId));
    const uniqueNewRows = newRows.filter(
      (r) => r.rowId && !existingIds.has(r.rowId)
    );
    allRows.push(...uniqueNewRows);

    const currentRowCount = await page.evaluate(() =>
      document.querySelectorAll('.ag-center-cols-container [role="row"]')
        .length
    );

    if (currentRowCount === previousRowCount) {
      stableCounter++;
    } else {
      stableCounter = 0;
      previousRowCount = currentRowCount;
    }
  }

  await browser.close();

  // ✅ Save to Excel
  const cleanedRows = allRows.map(({ rowId, ...data }) => data);
  const worksheet = xlsx.utils.json_to_sheet(cleanedRows);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Users");

  const filePath = `output-${Date.now()}.xlsx`;
  xlsx.writeFile(workbook, filePath);
  console.log(`✅ Excel file saved: ${filePath}`);
}

runPuppeteer();
*/
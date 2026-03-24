📄 Autodesk ACC Multi-Download Tool (Simple Guide)
1. What is this tool?

This tool helps you download many files from Autodesk ACC quickly.

Instead of downloading files one by one, this tool does everything automatically.

What it does:
Opens Chrome browser automatically
Uses your existing Autodesk login
Finds files by name
Downloads all versions (or selected versions)
Saves files into folders on your computer
Renames duplicate files automatically (example: file (1).dwg)
When to use this:
When downloading many files
When downloading all versions of a file
To save time and avoid manual mistakes
When you need specific versions (like V1, V3)
Requirements:
Windows 10 or 11
Google Chrome installed
Autodesk ACC account
autodesk_multi_download.exe file

⚠️ Do not close Chrome while the tool is running

2. How to use the tool
Step 1: Open Chrome in automation mode

Press Windows + R, paste this, and press Enter:

"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Temp\Chrome-Automation-Profile" --no-first-run
Step 2: Login to Autodesk
Open: acc.autodesk.com
Login with your account
Step 3: Run the tool
Double-click the .exe file
A black window will open → this is normal
Step 4: Enter project URL (optional)
Paste URL OR press Enter to use default
Step 5: Enter file name
Type file name (example: RSW9-GAYL-ZZ-ALL-M3-ELC)
Or press Enter
Step 6: Choose versions
Type all → download all versions
OR v1,v3,v5 → download selected versions
Step 7: Wait
Tool will download automatically
You will see progress messages
Step 8: Finish
Press Enter to close
Files saved in:
[exe folder]\Downloads\[FileName]
3. Common problems & solutions
Problem	Solution
Cannot connect to Chrome	Make sure Chrome started with command
Download timeout	File is large → try again
No versions found	Check file name
Blank page	Login to Autodesk first
Tool closes	Check error.log
Duplicate files	Normal (auto renamed)
4. Technical overview (Simple)
Built using Node.js
Uses Puppeteer to control Chrome
Connects to your Chrome (does not open new one)
Keeps your login session active
Main parts:
index.js → main logic
download_manager.js → tracks downloads
startChromeBrowser.js → starts Chrome
utils.js → helper functions
config.js → settings
5. How it works (simple flow)
Starts Chrome (if not running)
Asks user for inputs
Connects to Chrome
Opens Autodesk page
Finds file
Gets versions
Downloads files
Saves files safely
Renames duplicates
Finishes process
6. Developer setup
Requirements:
Node.js 18+
npm
Chrome
Windows
Install:
npm install
npm start
Build EXE:
npm install -g pkg
npm run pkg
7. Configuration
Important settings:
Download folder → Downloads/
Timeout → 5 minutes
Default URL → can be changed
Default file name → can be changed
8. FAQ
Q: Does it login automatically?

No. You must login manually.

Q: Does it delete files?

No. It only downloads files.

Q: Can I use Chrome normally?

Yes, but avoid using the automation Chrome.

Q: Where are files saved?

Inside the Downloads folder near the .exe

9. For developers
Uses puppeteer-core (no Chromium included)
Uses string-based automation for compatibility
Can be modified for other Autodesk projects

// index.js
// Main process with: Project Manager backend + Application Menu.

const { app, BrowserWindow, ipcMain, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");

// Enable env vars and TS in main, then load IPC handlers
require("dotenv/config");
require("ts-node/register");
require("./src/main/ipc.ts");

// Temporary flag to disable DB sync while keeping auth
global.DB_SYNC_ENABLED = true;

// Add handler to check sync enabled state
ipcMain.handle('sync:isEnabled', () => {
  return !!global.DB_SYNC_ENABLED;
});

// ---------- Paths ----------
const PROJECTS_ROOT = () => path.join(app.getPath("documents"), "InkDoodleProjects");
const WORKSPACE_DIR = () => path.join(app.getPath("userData"), "workspace");

// Tracks currently loaded project dir (absolute path)
let currentProjectDir = null;

// ---------- FS helpers ----------
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function emptyDirSync(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}
function copyDirSync(src, dest) {
  ensureDir(dest);
  fs.cpSync(src, dest, { recursive: true, force: true });
}
// Use shared logger so IPC code can also write to the same logs
const { appendDebugLog, getGlobalLogPath } = require('./src/main/log');
const { pool } = require('./src/main/db');
function listProjects() {
  const root = PROJECTS_ROOT();
  ensureDir(root);
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const dir = path.join(root, d.name);
      let modified = 0;
      try { modified = fs.statSync(dir).mtimeMs || 0; } catch {}
      return { name: d.name, dir, modified };
    })
    .sort((a,b) => b.modified - a.modified);
}
function initWorkspace() { ensureDir(WORKSPACE_DIR()); }

// ---------- Window ----------
let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, "index.html"));

  win.webContents.on("did-finish-load", () => {
    console.log("[main] did-finish-load");
    win.webContents.executeJavaScript('console.log("[renderer] typeof require =", typeof require);');
  });

  // win.webContents.openDevTools();
  console.log("[main] window created; app path =", app.getAppPath());
}

// ---------- App Menu ----------
function buildMenu() {
  const isMac = process.platform === "darwin";

  const template = [
    // macOS app menu
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : []),

    {
      label: "File",
      submenu: [
        {
          label: "Open Project Picker…",
          click: () => {
            const w = BrowserWindow.getFocusedWindow() || win;
            w && w.webContents.send("menu:openPicker");
          },
        },
        {
          label: "Find…",                  // ADDED
          accelerator: "CmdOrCtrl+F",      // ADDED
          click: () => {                   // ADDED
            const w = BrowserWindow.getFocusedWindow() || win;
            w && w.webContents.send("menu:openFinder");
          },
        },
        { type: "separator" },
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: () => {
            const w = BrowserWindow.getFocusedWindow() || win;
            w && w.webContents.send("menu:save");
          },
        },
        {
          label: "Save Back",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => {
            const w = BrowserWindow.getFocusedWindow() || win;
            w && w.webContents.send("menu:saveBack");
          },
        },
        {
          label: "Open Global Log",
          accelerator: "CmdOrCtrl+Shift+L",
          click: () => {
            try {
              const globalLog = getGlobalLogPath();
              if (globalLog) shell.openPath(globalLog);
            } catch (e) { /* best-effort */ }
          }
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },

    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac ? [
          { role: "pasteAndMatchStyle" },
          {
            label: "Delete Entry",
            accelerator: "CmdOrCtrl+Backspace",
            click: () => {
                const w = BrowserWindow.getFocusedWindow();
                if (w) w.webContents.send("menu:delete");
            },
          },
          { role: "selectAll" },
          { type: "separator" },
          {
            label: "Speech",
            submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
          },
        ] : [
          {
            label: "Delete Entry",
            accelerator: "Ctrl+Backspace",
            click: () => {
                const w = BrowserWindow.getFocusedWindow();
                if (w) w.webContents.send("menu:delete");
            },
          },
          { type: "separator" },
          { role: "selectAll" },
        ]),
      ],
    },

    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },

    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        ...(isMac ? [{ role: "zoom" }, { type: "separator" }, { role: "front" }] : [{ role: "close" }]),
      ],
    },

    {
      label: "Help",
      submenu: [
        { role: "about" },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ---------- IPC: Project Manager ----------
ipcMain.handle("project:list", async () => {
  try { return { ok: true, items: listProjects(), root: PROJECTS_ROOT() }; }
  catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle("project:new", async (_evt, { name }) => {
  try {
    if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error("Invalid project name.");
    const root = PROJECTS_ROOT(); ensureDir(root);
    const dir = path.join(root, name);
    if (fs.existsSync(dir)) throw new Error("A project with that name already exists.");

    // Get current user's ID for project creation
    const authQuery = await pool.query(
      `SELECT value->>'id' AS creator_id FROM prefs WHERE key = 'auth_user' LIMIT 1;`
    );
    const creatorId = Number(authQuery.rows?.[0]?.creator_id);
    if (!creatorId) {
      throw new Error('Must be logged in to create a project');
    }

    // Create all required directories
    ensureDir(dir);
    const dataDir = path.join(dir, "data"); ensureDir(dataDir);
    const chaptersDir = path.join(dir, "chapters"); ensureDir(chaptersDir);
    const notesDir = path.join(dir, "notes"); ensureDir(notesDir);
    const refsDir = path.join(dir, "refs"); ensureDir(refsDir);

    // Create base project structure with all required fields
    const pj = {
      // Project data
      project: {
        title: name,
        name: name,
        creator_id: creatorId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        saved_at: new Date().toISOString()
      },
      // Entries array for all content
      entries: [],
      // UI state and metadata
      ui: { 
        activeTab: "chapters", 
        selectedId: null, 
        counters: { chapter: 0, note: 0, reference: 0 } 
      },
      saved_at: new Date().toISOString(),
      version: 1
    };
    fs.writeFileSync(path.join(dataDir, "project.json"), JSON.stringify(pj, null, 2), "utf8");
    appendDebugLog(`project:new — Created new project "${name}" at ${dir}`);
    return { ok: true, dir };
  } catch (e) {
    appendDebugLog(`project:new — Failed: ${e?.message || e}`);
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("project:delete", async (_evt, { dir }) => {
  try {
    if (!dir || !path.resolve(dir).startsWith(path.resolve(PROJECTS_ROOT())))
      throw new Error("Cannot delete: invalid directory.");
    // log delete start (best-effort read project name)
    let projectName = path.basename(dir);
    try {
      const pj = path.join(dir, 'data', 'project.json');
      if (fs.existsSync(pj)) {
        const raw = fs.readFileSync(pj, 'utf8');
        const obj = JSON.parse(raw);
        projectName = obj?.project?.name || projectName;
      }
    } catch (e) {}
    appendDebugLog(`project:delete — Deleting project "${projectName}" at ${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });
    appendDebugLog(`project:delete — Deleted project "${projectName}"`);
    if (currentProjectDir && path.resolve(currentProjectDir) === path.resolve(dir)) {
      currentProjectDir = null;
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// Auto save-back then load new project
ipcMain.handle("project:load", async (_evt, { dir }) => {
  try {
    if (!dir || !fs.existsSync(dir)) throw new Error("Project directory does not exist.");

    const ws = WORKSPACE_DIR();
    // determine project name for logging
    let incomingName = path.basename(dir);
    try {
      const pj = path.join(dir, 'data', 'project.json');
      if (fs.existsSync(pj)) {
        const raw = fs.readFileSync(pj, 'utf8');
        const obj = JSON.parse(raw);
        incomingName = obj?.project?.name || incomingName;
      }
    } catch (e) {}
  appendDebugLog(`project:load — Starting load of project "${incomingName}" from ${dir} into workspace ${ws}`, dir);
    if (currentProjectDir) {
      try {
        ensureDir(currentProjectDir);
        // log auto-save-back start
        let curName = path.basename(currentProjectDir);
        try {
          const pj2 = path.join(currentProjectDir, 'data', 'project.json');
          if (fs.existsSync(pj2)) {
            const raw2 = fs.readFileSync(pj2, 'utf8');
            const obj2 = JSON.parse(raw2);
            curName = obj2?.project?.name || curName;
          }
        } catch (e) {}
        appendDebugLog(`project:saveBack — Auto-saving current workspace ${ws} back to project "${curName}" at ${currentProjectDir}`);
        copyDirSync(ws, currentProjectDir);
        appendDebugLog(`project:saveBack — Completed auto-save-back of project "${curName}" → ${currentProjectDir}`);
      } catch (e) {
        appendDebugLog(`project:saveBack — Auto-save-back failed for ${currentProjectDir}: ${e?.message || e}`);
      }
    }

    emptyDirSync(ws);
    copyDirSync(dir, ws);
    currentProjectDir = dir;
  appendDebugLog(`project:load — Completed load of project "${incomingName}" → workspace ${ws}`, dir);

    return { ok: true, activePath: ws, currentProjectDir };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("project:activePath", async () => {
  try { return { ok: true, activePath: WORKSPACE_DIR(), currentProjectDir }; }
  catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle("project:saveBack", async () => {
  try {
    if (!currentProjectDir) throw new Error("No project loaded.");
    const ws = WORKSPACE_DIR();
    if (!fs.existsSync(ws)) throw new Error("Workspace missing.");
    // read project name for logging
    let curName = path.basename(currentProjectDir);
    try {
      const pj2 = path.join(currentProjectDir, 'data', 'project.json');
      if (fs.existsSync(pj2)) {
        const raw2 = fs.readFileSync(pj2, 'utf8');
        const obj2 = JSON.parse(raw2);
        curName = (obj2 && obj2.project && obj2.project.name) || curName;
      }
    } catch (e) {}
    appendDebugLog(`project:saveBack — Manual save-back starting for project "${curName}" at ${currentProjectDir}`);
    ensureDir(currentProjectDir);
    copyDirSync(ws, currentProjectDir);
    appendDebugLog(`project:saveBack — Manual save-back completed for project "${curName}" → ${currentProjectDir}`);
    return { ok: true, target: currentProjectDir };
  } catch (e) {
    appendDebugLog(`project:saveBack — Failed save-back to ${currentProjectDir}: ${e && e.message ? e.message : e}`);
    return { ok: false, error: String(e) };
  }
});

// ---------- App lifecycle ----------
app.whenReady().then(async () => {
  initWorkspace();
  // New session separator and startup paths (helps keep logs readable across launches)
  try {
    appendDebugLog('=== NEW SESSION ===');
    appendDebugLog(`paths: workspace=${WORKSPACE_DIR()} projects=${PROJECTS_ROOT()} global=${getGlobalLogPath()}`);

    // Check if user is logged in and sync DB if they are
    const pool = require('./src/main/db').pool;
    const auth = await pool.query(
      `SELECT value->>'id' AS creator_id 
       FROM prefs 
       WHERE key = 'auth_user' 
       LIMIT 1;`
    );
    const creatorId = Number(auth.rows?.[0]?.creator_id);
    if (creatorId && global.DB_SYNC_ENABLED) {
      appendDebugLog('Found logged in user on startup - syncing from DB');
      const { syncFromDB } = require('./src/main/db.sync');
      const result = await syncFromDB(creatorId);
      if (result.ok) {
        appendDebugLog(`DB sync successful - synced ${result.projectCount} projects`);
      } else {
        appendDebugLog(`DB sync failed: ${result.error}`);
      }
    } else if (creatorId) {
      appendDebugLog('DB sync disabled - skipping sync on startup');
    }
  } catch (e) { /* best-effort */ }
  createWindow();
  buildMenu();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      buildMenu();
    }
  });
});

app.on("before-quit", () => {
  try {
    if (currentProjectDir) {
      const ws = WORKSPACE_DIR();
      if (fs.existsSync(ws)) {
        copyDirSync(ws, currentProjectDir);
        console.log("[main] Saved workspace back to", currentProjectDir);
      }
    }
  } catch (e) {
    console.warn("[main] Save-back on exit failed:", e);
  }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

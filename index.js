// index.js
// Main process with: Project Manager backend + Application Menu.

const { app, BrowserWindow, ipcMain, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");

// Enable env vars and TS in main, then load IPC handlers
require("dotenv/config");
require("ts-node/register");
// Load IPC handlers and capture exported helpers (performLogout)
const ipcModule = require("./src/main/ipc.ts");

// Temporary flag to disable DB sync while keeping auth
global.DB_SYNC_ENABLED = false;

// Add handler to check sync enabled state
ipcMain.handle('sync:isEnabled', () => {
  return !!global.DB_SYNC_ENABLED;
});

// ---------- Paths ----------
const PROJECTS_ROOT = () => path.join(app.getPath("documents"), "InkDoodleProjects");
const WORKSPACE_DIR = () => path.join(app.getPath("userData"), "workspace");

// Tracks currently loaded project dir (absolute path)
// Exposed on global so other main-process modules (ipc.ts) can clear it during logout.
global.currentProjectDir = null;

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
// Utility: list files under a directory (relative paths). Limits to max entries.
function listFilesRecursive(root, maxEntries = 500) {
  const out = [];
  try {
    function walk(dir) {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const it of items) {
        if (out.length >= maxEntries) return;
        const full = path.join(dir, it.name);
        const rel = path.relative(root, full).replace(/\\/g, '/');
        if (it.isDirectory()) {
          walk(full);
        } else {
          out.push(rel);
        }
        if (out.length >= maxEntries) return;
      }
    }
    if (fs.existsSync(root)) walk(root);
  } catch (e) { /* best-effort */ }
  return out;
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
        {
          label: "Timeline: Zoom In",
          accelerator: "CmdOrCtrl+Alt+Plus",
          click: () => {
            const w = BrowserWindow.getFocusedWindow() || win;
            if (w) w.webContents.send('menu:timelineZoomIn');
          }
        },
        {
          label: "Timeline: Zoom Out",
          accelerator: "CmdOrCtrl+Alt+-",
          click: () => {
            const w = BrowserWindow.getFocusedWindow() || win;
            if (w) w.webContents.send('menu:timelineZoomOut');
          }
        },
        {
          label: "Timeline: Reset View",
          accelerator: "CmdOrCtrl+Alt+0",
          click: () => {
            const w = BrowserWindow.getFocusedWindow() || win;
            if (w) w.webContents.send('menu:timelineReset');
          }
        },
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

    // Determine a numeric project id by counting existing projects (do this before creating the dir)
    const existingDirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).length;
    const nextId = existingDirs + 1;
    const now = new Date().toISOString();
    const pad = (n) => String(n).padStart(6, '0');

    // Create all required directories
    ensureDir(dir);
    const dataDir = path.join(dir, "data"); ensureDir(dataDir);
    const chaptersDir = path.join(dir, "chapters"); ensureDir(chaptersDir);
    const notesDir = path.join(dir, "notes"); ensureDir(notesDir);
    const refsDir = path.join(dir, "refs"); ensureDir(refsDir);

    // Create base project structure (new format)
    // For codes we use the pattern: <TYPE>-<parentId(4)>-<id(6)>
    // For projects: parentId = creatorId; for entries: parentId = projectId
    const projectCode = `PRJ-${String(creatorId).padStart(4,'0')}-${pad(nextId)}`;

    // Determine per-entry sequence ids by counting existing files in each folder
    const existingCh = fs.existsSync(chaptersDir) ? fs.readdirSync(chaptersDir).filter(f => f.endsWith('.json')).length : 0;
    const existingNt = fs.existsSync(notesDir) ? fs.readdirSync(notesDir).filter(f => f.endsWith('.json')).length : 0;
    const existingRf = fs.existsSync(refsDir) ? fs.readdirSync(refsDir).filter(f => f.endsWith('.json')).length : 0;
    const chSeq = existingCh + 1;
    const ntSeq = existingNt + 1;
    const rfSeq = existingRf + 1;

    // Per-entry codes follow the original pattern: TYPE-<projectId padded4>-<id padded6>
    const chCode = `CHP-${String(nextId).padStart(4,'0')}-${pad(chSeq)}`;
    const ntCode = `NT-${String(nextId).padStart(4,'0')}-${pad(ntSeq)}`;
    const rfCode = `RF-${String(nextId).padStart(4,'0')}-${pad(rfSeq)}`;

    const pj = {
      project: {
        id: nextId,
        code: projectCode,
        title: name,
        creator_id: creatorId,
        created_at: now,
        updated_at: now
      },
      entries: [
        {
          id: chSeq,
          code: chCode,
          type: 'chapter',
          title: 'Chapter 1',
          order_index: 0,
          updated_at: now
        },
        {
            id: ntSeq,
            code: ntCode,
          type: 'note',
          title: 'Note 1',
          order_index: 0,
          updated_at: now
        },
        {
            id: rfSeq,
            code: rfCode,
          type: 'reference',
          title: 'Reference 1',
          order_index: 0,
          updated_at: now
        }
      ]
    };

    // Write project.json
    fs.writeFileSync(path.join(dataDir, "project.json"), JSON.stringify(pj, null, 2), "utf8");

    // Also create per-item files for chapters, notes, and refs (match example structure)
    try {
  const chCode = pj.entries[0].code;
  const ntCode = pj.entries[1].code;
  const rfCode = pj.entries[2].code;

      const chapterObj = {
        id: chSeq,
        code: chCode,
        project_id: nextId,
        creator_id: creatorId,
        title: pj.entries[0].title,
        content: "",
        status: "Draft",
        summary: "",
        tags: [],
        created_at: now,
        updated_at: now,
        word_goal: 0
      };
  // Write per-item files using concise filenames (e.g. CH1.json, NT1.json, RF1.json)
  const chFilename = `CH${chSeq}.json`;
  fs.writeFileSync(path.join(chaptersDir, chFilename), JSON.stringify(chapterObj, null, 2), 'utf8');

      const noteObj = {
        id: ntSeq,
        code: ntCode,
        project_id: nextId,
        creator_id: creatorId,
        title: pj.entries[1].title,
        content: "",
        tags: [],
        category: "Misc",
        pinned: false,
        created_at: now,
        updated_at: now
      };
  const ntFilename = `NT${ntSeq}.json`;
  fs.writeFileSync(path.join(notesDir, ntFilename), JSON.stringify(noteObj, null, 2), 'utf8');

      const refObj = {
        id: rfSeq,
        code: rfCode,
        project_id: nextId,
        creator_id: creatorId,
        title: pj.entries[2].title,
        tags: [],
        reference_type: "Glossary",
        summary: "",
        source_link: "",
        content: "",
        created_at: now,
        updated_at: now
      };
  const rfFilename = `RF${rfSeq}.json`;
  fs.writeFileSync(path.join(refsDir, rfFilename), JSON.stringify(refObj, null, 2), 'utf8');
    } catch (e) {
      // Non-fatal: log and continue
      try { appendDebugLog(`project:new — Warning: failed to write per-item files: ${e?.message || e}`); } catch (ex) {}
    }
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
    if (global.currentProjectDir && path.resolve(global.currentProjectDir) === path.resolve(dir)) {
      global.currentProjectDir = null;
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
    if (global.currentProjectDir) {
      try {
        ensureDir(global.currentProjectDir);
        // log auto-save-back start
        let curName = path.basename(global.currentProjectDir);
        try {
          const pj2 = path.join(global.currentProjectDir, 'data', 'project.json');
          if (fs.existsSync(pj2)) {
            const raw2 = fs.readFileSync(pj2, 'utf8');
            const obj2 = JSON.parse(raw2);
            curName = obj2?.project?.name || curName;
          }
        } catch (e) {}
        appendDebugLog(`project:saveBack — Auto-saving current workspace ${ws} back to project "${curName}" at ${global.currentProjectDir}`);
        copyDirSync(ws, global.currentProjectDir);
        // Provide a file-level summary of what was saved back
        try {
          const files = listFilesRecursive(ws, 500);
          appendDebugLog(`project:saveBack — Completed auto-save-back of project "${curName}" → ${global.currentProjectDir} (files saved: ${files.length})`, global.currentProjectDir);
          if (files.length) appendDebugLog(`project:saveBack — Sample files: ${files.slice(0,50).join(', ')}`, global.currentProjectDir);
        } catch (e) {
          appendDebugLog(`project:saveBack — Completed auto-save-back of project "${curName}" → ${global.currentProjectDir}`);
        }
      } catch (e) {
        appendDebugLog(`project:saveBack — Auto-save-back failed for ${global.currentProjectDir}: ${e?.message || e}`);
      }
    }
    appendDebugLog(`project:load — Clearing workspace directory: ${ws}`);
    emptyDirSync(ws);
    appendDebugLog(`project:load — Copying project files from ${dir} → ${ws}`);
    copyDirSync(dir, ws);
  global.currentProjectDir = dir;
  appendDebugLog(`project:load — Completed load of project "${incomingName}" → workspace ${ws}`, dir);

  return { ok: true, activePath: ws, currentProjectDir: global.currentProjectDir };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("project:activePath", async () => {
  try { return { ok: true, activePath: WORKSPACE_DIR(), currentProjectDir: global.currentProjectDir }; }
  catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle("project:saveBack", async () => {
  const fs = require('fs');
  const path = require('path');
  // Removed localSaveDebug.log logging
  try {
    if (!global.currentProjectDir) throw new Error("No project loaded.");
    const ws = WORKSPACE_DIR();
    if (!fs.existsSync(ws)) throw new Error("Workspace missing.");
    let curName = path.basename(global.currentProjectDir);
    try {
      const pj2 = path.join(global.currentProjectDir, 'data', 'project.json');
      if (fs.existsSync(pj2)) {
        const raw2 = fs.readFileSync(pj2, 'utf8');
        const obj2 = JSON.parse(raw2);
        curName = (obj2 && obj2.project && obj2.project.name) || curName;
      }
    } catch (e) {}
    appendDebugLog(`project:saveBack — Manual save-back starting for project "${curName}" at ${global.currentProjectDir}`);
    ensureDir(global.currentProjectDir);
    copyDirSync(ws, global.currentProjectDir);
    try {
      const srcFiles = listFilesRecursive(ws, 10000) || [];
      const destFiles = listFilesRecursive(global.currentProjectDir, 10000) || [];
      const srcSet = new Set(srcFiles.map(s => s.replace(/\\/g, '/')));
      const stale = destFiles.filter(f => !srcSet.has(f.replace(/\\/g, '/')));
      // ...existing code...
      for (const rel of stale) {
        const destPath = path.join(global.currentProjectDir, rel);
        try {
          fs.rmSync(destPath, { force: true });
          // ...existing code...
        } catch (e) {
          appendDebugLog(`project:saveBack — failed removing stale file ${rel}: ${e?.message || e}`, global.currentProjectDir);
          // ...existing code...
        }
      }
    } catch (e) {
      appendDebugLog(`project:saveBack — mirror cleanup failed: ${e?.message || e}`, global.currentProjectDir);
      // ...existing code...
    }
    try {
      const files = listFilesRecursive(ws, 500);
      appendDebugLog(`project:saveBack — Manual save-back completed for project "${curName}" → ${global.currentProjectDir} (files saved: ${files.length})`, global.currentProjectDir);
      // ...existing code...
      if (files.length) {
        appendDebugLog(`project:saveBack — Sample files: ${files.slice(0,50).join(', ')}`, global.currentProjectDir);
        // ...existing code...
      }
    } catch (e) {
      appendDebugLog(`project:saveBack — Manual save-back completed for project "${curName}" → ${global.currentProjectDir}`);
      // ...existing code...
    }
    return { ok: true, target: global.currentProjectDir };
  } catch (e) {
    appendDebugLog(`project:saveBack — Failed save-back to ${global.currentProjectDir}: ${e && e.message ? e.message : e}`);
    // ...existing code...
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

    // Startup automatic DB->local sync has been removed to keep local JSON
    // authoritative. If a controlled import is required, implement it in
    // `src/main/db.load.ts` behind a developer flag. We intentionally do not
    // call any startup DB->local sync helper here.
    // This log marks the (now disabled) automatic DB->local sync step at startup
    appendDebugLog('startupLoginSync — disabled: automatic DB->local sync removed');
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

// Named before-quit handler to avoid accidental re-entry loops. The handler
// prevents the default quit, performs a fail-fast logout, then removes
// itself before re-invoking quit so a second before-quit won't re-run the
// same flow repeatedly.
async function onBeforeQuit(e) {
  try {
    if (global._logoutInProgress) {
      appendDebugLog('before-quit — logout already in progress, skipping additional before-quit');
      // Do not prevent default here so the quit can continue if another
      // listener expects it; simply return.
      return;
    }

    // Prevent the default quit until we've attempted logout.
    e.preventDefault();
    global._logoutInProgress = true;

    if (ipcModule && typeof ipcModule.performLogout === 'function') {
      try {
        const q = await pool.query(`SELECT 1 FROM prefs WHERE key = 'auth_user' LIMIT 1;`);
        if (q && q.rowCount > 0) {
          appendDebugLog('before-quit — auth_user present, invoking performLogout (blocking exit until complete)');
          // Fail-fast: do not block quit longer than 10s
          const logoutPromise = ipcModule.performLogout({ projectPath: WORKSPACE_DIR(), workspaceExists: fs.existsSync(WORKSPACE_DIR()) });
          const timeout = new Promise(resolve => setTimeout(() => resolve({ ok: false, error: 'performLogout: timeout' }), 10000));
          try {
            const r = await Promise.race([logoutPromise, timeout]);
            appendDebugLog(`before-quit — performLogout result (or timeout): ${JSON.stringify(r)}`);
          } catch (ex) {
            appendDebugLog(`before-quit — performLogout threw: ${ex?.message || ex}`);
          }
        } else {
          appendDebugLog('before-quit — no auth_user, skipping performLogout');
        }
      } catch (qe) {
        appendDebugLog(`before-quit — failed checking auth_user or performLogout failed: ${qe?.message || qe}`);
      }
    } else {
      appendDebugLog('before-quit — performLogout not available on ipc module');
    }

    // Remove this handler to avoid re-entry when calling app.quit()
    try { app.removeListener('before-quit', onBeforeQuit); } catch (e) { /* best-effort */ }

    appendDebugLog('before-quit — performLogout finished; continuing quit');
    // Re-invoke quit; since we've removed this handler it won't loop.
    app.quit();
  } catch (err) {
    appendDebugLog(`before-quit handler failed: ${err?.message || err}`);
    try { app.removeListener('before-quit', onBeforeQuit); } catch (e) {}
    // On error, fall back to quitting so user is not stuck.
    app.quit();
  } finally {
    try { global._logoutInProgress = false; } catch (e) {}
  }
}

app.on('before-quit', onBeforeQuit);

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

// index.js
// Main process with: Project Manager backend + Application Menu.

const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("path");
const fs = require("fs");

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
          accelerator: "CmdOrCtrl+P",
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

    ensureDir(dir);
    const dataDir = path.join(dir, "data"); ensureDir(dataDir);
    const pj = {
      project: { name, saved_at: new Date().toISOString() },
      entries: [],
      ui: { activeTab: "chapters", selectedId: null, counters: { chapter: 1, note: 1, reference: 1 } },
      version: 1,
    };
    fs.writeFileSync(path.join(dataDir, "project.json"), JSON.stringify(pj, null, 2), "utf8");
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("project:delete", async (_evt, { dir }) => {
  try {
    if (!dir || !path.resolve(dir).startsWith(path.resolve(PROJECTS_ROOT())))
      throw new Error("Cannot delete: invalid directory.");
    fs.rmSync(dir, { recursive: true, force: true });
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
    if (currentProjectDir) {
      try {
        ensureDir(currentProjectDir);
        copyDirSync(ws, currentProjectDir);
        console.log("[main] Saved workspace back to", currentProjectDir);
      } catch (e) {
        console.warn("[main] Save-back before switch failed:", e);
      }
    }

    emptyDirSync(ws);
    copyDirSync(dir, ws);
    currentProjectDir = dir;

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
    ensureDir(currentProjectDir);
    copyDirSync(ws, currentProjectDir);
    return { ok: true, target: currentProjectDir };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// ---------- App lifecycle ----------
app.whenReady().then(() => {
  initWorkspace();
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

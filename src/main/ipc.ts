// ink-doodle/src/main/ipc.ts

// Use CommonJS so Node can load this via ts-node/register
const { ipcMain, app } = require('electron');
import { appendDebugLog, getGlobalLogPath } from './log';
import { pingDB, pool } from './db';
// db.sync IPC handlers intentionally removed from automatic registration.
// If you need the old 'db:syncFromDB' IPC handler, reintroduce it explicitly.
// (Removed unused Project type import)
import * as fs from 'fs';
import * as path from 'path';
import { uploadLocalProjects } from './db.upload';

ipcMain.handle('db:ping', async () => {
  try {
    const row = await pingDB();
    return { ok: true, ts: row.ts, version: row.version };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

// DB helpers will be reimplemented with new sync approach

// Project listing/loading handlers will be reimplemented with new DB sync approach

// NEW: prefs:getWorkspacePath (reads prefs table; returns "" if unset)
ipcMain.handle('prefs:getWorkspacePath', async () => {
  try {
    const res = await pool.query(
      `SELECT value->>'path' AS path
         FROM prefs
        WHERE key = 'workspace_root'
        LIMIT 1;`
    );
    const path = res.rows?.[0]?.path ?? '';
    return { ok: true, path };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

// NEW: prefs:setWorkspacePath (upsert JSONB { path })
ipcMain.handle('prefs:setWorkspacePath', async (_evt, { path }) => {
  try {
    if (!path || typeof path !== 'string') {
      return { ok: false, error: 'Path must be a non-empty string' };
    }
    await pool.query(
      `INSERT INTO prefs(key, value)
           VALUES ('workspace_root', jsonb_build_object('path', $1))
       ON CONFLICT (key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now();`,
      [path]
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

// ──────────────────────────────────────────────────────────────
// NEW: Generic prefs:get  → returns { [key]: any } for all rows
ipcMain.handle('prefs:get', async () => {
  try {
    const res = await pool.query(
      `SELECT key, value
         FROM prefs
        ORDER BY key;`
    );
    const out = {};
    for (const r of res.rows || []) out[r.key] = r.value;
    return { ok: true, prefs: out };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

// NEW: Generic prefs:set  → upsert arbitrary { key, value }
// renderer calls example: ipcRenderer.invoke('prefs:set', { key: 'ui', value: { ... } })
import { loginByEmail } from './db.login';
import { fullLoad } from './db.load';

ipcMain.handle('auth:login', async (_evt, { email }) => {
  // Delegate login behavior to the centralized auth logic (no FS side-effects)
  try {
    const res = await loginByEmail(email);
    // If login succeeded, kick off a background fullLoad to populate local projects
    if (res && res.ok) {
      try {
        // fire-and-forget: do not block the login response
        fullLoad().then(r => appendDebugLog(`auth:login — fullLoad result: ${JSON.stringify(r)}`)).catch(e => appendDebugLog(`auth:login — fullLoad failed: ${e?.message || e}`));
      } catch (e) {
        appendDebugLog(`auth:login — failed to start fullLoad: ${e?.message || e}`);
      }
    }

    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

// Logout: clear local workspace/projects and remove auth_user. Uploads
// are intentionally disabled to avoid automatic local->DB writes.
ipcMain.handle('auth:logout', async (_evt, payload?: { projectPath?: string; workspaceExists?: boolean }) => {
  appendDebugLog('auth:logout — Starting logout process');
  try {
    try { global.DB_SYNC_ENABLED = true; appendDebugLog('auth:logout — DB_SYNC_ENABLED set true'); } catch (e) { /* best-effort */ }

    const projectPath = payload?.projectPath;
    const workspaceExists = payload?.workspaceExists ?? false;

  appendDebugLog(`auth:logout — Workspace path: ${projectPath || '(none)'}`);
    appendDebugLog(`auth:logout — Workspace exists: ${workspaceExists}`);

    // Always clean up local projects directory
    const projectsRoot = path.join(app.getPath('documents'), 'InkDoodleProjects');
    try {
      if (fs.existsSync(projectsRoot)) {
        const projCount = fs.readdirSync(projectsRoot).length;
        appendDebugLog(`auth:logout — Clearing ${projCount} projects from ${projectsRoot}`);
        fs.rmSync(projectsRoot, { recursive: true, force: true });
        fs.mkdirSync(projectsRoot, { recursive: true });
        appendDebugLog('auth:logout — Successfully cleared and reinitialized projects directory');
      } else {
        appendDebugLog('auth:logout — Projects directory did not exist, creating fresh');
        fs.mkdirSync(projectsRoot, { recursive: true });
      }
    } catch (e) {
      appendDebugLog(`auth:logout — Failed to clear projects directory: ${e?.message || e}`);
    }

    // Clear workspace if provided
    if (projectPath) {
      try {
        if (fs.existsSync(projectPath)) {
          appendDebugLog(`auth:logout — Clearing workspace at: ${projectPath}`);
          fs.rmSync(projectPath, { recursive: true, force: true });
          fs.mkdirSync(projectPath, { recursive: true });
          appendDebugLog('auth:logout — Successfully cleared and reinitialized workspace');
        } else {
          appendDebugLog('auth:logout — Workspace directory did not exist, skipping cleanup');
        }
      } catch (e) {
        appendDebugLog(`auth:logout — Failed to clear workspace: ${e?.message || e}`);
      }
    }

    // Clear auth_user in prefs
    try {
      await pool.query(`DELETE FROM prefs WHERE key = 'auth_user';`);
      appendDebugLog('auth:logout — Successfully cleared auth_user from prefs');
    } catch (e) {
      appendDebugLog(`auth:logout — Failed to clear auth_user from prefs: ${e?.message || e}`);
      throw e; // Auth clear failure should abort logout
    }

    appendDebugLog('auth:logout — Logout process completed successfully');
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendDebugLog(`auth:logout — Process failed with error: ${msg}`);
    return { ok: false, error: msg };
  } finally {
    try { global.DB_SYNC_ENABLED = false; appendDebugLog('auth:logout — DB_SYNC_ENABLED set false'); } catch (e) { /* best-effort */ }
  }
});

// Auth + Remote Projects handlers

// List remote projects for the current or provided creator

// Local project handlers are provided by the main entry (`index.js`) to avoid duplicate ipcMain registrations.

ipcMain.handle('projects:listRemote', async (_evt, payload) => {
  const creatorId = payload?.creatorId ?? null; // pass numeric id explicitly when provided
  try {
    let effectiveId = creatorId;

    if (!effectiveId) {
      // read from prefs.auth_user
      const p = await pool.query(
        `SELECT value AS user FROM prefs WHERE key = 'auth_user' LIMIT 1;`
      );
      const u = p.rows?.[0]?.user || null;
      effectiveId = u?.id ?? null;
      if (!effectiveId) {
        return { ok: false, error: 'No logged in user.' };
      }
    }

     const projs = await pool.query(
      `SELECT id, code, title, created_at, updated_at
         FROM projects
        WHERE creator_id = $1
        ORDER BY updated_at DESC NULLS LAST, created_at DESC;`,
      [effectiveId]
    );

    return { ok: true, items: projs.rows || [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

// Download project bundle from DB and save to local files
ipcMain.handle('projects:bundle', async (_evt, payload) => {
  // Bundling remote projects into local disk has been disabled to ensure
  // local JSON files remain authoritative and to prevent automatic DB->local
  // writes. If an explicit, reviewed import is required, implement it in
  // `src/main/db.load.ts` and call it from a developer-only path.
  appendDebugLog('ipc:projects:bundle — blocked: DB->local writes are disabled');
  return { ok: false, error: 'projects:bundle disabled: DB->local writes removed' };
});

// Debug logging helpers
ipcMain.handle('debug:getGlobalLogPath', () => {
  try {
    const logPath = getGlobalLogPath();
    return { ok: true, path: logPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

// Allow renderer to append a debug line to the global/per-project logs.
ipcMain.handle('debug:append', (_evt, payload) => {
  try {
    const line = payload && typeof payload === 'object' ? payload.line : undefined;
    const projectDir = payload && typeof payload === 'object' ? payload.projectDir : undefined;
    if (typeof line !== 'string') throw new Error('Invalid debug line');
    appendDebugLog(line, projectDir || null);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

// App path helper 
ipcMain.handle('app:getPath', (_evt, { name }) => {
  try {
    const p = app.getPath(name);
    return { ok: true, path: p };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

// Save project to DB before app quits
ipcMain.handle('app:willQuit', async (_evt, payload?: { projectPath?: string }) => {
  appendDebugLog('app:willQuit — Starting quit save process');
  try {
    const projectPath = payload?.projectPath;
    if (!projectPath) {
      appendDebugLog('app:willQuit — No project path provided, skipping save');
      return { ok: true };
    }

    appendDebugLog(`app:willQuit — Processing project at: ${projectPath}`);

    // Load project from files and save to DB if sync is enabled
    if (!global.DB_SYNC_ENABLED) {
      appendDebugLog('app:willQuit — Project sync disabled - skipping DB save');
      return { ok: true };
    }

    const projectFile = path.join(projectPath, 'data', 'project.json');
    if (fs.existsSync(projectFile)) {
      // NOTE: Upload-on-quit has been disabled per request. We intentionally
      // do NOT call syncToDB or syncDeletions here to avoid automatic writes
      // to the remote database during app shutdown. Keep logging so the
      // behavior is visible and reversible.
      appendDebugLog(`app:willQuit — Found project at ${projectFile} but skipping DB upload on quit (upload logic removed)`);
    } else {
      appendDebugLog('app:willQuit — No project.json found, skipping DB save');
    }

    appendDebugLog('app:willQuit — Quit save process completed successfully');
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendDebugLog(`app:willQuit — Process failed with error: ${msg}`);
    return { ok: false, error: msg };
  }
});
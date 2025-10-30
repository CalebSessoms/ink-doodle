// db.sync.ipc.ts - Centralized IPC handlers for DB sync
const { ipcMain } = require('electron');
import { syncFromDB, syncToDB } from './db.sync';
import { pool } from './db';
import { appendDebugLog } from './log';
import * as fs from 'fs';
import * as path from 'path';

// Send progress updates to renderer
function sendProgressUpdate(event: Electron.IpcMainInvokeEvent, progress: { 
  phase: string;
  current: number;
  total: number;
  detail?: string;
}) {
  try {
    event.sender.send('sync:progress', progress);
  } catch (e) {
    appendDebugLog(`Failed to send progress update: ${e?.message || e}`);
  }
}

// Sync from DB to local files with progress reporting
ipcMain.handle('db:syncFromDB', async (event) => {
  try {
    // 1. Get current auth user
    sendProgressUpdate(event, {
      phase: 'init',
      current: 0,
      total: 1,
      detail: 'Checking authentication...'
    });

    const auth = await pool.query(
      `SELECT value->>'id' AS creator_id 
       FROM prefs 
       WHERE key = 'auth_user' 
       LIMIT 1;`
    );
    const creatorId = Number(auth.rows?.[0]?.creator_id);
    if (!creatorId) {
      appendDebugLog('db:syncFromDB — No logged in user found');
      return { ok: false, error: 'No logged in user' };
    }

    // 2. Get project count
    const projectCount = await pool.query(
      `SELECT COUNT(*) as count FROM projects WHERE creator_id = $1`,
      [creatorId]
    );
    const total = Number(projectCount.rows[0].count);

    sendProgressUpdate(event, {
      phase: 'sync',
      current: 0,
      total,
      detail: `Found ${total} projects to sync...`
    });

    // 3. Perform DB sync
    const result = await syncFromDB(creatorId);

    sendProgressUpdate(event, {
      phase: 'complete',
      current: total,
      total,
      detail: `Successfully synced ${result.projectCount} projects`
    });

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendDebugLog(`db:syncFromDB — Error: ${msg}`);
    
    sendProgressUpdate(event, {
      phase: 'error',
      current: 0,
      total: 1,
      detail: msg
    });

    return { ok: false, error: msg };
  }
});

// Check if a directory has entries that need syncing
ipcMain.handle('db:checkSync', async (_evt, { projectDir }) => {
  try {
    // Simply check if any files exist in entry directories
    const entryTypes = ['chapters', 'notes', 'refs'];
    let hasFiles = false;

    for (const type of entryTypes) {
      const typeDir = path.join(projectDir, type);
      if (fs.existsSync(typeDir)) {
        const files = fs.readdirSync(typeDir).filter(f => f.endsWith('.json'));
        if (files.length > 0) {
          hasFiles = true;
          break;
        }
      }
    }

    return { 
      ok: true, 
      needsSync: hasFiles
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendDebugLog(`db:checkSync — Error: ${msg}`);
    return { ok: false, error: msg };
  }
});

// Push directory contents to DB
ipcMain.handle('db:pushDirectory', async (_evt, { projectDir }) => {
  try {
    // 1. Get auth user
    const auth = await pool.query(
      `SELECT value->>'id' AS creator_id 
       FROM prefs 
       WHERE key = 'auth_user' 
       LIMIT 1;`
    );
    const creatorId = Number(auth.rows?.[0]?.creator_id);
    if (!creatorId) {
      return { ok: false, error: 'No logged in user' };
    }

    // 2. Push to DB
    const result = await syncToDB(creatorId, projectDir);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendDebugLog(`db:pushDirectory — Error: ${msg}`);
    return { ok: false, error: msg };
  }
});
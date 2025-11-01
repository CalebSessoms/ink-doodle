// db.sync.ipc.ts - Centralized IPC handlers for DB->local sync (downloads only)
const { ipcMain } = require('electron');
import { syncFromDB } from './db.sync';
import { pool } from './db';
import { appendDebugLog } from './log';

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

// Note: db:checkSync and db:pushDirectory handlers were removed.
// Uploads from renderer to DB are intentionally disabled. The only
// remaining IPC handler in this module is 'db:syncFromDB' which performs
// downloads/pulls from the database into local files.
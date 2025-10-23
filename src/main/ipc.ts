// ink-doodle/src/main/ipc.ts

// Use CommonJS so Node can load this via ts-node/register
const { ipcMain } = require('electron');
const { pingDB } = require('./db');

ipcMain.handle('db:ping', async () => {
  try {
    const row = await pingDB();
    return { ok: true, ts: row.ts, version: row.version };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});
// ink-doodle/src/main/ipc.ts

// Use CommonJS so Node can load this via ts-node/register
const { ipcMain } = require('electron');
const { pingDB, pool } = require('./db');

ipcMain.handle('db:ping', async () => {
  try {
    const row = await pingDB();
    return { ok: true, ts: row.ts, version: row.version };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

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
ipcMain.handle('prefs:set', async (_evt, { key, value }) => {
  try {
    if (!key || typeof key !== 'string') {
      return { ok: false, error: 'key must be a non-empty string' };
    }
    // Store the provided JS value as JSONB
    await pool.query(
      `INSERT INTO prefs(key, value)
           VALUES ($1, $2::jsonb)
       ON CONFLICT (key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now();`,
      [key, JSON.stringify(value ?? null)]
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});
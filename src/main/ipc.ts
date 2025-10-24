// ink-doodle/src/main/ipc.ts

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

// ---------- DB helpers (resolve id or code) ----------
async function resolveProjectId(idOrCode) {
  // Accept numeric id or public code (e.g., PRJ-0001-000123)
  const q = `
    SELECT id
      FROM projects
     WHERE code = $1
        OR (CASE WHEN $1 ~ '^[0-9]+$' THEN CAST($1 AS INT) ELSE NULL END) = id
     LIMIT 1;
  `;
  const res = await pool.query(q, [String(idOrCode)]);
  return res.rows?.[0]?.id ?? null;
}

// ---------- READ-ONLY IPC: projects:list ----------
ipcMain.handle('projects:list', async () => {
  try {
    const q = `
      SELECT id, code, title, creator_id, created_at, updated_at
        FROM projects
       ORDER BY id;
    `;
    const { rows } = await pool.query(q);
    return { ok: true, items: rows };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg, items: [] };
  }
});

// ---------- READ-ONLY IPC: chapters:listByProject ----------
ipcMain.handle('chapters:listByProject', async (_evt, { projectIdOrCode }) => {
  try {
    const pid = await resolveProjectId(projectIdOrCode);
    if (!pid) return { ok: true, items: [] };

    const q = `
      SELECT id, code, project_id, creator_id, number, title, status, summary,
             tags, created_at, updated_at
        FROM chapters
       WHERE project_id = $1
       ORDER BY number NULLS LAST, id;
    `;
    const { rows } = await pool.query(q, [pid]);
    return { ok: true, items: rows };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg, items: [] };
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

// ──────────────────────────────────────────────────────────────
// Auth:get → returns current logged-in user from prefs.auth_user or null
ipcMain.handle('auth:get', async () => {
  try {
    const r = await pool.query(
      `SELECT value AS user FROM prefs WHERE key = 'auth_user' LIMIT 1;`
    );
    const user = r.rows?.[0]?.user ?? null;
    return { ok: true, user };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg, user: null };
  }
});

// Auth:logout → clears the stored auth user
ipcMain.handle('auth:logout', async () => {
  try {
    await pool.query(`DELETE FROM prefs WHERE key = 'auth_user';`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

// ─────────────────────────────────────────────────────────────
// Auth + Remote Projects (MVP email login)
// ─────────────────────────────────────────────────────────────

// Login (MVP): email lookup-or-create, then persist to prefs.auth_user
ipcMain.handle('auth:login', async (_evt, { email }) => {
  try {
    const em = String(email || '').trim().toLowerCase();
    if (!em || !em.includes('@')) {
      return { ok: false, error: 'Please provide a valid email.' };
    }

    // 1) find creator by email
    let q = await pool.query(
      `SELECT id, email, display_name
         FROM creators
        WHERE lower(email) = $1
        LIMIT 1;`,
      [em]
    );

    // 2) if not found, create one (MVP auto-create)
    if (q.rows.length === 0) {
      q = await pool.query(
        `INSERT INTO creators (email, display_name)
         VALUES ($1, $2)
         RETURNING id, email, display_name;`,
        [em, em.split('@')[0]]
      );
    }

    const creator = q.rows[0];

    // 3) persist as prefs.auth_user (id/email/name only)
    await pool.query(
      `INSERT INTO prefs(key, value)
           VALUES ('auth_user', $1::jsonb)
       ON CONFLICT (key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now();`,
      [JSON.stringify({
        id: creator.id,
        email: creator.email,
        name: creator.display_name || null
        // token: null // placeholder for future token-based auth
      })]
    );

    return { ok: true, user: { ...creator } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

// List remote projects for the current or provided creator
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
// ink-doodle/src/main/ipc.ts

// Use CommonJS so Node can load this via ts-node/register
const { ipcMain } = require('electron');
const { pingDB, pool } = require('./db');
const fs   = require('fs');
const path = require('path');

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

// NEW: helper → current logged-in creator id (from prefs.auth_user)
async function getCurrentCreatorId() {
  const r = await pool.query(
    `SELECT value AS user FROM prefs WHERE key = 'auth_user' LIMIT 1;`
  );
  return r.rows?.[0]?.user?.id ?? null;
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

// ---------- READ-ONLY IPC: notes:listByProject ----------
ipcMain.handle('notes:listByProject', async (_evt, payload) => {
  try {
    const pid = await resolveProjectId(payload?.projectIdOrCode);
    if (!pid) return { ok: true, items: [] };

    const q = `
      SELECT id, code, project_id, creator_id, number, title, content,
             tags, category, pinned, created_at, updated_at
        FROM notes
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

// ---------- READ-ONLY IPC: refs:listByProject ----------
ipcMain.handle('refs:listByProject', async (_evt, payload) => {
  try {
    const pid = await resolveProjectId(payload?.projectIdOrCode);
    if (!pid) return { ok: true, items: [] };

    const q = `
      SELECT id, code, project_id, creator_id, number, title, tags, type,
             summary, link, content, created_at, updated_at
        FROM refs
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

// Logout: clear auth_user, optionally push/save and clear local workspace
ipcMain.handle('auth:logout', async (_evt, payload?: { workspacePath?: string; projectIdOrCode?: string | number }) => {
  try {
    const workspacePath = payload?.workspacePath;
    const projectIdOrCode = payload?.projectIdOrCode;

    // 1) Persist local → DB if both hints provided
    if (workspacePath && projectIdOrCode) {
      await pushWorkspaceToDb(workspacePath, projectIdOrCode);
    }

    // 2) Clear auth_user in prefs
    await pool.query(`DELETE FROM prefs WHERE key = 'auth_user';`);

    // 3) Optionally clear local workspace folder
    if (workspacePath) await clearWorkspaceDir(workspacePath);

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

// ---------- READ-ONLY IPC: projects:bundle (project + children) ----------
ipcMain.handle('projects:bundle', async (_evt, payload) => {
  try {
    const pid = await resolveProjectId(payload?.projectIdOrCode);
    if (!pid) return { ok: false, error: 'Unknown project.' };

    const qProject = pool.query(
      `SELECT id, code, title, creator_id, created_at, updated_at
         FROM projects
        WHERE id = $1
        LIMIT 1;`,
      [pid]
    );

    const qChapters = pool.query(
      `SELECT id, code, project_id, creator_id, number, title, status, summary,
              tags, content, created_at, updated_at
         FROM chapters
        WHERE project_id = $1
        ORDER BY number NULLS LAST, id;`,
      [pid]
    );

    const qNotes = pool.query(
      `SELECT id, code, project_id, creator_id, number, title, content,
              tags, category, pinned, created_at, updated_at
         FROM notes
        WHERE project_id = $1
        ORDER BY number NULLS LAST, id;`,
      [pid]
    );

    const qRefs = pool.query(
      `SELECT id, code, project_id, creator_id, number, title, tags, type,
              summary, link, content, created_at, updated_at
         FROM refs
        WHERE project_id = $1
        ORDER BY number NULLS LAST, id;`,
      [pid]
    );

    const [proj, ch, no, re] = await Promise.all([qProject, qChapters, qNotes, qRefs]);

    return {
      ok: true,
      project: proj.rows?.[0] || null,
      chapters: ch.rows || [],
      notes: no.rows || [],
      refs: re.rows || [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

// App is quitting: optionally persist & clear local
ipcMain.handle('app:willQuit', async (_evt, payload?: { workspacePath?: string; projectIdOrCode?: string | number }) => {
  try {
    const workspacePath = payload?.workspacePath;
    const projectIdOrCode = payload?.projectIdOrCode;

    if (workspacePath && projectIdOrCode) {
      await pushWorkspaceToDb(workspacePath, projectIdOrCode);
    }
    // NOTE: we do NOT clear auth on quit; only on explicit logout
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

// ──────────────────────────────────────────────────────────────
// Helpers: write local workspace → DB (replace children), and clear workspace dir
async function syncFromWorkspaceToDB({ workspacePath, projectIdOrCode }) {
  // 1) read project.json
  const dataPath = path.join(workspacePath, 'data', 'project.json');
  const raw = fs.readFileSync(dataPath, 'utf8');
  const payload = JSON.parse(raw);

  const title = (payload?.project?.name || 'Untitled Project').trim();

  // 2) find current user (creator)
  const cr = await pool.query(`SELECT value AS user FROM prefs WHERE key = 'auth_user' LIMIT 1;`);
  const creatorId = cr.rows?.[0]?.user?.id ?? null;
  if (!creatorId) throw new Error('No logged-in user');

  // 3) resolve or create project (prefer explicit id/code if provided)
  let projectId = null;
  if (projectIdOrCode != null) {
    projectId = await resolveProjectId(projectIdOrCode);
  }
  if (!projectId) {
    // try to find by (creator_id, title)
    const f = await pool.query(
      `SELECT id FROM projects WHERE creator_id = $1 AND title = $2 LIMIT 1;`,
      [creatorId, title]
    );
    projectId = f.rows?.[0]?.id ?? null;
  }
  if (!projectId) {
    const ins = await pool.query(
      `INSERT INTO projects (creator_id, title) VALUES ($1, $2) RETURNING id;`,
      [creatorId, title]
    );
    projectId = ins.rows[0].id;
  }

  // 4) split entries
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  const chapters = entries.filter(e => e.type === 'chapter');
  const notes    = entries.filter(e => e.type === 'note');
  const refs     = entries.filter(e => e.type === 'reference');

  // 5) replace children in a transaction (simple, consistent with MVP)
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`DELETE FROM chapters WHERE project_id = $1;`, [projectId]);
    await client.query(`DELETE FROM notes    WHERE project_id = $1;`, [projectId]);
    await client.query(`DELETE FROM refs     WHERE project_id = $1;`, [projectId]);

    // chapters
    for (const ch of chapters) {
      await client.query(
        `INSERT INTO chapters (project_id, creator_id, number, title, status, summary, tags, content)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8);`,
        [
          projectId,
          creatorId,
          Number.isFinite(ch.order_index) ? ch.order_index : null,
          ch.title || 'Untitled Chapter',
          (ch.status || 'draft'),
          ch.synopsis || '',
          Array.isArray(ch.tags) ? ch.tags : [],
          ch.body || ''
        ]
      );
    }

    // notes
    for (const n of notes) {
      await client.query(
        `INSERT INTO notes (project_id, creator_id, number, title, content, tags, category, pinned)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8);`,
        [
          projectId,
          creatorId,
          Number.isFinite(n.order_index) ? n.order_index : null,
          n.title || 'Untitled Note',
          n.body || '',
          Array.isArray(n.tags) ? n.tags : [],
          n.category || null,
          !!n.pinned
        ]
      );
    }

    // refs
    for (const r of refs) {
      await client.query(
        `INSERT INTO refs (project_id, creator_id, number, title, tags, type, summary, link, content)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9);`,
        [
          projectId,
          creatorId,
          Number.isFinite(r.order_index) ? r.order_index : null,
          r.title || 'Untitled Reference',
          Array.isArray(r.tags) ? r.tags : [],
          r.reference_type || null,
          r.summary || '',
          r.source_link || '',
          r.body || ''
        ]
      );
    }

    await client.query('COMMIT');
    return { ok: true, projectId, counts: { chapters: chapters.length, notes: notes.length, refs: refs.length } };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function clearWorkspaceDir(workspacePath) {
  try {
    if (workspacePath && fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  } catch (e) {
    // bubble up so callers can decide whether to ignore
    throw e;
  }
}

// ──────────────────────────────────────────────────────────────
// projects:syncToWorkspace → pull bundle from DB and write workspace/data/project.json
ipcMain.handle('projects:syncToWorkspace', async (_evt, { projectIdOrCode, workspacePath }) => {

  try {
    if (!workspacePath || typeof workspacePath !== 'string') {
      return { ok: false, error: 'workspacePath is required' };
    }

    // 1) Resolve project id and fetch bundle (reuse SQL similar to projects:bundle)
    const pid = await resolveProjectId(projectIdOrCode);
    if (!pid) return { ok: false, error: 'Unknown project.' };

    const qProject = pool.query(
      `SELECT id, code, title, creator_id, created_at, updated_at
         FROM projects
        WHERE id = $1
        LIMIT 1;`,
      [pid]
    );

    const qChapters = pool.query(
      `SELECT id, code, project_id, creator_id, number, title, status, summary,
              tags, content, created_at, updated_at
         FROM chapters
        WHERE project_id = $1
        ORDER BY number NULLS LAST, id;`,
      [pid]
    );

    const qNotes = pool.query(
      `SELECT id, code, project_id, creator_id, number, title, content,
              tags, category, pinned, created_at, updated_at
         FROM notes
        WHERE project_id = $1
        ORDER BY number NULLS LAST, id;`,
      [pid]
    );

    const qRefs = pool.query(
      `SELECT id, code, project_id, creator_id, number, title, tags, type,
              summary, link, content, created_at, updated_at
         FROM refs
        WHERE project_id = $1
        ORDER BY number NULLS LAST, id;`,
      [pid]
    );

    const [proj, ch, no, re] = await Promise.all([qProject, qChapters, qNotes, qRefs]);
    const project = proj.rows?.[0];
    if (!project) return { ok: false, error: 'Project not found.' };

    // 2) Map DB rows → renderer entries (aligns with your local app model)
    const nowISO = () => new Date().toISOString();
    const entries = [];

    // chapters → type: "chapter"
    for (const r of (ch.rows || [])) {
      entries.push({
        id: r.code || `db-ch-${r.id}`,
        type: 'chapter',
        title: r.title || 'Untitled Chapter',
        status: (r.status || 'draft').toLowerCase(),
        tags: Array.isArray(r.tags) ? r.tags : [],
        synopsis: r.summary || '',
        body: r.content || '',
        order_index: Number.isFinite(r.number) ? r.number : entries.filter(e => e.type === 'chapter').length,
        updated_at: r.updated_at || nowISO(),
        // word_goal is optional; if you added it in DB it will exist as r.word_goal
        word_goal: r.word_goal ?? 0
      });
    }

    // notes → type: "note"
    for (const r of (no.rows || [])) {
      entries.push({
        id: r.code || `db-no-${r.id}`,
        type: 'note',
        title: r.title || 'Untitled Note',
        tags: Array.isArray(r.tags) ? r.tags : [],
        category: r.category || 'Misc',
        pinned: !!r.pinned,
        body: r.content || '',
        order_index: Number.isFinite(r.number) ? r.number : entries.filter(e => e.type === 'note').length,
        updated_at: r.updated_at || nowISO(),
      });
    }

    // refs → type: "reference"
    for (const r of (re.rows || [])) {
      entries.push({
        id: r.code || `db-re-${r.id}`,
        type: 'reference',
        title: r.title || 'Untitled Reference',
        tags: Array.isArray(r.tags) ? r.tags : [],
        reference_type: r.type || 'Glossary',
        summary: r.summary || '',
        source_link: r.link || '',
        body: r.content || '',
        order_index: Number.isFinite(r.number) ? r.number : entries.filter(e => e.type === 'reference').length,
        updated_at: r.updated_at || nowISO(),
      });
    }

    // 3) Compose local project.json payload
    const data = {
      project: { name: project.title || 'Untitled Project', saved_at: nowISO() },
      entries,
      ui: {
        // keep defaults; renderer will set these on first write
        activeTab: 'chapters',
        selectedId: entries.find(e => e.type === 'chapter')?.id || entries[0]?.id || null,
        counters: { chapter: 1, note: 1, reference: 1 },
      },
      version: 1,
    };

    // 4) Write to <workspace>/data/project.json
    const saveFile = path.join(workspacePath, 'data', 'project.json');
    fs.mkdirSync(path.dirname(saveFile), { recursive: true });
    fs.writeFileSync(saveFile, JSON.stringify(data, null, 2), 'utf8');

    return { ok: true, saveFile, counts: {
      chapters: (ch.rows || []).length,
      notes: (no.rows || []).length,
      refs: (re.rows || []).length,
    }};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});
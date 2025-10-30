// ink-doodle/src/main/ipc.ts

// Use CommonJS so Node can load this via ts-node/register
const { ipcMain, app } = require('electron');
import { appendDebugLog, getGlobalLogPath } from './log';
import { pingDB, pool, downloadProjects, uploadProject } from './db';
require('./db.sync.ipc.ts'); // Register DB sync handlers
import type { Project, ProjectChanges } from './db.types';
import * as fs from 'fs';
import * as path from 'path';

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

// Get current logged in user
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

// Logout: Upload active project to DB and clear local data
ipcMain.handle('auth:logout', async (_evt, payload?: { projectPath?: string; workspaceExists?: boolean }) => {
  appendDebugLog('auth:logout — Starting logout process');
  try {
    const projectPath = payload?.projectPath;
    const workspaceExists = payload?.workspaceExists ?? false;
    
    appendDebugLog(`auth:logout — Workspace path: ${projectPath || '(none)'}`);
    appendDebugLog(`auth:logout — Workspace exists: ${workspaceExists}`);
    
    // 1) First, get the current user's ID for project creation
    const authQuery = await pool.query(
      `SELECT value->>'id' AS creator_id FROM prefs WHERE key = 'auth_user' LIMIT 1;`
    );
    const creatorId = Number(authQuery.rows?.[0]?.creator_id);
    if (!creatorId) {
      throw new Error('Could not determine current user ID');
    }

    // 2) Process all projects in InkDoodleProjects directory
    const projectsRoot = path.join(require('electron').app.getPath('documents'), 'InkDoodleProjects');
    
    if (!global.DB_SYNC_ENABLED) {
      appendDebugLog('auth:logout — Project upload disabled via DB_SYNC_ENABLED flag');
    } else if (fs.existsSync(projectsRoot)) {
      // First sync any deletions for existing projects
      const { syncDeletions } = require('./db.sync');
      await syncDeletions(creatorId, { ignoreMissing: false });
      appendDebugLog('auth:logout — Completed initial deletion sync');

      // Then process remaining projects
      const projectDirs = fs.readdirSync(projectsRoot).filter(d => 
        fs.statSync(path.join(projectsRoot, d)).isDirectory()
      );
      
      appendDebugLog(`auth:logout — Found ${projectDirs.length} projects to process`);
      
      for (const projectDir of projectDirs) {
        const fullPath = path.join(projectsRoot, projectDir);
        try {
          appendDebugLog(`auth:logout — Processing project at: ${fullPath}`);
        
          // Load the project and its items
          const projectFile = path.join(fullPath, 'data', 'project.json');
          if (fs.existsSync(projectFile)) {
            const raw = fs.readFileSync(projectFile, 'utf8');
            const data = JSON.parse(raw);
            // Extract project info from data
            const project: Project = {
              id: 0, // Will be assigned by DB
              code: data.project.code || '',
              title: data.project.name || data.project.title || 'Untitled Project',
              creator_id: creatorId,
              created_at: data.project.created_at || new Date().toISOString(),
              updated_at: data.project.saved_at || data.project.updated_at || new Date().toISOString(),
              chapters: [], // These arrays will be populated by the changes system
              notes: [],
              refs: []
            };
            appendDebugLog(`auth:logout — Loaded project: "${project.title}"`);
          
            // Load all items from their respective directories 
            const chaptersDir = path.join(fullPath, 'chapters');
            const notesDir = path.join(fullPath, 'notes'); 
            const refsDir = path.join(fullPath, 'refs');
          
            // Call syncToDB with project directory
            appendDebugLog(`auth:logout — Starting sync of project directory: ${fullPath}`);
            try {
              const { syncToDB } = require('./db.sync');
              const result = await syncToDB(creatorId, fullPath);
              if (!result.ok) {
                throw new Error(result.error);
              }
              appendDebugLog(`auth:logout — Successfully synced project "${project.title}" to DB`);
            } catch (syncError) {
              appendDebugLog(`auth:logout — Failed to sync project: ${syncError?.message || syncError}`);
              throw syncError;
            }
          } else {
            appendDebugLog(`auth:logout — No project.json found in ${fullPath}, skipping`);
          }
        } catch (e) {
          const errMsg = `Failed to save project to DB: ${e?.message || e}`;
          appendDebugLog(`auth:logout — ${errMsg}`);
          throw new Error(errMsg); // Rethrow to prevent logout if save fails
        }
      }
    } else {
      appendDebugLog('auth:logout — No projects directory found');
    }

    // Always clean up local files on logout, regardless of sync state
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

    // 3) Clear workspace if provided
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

    // No final sync needed - the local projects were already synced and saved
    appendDebugLog('auth:logout — Skipping final deletion sync since all projects were already processed');

    // 5) Clear auth_user in prefs
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

    try { appendDebugLog(`auth:login — User logged in: ${creator.email} (${creator.id})`); } catch (e) {}

    // 4) Download all user's projects to local files
    // Ensure projects directory exists even when not syncing
    const projectsRoot = path.join(require('electron').app.getPath('documents'), 'InkDoodleProjects');
    if (!fs.existsSync(projectsRoot)) {
      fs.mkdirSync(projectsRoot, { recursive: true });
    }

    if (!global.DB_SYNC_ENABLED) {
      appendDebugLog('auth:login — Project download disabled via DB_SYNC_ENABLED flag');
    } else {
      try {
        const projects = await downloadProjects(creator.id);
        
        // Ensure fresh projects directory
        if (fs.existsSync(projectsRoot)) {
          fs.rmSync(projectsRoot, { recursive: true, force: true });
        }
        fs.mkdirSync(projectsRoot, { recursive: true });

        // Save each project - ALWAYS use code as directory name for consistency
      for (const project of projects) {
        // Always use code as the directory name to ensure consistency
        const projectDir = path.join(projectsRoot, project.code);
        
        fs.mkdirSync(path.join(projectDir, 'data'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'chapters'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'notes'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'refs'), { recursive: true });

        // Write project.json with proper nesting structure and normalized title
        fs.writeFileSync(
          path.join(projectDir, 'data', 'project.json'),
          JSON.stringify({
            project: {
              ...project,
              displayTitle: project.title, // Preserve the display title
              name: project.title // For backwards compatibility
            },
            // Current state of entries
            entries: [
              ...project.chapters.map(ch => ({
                id: ch.code,
                type: 'chapter',
                title: ch.title,
                order_index: ch.number || 0,
                updated_at: ch.updated_at
              })),
              ...project.notes.map(n => ({
                id: n.code,
                type: 'note', 
                title: n.title,
                order_index: n.number || 0,
                updated_at: n.updated_at
              })),
              ...project.refs.map(r => ({
                id: r.code,
                type: 'reference',
                title: r.title,
                order_index: r.number || 0,
                updated_at: r.updated_at
              }))
            ],
            // Change tracking
            chapters: { added: [], updated: [], deleted: [] },
            notes: { added: [], updated: [], deleted: [] },
            refs: { added: [], updated: [], deleted: [] }
          }, null, 2),
          'utf8'
        );

        // Write chapters, notes, refs to their own files
        for (const ch of project.chapters) {
          fs.writeFileSync(
            path.join(projectDir, 'chapters', `${ch.code}.json`),
            JSON.stringify(ch, null, 2),
            'utf8'
          );
        }

        for (const note of project.notes) {
          fs.writeFileSync(
            path.join(projectDir, 'notes', `${note.code}.json`),
            JSON.stringify(note, null, 2),
            'utf8'
          );
        }

        for (const ref of project.refs) {
          fs.writeFileSync(
            path.join(projectDir, 'refs', `${ref.code}.json`),
            JSON.stringify(ref, null, 2),
            'utf8'
          );
        }
      }

        appendDebugLog(`auth:login — Downloaded ${projects.length} projects to local files`);
      } catch (e) {
        appendDebugLog(`auth:login — Warning: Failed to download projects: ${e?.message || e}`);
      }
    }

    return { ok: true, user: { ...creator } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
});

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
  try {
    const projectId = Number(payload?.projectIdOrCode);
    if (!projectId || isNaN(projectId)) {
      return { ok: false, error: 'Invalid project ID' };
    }

    // Get creator ID from auth user
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

    // Check sync status before downloading
    if (!global.DB_SYNC_ENABLED) {
      appendDebugLog('projects:bundle — Project download disabled via DB_SYNC_ENABLED flag');
      return { ok: false, error: 'Project sync is currently disabled' };
    }

    // Download all projects (we'll filter to the one we want)
    const projects = await downloadProjects(creatorId);
    const project = projects.find(p => p.id === projectId);
    
    if (!project) {
      return { ok: false, error: 'Project not found' };
    }

    // Save to local files
    const projectsRoot = path.join(require('electron').app.getPath('documents'), 'InkDoodleProjects');
    // Always use code as directory name for consistency
    const projectDir = path.join(projectsRoot, project.code);
    
    fs.mkdirSync(path.join(projectDir, 'data'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'chapters'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'refs'), { recursive: true });

    // Write project.json with proper nesting structure and normalized title
    fs.writeFileSync(
      path.join(projectDir, 'data', 'project.json'),
      JSON.stringify({
        project: {
          ...project,
          displayTitle: project.title, // Preserve the display title 
          name: project.title // For backwards compatibility
        },
        // Current state of entries
        entries: [
          ...project.chapters.map(ch => ({
            id: ch.code,
            type: 'chapter',
            title: ch.title,
            order_index: ch.number || 0,
            updated_at: ch.updated_at
          })),
          ...project.notes.map(n => ({
            id: n.code,
            type: 'note',
            title: n.title,
            order_index: n.number || 0,
            updated_at: n.updated_at
          })),
          ...project.refs.map(r => ({
            id: r.code,
            type: 'reference',
            title: r.title,
            order_index: r.number || 0,
            updated_at: r.updated_at
          }))
        ],
        // Change tracking
        chapters: { added: [], updated: [], deleted: [] },
        notes: { added: [], updated: [], deleted: [] },
        refs: { added: [], updated: [], deleted: [] }
      }, null, 2),
      'utf8'
    );

    // Write chapters, notes, refs to their own files
    for (const ch of project.chapters) {
      fs.writeFileSync(
        path.join(projectDir, 'chapters', `${ch.code}.json`),
        JSON.stringify(ch, null, 2),
        'utf8'
      );
    }

    for (const note of project.notes) {
      fs.writeFileSync(
        path.join(projectDir, 'notes', `${note.code}.json`),
        JSON.stringify(note, null, 2),
        'utf8'
      );
    }

    for (const ref of project.refs) {
      fs.writeFileSync(
        path.join(projectDir, 'refs', `${ref.code}.json`),
        JSON.stringify(ref, null, 2),
        'utf8'
      );
    }

    return { ok: true, project };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
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
      try {
        // Load project info
        const raw = fs.readFileSync(projectFile, 'utf8');
        const project = JSON.parse(raw);
        appendDebugLog(`app:willQuit — Loaded project from ${projectFile}`);

        // Get creator ID for sync
        const authQuery = await pool.query(
          `SELECT value->>'id' AS creator_id FROM prefs WHERE key = 'auth_user' LIMIT 1;`
        );
        const creatorId = Number(authQuery.rows?.[0]?.creator_id);
        if (!creatorId) {
          throw new Error('No logged in user found');
        }

        // Sync project directory to DB
        try {
          const { syncToDB, syncDeletions } = require('./db.sync');
          await syncToDB(creatorId, projectPath);
          appendDebugLog(`app:willQuit — Successfully synced project to DB`);

          // After syncing changes, handle deletions
          await syncDeletions(creatorId);
          appendDebugLog(`app:willQuit — Successfully synced deletions`);
        } catch (uploadError) {
          const errMsg = `DB upload failed: ${uploadError?.message || uploadError}`;
          appendDebugLog(`app:willQuit — ${errMsg}`);
          throw new Error(errMsg);
        }

      } catch (parseError) {
        const errMsg = `Failed to process project data: ${parseError?.message || parseError}`;
        appendDebugLog(`app:willQuit — ${errMsg}`);
        throw new Error(errMsg);
      }
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
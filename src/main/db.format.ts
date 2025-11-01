// db.format.ts
// Formatting and transformation helpers used by the upload code.
// This file will contain functions that convert local JSON shapes into the
// normalized shapes expected by the DB (e.g., mapping local codes/ids to DB
// columns, preparing parameter arrays for INSERT/UPDATE, etc.).
//
// NOTE: This is a scaffold file: the functions below throw if called and
// should be implemented when the upload flow is developed.

// Private: column names and keys for creators and projects tables.
// These are module-private constants used by future formatting/upload code.
const CREATORS = {
  ID: 'id',
  EMAIL: 'email',
  DISPLAY_NAME: 'display_name',
  CREATED_AT: 'created_at',
  IS_ACTIVE: 'is_active',
  UPDATED_AT: 'updated_at',
  LAST_LOGIN_AT: 'last_login_at'
} as const;

const PROJECTS = {
  ID: 'id',
  TITLE: 'title',
  CREATOR_ID: 'creator_id',
  CREATED_AT: 'created_at',
  UPDATED_AT: 'updated_at',
  CODE: 'code'
} as const;

/**
 * Load a local project directory and prepare a structured object suitable
 * for the uploader. This will call `collectProjectData` and return a small
 * object containing project and creator values used by the uploader.
 *
 * @param {string} projectPath - absolute path to the project directory
 * @returns {Promise<any>} structured project object ready for formatting
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { getColumnValue } from './db.query';

let lastLoadedProject: Record<string, any> | null = null;
let lastLoadedCreator: Record<string, any> | null = null;
let lastLoadedChapterCols: Record<string, any[]> | null = null;
let lastLoadedNoteCols: Record<string, any[]> | null = null;
let lastLoadedRefCols: Record<string, any[]> | null = null;

export async function loadProjectForUpload(projectPath: string): Promise<any> {
  const data = await collectProjectData(projectPath);
  return data;
}

/**
 * Helper: collectProjectData scans a project directory and returns raw
 * JSON objects for the project metadata and each entry (chapters/notes/refs).
 * This is a lower-level helper used by `loadProjectForUpload`.
 *
 * @param {string} projectPath - absolute path to the project directory
 * @returns {Promise<{project: any, chapters: any[], notes: any[], refs: any[]}>}
 */
export async function collectProjectData(projectPath: string): Promise<{project: any, creator: any, chapters: any[], notes: any[], refs: any[], chapter_ids: number[], note_ids: number[], ref_ids: number[], chapter_cols: Record<string, any[]>, note_cols: Record<string, any[]>, ref_cols: Record<string, any[]>}> {
  // Read project.json
  const projectFile = path.join(projectPath, 'data', 'project.json');
  let raw: any;
  try {
    const txt = await fs.readFile(projectFile, 'utf8');
    raw = JSON.parse(txt);
  } catch (err) {
    throw new Error(`collectProjectData: failed to read or parse project.json at ${projectFile}: ${err?.message || err}`);
  }

  const proj = raw?.project || {};

  // Map to DB column keys (use the private PROJECTS/CREATORS constants)
  // NOTE: DB expects `id` to be the project's code (text) and `code` to be the
  // numeric project id — reverse the local mapping accordingly.
  const nowIso = new Date().toISOString();

  const project = {
    [PROJECTS.ID]: proj.code ?? null,
    [PROJECTS.CODE]: proj.id ?? null,
    [PROJECTS.TITLE]: proj.title ?? null,
    [PROJECTS.CREATOR_ID]: proj.creator_id ?? null,
    [PROJECTS.CREATED_AT]: proj.created_at ?? null,
    // Ensure updated_at is set to current time when preparing for upload
    [PROJECTS.UPDATED_AT]: nowIso
  };

  const creator = {
    [CREATORS.ID]: proj.creator_id ?? null,
    [CREATORS.EMAIL]: null,
    [CREATORS.DISPLAY_NAME]: null,
    [CREATORS.CREATED_AT]: null,
    [CREATORS.IS_ACTIVE]: true,
    [CREATORS.UPDATED_AT]: nowIso,
    [CREATORS.LAST_LOGIN_AT]: null
  };

  // Save into private module variables for later use
  lastLoadedProject = project;
  lastLoadedCreator = creator;

  // If some creator fields are missing locally, try to enrich from DB
  try {
    const cid = creator[CREATORS.ID];
    if (cid) {
      // For each possibly-missing creator field, query the creators table for that column
      const fields = [
        { key: CREATORS.EMAIL, col: 'email' },
        { key: CREATORS.DISPLAY_NAME, col: 'display_name' },
        { key: CREATORS.CREATED_AT, col: 'created_at' },
        { key: CREATORS.UPDATED_AT, col: 'updated_at' },
        { key: CREATORS.LAST_LOGIN_AT, col: 'last_login_at' }
      ];

      for (const f of fields) {
        if (!creator[f.key]) {
          try {
            const val = await getColumnValue('creators', f.col, 'id = $1', [cid]);
            if (val !== null) creator[f.key] = val;
          } catch (e) {
            // ignore per-field failures, continue with others
          }
        }
      }
      lastLoadedCreator = creator;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('collectProjectData: failed to enrich creator from DB:', err?.message || err);
  }

  // Helper to read a directory of JSON entry files (if it exists).
  async function readEntries(dirName: string) {
    const dirPath = path.join(projectPath, dirName);
    const out: any[] = [];
    try {
      const files = await fs.readdir(dirPath);
      for (const f of files) {
        if (!f.toLowerCase().endsWith('.json')) continue;
        const fp = path.join(dirPath, f);
        try {
          const txt = await fs.readFile(fp, 'utf8');
          const parsed = JSON.parse(txt);
          // Some files wrap the payload (e.g., { chapter: {...} }) — normalize to keep the raw parsed object
          out.push(parsed);
        } catch (err) {
          // Skip unreadable/invalid files but continue with others
          // eslint-disable-next-line no-console
          console.warn(`collectProjectData: failed to read/parse ${fp}: ${err?.message || err}`);
        }
      }
    } catch (err) {
      // Directory may not exist — return empty array
    }
    return out;
  }

  const chapters = await readEntries('chapters');
  const notes = await readEntries('notes');
  const refs = await readEntries('refs');

  // Normalize entries (unwrap wrappers), set updated_at to current time.
  const nowIsoEntries = new Date().toISOString();

  function normalizeEntry(raw: any, wrapperKey?: string) {
    const item = wrapperKey && raw[wrapperKey] ? raw[wrapperKey] : raw;
    // ensure updated_at is set to now for upload
    item.updated_at = nowIsoEntries;
    return item;
  }

  const normChapters = chapters.map(c => normalizeEntry(c, 'chapter'));
  const normNotes = notes.map(n => normalizeEntry(n, 'note'));
  const normRefs = refs.map(r => normalizeEntry(r, 'ref'));

  // IDs are included as one of the fields in the per-column collections

  // Build per-field collections (collections-of-collections) for each entry type.
  const chapterCols: Record<string, any[]> = {
    id: [], code: [], project_id: [], creator_id: [], number: [], title: [], content: [],
    status: [], summary: [], tags: [], created_at: [], updated_at: [], word_goal: []
  };

  const noteCols: Record<string, any[]> = {
    id: [], code: [], project_id: [], creator_id: [], number: [], title: [], content: [],
    tags: [], category: [], pinned: [], created_at: [], updated_at: []
  };

  const refCols: Record<string, any[]> = {
    id: [], code: [], project_id: [], creator_id: [], number: [], title: [], tags: [],
    reference_type: [], summary: [], source_link: [], content: [], created_at: [], updated_at: []
  };

  for (const c of normChapters) {
    // DB expects `id` to be the chapter's code (text) and `code` to be the
    // local numeric id — reverse the local mapping accordingly (match projects mapping).
    chapterCols.id.push(c.code ?? null);
    chapterCols.code.push(c.id ?? null);
    // Use the project's DB-facing id (the project's code) for project_id so
    // foreign-key references match the projects.id column in the DB.
    chapterCols.project_id.push(project[PROJECTS.ID] ?? c.project_id ?? null);
    chapterCols.creator_id.push(c.creator_id ?? null);
    chapterCols.number.push(c.number ?? null);
    chapterCols.title.push(c.title ?? null);
    chapterCols.content.push(c.content ?? null);
    chapterCols.status.push(c.status ?? null);
    chapterCols.summary.push(c.summary ?? null);
    chapterCols.tags.push(c.tags ?? []);
    chapterCols.created_at.push(c.created_at ?? null);
    chapterCols.updated_at.push(c.updated_at ?? null);
    chapterCols.word_goal.push(c.word_goal ?? null);
  }

  for (const n of normNotes) {
    // Normalize note id/code to DB mapping: id <- code, code <- id
    noteCols.id.push(n.code ?? null);
    noteCols.code.push(n.id ?? null);
    // Ensure notes reference the project's DB-facing id (project code)
    noteCols.project_id.push(project[PROJECTS.ID] ?? n.project_id ?? null);
    noteCols.creator_id.push(n.creator_id ?? null);
    noteCols.number.push(n.number ?? null);
    noteCols.title.push(n.title ?? null);
    noteCols.content.push(n.content ?? null);
    noteCols.tags.push(n.tags ?? []);
    noteCols.category.push(n.category ?? null);
    noteCols.pinned.push(n.pinned ?? false);
    noteCols.created_at.push(n.created_at ?? null);
    noteCols.updated_at.push(n.updated_at ?? null);
  }

  for (const r of normRefs) {
    // Normalize ref id/code to DB mapping: id <- code, code <- id
    refCols.id.push(r.code ?? null);
    refCols.code.push(r.id ?? null);
    // Ensure refs reference the project's DB-facing id (project code)
    refCols.project_id.push(project[PROJECTS.ID] ?? r.project_id ?? null);
    refCols.creator_id.push(r.creator_id ?? null);
    refCols.number.push(r.number ?? null);
    refCols.title.push(r.title ?? null);
    refCols.tags.push(r.tags ?? []);
    refCols.reference_type.push(r.reference_type ?? null);
    refCols.summary.push(r.summary ?? null);
    refCols.source_link.push(r.source_link ?? null);
    refCols.content.push(r.content ?? null);
    refCols.created_at.push(r.created_at ?? null);
    refCols.updated_at.push(r.updated_at ?? null);
  }

  // Return normalized entries and per-field collections
  lastLoadedChapterCols = chapterCols;
  lastLoadedNoteCols = noteCols;
  lastLoadedRefCols = refCols;

  return {
    project,
    creator,
    chapters: normChapters,
    notes: normNotes,
    refs: normRefs,
    chapter_ids: chapterCols.id.slice(),
    note_ids: noteCols.id.slice(),
    ref_ids: refCols.id.slice(),
    chapter_cols: chapterCols,
    note_cols: noteCols,
    ref_cols: refCols
  };
}

// Expose getters for the last-loaded values (private module state)
export function getLastLoadedProject() {
  return lastLoadedProject;
}

export function getLastLoadedCreator() {
  return lastLoadedCreator;
}

export function getLastLoadedChapterIds() {
  return lastLoadedChapterCols ? (lastLoadedChapterCols.id || []).slice() : [];
}

export function getLastLoadedNoteIds() {
  return lastLoadedNoteCols ? (lastLoadedNoteCols.id || []).slice() : [];
}

export function getLastLoadedRefIds() {
  return lastLoadedRefCols ? (lastLoadedRefCols.id || []).slice() : [];
}

export function getLastLoadedChapterCols() {
  return lastLoadedChapterCols;
}

export function getLastLoadedNoteCols() {
  return lastLoadedNoteCols;
}

export function getLastLoadedRefCols() {
  return lastLoadedRefCols;
}

/**
 * Convert a columns-of-arrays object into an array of row objects.
 * Each key in `cols` is an array of values aligned by index. The result
 * is an array of objects where each object has the same keys with the
 * corresponding indexed values.
 */
export function convertColsToRows(cols: Record<string, any[]> | null): any[] {
  if (!cols) return [];
  const keys = Object.keys(cols);
  if (keys.length === 0) return [];
  const len = cols[keys[0]]?.length || 0;
  const rows: any[] = [];
  for (let i = 0; i < len; i++) {
    const row: Record<string, any> = {};
    for (const k of keys) {
      const arr = cols[k];
      row[k] = Array.isArray(arr) ? arr[i] : null;
    }
    rows.push(row);
  }
  return rows;
}

export function chapterColsToRows() {
  return convertColsToRows(lastLoadedChapterCols);
}

export function noteColsToRows() {
  return convertColsToRows(lastLoadedNoteCols);
}

export function refColsToRows() {
  return convertColsToRows(lastLoadedRefCols);
}

/**
 * Pop and return the next chapter row (as an object) from the loaded
 * chapter columns. If no chapters remain, returns null. This mutates the
 * module-private `lastLoadedChapterCols` so subsequent calls return
 * subsequent rows.
 */
export function getNextChapter(): Record<string, any> | null {
  if (!lastLoadedChapterCols) return null;
  const keys = Object.keys(lastLoadedChapterCols);
  if (keys.length === 0) return null;
  const len = lastLoadedChapterCols[keys[0]]?.length || 0;
  if (len === 0) return null;

  // Build the next row from the first element of each column array
  const row: Record<string, any> = {};
  for (const k of keys) {
    const arr = lastLoadedChapterCols[k];
    row[k] = Array.isArray(arr) ? arr[0] : null;
  }

  // Remove the first element from each column array
  for (const k of keys) {
    const arr = lastLoadedChapterCols[k];
    if (Array.isArray(arr)) arr.shift();
  }

  // IDs are stored in the column collections; no separate ID arrays to update.

  return row;
}

export function getNextNote(): Record<string, any> | null {
  if (!lastLoadedNoteCols) return null;
  const keys = Object.keys(lastLoadedNoteCols);
  if (keys.length === 0) return null;
  const len = lastLoadedNoteCols[keys[0]]?.length || 0;
  if (len === 0) return null;

  const row: Record<string, any> = {};
  for (const k of keys) {
    const arr = lastLoadedNoteCols[k];
    row[k] = Array.isArray(arr) ? arr[0] : null;
  }

  for (const k of keys) {
    const arr = lastLoadedNoteCols[k];
    if (Array.isArray(arr)) arr.shift();
  }

  return row;
}

export function getNextRef(): Record<string, any> | null {
  if (!lastLoadedRefCols) return null;
  const keys = Object.keys(lastLoadedRefCols);
  if (keys.length === 0) return null;
  const len = lastLoadedRefCols[keys[0]]?.length || 0;
  if (len === 0) return null;

  const row: Record<string, any> = {};
  for (const k of keys) {
    const arr = lastLoadedRefCols[k];
    row[k] = Array.isArray(arr) ? arr[0] : null;
  }

  for (const k of keys) {
    const arr = lastLoadedRefCols[k];
    if (Array.isArray(arr)) arr.shift();
  }

  return row;
}

// Export functions that expose the private schema constants so callers can
// inspect the column/key names used by the formatter/upload code.
export function getProjectColumns() {
  return PROJECTS;
}

export function getCreatorColumns() {
  return CREATORS;
}

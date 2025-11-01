import 'dotenv/config';
import { Pool } from 'pg';
import { appendDebugLog } from './log';
import type { Project, Chapter, Note, Reference } from './types/db.types';

const DATABASE_URL = process.env.DATABASE_URL!;

export const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// (Removed complex normalization helpers; child-item mapping is handled by upload flow)

export async function pingDB() {
  const { rows } = await pool.query('SELECT now() AS ts, version() AS version;');
  return rows[0];
}


export async function downloadProjects(creatorId: number): Promise<Project[]> {
  appendDebugLog(`db:download — Starting download of projects for creator ${creatorId}`);
  
  const projects = await pool.query<Project>(
    `SELECT id, code, title, creator_id, created_at, updated_at
     FROM projects 
     WHERE creator_id = $1
     ORDER BY updated_at DESC NULLS LAST, created_at DESC;`,
    [creatorId]
  );

  appendDebugLog(`db:download — Found ${projects.rows.length} projects to download`);
  const result: Project[] = [];

  for (const proj of projects.rows) {
    const [chapters, notes, refs] = await Promise.all([
      pool.query<Chapter>(
        `SELECT id, code, project_id, creator_id, number, title, content, 
                status, summary, tags, created_at, updated_at, word_goal
         FROM chapters
         WHERE project_id = $1
         ORDER BY number NULLS LAST, id;`,
        [proj.id]
      ),
      pool.query<Note>(
        `SELECT id, code, project_id, creator_id, number, title, content,
                tags, category, pinned, created_at, updated_at
         FROM notes
         WHERE project_id = $1
         ORDER BY number NULLS LAST, id;`,
        [proj.id]
      ),
      pool.query<Reference>(
        `SELECT id, code, project_id, creator_id, number, title, tags,
                reference_type as type, summary, source_link as link, content,
                created_at, updated_at
         FROM refs
         WHERE project_id = $1
         ORDER BY number NULLS LAST, id;`,
        [proj.id]
      )
    ]);

    result.push({
      ...proj,
      chapters: chapters.rows,
      notes: notes.rows,
      refs: refs.rows
    });

    appendDebugLog(`db:download — Project "${proj.title}" (${proj.code}):
      - ${chapters.rows.length} chapters
      - ${notes.rows.length} notes
      - ${refs.rows.length} references`);
  }

  appendDebugLog(`db:download — Successfully downloaded ${result.length} projects with all their items`);
  return result;
}
// The following DB write helpers (create/edit/delete/upload) were removed
// intentionally to ensure the application cannot perform local->DB writes.
// Only read/download helpers (e.g., `downloadProjects`) remain in this
// module. If you need these operations re-enabled later, consider
// reintroducing them behind a controlled feature flag.

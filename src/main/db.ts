import 'dotenv/config';
import { Pool } from 'pg';
import { 
    validateProject, validateChapter, validateNote, validateReference,
    withTransaction, handleDatabaseError 
} from './db.utils';
import { DatabaseError } from './db.errors';
import type { Project, Chapter, Note, Reference, ProjectChanges, EntityChanges } from './types/db.types';

const DATABASE_URL = process.env.DATABASE_URL!;

export const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

export async function pingDB() {
  const { rows } = await pool.query('SELECT now() AS ts, version() AS version;');
  return rows[0];
}

import { appendDebugLog } from './log';

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
                reference_type, summary, source_link, content,
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

export async function createProject(creatorId: number, title: string): Promise<Project> {
    validateProject({ creator_id: creatorId, title });
    
    return withTransaction(pool, async (client) => {
        try {
            const result = await client.query<Project>(
                `INSERT INTO projects (creator_id, title) 
                 VALUES ($1, $2) 
                 RETURNING id, code, title, creator_id, created_at, updated_at`,
                [creatorId, title]
            );

            const project = result.rows[0];
            if (!project) {
                throw new DatabaseError('Failed to create project');
            }

            project.chapters = [];
            project.notes = [];
            project.refs = [];

            return project;
        } catch (error) {
            throw handleDatabaseError(error);
        }
    });
}

export async function editChapter(chapter: Chapter): Promise<Chapter> {
  const result = await pool.query<Chapter>(
    `UPDATE chapters 
     SET number = $1, title = $2, content = $3, status = $4,
         summary = $5, tags = $6, word_goal = $7, updated_at = now()
     WHERE code = $8
     RETURNING *`,
    [chapter.number, chapter.title, chapter.content, chapter.status,
     chapter.summary, chapter.tags, chapter.word_goal, chapter.code]
  );
  return result.rows[0];
}

export async function editNote(note: Note): Promise<Note> {
  const result = await pool.query<Note>(
    `UPDATE notes 
     SET number = $1, title = $2, content = $3, tags = $4,
         category = $5, pinned = $6, updated_at = now()
     WHERE code = $7
     RETURNING *`,
    [note.number, note.title, note.content, note.tags,
     note.category, note.pinned, note.code]
  );
  return result.rows[0];
}

export async function editReference(ref: Reference): Promise<Reference> {
  const result = await pool.query<Reference>(
    `UPDATE refs 
     SET number = $1, title = $2, tags = $3, reference_type = $4,
         summary = $5, source_link = $6, content = $7, updated_at = now()
     WHERE code = $8
     RETURNING *`,
    [ref.number, ref.title, ref.tags, ref.reference_type,
     ref.summary, ref.source_link, ref.content, ref.code]
  );
  return result.rows[0];
}

export async function createChapter(chapter: Omit<Chapter, 'id' | 'code' | 'created_at' | 'updated_at'>): Promise<Chapter> {
  const result = await pool.query<Chapter>(
    `INSERT INTO chapters (project_id, creator_id, number, title, content, status, summary, tags, word_goal)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [chapter.project_id, chapter.creator_id, chapter.number, chapter.title,
     chapter.content, chapter.status, chapter.summary, chapter.tags, chapter.word_goal]
  );
  return result.rows[0];
}

export async function createNote(note: Omit<Note, 'id' | 'code' | 'created_at' | 'updated_at'>): Promise<Note> {
  const result = await pool.query<Note>(
    `INSERT INTO notes (project_id, creator_id, number, title, content, tags, category, pinned)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [note.project_id, note.creator_id, note.number, note.title,
     note.content, note.tags, note.category, note.pinned]
  );
  return result.rows[0];
}

export async function createReference(ref: Omit<Reference, 'id' | 'code' | 'created_at' | 'updated_at'>): Promise<Reference> {
  const result = await pool.query<Reference>(
    `INSERT INTO refs (project_id, creator_id, number, title, tags, reference_type, summary, source_link, content)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [ref.project_id, ref.creator_id, ref.number, ref.title, ref.tags,
     ref.reference_type, ref.summary, ref.source_link, ref.content]
  );
  return result.rows[0];
}

export async function deleteItem(type: 'chapter' | 'note' | 'reference', code: string): Promise<void> {
  const table = type === 'chapter' ? 'chapters' : type === 'note' ? 'notes' : 'refs';
  await pool.query(`DELETE FROM ${table} WHERE code = $1`, [code]);
}

export async function deleteProject(projectId: number): Promise<void> {
  await withTransaction(pool, async (client) => {
    // Delete all related items first
    await client.query('DELETE FROM chapters WHERE project_id = $1', [projectId]);
    await client.query('DELETE FROM notes WHERE project_id = $1', [projectId]);
    await client.query('DELETE FROM refs WHERE project_id = $1', [projectId]);
    // Then delete the project itself
    await client.query('DELETE FROM projects WHERE id = $1', [projectId]);
  });
}

export async function uploadProject(changes: ProjectChanges): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    appendDebugLog(`db:upload — Starting upload of project "${changes.project?.title || 'unknown'}"`);

    // Create or update project
    if (changes.project) {
      // Check if project exists
      const projectCheck = await client.query(
        `SELECT id FROM projects WHERE id = $1 OR code = $2`,
        [changes.project.id, changes.project.code]
      );

      if (projectCheck.rows.length === 0) {
        // Project doesn't exist - create it
        appendDebugLog(`db:upload — Creating new project "${changes.project.title}" in database`);
        const result = await client.query(
          `INSERT INTO projects (creator_id, title)
           VALUES ($1, $2)
           RETURNING id, code`,
          [changes.project.creator_id, changes.project.title]
        );
        // Update the changes object with the new project ID and code
        changes.project.id = result.rows[0].id;
        changes.project.code = result.rows[0].code;
        appendDebugLog(`db:upload — Created project with ID ${result.rows[0].id} and code ${result.rows[0].code}`);
      } else {
        // Project exists - update it
        appendDebugLog(`db:upload — Updating existing project "${changes.project.title}" (ID: ${changes.project.id})`);
        await client.query(
          `UPDATE projects 
           SET title = $1, updated_at = now()
           WHERE id = $2`,
          [changes.project.title, changes.project.id]
        );
      }
    }

    // Handle chapters
    appendDebugLog(`db:upload — Processing chapters:
      - ${changes.chapters.added.length} new
      - ${changes.chapters.updated.length} updates
      - ${changes.chapters.deleted.length} deletions`);
    
    for (const ch of changes.chapters.added) {
      appendDebugLog(`db:upload — Creating new chapter "${ch.title}"`);
      await createChapter(ch);
    }
    for (const ch of changes.chapters.updated) {
      appendDebugLog(`db:upload — Updating chapter "${ch.title}" (${ch.code})`);
      await editChapter(ch);
    }
    for (const code of changes.chapters.deleted) {
      appendDebugLog(`db:upload — Deleting chapter ${code}`);
      await deleteItem('chapter', code);
    }

    // Handle notes
    appendDebugLog(`db:upload — Processing notes:
      - ${changes.notes.added.length} new
      - ${changes.notes.updated.length} updates
      - ${changes.notes.deleted.length} deletions`);
    
    for (const note of changes.notes.added) {
      appendDebugLog(`db:upload — Creating new note "${note.title}"`);
      await createNote(note);
    }
    for (const note of changes.notes.updated) {
      appendDebugLog(`db:upload — Updating note "${note.title}" (${note.code})`);
      await editNote(note);
    }
    for (const code of changes.notes.deleted) {
      appendDebugLog(`db:upload — Deleting note ${code}`);
      await deleteItem('note', code);
    }

    // Handle refs
    appendDebugLog(`db:upload — Processing references:
      - ${changes.refs.added.length} new
      - ${changes.refs.updated.length} updates
      - ${changes.refs.deleted.length} deletions`);
    
    for (const ref of changes.refs.added) {
      appendDebugLog(`db:upload — Creating new reference "${ref.title}"`);
      await createReference(ref);
    }
    for (const ref of changes.refs.updated) {
      appendDebugLog(`db:upload — Updating reference "${ref.title}" (${ref.code})`);
      await editReference(ref);
    }
    for (const code of changes.refs.deleted) {
      appendDebugLog(`db:upload — Deleting reference ${code}`);
      await deleteItem('reference', code);
    }

    await client.query('COMMIT');
    appendDebugLog(`db:upload — Successfully completed upload of project "${changes.project?.title || 'unknown'}"`);
  } catch (error) {
    await client.query('ROLLBACK');
    appendDebugLog(`db:upload — Error during upload: ${error?.message || String(error)}`);
    throw error;
  } finally {
    client.release();
  }
}

// db.sync.ts - DB -> local sync helpers (downloads only). Local->DB
// upload helpers have been disabled to avoid accidental writes.
const { app } = require("electron");
const path = require("path");
const fs = require("fs");
import { pool } from "./db";
import { appendDebugLog } from "./log";

interface WorkspaceLogContext {
  operation: string;
  entryType?: 'chapter' | 'note' | 'reference';
  entryId?: string;
  details?: Record<string, any>;
}

function logWorkspaceOperation({ operation, entryType, entryId, details }: WorkspaceLogContext) {
  const detailsStr = details ? ` ${JSON.stringify(details)}` : '';
  const entryInfo = entryType && entryId ? ` [${entryType}:${entryId}]` : '';
  appendDebugLog(`workspace:${operation}${entryInfo} —${detailsStr}`);
}
import type { Project, Chapter, Note, Reference } from './types/db.types';

// Upload-related helpers removed.
// Functions that performed local->DB filesystem operations (directory
// recreation and workspace-to-project copying) were intentionally
// removed to avoid accidental remote writes. Only DB->local sync
// functionality remains in this module.

// saveWorkspaceToLocal removed — this was upload-only logic.

// syncToDB and syncDeletions removed — upload/deletion operations are
// intentionally deleted from the codebase to prevent accidental writes.

export async function syncFromDB(creatorId: number) {
  try {
    appendDebugLog(`db:sync — Starting incremental DB sync for creator ${creatorId}`);
    const projectsRoot = path.join(app.getPath("documents"), "InkDoodleProjects");
    let totalProjectCount = 0;

    // 1. Get project list (lightweight query - just metadata)
    const projectList = await pool.query<Project>(
      `SELECT id, code, title, created_at, updated_at
       FROM projects 
       WHERE creator_id = $1
       ORDER BY updated_at DESC NULLS LAST, created_at DESC;`,
      [creatorId]
    );
    
    for (const project of projectList.rows) {
      const projectDir = path.join(projectsRoot, project.code);
      
      // Create project directory structure
      fs.mkdirSync(path.join(projectDir, "data"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, "chapters"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, "notes"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, "refs"), { recursive: true });

      // Initialize basic project.json with metadata
      const initialProjectData = {
        project: {
          title: project.title,
          name: project.title,
          code: project.code,
          created_at: project.created_at,
          updated_at: project.updated_at,
          saved_at: new Date().toISOString()
        },
        entries: [],
        ui: {
          activeTab: "chapters",
          selectedId: null,
          counters: { chapter: 1, note: 1, reference: 1 }
        },
        version: 1
      };

      // Write initial project.json
      fs.writeFileSync(
        path.join(projectDir, "data", "project.json"),
        JSON.stringify(initialProjectData, null, 2),
        "utf8"
      );

      // 2. Load chapters in batches
      const chapters = await pool.query<Chapter>(
        `SELECT id, code, project_id, creator_id, number, title, content, 
                status, summary, tags, created_at, updated_at, word_goal
         FROM chapters
         WHERE project_id = $1
         ORDER BY number NULLS LAST, id;`,
        [project.id]
      );

      const projectData = initialProjectData;
      
      // Process chapters
      for (const ch of chapters.rows) {
        const chapterEntry = {
          id: ch.code,
          type: 'chapter',
          title: ch.title,
          status: ch.status || 'Draft',
          synopsis: ch.summary || '',
          tags: ch.tags || [],
          body: ch.content || '',
          word_goal: ch.word_goal || 0,
          order_index: ch.number || 0,
          created_at: ch.created_at,
          updated_at: ch.updated_at,
          project_code: project.code
        };
        
        // Add to entries list
        projectData.entries.push(chapterEntry);
        
        // Write chapter file in the app's normalized format (not raw DB row)
        fs.writeFileSync(
          path.join(projectDir, "chapters", `${ch.code}.json`),
          JSON.stringify(chapterEntry, null, 2),
          "utf8"
        );
      }

      // 3. Load notes in batches
      const notes = await pool.query<Note>(
        `SELECT id, code, project_id, creator_id, number, title, content,
                tags, category, pinned, created_at, updated_at
         FROM notes
         WHERE project_id = $1
         ORDER BY number NULLS LAST, id;`,
        [project.id]
      );

      // Process notes
      for (const n of notes.rows) {
        const noteEntry = {
          id: n.code,
          type: 'note',
          title: n.title,
          tags: n.tags || [],
          category: n.category || 'Misc',
          pinned: !!n.pinned,
          body: n.content || '',
          order_index: n.number || 0,
          created_at: n.created_at,
          updated_at: n.updated_at,
          project_code: project.code
        };

        // Add to entries list
        projectData.entries.push(noteEntry);

        // Write note file in the app's normalized format (not raw DB row)
        fs.writeFileSync(
          path.join(projectDir, "notes", `${n.code}.json`),
          JSON.stringify(noteEntry, null, 2),
          "utf8"
        );
      }

      // 4. Load references in batches
      const refs = await pool.query<Reference>(
        `SELECT id, code, project_id, creator_id, number, title, tags,
                reference_type, summary, source_link, content,
                created_at, updated_at
         FROM refs
         WHERE project_id = $1
         ORDER BY number NULLS LAST, id;`,
        [project.id]
      );

      // Process references
      for (const r of refs.rows) {
        const refEntry = {
          id: r.code,
          type: 'reference',
          title: r.title,
          tags: r.tags || [],
          reference_type: r.reference_type || 'Glossary',
          summary: r.summary || '',
          source_link: r.source_link || '',
          body: r.content || '',
          order_index: r.number || 0,
          created_at: r.created_at,
          updated_at: r.updated_at,
          project_code: project.code
        };

        // Add to entries list
        projectData.entries.push(refEntry);

        // Write reference file in the app's normalized format (not raw DB row)
        fs.writeFileSync(
          path.join(projectDir, "refs", `${r.code}.json`),
          JSON.stringify(refEntry, null, 2),
          "utf8"
        );
      }

      // Update counters based on actual counts
      projectData.ui.counters = {
        chapter: chapters.rows.length + 1,
        note: notes.rows.length + 1,
        reference: refs.rows.length + 1
      };

      // Update final project.json with all entries
      fs.writeFileSync(
        path.join(projectDir, "data", "project.json"),
        JSON.stringify(projectData, null, 2),
        "utf8"
      );

      appendDebugLog(`db:sync — Synced project "${project.title}" with ${chapters.rows.length} chapters, ${notes.rows.length} notes, ${refs.rows.length} references`);
      totalProjectCount++;
    }

    appendDebugLog(`db:sync — Successfully synced ${totalProjectCount} projects from DB`);
    return { 
      ok: true, 
      projectCount: totalProjectCount,
      reloadNeeded: totalProjectCount > 0 
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendDebugLog(`db:sync — Failed: ${msg}`);
    return { ok: false, error: msg };
  }
}
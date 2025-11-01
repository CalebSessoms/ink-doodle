// db.upload.ts
// Controlled local->DB upload logic. This module provides helpers to scan
// local project directories, collect prepared payloads (via db.format), and
// perform transactional uploads into the Postgres DB. Uploads are gated and
// should only be enabled explicitly by the caller.

import * as fs from 'fs/promises';
import * as path from 'path';
import { appendDebugLog } from './log';
import { loadProjectForUpload, getLastLoadedProject, getLastLoadedCreator } from './db.format';
import { getColumnValue, getProjectIdsForCreator, getChapterIdsForCreator, getNoteIdsForCreator, getRefIdsForCreator } from './db.query';
import { chapterColsToRows, getNextChapter, getNextNote, getNextRef } from './db.format';
import { pool } from './db';

/**
 * Minimal db.upload module: only the local project counter remains.
 * This file intentionally omits any DB write or upload logic.
 */
export async function countLocalProjects(rootDir: string): Promise<number> {
  appendDebugLog(`db.upload:countLocalProjects scanning ${rootDir}`);
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    let count = 0;
    for (const e of entries as any[]) {
      if (!e.isDirectory()) continue;
      const projectJson = path.join(rootDir, e.name, 'data', 'project.json');
      try {
        const stat = await fs.stat(projectJson);
        if (stat.isFile()) count += 1;
      } catch (err) {
        // ignore missing project.json files
      }
    }
    appendDebugLog(`db.upload:countLocalProjects found ${count} projects under ${rootDir}`);
    return count;
  } catch (err) {
    appendDebugLog(`db.upload:countLocalProjects failed to read ${rootDir}: ${(err as Error).message}`);
    return 0;
  }
}

/**
 * Base uploader function (stub).
 * This is the minimal placeholder for the upload flow. It intentionally
 * performs no DB writes and returns a neutral result. It exists so callers
 * can import and call an uploader function without triggering any side
 * effects until a full implementation is added.
 */
export async function uploadLocalProjects(rootDir: string, options?: { performUpload?: boolean }) {
  const performUpload = !!options?.performUpload;
  appendDebugLog(`db.upload: uploadLocalProjects (enumerate) called; performUpload=${performUpload} rootDir=${rootDir}`);

  // Enumerate immediate subdirectories that contain a data/project.json file.
  const entries = await fs.readdir(rootDir, { withFileTypes: true }) as any[];
  // Track local ids per-creator so we can detect deletions in DB later.
  const localProjectsByCreator: Map<string, Set<string>> = new Map();
  const localChaptersByCreator: Map<string, Set<string>> = new Map();
  const localNotesByCreator: Map<string, Set<string>> = new Map();
  const localRefsByCreator: Map<string, Set<string>> = new Map();

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const pj = path.join(rootDir, e.name, 'data', 'project.json');
    const stat = await fs.stat(pj);
    if (stat.isFile()) {
      // Single-variable-per-iteration: capture the project path and log it.
  const projectPath = path.join(rootDir, e.name);
  appendDebugLog(`db.upload: project found: ${projectPath}`);
  appendDebugLog(`db.upload: loading project for upload: ${projectPath}`);
  await loadProjectForUpload(projectPath);
      // Capture formatted values once for this iteration
      const collectedProject = getLastLoadedProject();
      const collectedCreator = getLastLoadedCreator();

      // Verify creator exists in DB. If not, skip this project.
      const creatorId = collectedCreator?.id ?? collectedCreator?.["id"] ?? null;
      if (!creatorId) {
        appendDebugLog(`db.upload: no creator id for project at ${projectPath}; skipping`);
        continue;
      }

      const foundCreator = await getColumnValue('creators', 'id', 'id = $1', [creatorId]);
      if (!foundCreator) {
        appendDebugLog(`db.upload: creator not found for id=${creatorId}; skipping project ${projectPath}`);
        continue;
      }

      // Creator exists — now check whether the project already exists in the DB.
      try {
        const projectId = collectedProject?.id ?? collectedProject?.["id"] ?? null;
        // Now check chapters: for each chapter entry, log whether it exists in DB.
        if (!projectId) {
          appendDebugLog(`db.upload: collected project has no id; skipping project at ${projectPath}`);
          continue;
        }

        const foundProject = await getColumnValue('projects', 'id', 'id = $1', [projectId]);
        // Record this local project id for the creator so we can compare with DB later.
        try {
          const s = localProjectsByCreator.get(String(creatorId)) || new Set<string>();
          s.add(String(projectId));
          localProjectsByCreator.set(String(creatorId), s);
        } catch (e) {
          // ignore tracking failures
        }
        // Project upsert: if project exists, UPDATE selected fields; otherwise INSERT full project.
        try {
          if (foundProject) {
            const updFields = {
              title: collectedProject?.title ?? null,
              updated_at: collectedProject?.updated_at ?? new Date().toISOString()
            };
            appendDebugLog(`db.upload: project exists id=${projectId}; will UPDATE fields: ${Object.keys(updFields).join(', ')} (performUpload=${performUpload})`);
            if (performUpload) {
              try {
                await pool.query(
                  `UPDATE projects SET title = $1, updated_at = $2 WHERE id = $3`,
                  [updFields.title, updFields.updated_at, projectId]
                );
                appendDebugLog(`db.upload: updated project id=${projectId}`);
              } catch (err) {
                appendDebugLog(`db.upload: failed to update project id=${projectId}: ${(err as Error).message}`);
              }
            }
          } else {
            const insertParams = [
              projectId,
              collectedProject?.code ?? null,
              collectedProject?.title ?? null,
              creatorId,
              collectedProject?.created_at ?? new Date().toISOString(),
              collectedProject?.updated_at ?? new Date().toISOString()
            ];
            appendDebugLog(`db.upload: project id=${projectId} not found; will INSERT new project (performUpload=${performUpload})`);
            if (performUpload) {
              try {
                await pool.query(
                  `INSERT INTO projects (id, code, title, creator_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6)`,
                  insertParams
                );
                appendDebugLog(`db.upload: inserted project id=${projectId}`);
              } catch (err) {
                appendDebugLog(`db.upload: failed to insert project id=${projectId}: ${(err as Error).message}`);
              }
            }
          }
        } catch (err) {
          appendDebugLog(`db.upload: error during project upsert for ${projectId}: ${(err as Error).message}`);
        }
        const titleStart = (collectedProject && collectedProject.title) ? String(collectedProject.title).slice(0, 64) : '<untitled>';

        // Iterate chapters via getNextChapter and perform upsert (dry-run unless performUpload=true).
        try {
          let ch = getNextChapter();
          while (ch) {
            const idVal = ch?.id ?? ch?.["id"] ?? null;
            const idType = idVal === null || idVal === undefined ? String(idVal) : typeof idVal;
            appendDebugLog(`db.upload: chapter debug id: ${String(idVal)} (type: ${idType})`);

            if (!idVal) {
              appendDebugLog(`db.upload: chapter has no id; skipping this chapter for project ${projectId}`);
              ch = getNextChapter();
              continue;
            }

            // record local chapter id for creator deletion checks later
            try {
              const s = localChaptersByCreator.get(String(creatorId)) || new Set<string>();
              s.add(String(idVal));
              localChaptersByCreator.set(String(creatorId), s);
            } catch (e) {
              // ignore tracking failures
            }

            try {
              const existing = await getColumnValue('chapters', 'id', 'id = $1', [idVal]);
              if (existing) {
                // Chapter exists — perform an UPDATE of selected fields
                const updFields = {
                  title: ch.title ?? null,
                  content: ch.content ?? null,
                  status: ch.status ?? null,
                  summary: ch.summary ?? null,
                  tags: ch.tags ?? [],
                  updated_at: ch.updated_at ?? new Date().toISOString(),
                  word_goal: ch.word_goal ?? null
                };

                appendDebugLog(`db.upload: chapter exists id=${idVal}; will UPDATE fields: ${Object.keys(updFields).join(', ')} (performUpload=${performUpload})`);

                if (performUpload) {
                  try {
                    await pool.query(
                      `UPDATE chapters SET title = $1, content = $2, status = $3, summary = $4, tags = $5, updated_at = $6, word_goal = $7 WHERE id = $8`,
                      [updFields.title, updFields.content, updFields.status, updFields.summary, updFields.tags, updFields.updated_at, updFields.word_goal, idVal]
                    );
                    appendDebugLog(`db.upload: updated chapter id=${idVal}`);
                  } catch (err) {
                    appendDebugLog(`db.upload: failed to update chapter id=${idVal}: ${(err as Error).message}`);
                  }
                }
              } else {
                // Chapter does not exist — INSERT full row
                const insertParams = [
                  ch.id ?? null,
                  ch.code ?? null,
                  ch.project_id ?? projectId,
                  ch.creator_id ?? creatorId,
                  ch.number ?? null,
                  ch.title ?? null,
                  ch.content ?? null,
                  ch.status ?? null,
                  ch.summary ?? null,
                  ch.tags ?? [],
                  ch.created_at ?? new Date().toISOString(),
                  ch.updated_at ?? new Date().toISOString(),
                  ch.word_goal ?? null
                ];

                appendDebugLog(`db.upload: chapter id=${idVal} not found; will INSERT new chapter (performUpload=${performUpload})`);

                if (performUpload) {
                  try {
                    await pool.query(
                      `INSERT INTO chapters (id, code, project_id, creator_id, number, title, content, status, summary, tags, created_at, updated_at, word_goal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                      insertParams
                    );
                    appendDebugLog(`db.upload: inserted chapter id=${idVal}`);
                  } catch (err) {
                    appendDebugLog(`db.upload: failed to insert chapter id=${idVal}: ${(err as Error).message}`);
                  }
                }
              }
            } catch (err) {
              appendDebugLog(`db.upload: error checking/inserting/updating chapter id=${idVal} for project ${projectId}: ${(err as Error).message}`);
            }

            ch = getNextChapter();
          }
        } catch (err) {
          appendDebugLog(`db.upload: failed iterating chapters for project ${projectId || collectedProject?.id}: ${(err as Error).message}`);
        }

        // Notes: mirror chapter upsert behavior (UPDATE selected fields or INSERT full row)
        try {
          let n = getNextNote();
          while (n) {
            const idVal = n?.id ?? n?.["id"] ?? null;
            const idType = idVal === null || idVal === undefined ? String(idVal) : typeof idVal;
            appendDebugLog(`db.upload: note debug id: ${String(idVal)} (type: ${idType})`);

            if (!idVal) {
              appendDebugLog(`db.upload: note has no id; skipping this note for project ${projectId}`);
              n = getNextNote();
              continue;
            }

            // record local note id for creator deletion checks later
            try {
              const s = localNotesByCreator.get(String(creatorId)) || new Set<string>();
              s.add(String(idVal));
              localNotesByCreator.set(String(creatorId), s);
            } catch (e) {
              // ignore tracking failures
            }

            try {
              const existing = await getColumnValue('notes', 'id', 'id = $1', [idVal]);
              if (existing) {
                const updFields = {
                  title: n.title ?? null,
                  content: n.content ?? null,
                  tags: n.tags ?? [],
                  category: n.category ?? null,
                  pinned: n.pinned ?? false,
                  updated_at: n.updated_at ?? new Date().toISOString()
                };

                appendDebugLog(`db.upload: note exists id=${idVal}; will UPDATE fields: ${Object.keys(updFields).join(', ')} (performUpload=${performUpload})`);

                if (performUpload) {
                  try {
                    await pool.query(
                      `UPDATE notes SET title = $1, content = $2, tags = $3, category = $4, pinned = $5, updated_at = $6 WHERE id = $7`,
                      [updFields.title, updFields.content, updFields.tags, updFields.category, updFields.pinned, updFields.updated_at, idVal]
                    );
                    appendDebugLog(`db.upload: updated note id=${idVal}`);
                  } catch (err) {
                    appendDebugLog(`db.upload: failed to update note id=${idVal}: ${(err as Error).message}`);
                  }
                }
              } else {
                const insertParams = [
                  n.id ?? null,
                  n.code ?? null,
                  n.project_id ?? projectId,
                  n.creator_id ?? creatorId,
                  n.number ?? null,
                  n.title ?? null,
                  n.content ?? null,
                  n.tags ?? [],
                  n.category ?? null,
                  n.pinned ?? false,
                  n.created_at ?? new Date().toISOString(),
                  n.updated_at ?? new Date().toISOString()
                ];

                appendDebugLog(`db.upload: note id=${idVal} not found; will INSERT new note (performUpload=${performUpload})`);

                if (performUpload) {
                  try {
                    await pool.query(
                      `INSERT INTO notes (id, code, project_id, creator_id, number, title, content, tags, category, pinned, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                      insertParams
                    );
                    appendDebugLog(`db.upload: inserted note id=${idVal}`);
                  } catch (err) {
                    appendDebugLog(`db.upload: failed to insert note id=${idVal}: ${(err as Error).message}`);
                  }
                }
              }
            } catch (err) {
              appendDebugLog(`db.upload: error checking/inserting/updating note id=${idVal} for project ${projectId}: ${(err as Error).message}`);
            }

            n = getNextNote();
          }
        } catch (err) {
          appendDebugLog(`db.upload: failed iterating notes for project ${projectId || collectedProject?.id}: ${(err as Error).message}`);
        }

        // Refs: mirror chapter upsert behavior
        try {
          let r = getNextRef();
          while (r) {
            const idVal = r?.id ?? r?.["id"] ?? null;
            const idType = idVal === null || idVal === undefined ? String(idVal) : typeof idVal;
            appendDebugLog(`db.upload: ref debug id: ${String(idVal)} (type: ${idType})`);

            if (!idVal) {
              appendDebugLog(`db.upload: ref has no id; skipping this ref for project ${projectId}`);
              r = getNextRef();
              continue;
            }

            // record local ref id for creator deletion checks later
            try {
              const s = localRefsByCreator.get(String(creatorId)) || new Set<string>();
              s.add(String(idVal));
              localRefsByCreator.set(String(creatorId), s);
            } catch (e) {
              // ignore tracking failures
            }

            try {
              const existing = await getColumnValue('refs', 'id', 'id = $1', [idVal]);
              if (existing) {
                const updFields = {
                  title: r.title ?? null,
                  content: r.content ?? null,
                  summary: r.summary ?? null,
                  tags: r.tags ?? [],
                  reference_type: r.reference_type ?? null,
                  source_link: r.source_link ?? null,
                  updated_at: r.updated_at ?? new Date().toISOString()
                };

                appendDebugLog(`db.upload: ref exists id=${idVal}; will UPDATE fields: ${Object.keys(updFields).join(', ')} (performUpload=${performUpload})`);

                if (performUpload) {
                  try {
                    await pool.query(
                      `UPDATE refs SET title = $1, content = $2, summary = $3, tags = $4, reference_type = $5, source_link = $6, updated_at = $7 WHERE id = $8`,
                      [updFields.title, updFields.content, updFields.summary, updFields.tags, updFields.reference_type, updFields.source_link, updFields.updated_at, idVal]
                    );
                    appendDebugLog(`db.upload: updated ref id=${idVal}`);
                  } catch (err) {
                    appendDebugLog(`db.upload: failed to update ref id=${idVal}: ${(err as Error).message}`);
                  }
                }
              } else {
                const insertParams = [
                  r.id ?? null,
                  r.code ?? null,
                  r.project_id ?? projectId,
                  r.creator_id ?? creatorId,
                  r.number ?? null,
                  r.title ?? null,
                  r.tags ?? [],
                  r.reference_type ?? null,
                  r.summary ?? null,
                  r.source_link ?? null,
                  r.content ?? null,
                  r.created_at ?? new Date().toISOString(),
                  r.updated_at ?? new Date().toISOString()
                ];

                appendDebugLog(`db.upload: ref id=${idVal} not found; will INSERT new ref (performUpload=${performUpload})`);

                if (performUpload) {
                  try {
                    await pool.query(
                      `INSERT INTO refs (id, code, project_id, creator_id, number, title, tags, reference_type, summary, source_link, content, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                      insertParams
                    );
                    appendDebugLog(`db.upload: inserted ref id=${idVal}`);
                  } catch (err) {
                    appendDebugLog(`db.upload: failed to insert ref id=${idVal}: ${(err as Error).message}`);
                  }
                }
              }
            } catch (err) {
              appendDebugLog(`db.upload: error checking/inserting/updating ref id=${idVal} for project ${projectId}: ${(err as Error).message}`);
            }

            r = getNextRef();
          }
        } catch (err) {
          appendDebugLog(`db.upload: failed iterating refs for project ${projectId || collectedProject?.id}: ${(err as Error).message}`);
        }
      } catch (err) {
        appendDebugLog(`db.upload: error checking project existence for ${projectPath}: ${(err as Error).message}`);
        continue;
      }
      // Intentionally do not store or accumulate the path; loop moves on.
    }
  }

    // After processing all local projects, check for DB-only projects per creator and delete them.
    try {
      for (const [creatorId, localSet] of localProjectsByCreator.entries()) {
        try {
          const dbIds = await getProjectIdsForCreator(creatorId);
          const toDelete = dbIds.filter(id => !localSet.has(id));
          if (toDelete.length === 0) {
            appendDebugLog(`db.upload: no DB-only projects to delete for creator ${creatorId}`);
            continue;
          }

          appendDebugLog(`db.upload: projects to delete for creator ${creatorId}: ${toDelete.join(', ')}`);

          for (const delId of toDelete) {
            appendDebugLog(`db.upload: will delete project id=${delId} for creator ${creatorId} (performUpload=${performUpload})`);
            if (performUpload) {
              try {
                await pool.query('DELETE FROM projects WHERE id = $1 AND creator_id = $2;', [delId, creatorId]);
                appendDebugLog(`db.upload: deleted project id=${delId} for creator ${creatorId}`);
              } catch (err) {
                appendDebugLog(`db.upload: failed to delete project id=${delId} for creator ${creatorId}: ${(err as Error).message}`);
              }
            }
          }
        } catch (err) {
          appendDebugLog(`db.upload: failed comparing/deleting projects for creator ${creatorId}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      appendDebugLog(`db.upload: error during post-upload deletion pass: ${(err as Error).message}`);
    }

    // Now perform deletions for chapters, notes and refs using the same per-creator comparison.
    try {
      // Chapters
      for (const [creatorId, localSet] of localChaptersByCreator.entries()) {
        try {
          const dbIds = await getChapterIdsForCreator(creatorId);
          const toDelete = dbIds.filter(id => !localSet.has(id));
          if (toDelete.length === 0) {
            appendDebugLog(`db.upload: no DB-only chapters to delete for creator ${creatorId}`);
            continue;
          }
          appendDebugLog(`db.upload: chapters to delete for creator ${creatorId}: ${toDelete.join(', ')}`);
          for (const delId of toDelete) {
            appendDebugLog(`db.upload: will delete chapter id=${delId} for creator ${creatorId} (performUpload=${performUpload})`);
            if (performUpload) {
              try {
                await pool.query('DELETE FROM chapters WHERE id = $1 AND creator_id = $2;', [delId, creatorId]);
                appendDebugLog(`db.upload: deleted chapter id=${delId} for creator ${creatorId}`);
              } catch (err) {
                appendDebugLog(`db.upload: failed to delete chapter id=${delId} for creator ${creatorId}: ${(err as Error).message}`);
              }
            }
          }
        } catch (err) {
          appendDebugLog(`db.upload: failed comparing/deleting chapters for creator ${creatorId}: ${(err as Error).message}`);
        }
      }

      // Notes
      for (const [creatorId, localSet] of localNotesByCreator.entries()) {
        try {
          const dbIds = await getNoteIdsForCreator(creatorId);
          const toDelete = dbIds.filter(id => !localSet.has(id));
          if (toDelete.length === 0) {
            appendDebugLog(`db.upload: no DB-only notes to delete for creator ${creatorId}`);
            continue;
          }
          appendDebugLog(`db.upload: notes to delete for creator ${creatorId}: ${toDelete.join(', ')}`);
          for (const delId of toDelete) {
            appendDebugLog(`db.upload: will delete note id=${delId} for creator ${creatorId} (performUpload=${performUpload})`);
            if (performUpload) {
              try {
                await pool.query('DELETE FROM notes WHERE id = $1 AND creator_id = $2;', [delId, creatorId]);
                appendDebugLog(`db.upload: deleted note id=${delId} for creator ${creatorId}`);
              } catch (err) {
                appendDebugLog(`db.upload: failed to delete note id=${delId} for creator ${creatorId}: ${(err as Error).message}`);
              }
            }
          }
        } catch (err) {
          appendDebugLog(`db.upload: failed comparing/deleting notes for creator ${creatorId}: ${(err as Error).message}`);
        }
      }

      // Refs
      for (const [creatorId, localSet] of localRefsByCreator.entries()) {
        try {
          const dbIds = await getRefIdsForCreator(creatorId);
          const toDelete = dbIds.filter(id => !localSet.has(id));
          if (toDelete.length === 0) {
            appendDebugLog(`db.upload: no DB-only refs to delete for creator ${creatorId}`);
            continue;
          }
          appendDebugLog(`db.upload: refs to delete for creator ${creatorId}: ${toDelete.join(', ')}`);
          for (const delId of toDelete) {
            appendDebugLog(`db.upload: will delete ref id=${delId} for creator ${creatorId} (performUpload=${performUpload})`);
            if (performUpload) {
              try {
                await pool.query('DELETE FROM refs WHERE id = $1 AND creator_id = $2;', [delId, creatorId]);
                appendDebugLog(`db.upload: deleted ref id=${delId} for creator ${creatorId}`);
              } catch (err) {
                appendDebugLog(`db.upload: failed to delete ref id=${delId} for creator ${creatorId}: ${(err as Error).message}`);
              }
            }
          }
        } catch (err) {
          appendDebugLog(`db.upload: failed comparing/deleting refs for creator ${creatorId}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      appendDebugLog(`db.upload: error during post-upload entry-deletion pass: ${(err as Error).message}`);
    }

    return { ok: true };
}

export default { countLocalProjects, uploadLocalProjects };

// db.upload.ts
// Uploader: enumerates local InkDoodleProjects, collects project payloads
// via db.format, upserts the project row, then iterates child entries using
// the mutating getNextChapter/getNextNote/getNextRef APIs (one-at-a-time).

import * as fs from 'fs/promises';
import * as path from 'path';
import { appendDebugLog } from './log';
import {
  collectProjectData,
  getLastLoadedProject,
  getLastLoadedCreator,
  getNextChapter,
  getNextNote,
	getNextRef,
	getNextLore,
	getLastLoadedChapterIds,
	getLastLoadedNoteIds,
	getLastLoadedRefIds,
	getLastLoadedLoreIds,
} from './db.format';
import { pool } from './db';
import { getColumnValue, getFirstRow, getProjectIdsForCreator } from './db.query';

export async function countLocalProjects(rootDir: string): Promise<number> {
  try {
	const entries = await fs.readdir(rootDir, { withFileTypes: true });
	let count = 0;
	for (const e of entries as any[]) {
	  if (!e.isDirectory()) continue;
	  const projectJson = path.join(rootDir, e.name, 'data', 'project.json');
	  try {
		const st = await fs.stat(projectJson);
		if (st.isFile()) count += 1;
	  } catch (err) {
		// ignore missing project.json
	  }
	}
	appendDebugLog(`db.upload:countLocalProjects found ${count} projects under ${rootDir}`);
	return count;
  } catch (err) {
	appendDebugLog(`db.upload:countLocalProjects failed to read ${rootDir}: ${(err as Error).message}`);
	return 0;
  }
}

export async function uploadLocalProjects(rootDir: string, options?: { performUpload?: boolean }) {
  const performUpload = !!options?.performUpload;
  appendDebugLog(`db.upload: uploadLocalProjects called; performUpload=${performUpload} rootDir=${rootDir}`);

  const results: Array<{ project: string; path: string; entries?: { chapters: number; notes: number; refs: number }; error?: string | null }> = [];

  // Track local project ids per creator so we can run a deletion pass later.
  const localProjectsByCreator: Map<string, Set<string>> = new Map();

  const summary = {
	projects: { inserted: 0, updated: 0, deleted: 0, errors: 0 },
	chapters: { inserted: 0, updated: 0, errors: 0 },
	notes: { inserted: 0, updated: 0, errors: 0 },
		refs: { inserted: 0, updated: 0, errors: 0 },
		lore: { inserted: 0, updated: 0, errors: 0 },
	conflicts: 0,
	skipped: 0,
  } as any;

  try {
	const entries = await fs.readdir(rootDir, { withFileTypes: true }) as any[];
	for (const e of entries) {
	  if (!e.isDirectory()) continue;
	  const projectPath = path.join(rootDir, e.name);
	  appendDebugLog(`db.upload: project found: ${projectPath}`);

	  // Collect project data into module-private caches (db.format)
	  try {
		await collectProjectData(projectPath);
	  } catch (err) {
		appendDebugLog(`db.upload: collectProjectData failed for ${projectPath}: ${(err as Error).message}`);
		results.push({ project: e.name, path: projectPath, error: (err as Error).message });
		continue;
	  }

			const collectedProject = getLastLoadedProject();
			const collectedCreator = getLastLoadedCreator();
			// Debug: report the collected project/creator identifiers (best-effort)
			try {
				appendDebugLog(`db.upload: collectedProject.id=${collectedProject?.id ?? '<none>'} collectedProject.code=${collectedProject?.code ?? '<none>'} collectedCreator.id=${collectedCreator?.id ?? '<none>'}`);
			} catch (err) {
				// ignore logging failures
			}

		// Capture local loaded entry counts (best effort) so we can verify later
		let localChapterCount = 0;
		let localNoteCount = 0;
		let localRefCount = 0;
		let localLoreCount = 0;
		try {
		const loadedChapterIds = getLastLoadedChapterIds();
		const loadedNoteIds = getLastLoadedNoteIds();
		const loadedRefIds = getLastLoadedRefIds();
		const loadedLoreIds = getLastLoadedLoreIds();
		localChapterCount = Array.isArray(loadedChapterIds) ? loadedChapterIds.length : 0;
		localNoteCount = Array.isArray(loadedNoteIds) ? loadedNoteIds.length : 0;
		localRefCount = Array.isArray(loadedRefIds) ? loadedRefIds.length : 0;
		const localLoreCount = Array.isArray(loadedLoreIds) ? loadedLoreIds.length : 0;
		appendDebugLog(`db.upload: loaded entries for project ${projectPath}: chapters=${localChapterCount} notes=${localNoteCount} refs=${localRefCount} lore=${localLoreCount}`);
		} catch (err) {
			// ignore logging failures
		}

	  // Record local project id for creator for deletion pass
	  try {
		const pid = collectedProject?.id ?? collectedProject?.['id'] ?? null;
		const cid = collectedCreator?.id ?? collectedCreator?.['id'] ?? null;
		if (pid && cid) {
		  const s = localProjectsByCreator.get(String(cid)) ?? new Set<string>();
		  s.add(String(pid));
		  localProjectsByCreator.set(String(cid), s);
		}
	  } catch (err) {
		// non-fatal
	  }

	  // Project upsert: must happen before any child entries
	  try {
		const projectId = collectedProject?.id ?? collectedProject?.['id'] ?? null;
		if (!projectId) {
		  appendDebugLog(`db.upload: collected project has no id; skipping project at ${projectPath}`);
		  results.push({ project: e.name, path: projectPath, error: 'missing project id' });
		  summary.skipped += 1;
		  continue;
		}

		const creatorId = collectedCreator?.id ?? collectedCreator?.['id'] ?? null;
		if (!creatorId) {
		  appendDebugLog(`db.upload: no creator id for project at ${projectPath}; skipping`);
		  results.push({ project: e.name, path: projectPath, error: 'missing creator id' });
		  summary.skipped += 1;
		  continue;
		}

		const foundCreator = await getColumnValue('creators', 'id', 'id = $1', [creatorId]);
		if (!foundCreator) {
		  appendDebugLog(`db.upload: creator not found for id=${creatorId}; skipping project ${projectPath}`);
		  results.push({ project: e.name, path: projectPath, error: `creator ${creatorId} not found` });
		  continue;
		}

		const foundProject = await getColumnValue('projects', 'id', 'id = $1', [projectId]);
				if (foundProject) {
		  appendDebugLog(`db.upload: project exists id=${projectId}; will UPDATE (performUpload=${performUpload})`);
		  if (performUpload) {
			try {
			  await pool.query(`UPDATE projects SET title = $1, updated_at = $2 WHERE id = $3`, [collectedProject?.title ?? null, collectedProject?.updated_at ?? new Date().toISOString(), projectId]);
			  appendDebugLog(`db.upload: updated project id=${projectId}`);
			  summary.projects.updated += 1;
							// Debug: note update completed
							appendDebugLog(`db.upload: project upsert result=UPDATED id=${projectId}`);
			} catch (err) {
			  appendDebugLog(`db.upload: failed to update project id=${projectId}: ${(err as Error).message}`);
			  summary.projects.errors += 1;
			}
		  }
		} else {
		  appendDebugLog(`db.upload: project id=${projectId} not found; will INSERT (performUpload=${performUpload})`);
		  if (performUpload) {
			try {
			  await pool.query(
				`INSERT INTO projects (id, code, title, creator_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6)`,
				[projectId, collectedProject?.code ?? null, collectedProject?.title ?? null, creatorId, collectedProject?.created_at ?? new Date().toISOString(), collectedProject?.updated_at ?? new Date().toISOString()]
			  );
			  appendDebugLog(`db.upload: inserted project id=${projectId}`);
			  summary.projects.inserted += 1;
							// Debug: note insert completed
							appendDebugLog(`db.upload: project upsert result=INSERTED id=${projectId}`);
			} catch (err) {
			  appendDebugLog(`db.upload: failed to insert project id=${projectId}: ${(err as Error).message}`);
			  summary.projects.errors += 1;
			  if (String((err as Error).message).toLowerCase().includes('duplicate')) summary.conflicts += 1;
			}
		  }
		}
	  } catch (err) {
		appendDebugLog(`db.upload: error checking/inserting/updating project for ${projectPath}: ${(err as Error).message}`);
		results.push({ project: e.name, path: projectPath, error: (err as Error).message });
		continue;
	  }

			// Determine effective creator id to use for child rows. Prefer the
			// enriched creator returned by db.format (collectedCreator) which may
			// include the numeric DB id; fall back to the project's creator id.
			const effectiveCreatorId = (collectedCreator?.id ?? collectedCreator?.['id'] ?? null);
			try {
				appendDebugLog(`db.upload: effectiveCreatorId for project ${projectPath} = ${effectiveCreatorId}`);
			} catch (err) {
				// ignore logging failures
			}

	  // Iterate chapters one-at-a-time using getNextChapter()
	  try {
		appendDebugLog(`db.upload: iterating chapters via getNextChapter() for project ${projectPath}`);
		while (true) {
		  const ch = getNextChapter();
		  if (!ch) break;
		  const idVal = ch?.id ?? ch?.['id'] ?? null;
		  if (!idVal) continue;
		  try {
			appendDebugLog(`db.upload: chapter check params for id=${idVal}`);
			const existing = await getColumnValue('chapters', 'id', 'id = $1', [idVal]);
			appendDebugLog(`db.upload: getColumnValue(chapters,id) returned ${existing ? 'FOUND' : 'NOT FOUND'} for param id=${idVal}`);
			if (existing) {
			  appendDebugLog(`db.upload: chapter exists id=${idVal}; will UPDATE (performUpload=${performUpload})`);
			  if (performUpload) {
				const params = [ch.title ?? null, ch.content ?? null, ch.status ?? null, ch.summary ?? null, ch.tags ?? [], ch.updated_at ?? new Date().toISOString(), ch.word_goal ?? null, idVal];
				appendDebugLog(`db.upload: UPDATE chapters params=${JSON.stringify(params)}`);
				try {
				  await pool.query(`UPDATE chapters SET title = $1, content = $2, status = $3, summary = $4, tags = $5, updated_at = $6, word_goal = $7 WHERE id = $8`, params);
				  summary.chapters.updated += 1;
				} catch (err) {
				  appendDebugLog(`db.upload: failed to update chapter id=${idVal}: ${(err as Error).message}`);
				  summary.chapters.errors += 1;
				}
			  }
			} else {
			  appendDebugLog(`db.upload: chapter id=${idVal} not found; checking by id-string (performUpload=${performUpload})`);
			  try {
				const existingById = ch?.id ? await getFirstRow('chapters', 'CAST(id AS text) = $1', [ch.id]) : null;
				if (existingById) {
				  appendDebugLog(`db.upload: chapter id-string match found for local id=${ch.id}; will UPDATE row id=${existingById.id} (performUpload=${performUpload})`);
				  if (performUpload) {
					const params = [ch.title ?? null, ch.content ?? null, ch.status ?? null, ch.summary ?? null, ch.tags ?? [], ch.updated_at ?? new Date().toISOString(), ch.word_goal ?? null, existingById.id];
					appendDebugLog(`db.upload: UPDATE chapters (by id-string) params=${JSON.stringify(params)}`);
					try {
					  await pool.query(`UPDATE chapters SET title = $1, content = $2, status = $3, summary = $4, tags = $5, updated_at = $6, word_goal = $7 WHERE id = $8`, params);
					  summary.chapters.updated += 1;
					} catch (err) {
					  appendDebugLog(`db.upload: failed to update chapter (by id) id=${existingById.id}: ${(err as Error).message}`);
					  summary.chapters.errors += 1;
					}
				  }
				} else {
				  appendDebugLog(`db.upload: chapter id=${idVal} not found by id-string; will INSERT (performUpload=${performUpload})`);
				  if (performUpload) {
										const params = [ch.id ?? null, ch.code ?? null, ch.project_id ?? null, effectiveCreatorId, ch.number ?? null, ch.title ?? null, ch.content ?? null, ch.status ?? null, ch.summary ?? null, ch.tags ?? [], ch.created_at ?? new Date().toISOString(), ch.updated_at ?? new Date().toISOString(), ch.word_goal ?? null];
					appendDebugLog(`db.upload: INSERT chapters params=${JSON.stringify(params)}`);
					try {
					  await pool.query(`INSERT INTO chapters (id, code, project_id, creator_id, number, title, content, status, summary, tags, created_at, updated_at, word_goal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, params);
					  appendDebugLog(`db.upload: inserted chapter id=${idVal}`);
					  summary.chapters.inserted += 1;
					} catch (err) {
					  appendDebugLog(`db.upload: failed to insert chapter id=${idVal}: ${(err as Error).message}`);
					  summary.chapters.errors += 1;
					  if (String((err as Error).message).toLowerCase().includes('duplicate')) summary.conflicts += 1;
					}
				  }
				}
			  } catch (err) {
				appendDebugLog(`db.upload: error checking chapter by id for id=${idVal}: ${(err as Error).message}`);
			  }
			}
		  } catch (err) {
			appendDebugLog(`db.upload: error handling chapter id=${idVal} for project ${projectPath}: ${(err as Error).message}`);
		  }
		}
	  } catch (err) {
		appendDebugLog(`db.upload: failed iterating chapters for project ${projectPath}: ${(err as Error).message}`);
	  }

	  // Iterate notes one-at-a-time using getNextNote()
	  try {
		appendDebugLog(`db.upload: iterating notes via getNextNote() for project ${projectPath}`);
		while (true) {
		  const n = getNextNote();
		  if (!n) break;
		  const idVal = n?.id ?? n?.['id'] ?? null;
		  if (!idVal) continue;
		  try {
			appendDebugLog(`db.upload: note check params for id=${idVal}`);
			const existing = await getColumnValue('notes', 'id', 'id = $1', [idVal]);
			appendDebugLog(`db.upload: getColumnValue(notes,id) returned ${existing ? 'FOUND' : 'NOT FOUND'} for param id=${idVal}`);
			if (existing) {
			  appendDebugLog(`db.upload: note exists id=${idVal}; will UPDATE (performUpload=${performUpload})`);
			  if (performUpload) {
				const params = [n.title ?? null, n.content ?? null, n.tags ?? [], n.category ?? null, n.pinned ?? false, n.updated_at ?? new Date().toISOString(), idVal];
				appendDebugLog(`db.upload: UPDATE notes params=${JSON.stringify(params)}`);
				try {
				  await pool.query(`UPDATE notes SET title = $1, content = $2, tags = $3, category = $4, pinned = $5, updated_at = $6 WHERE id = $7`, params);
				  summary.notes.updated += 1;
				} catch (err) {
				  appendDebugLog(`db.upload: failed to update note id=${idVal}: ${(err as Error).message}`);
				  summary.notes.errors += 1;
				}
			  }
			} else {
			  appendDebugLog(`db.upload: note id=${idVal} not found; checking by id-string (performUpload=${performUpload})`);
			  try {
				const existingById = n?.id ? await getFirstRow('notes', 'CAST(id AS text) = $1', [n.id]) : null;
				if (existingById) {
				  appendDebugLog(`db.upload: note id-string match found for local id=${n.id}; will UPDATE row id=${existingById.id} (performUpload=${performUpload})`);
				  if (performUpload) {
					const params = [n.title ?? null, n.content ?? null, n.tags ?? [], n.category ?? null, n.pinned ?? false, n.updated_at ?? new Date().toISOString(), existingById.id];
					appendDebugLog(`db.upload: UPDATE notes (by id-string) params=${JSON.stringify(params)}`);
					try {
					  await pool.query(`UPDATE notes SET title = $1, content = $2, tags = $3, category = $4, pinned = $5, updated_at = $6 WHERE id = $7`, params);
					  summary.notes.updated += 1;
					} catch (err) {
					  appendDebugLog(`db.upload: failed to update note (by id) id=${existingById.id}: ${(err as Error).message}`);
					  summary.notes.errors += 1;
					}
				  }
				} else {
				  appendDebugLog(`db.upload: note id=${idVal} not found by id-string; will INSERT (performUpload=${performUpload})`);
				  if (performUpload) {
										const params = [n.id ?? null, n.code ?? null, n.project_id ?? null, effectiveCreatorId, n.number ?? null, n.title ?? null, n.content ?? null, n.tags ?? [], n.category ?? null, n.pinned ?? false, n.created_at ?? new Date().toISOString(), n.updated_at ?? new Date().toISOString()];
					appendDebugLog(`db.upload: INSERT notes params=${JSON.stringify(params)}`);
					try {
					  await pool.query(`INSERT INTO notes (id, code, project_id, creator_id, number, title, content, tags, category, pinned, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, params);
					  appendDebugLog(`db.upload: inserted note id=${idVal}`);
					  summary.notes.inserted += 1;
					} catch (err) {
					  appendDebugLog(`db.upload: failed to insert note id=${idVal}: ${(err as Error).message}`);
					  summary.notes.errors += 1;
					  if (String((err as Error).message).toLowerCase().includes('duplicate')) summary.conflicts += 1;
					}
				  }
				}
			  } catch (err) {
				appendDebugLog(`db.upload: error checking note by id for id=${idVal}: ${(err as Error).message}`);
			  }
			}
		  } catch (err) {
			appendDebugLog(`db.upload: error handling note id=${idVal} for project ${projectPath}: ${(err as Error).message}`);
		  }
		}
	  } catch (err) {
		appendDebugLog(`db.upload: failed iterating notes for project ${projectPath}: ${(err as Error).message}`);
	  }

	  // Iterate refs one-at-a-time using getNextRef()
	  try {
		appendDebugLog(`db.upload: iterating refs via getNextRef() for project ${projectPath}`);
		while (true) {
		  const r = getNextRef();
		  if (!r) break;
		  const idVal = r?.id ?? r?.['id'] ?? null;
		  if (!idVal) continue;
		  try {
			appendDebugLog(`db.upload: ref check params for id=${idVal}`);
			const existing = await getColumnValue('refs', 'id', 'id = $1', [idVal]);
			appendDebugLog(`db.upload: getColumnValue(refs,id) returned ${existing ? 'FOUND' : 'NOT FOUND'} for param id=${idVal}`);
			if (existing) {
			  appendDebugLog(`db.upload: ref exists id=${idVal}; will UPDATE (performUpload=${performUpload})`);
			  if (performUpload) {
				const params = [r.title ?? null, r.content ?? null, r.summary ?? null, r.tags ?? [], r.reference_type ?? null, r.source_link ?? null, r.updated_at ?? new Date().toISOString(), idVal];
				appendDebugLog(`db.upload: UPDATE refs params=${JSON.stringify(params)}`);
				try {
				  await pool.query(`UPDATE refs SET title = $1, content = $2, summary = $3, tags = $4, reference_type = $5, source_link = $6, updated_at = $7 WHERE id = $8`, params);
				  summary.refs.updated += 1;
				} catch (err) {
				  appendDebugLog(`db.upload: failed to update ref id=${idVal}: ${(err as Error).message}`);
				  summary.refs.errors += 1;
				}
			  }
			} else {
			  appendDebugLog(`db.upload: ref id=${idVal} not found; checking by id-string (performUpload=${performUpload})`);
			  try {
				const existingById = r?.id ? await getFirstRow('refs', 'CAST(id AS text) = $1', [r.id]) : null;
				if (existingById) {
				  appendDebugLog(`db.upload: ref id-string match found for local id=${r.id}; will UPDATE row id=${existingById.id} (performUpload=${performUpload})`);
				  if (performUpload) {
					const params = [r.title ?? null, r.content ?? null, r.summary ?? null, r.tags ?? [], r.reference_type ?? null, r.source_link ?? null, r.updated_at ?? new Date().toISOString(), existingById.id];
					appendDebugLog(`db.upload: UPDATE refs (by id-string) params=${JSON.stringify(params)}`);
					try {
					  await pool.query(`UPDATE refs SET title = $1, content = $2, summary = $3, tags = $4, reference_type = $5, source_link = $6, updated_at = $7 WHERE id = $8`, params);
					  summary.refs.updated += 1;
					} catch (err) {
					  appendDebugLog(`db.upload: failed to update ref (by id) id=${existingById.id}: ${(err as Error).message}`);
					  summary.refs.errors += 1;
					}
				  }
				} else {
				  appendDebugLog(`db.upload: ref id=${idVal} not found by id-string; will INSERT (performUpload=${performUpload})`);
				  if (performUpload) {
										const params = [r.id ?? null, r.code ?? null, r.project_id ?? null, effectiveCreatorId, r.number ?? null, r.title ?? null, r.tags ?? [], r.reference_type ?? null, r.summary ?? null, r.source_link ?? null, r.content ?? null, r.created_at ?? new Date().toISOString(), r.updated_at ?? new Date().toISOString()];
					appendDebugLog(`db.upload: INSERT refs params=${JSON.stringify(params)}`);
					try {
					  await pool.query(`INSERT INTO refs (id, code, project_id, creator_id, number, title, tags, reference_type, summary, source_link, content, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, params);
					  appendDebugLog(`db.upload: inserted ref id=${idVal}`);
					  summary.refs.inserted += 1;
					} catch (err) {
					  appendDebugLog(`db.upload: failed to insert ref id=${idVal}: ${(err as Error).message}`);
					  summary.refs.errors += 1;
					  if (String((err as Error).message).toLowerCase().includes('duplicate')) summary.conflicts += 1;
					}
				  }
				}
			  } catch (err) {
				appendDebugLog(`db.upload: error checking ref by id for id=${idVal}: ${(err as Error).message}`);
			  }
			}
		  } catch (err) {
			appendDebugLog(`db.upload: error handling ref id=${idVal} for project ${projectPath}: ${(err as Error).message}`);
		  }
		}
	  } catch (err) {
		appendDebugLog(`db.upload: failed iterating refs for project ${projectPath}: ${(err as Error).message}`);
	  }

		// Iterate lore one-at-a-time using getNextLore()
		try {
				// Log how many lore rows we expect to process (best-effort)
				try {
					const loadedLoreIds = getLastLoadedLoreIds();
					appendDebugLog(`db.upload: iterating lore via getNextLore() for project ${projectPath}; expected=${Array.isArray(loadedLoreIds)?loadedLoreIds.length:0}`);
				} catch (e) {
					appendDebugLog(`db.upload: iterating lore via getNextLore() for project ${projectPath}`);
				}
			while (true) {
				const l = (global as any).getNextLore ? (global as any).getNextLore() : null;
				// Prefer local module import when available
				// If getNextLore was imported from db.format it will exist in scope
				const loreRow = (typeof getNextLore === 'function') ? getNextLore() : l;
				if (!loreRow) break;
				const idVal = loreRow?.id ?? loreRow?.['id'] ?? null;
				if (!idVal) continue;
				try {
					appendDebugLog(`db.upload: lore check params for id=${idVal}`);
					const existing = await getColumnValue('lore', 'id', 'id = $1', [idVal]);
					appendDebugLog(`db.upload: getColumnValue(lore,id) returned ${existing ? 'FOUND' : 'NOT FOUND'} for param id=${idVal}`);
					if (existing) {
						appendDebugLog(`db.upload: lore exists id=${idVal}; will UPDATE (performUpload=${performUpload})`);
						if (performUpload) {
							const params = [
								loreRow.title ?? null,
								loreRow.content ?? null,
								loreRow.summary ?? null,
								loreRow.tags ?? [],
								loreRow.lore_kind ?? null,
								loreRow.entry1_name ?? null,
								loreRow.entry1_content ?? null,
								loreRow.entry2_name ?? null,
								loreRow.entry2_content ?? null,
								loreRow.entry3_name ?? null,
								loreRow.entry3_content ?? null,
								loreRow.entry4_name ?? null,
								loreRow.entry4_content ?? null,
								loreRow.updated_at ?? new Date().toISOString(),
								idVal
							];
							appendDebugLog(`db.upload: UPDATE lore params=${JSON.stringify(params)}`);
							try {
								await pool.query(`UPDATE lore SET title = $1, content = $2, summary = $3, tags = $4, lore_kind = $5, entry1_name = $6, entry1_content = $7, entry2_name = $8, entry2_content = $9, entry3_name = $10, entry3_content = $11, entry4_name = $12, entry4_content = $13, updated_at = $14 WHERE id = $15`, params);
								summary.lore.updated += 1;
							} catch (err) {
								appendDebugLog(`db.upload: failed to update lore id=${idVal}: ${(err as Error).message}`);
								summary.lore.errors += 1;
							}
						}
					} else {
						appendDebugLog(`db.upload: lore id=${idVal} not found; checking by id-string (performUpload=${performUpload})`);
						try {
							const existingById = loreRow?.id ? await getFirstRow('lore', 'CAST(id AS text) = $1', [loreRow.id]) : null;
							if (existingById) {
								appendDebugLog(`db.upload: lore id-string match found for local id=${loreRow.id}; will UPDATE row id=${existingById.id} (performUpload=${performUpload})`);
								if (performUpload) {
									const params = [
										loreRow.title ?? null,
										loreRow.content ?? null,
										loreRow.summary ?? null,
										loreRow.tags ?? [],
										loreRow.lore_kind ?? null,
										loreRow.entry1_name ?? null,
										loreRow.entry1_content ?? null,
										loreRow.entry2_name ?? null,
										loreRow.entry2_content ?? null,
										loreRow.entry3_name ?? null,
										loreRow.entry3_content ?? null,
										loreRow.entry4_name ?? null,
										loreRow.entry4_content ?? null,
										loreRow.updated_at ?? new Date().toISOString(),
										existingById.id
									];
									appendDebugLog(`db.upload: UPDATE lore (by id-string) params=${JSON.stringify(params)}`);
									try {
										await pool.query(`UPDATE lore SET title = $1, content = $2, summary = $3, tags = $4, lore_kind = $5, entry1_name = $6, entry1_content = $7, entry2_name = $8, entry2_content = $9, entry3_name = $10, entry3_content = $11, entry4_name = $12, entry4_content = $13, updated_at = $14 WHERE id = $15`, params);
										summary.lore.updated += 1;
									} catch (err) {
										appendDebugLog(`db.upload: failed to update lore (by id) id=${existingById.id}: ${(err as Error).message}`);
										summary.lore.errors += 1;
									}
								}
							} else {
								appendDebugLog(`db.upload: lore id=${idVal} not found by id-string; will INSERT (performUpload=${performUpload})`);
								if (performUpload) {
									const params = [
										loreRow.id ?? null,
										loreRow.code ?? null,
										loreRow.project_id ?? null,
										effectiveCreatorId,
										loreRow.number ?? null,
										loreRow.title ?? null,
										loreRow.content ?? null,
										loreRow.summary ?? null,
										loreRow.tags ?? [],
										loreRow.lore_kind ?? null,
										loreRow.entry1_name ?? null,
										loreRow.entry1_content ?? null,
										loreRow.entry2_name ?? null,
										loreRow.entry2_content ?? null,
										loreRow.entry3_name ?? null,
										loreRow.entry3_content ?? null,
										loreRow.entry4_name ?? null,
										loreRow.entry4_content ?? null,
										loreRow.created_at ?? new Date().toISOString(),
										loreRow.updated_at ?? new Date().toISOString()
									];
									appendDebugLog(`db.upload: INSERT lore params=${JSON.stringify(params)}`);
									try {
										await pool.query(`INSERT INTO lore (id, code, project_id, creator_id, number, title, content, summary, tags, lore_kind, entry1_name, entry1_content, entry2_name, entry2_content, entry3_name, entry3_content, entry4_name, entry4_content, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`, params);
										appendDebugLog(`db.upload: inserted lore id=${idVal}`);
										summary.lore.inserted += 1;
									} catch (err) {
										appendDebugLog(`db.upload: failed to insert lore id=${idVal}: ${(err as Error).message}`);
										summary.lore.errors += 1;
										if (String((err as Error).message).toLowerCase().includes('duplicate')) summary.conflicts += 1;
									}
								}
							}
						} catch (err) {
							appendDebugLog(`db.upload: error checking lore by id for id=${idVal}: ${(err as Error).message}`);
						}
					}
				} catch (err) {
					appendDebugLog(`db.upload: error handling lore id=${idVal} for project ${projectPath}: ${(err as Error).message}`);
				}
			}
		} catch (err) {
			appendDebugLog(`db.upload: failed iterating lore for project ${projectPath}: ${(err as Error).message}`);
		}

			// Debug: finished processing this project — report loaded counts and running totals
			try {
				appendDebugLog(`db.upload: finished project ${projectPath}; localLoaded chapters=${localChapterCount} notes=${localNoteCount} refs=${localRefCount} lore=${localLoreCount ?? 0}; runningTotals projects(inserted=${summary.projects.inserted},updated=${summary.projects.updated},deleted=${summary.projects.deleted}) chapters(inserted=${summary.chapters.inserted},updated=${summary.chapters.updated}) notes(inserted=${summary.notes.inserted},updated=${summary.notes.updated}) refs(inserted=${summary.refs.inserted},updated=${summary.refs.updated}) lore(inserted=${summary.lore.inserted},updated=${summary.lore.updated}) conflicts=${summary.conflicts} errors(projects=${summary.projects.errors},chapters=${summary.chapters.errors},notes=${summary.notes.errors},refs=${summary.refs.errors},lore=${summary.lore.errors})`);
			} catch (err) {
				// ignore logging failures
			}

			// Post-upload verification: query DB counts for this project and compare
			try {
				if (performUpload) {
						const projectIdForQuery = collectedProject?.id ?? collectedProject?.['id'] ?? null;
					if (projectIdForQuery) {
						const qCh = await pool.query(`SELECT COUNT(*) AS c FROM chapters WHERE project_id = $1`, [projectIdForQuery]);
						const qNo = await pool.query(`SELECT COUNT(*) AS c FROM notes WHERE project_id = $1`, [projectIdForQuery]);
						const qRf = await pool.query(`SELECT COUNT(*) AS c FROM refs WHERE project_id = $1`, [projectIdForQuery]);
						const qLo = await pool.query(`SELECT COUNT(*) AS c FROM lore WHERE project_id = $1`, [projectIdForQuery]);
						const dbCh = Number(qCh.rows?.[0]?.c ?? 0);
						const dbNo = Number(qNo.rows?.[0]?.c ?? 0);
						const dbRf = Number(qRf.rows?.[0]?.c ?? 0);
						const dbLo = Number(qLo.rows?.[0]?.c ?? 0);
						appendDebugLog(`db.upload: verification for project ${projectPath} (id=${projectIdForQuery}): local chapters=${localChapterCount} db chapters=${dbCh}; local notes=${localNoteCount} db notes=${dbNo}; local refs=${localRefCount} db refs=${dbRf}; local lore=${localLoreCount ?? 0} db lore=${dbLo}`);
						if (dbCh !== localChapterCount || dbNo !== localNoteCount || dbRf !== localRefCount || dbLo !== (localLoreCount ?? 0)) {
							appendDebugLog(`db.upload: VERIFICATION MISMATCH for project ${projectPath} (id=${projectIdForQuery}).`);
							summary.conflicts += 1;
						}
					}
				}
			} catch (err) {
				appendDebugLog(`db.upload: verification queries failed for project ${projectPath}: ${(err as Error).message}`);
			}

			results.push({ project: e.name, path: projectPath, error: null });
	}
  } catch (err) {
	appendDebugLog(`db.upload: failed to enumerate projects in ${rootDir}: ${(err as Error).message}`);
	return { ok: false, error: (err as Error).message } as any;
  }

	// Deletion pass
	try {
		appendDebugLog(`db.upload: starting deletion pass; creatorsToCheck=${localProjectsByCreator.size}`);
	if (localProjectsByCreator.size === 0) {
	  try {
		appendDebugLog('db.upload: no local projects found; attempting to read prefs.auth_user for deletion pass');
		const p = await pool.query(`SELECT value AS user FROM prefs WHERE key = 'auth_user' LIMIT 1;`);
		const u = p.rows?.[0]?.user || null;
		const effectiveId = u?.id ?? null;
		if (effectiveId) {
		  appendDebugLog(`db.upload: found auth_user id=${effectiveId}; will run deletion pass for this creator`);
		  localProjectsByCreator.set(String(effectiveId), new Set<string>());
		} else {
		  appendDebugLog('db.upload: no auth_user found in prefs; skipping deletion pass');
		}
	  } catch (err) {
		appendDebugLog(`db.upload: failed reading prefs.auth_user: ${(err as Error).message}`);
	  }
	}
	for (const [creatorId, localSet] of localProjectsByCreator.entries()) {
	  appendDebugLog(`db.upload: deletion pass for creator ${creatorId}; local projects=${Array.from(localSet).join(',')}`);
	  let dbIds: string[] = [];
	  try {
		dbIds = await getProjectIdsForCreator(String(creatorId));
	  } catch (err) {
		appendDebugLog(`db.upload: failed to fetch DB project ids for creator ${creatorId}: ${(err as Error).message}`);
		continue;
	  }

	  for (const dbId of dbIds) {
		if (!localSet.has(String(dbId))) {
		  appendDebugLog(`db.upload: DB project id=${dbId} for creator=${creatorId} not found locally; will DELETE (performUpload=${performUpload})`);
		  if (performUpload) {
			try {
			  await pool.query(`DELETE FROM projects WHERE id = $1`, [dbId]);
			  appendDebugLog(`db.upload: deleted DB project id=${dbId}`);
			  summary.projects.deleted += 1;
			  results.push({ project: String(dbId), path: '', error: null });
			} catch (err) {
			  appendDebugLog(`db.upload: failed to delete DB project id=${dbId}: ${(err as Error).message}`);
			  summary.projects.errors += 1;
			  results.push({ project: String(dbId), path: '', error: (err as Error).message });
			}
		  } else {
			results.push({ project: String(dbId), path: '', error: `dry-run: would delete` });
		  }
		}
	  }
	}
	} catch (err) {
		appendDebugLog(`db.upload: deletion pass failed: ${(err as Error).message}`);
	}

	// Debug: final summary before returning
	try {
		appendDebugLog(`db.upload: uploadLocalProjects completed; summary=${JSON.stringify(summary)}`);
	} catch (err) {
		// ignore logging failures
	}

  return { ok: true, results, summary } as any;
}

export default { countLocalProjects, uploadLocalProjects };


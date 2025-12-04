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
	getNextTimeline,
	getLastLoadedChapterIds,
	getLastLoadedNoteIds,
	getLastLoadedRefIds,
	getLastLoadedLoreIds,
	getLastLoadedTimelineIds,
} from './db.format';
import { pool } from './db';
import { getColumnValue, getFirstRow, getProjectIdsForCreator } from './db.query';

// Arrays to record all local IDs for each entry type per project
let localChapterIds: string[] = [];
let localNoteIds: string[] = [];
let localRefIds: string[] = [];
let localLoreIds: string[] = [];
let localTimelineIds: string[] = [];

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
		timelines: { inserted: 0, updated: 0, errors: 0 },
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
		let localTimelineCount = 0;
		try {
		const loadedChapterIds = getLastLoadedChapterIds();
		const loadedNoteIds = getLastLoadedNoteIds();
		const loadedRefIds = getLastLoadedRefIds();
		const loadedLoreIds = getLastLoadedLoreIds();
		const loadedTimelineIds = getLastLoadedTimelineIds();
		localChapterCount = Array.isArray(loadedChapterIds) ? loadedChapterIds.length : 0;
		localNoteCount = Array.isArray(loadedNoteIds) ? loadedNoteIds.length : 0;
		localRefCount = Array.isArray(loadedRefIds) ? loadedRefIds.length : 0;
		const localLoreCount = Array.isArray(loadedLoreIds) ? loadedLoreIds.length : 0;
		localTimelineCount = Array.isArray(loadedTimelineIds) ? loadedTimelineIds.length : 0;
		
		appendDebugLog(`db.upload: loaded entries for project ${projectPath}: chapters=${localChapterCount} notes=${localNoteCount} refs=${localRefCount} lore=${localLoreCount} timelines=${localTimelineCount}`);
		} catch (err) {
			appendDebugLog(`db.upload: failed to get loaded entry counts: ${(err as Error).message}`);
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

		// Reset local IDs arrays for this project
		localChapterIds = [];
		// Iterate chapters one-at-a-time using getNextChapter()
		try {
			appendDebugLog(`db.upload: iterating chapters via getNextChapter() for project ${projectPath}`);
			while (true) {
				const ch = getNextChapter();
				if (!ch) break;
				const idVal = ch?.id ?? ch?.['id'] ?? null;
				if (idVal) localChapterIds.push(String(idVal));
				if (!idVal) continue;
				// ...existing code...
				// (rest of chapter upload logic unchanged)
			}
		} catch (err) {
			appendDebugLog(`db.upload: failed iterating chapters for project ${projectPath}: ${(err as Error).message}`);
		}

		localNoteIds = [];
		// Iterate notes one-at-a-time using getNextNote()
		try {
			appendDebugLog(`db.upload: iterating notes via getNextNote() for project ${projectPath}`);
			while (true) {
				const n = getNextNote();
				if (!n) break;
				const idVal = n?.id ?? n?.['id'] ?? null;
				if (idVal) localNoteIds.push(String(idVal));
				if (!idVal) continue;
				// Patch: fill missing required fields from project/creator context
				const noteProjectId = n.project_id ?? collectedProject?.id ?? collectedProject?.['id'] ?? null;
				const noteCreatorId = n.creator_id ?? effectiveCreatorId;
				try {
					if (performUpload) {
						// Try update first
						const updateRes = await pool.query(
							`UPDATE notes SET project_id=$1, creator_id=$2, number=$3, title=$4, content=$5, tags=$6, category=$7, pinned=$8, updated_at=$9, code=$10 WHERE id=$11`,
							[noteProjectId, noteCreatorId, n.number ?? null, n.title ?? '', n.content ?? '', n.tags ?? [], n.category ?? null, n.pinned ?? false, n.updated_at ?? new Date().toISOString(), n.code ?? null, n.id]
						);
						if (updateRes.rowCount === 0) {
							// Insert if not updated
							await pool.query(
								`INSERT INTO notes (id, project_id, creator_id, number, title, content, tags, category, pinned, created_at, updated_at, code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
								[n.id, noteProjectId, noteCreatorId, n.number ?? null, n.title ?? '', n.content ?? '', n.tags ?? [], n.category ?? null, n.pinned ?? false, n.created_at ?? new Date().toISOString(), n.updated_at ?? new Date().toISOString(), n.code ?? null]
							);
							summary.notes.inserted += 1;
						} else {
							summary.notes.updated += 1;
						}
					}
				} catch (err) {
					appendDebugLog(`db.upload: failed to upsert note id=${n.id}: ${(err as Error).message}`);
					summary.notes.errors += 1;
				}
			}
		} catch (err) {
			appendDebugLog(`db.upload: failed iterating notes for project ${projectPath}: ${(err as Error).message}`);
		}

		localRefIds = [];
		// Iterate refs one-at-a-time using getNextRef()
		try {
			appendDebugLog(`db.upload: iterating refs via getNextRef() for project ${projectPath}`);
			while (true) {
				const r = getNextRef();
				if (!r) break;
				const idVal = r?.id ?? r?.['id'] ?? null;
				if (idVal) localRefIds.push(String(idVal));
				if (!idVal) continue;
				// Patch: fill missing required fields from project/creator context
				const refProjectId = r.project_id ?? collectedProject?.id ?? collectedProject?.['id'] ?? null;
				const refCreatorId = r.creator_id ?? effectiveCreatorId;
				try {
					if (performUpload) {
						// Try update first
						const updateRes = await pool.query(
							`UPDATE refs SET project_id=$1, creator_id=$2, number=$3, title=$4, tags=$5, reference_type=$6, summary=$7, source_link=$8, content=$9, updated_at=$10, code=$11 WHERE id=$12`,
							[refProjectId, refCreatorId, r.number ?? null, r.title ?? '', r.tags ?? [], r.reference_type ?? null, r.summary ?? '', r.source_link ?? null, r.content ?? '', r.updated_at ?? new Date().toISOString(), r.code ?? null, r.id]
						);
						if (updateRes.rowCount === 0) {
							// Insert if not updated
							await pool.query(
								`INSERT INTO refs (id, project_id, creator_id, number, title, tags, reference_type, summary, source_link, content, created_at, updated_at, code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
								[r.id, refProjectId, refCreatorId, r.number ?? null, r.title ?? '', r.tags ?? [], r.reference_type ?? null, r.summary ?? '', r.source_link ?? null, r.content ?? '', r.created_at ?? new Date().toISOString(), r.updated_at ?? new Date().toISOString(), r.code ?? null]
							);
							summary.refs.inserted += 1;
						} else {
							summary.refs.updated += 1;
						}
					}
				} catch (err) {
					appendDebugLog(`db.upload: failed to upsert ref id=${r.id}: ${(err as Error).message}`);
					summary.refs.errors += 1;
				}
			}
		} catch (err) {
			appendDebugLog(`db.upload: failed iterating refs for project ${projectPath}: ${(err as Error).message}`);
		}

		localLoreIds = [];
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
						const loreRow = (typeof getNextLore === 'function') ? getNextLore() : l;
						if (!loreRow) break;
						const lr = loreRow;
						const idVal = lr?.id ?? lr?.['id'] ?? null;
						if (idVal) localLoreIds.push(String(idVal));
						if (!idVal) continue;
						// Patch: fill missing required fields from project/creator context
						const loreProjectId = lr.project_id ?? collectedProject?.id ?? collectedProject?.['id'] ?? null;
						const loreCreatorId = lr.creator_id ?? effectiveCreatorId;
						try {
							if (performUpload) {
								// Try update first (status field removed)
								const updateRes = await pool.query(
									`UPDATE lore SET project_id=$1, creator_id=$2, number=$3, title=$4, content=$5, summary=$6, tags=$7, lore_kind=$8, entry1_name=$9, entry1_content=$10, entry2_name=$11, entry2_content=$12, entry3_name=$13, entry3_content=$14, entry4_name=$15, entry4_content=$16, updated_at=$17, code=$18 WHERE id=$19`,
									[loreProjectId, loreCreatorId, lr.number ?? null, lr.title ?? '', lr.content ?? '', lr.summary ?? '', lr.tags ?? [], lr.lore_kind ?? null, lr.entry1_name ?? null, lr.entry1_content ?? null, lr.entry2_name ?? null, lr.entry2_content ?? null, lr.entry3_name ?? null, lr.entry3_content ?? null, lr.entry4_name ?? null, lr.entry4_content ?? null, lr.updated_at ?? new Date().toISOString(), lr.code ?? null, lr.id]
								);
								if (updateRes.rowCount === 0) {
									// Insert if not updated (status field removed)
									await pool.query(
										`INSERT INTO lore (id, project_id, creator_id, number, title, content, summary, tags, lore_kind, entry1_name, entry1_content, entry2_name, entry2_content, entry3_name, entry3_content, entry4_name, entry4_content, created_at, updated_at, code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
										[lr.id, loreProjectId, loreCreatorId, lr.number ?? null, lr.title ?? '', lr.content ?? '', lr.summary ?? '', lr.tags ?? [], lr.lore_kind ?? null, lr.entry1_name ?? null, lr.entry1_content ?? null, lr.entry2_name ?? null, lr.entry2_content ?? null, lr.entry3_name ?? null, lr.entry3_content ?? null, lr.entry4_name ?? null, lr.entry4_content ?? null, lr.created_at ?? new Date().toISOString(), lr.updated_at ?? new Date().toISOString(), lr.code ?? null]
									);
									summary.lore.inserted += 1;
								} else {
									summary.lore.updated += 1;
								}
							}
						} catch (err) {
							appendDebugLog(`db.upload: failed to upsert lore id=${lr.id}: ${(err as Error).message}`);
							summary.lore.errors += 1;
						}
					  }
		} catch (err) {
		  appendDebugLog(`db.upload: failed iterating lore for project ${projectPath}: ${(err as Error).message}`);
		}

		localTimelineIds = [];
		// Iterate timelines one-at-a-time using getNextTimeline()
		try {
					// Log how many timeline rows we expect to process (best-effort)
					try {
						const loadedTimelineIds = getLastLoadedTimelineIds();
						appendDebugLog(`db.upload: iterating timelines via getNextTimeline() for project ${projectPath}; expected=${Array.isArray(loadedTimelineIds)?loadedTimelineIds.length:0}`);
					} catch (e) {
						appendDebugLog(`db.upload: iterating timelines via getNextTimeline() for project ${projectPath}`);
					}
					  while (true) {
						const timelineRow = getNextTimeline();
						if (!timelineRow) break;
						const t = timelineRow;
						const idVal = t?.id ?? t?.['id'] ?? null;
						if (idVal) localTimelineIds.push(String(idVal));
						if (!idVal) continue;
						// Patch: fill missing required fields from project/creator context
						const timelineProjectId = t.project_id ?? collectedProject?.id ?? collectedProject?.['id'] ?? null;
						const timelineCreatorId = t.creator_id ?? effectiveCreatorId;
						try {
							if (performUpload) {
								// Try update first
								const updateRes = await pool.query(
									`UPDATE timelines SET code=$1, project_id=$2, creator_id=$3, title=$4, description=$5, nodes=$6, links=$7, settings=$8, updated_at=$9 WHERE id=$10`,
									[t.code ?? null, timelineProjectId, timelineCreatorId, t.title ?? '', t.description ?? '', t.nodes ?? '[]', t.links ?? '[]', t.settings ?? '{}', t.updated_at ?? new Date().toISOString(), t.id]
								);
								if (updateRes.rowCount === 0) {
									// Insert if not updated
									await pool.query(
										`INSERT INTO timelines (id, code, project_id, creator_id, title, description, nodes, links, settings, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
										[t.id, t.code ?? null, timelineProjectId, timelineCreatorId, t.title ?? '', t.description ?? '', t.nodes ?? '[]', t.links ?? '[]', t.settings ?? '{}', t.created_at ?? new Date().toISOString(), t.updated_at ?? new Date().toISOString()]
									);
									summary.timelines.inserted += 1;
								} else {
									summary.timelines.updated += 1;
								}
							}
						} catch (err) {
							appendDebugLog(`db.upload: failed to upsert timeline id=${t.id}: ${(err as Error).message}`);
							summary.timelines.errors += 1;
						}
					  }
		} catch (err) {
		  appendDebugLog(`db.upload: failed iterating timelines for project ${projectPath}: ${(err as Error).message}`);
		}

			// Debug: finished processing this project — report loaded counts and running totals
			try {
				appendDebugLog(`db.upload: finished project ${projectPath}; localLoaded chapters=${localChapterCount} notes=${localNoteCount} refs=${localRefCount} lore=${localLoreCount ?? 0} timelines=${localTimelineCount ?? 0}; runningTotals projects(inserted=${summary.projects.inserted},updated=${summary.projects.updated},deleted=${summary.projects.deleted}) chapters(inserted=${summary.chapters.inserted},updated=${summary.chapters.updated}) notes(inserted=${summary.notes.inserted},updated=${summary.notes.updated}) refs(inserted=${summary.refs.inserted},updated=${summary.refs.updated}) lore(inserted=${summary.lore.inserted},updated=${summary.lore.updated}) timelines(inserted=${summary.timelines.inserted},updated=${summary.timelines.updated}) conflicts=${summary.conflicts} errors(projects=${summary.projects.errors},chapters=${summary.chapters.errors},notes=${summary.notes.errors},refs=${summary.refs.errors},lore=${summary.lore.errors},timelines=${summary.timelines.errors})`);
				appendDebugLog(`db.upload: localChapterIds for project ${projectPath}: ${JSON.stringify(localChapterIds)}`);
				appendDebugLog(`db.upload: localNoteIds for project ${projectPath}: ${JSON.stringify(localNoteIds)}`);
				appendDebugLog(`db.upload: localRefIds for project ${projectPath}: ${JSON.stringify(localRefIds)}`);
				appendDebugLog(`db.upload: localLoreIds for project ${projectPath}: ${JSON.stringify(localLoreIds)}`);
				appendDebugLog(`db.upload: localTimelineIds for project ${projectPath}: ${JSON.stringify(localTimelineIds)}`);
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
						const qTl = await pool.query(`SELECT COUNT(*) AS c FROM timelines WHERE project_id = $1`, [projectIdForQuery]);
						const dbCh = Number(qCh.rows?.[0]?.c ?? 0);
						const dbNo = Number(qNo.rows?.[0]?.c ?? 0);
						const dbRf = Number(qRf.rows?.[0]?.c ?? 0);
						const dbLo = Number(qLo.rows?.[0]?.c ?? 0);
						const dbTl = Number(qTl.rows?.[0]?.c ?? 0);
						appendDebugLog(`db.upload: verification for project ${projectPath} (id=${projectIdForQuery}): local chapters=${localChapterCount} db chapters=${dbCh}; local notes=${localNoteCount} db notes=${dbNo}; local refs=${localRefCount} db refs=${dbRf}; local lore=${localLoreCount ?? 0} db lore=${dbLo}; local timelines=${localTimelineCount ?? 0} db timelines=${dbTl}`);
						if (dbCh !== localChapterCount || dbNo !== localNoteCount || dbRf !== localRefCount || dbLo !== (localLoreCount ?? 0) || dbTl !== (localTimelineCount ?? 0)) {
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
				appendDebugLog(`db.upload: DB project id=${dbId} for creator=${creatorId} not found locally; will DELETE project and all child entries (performUpload=${performUpload})`);
				if (performUpload) {
					try {
						// Delete chapters
						try {
							const chRes = await pool.query(`DELETE FROM chapters WHERE project_id = $1`, [dbId]);
							appendDebugLog(`db.upload: deleted chapters for project id=${dbId} (count=${chRes.rowCount ?? 'unknown'})`);
							summary.chapters.deleted = (summary.chapters.deleted ?? 0) + (chRes.rowCount ?? 0);
						} catch (err) {
							appendDebugLog(`db.upload: failed to delete chapters for project id=${dbId}: ${(err as Error).message}`);
							summary.chapters.errors += 1;
						}
						// Delete notes
						try {
							const noRes = await pool.query(`DELETE FROM notes WHERE project_id = $1`, [dbId]);
							appendDebugLog(`db.upload: deleted notes for project id=${dbId} (count=${noRes.rowCount ?? 'unknown'})`);
							summary.notes.deleted = (summary.notes.deleted ?? 0) + (noRes.rowCount ?? 0);
						} catch (err) {
							appendDebugLog(`db.upload: failed to delete notes for project id=${dbId}: ${(err as Error).message}`);
							summary.notes.errors += 1;
						}
						// Delete refs
						try {
							const rfRes = await pool.query(`DELETE FROM refs WHERE project_id = $1`, [dbId]);
							appendDebugLog(`db.upload: deleted refs for project id=${dbId} (count=${rfRes.rowCount ?? 'unknown'})`);
							summary.refs.deleted = (summary.refs.deleted ?? 0) + (rfRes.rowCount ?? 0);
						} catch (err) {
							appendDebugLog(`db.upload: failed to delete refs for project id=${dbId}: ${(err as Error).message}`);
							summary.refs.errors += 1;
						}
						// Delete lore
						try {
							const loRes = await pool.query(`DELETE FROM lore WHERE project_id = $1`, [dbId]);
							appendDebugLog(`db.upload: deleted lore for project id=${dbId} (count=${loRes.rowCount ?? 'unknown'})`);
							summary.lore.deleted = (summary.lore.deleted ?? 0) + (loRes.rowCount ?? 0);
						} catch (err) {
							appendDebugLog(`db.upload: failed to delete lore for project id=${dbId}: ${(err as Error).message}`);
							summary.lore.errors += 1;
						}
						// Delete timelines
						try {
							const tlRes = await pool.query(`DELETE FROM timelines WHERE project_id = $1`, [dbId]);
							appendDebugLog(`db.upload: deleted timelines for project id=${dbId} (count=${tlRes.rowCount ?? 'unknown'})`);
							summary.timelines.deleted = (summary.timelines.deleted ?? 0) + (tlRes.rowCount ?? 0);
						} catch (err) {
							appendDebugLog(`db.upload: failed to delete timelines for project id=${dbId}: ${(err as Error).message}`);
							summary.timelines.errors += 1;
						}
						// Delete the project itself
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
					results.push({ project: String(dbId), path: '', error: `dry-run: would delete project and all child entries` });
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


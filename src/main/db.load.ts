// db.load.ts - Centralized DB -> local load helpers (pulls/downloads)
//
// This module hosts explicit functions for loading data from the remote
// database into local files (InkDoodleProjects). These functions are
// intentionally explicit, gated, and read-only with respect to DB writes;
// callers must opt-in to performing local writes.

import * as fs from 'fs/promises';
import * as path from 'path';
import { appendDebugLog } from './log';
import { pool } from './db';
import { getProjectIdsForCreator, getProjectInfo, getProjectEntries } from './db.query';
import { translateDbToLocal } from './db.format';

/**
 * Retrieve full assembled payloads for every project belonging to the
 * currently logged-in creator. This mirrors the prior implementation but
 * lives in `db.load.ts` (DB -> local responsibilities).
 */
// fullLoad: fetch projects for the logged-in creator and create local folders
// for each project. The function will create the project folder named from
// the project's title (sanitized) or fallback to the project id, then create
// the subdirectories `data`, `chapters`, `notes`, and `refs`. An empty
// placeholder `data/project.json` (containing `{}`) is written for now.
export async function fullLoad(options?: { baseDir?: string; persist?: boolean; assemble?: boolean }): Promise<{ ok: boolean; ids?: string[]; created?: Array<{ id: string; path: string }>; error?: string }> {
		// Determine base directory: prefer a workspace-level `InkDoodleProjects`
		// folder if present; otherwise fall back to process.cwd() or an explicit
		// options.baseDir provided by the caller.
		let baseDir = options?.baseDir;
			if (!baseDir) {
				// Check a sibling folder (one level up) which is where the workspace
				// often keeps `InkDoodleProjects`, then check inside the repo folder.
				const sibling = path.join(path.dirname(process.cwd()), 'InkDoodleProjects');
				const inside = path.join(process.cwd(), 'InkDoodleProjects');
				const oneDriveCandidate = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'OneDrive', 'Documents', 'InkDoodleProjects') : null;
				const desktopCandidate = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop', 'InkDoodleProjects') : null;
				try {
							const s1 = await fs.stat(sibling);
							if (s1 && s1.isDirectory()) {
								baseDir = sibling;
							} else if (oneDriveCandidate) {
								try {
									const s3 = await fs.stat(oneDriveCandidate);
									if (s3 && s3.isDirectory()) baseDir = oneDriveCandidate;
									else {
										const s2 = await fs.stat(inside);
										baseDir = s2 && s2.isDirectory() ? inside : process.cwd();
									}
								} catch (e3) {
									const s2 = await fs.stat(inside);
									baseDir = s2 && s2.isDirectory() ? inside : process.cwd();
								}
							} else {
								const s2 = await fs.stat(inside);
								baseDir = s2 && s2.isDirectory() ? inside : process.cwd();
							}
				} catch (e) {
					// Fallback: if sibling doesn't exist try inside repo, else cwd
							try {
								if (oneDriveCandidate) {
									const s3 = await fs.stat(oneDriveCandidate);
									if (s3 && s3.isDirectory()) {
										baseDir = oneDriveCandidate;
										// skip checking inside
										throw new Error('chosen-onedrive');
									}
								}
								const s2 = await fs.stat(inside);
								baseDir = s2 && s2.isDirectory() ? inside : process.cwd();
							} catch (e2) {
								if (e2 && e2.message === 'chosen-onedrive') {
									/* baseDir already set */
								} else {
									baseDir = process.cwd();
								}
							}
				}
			}
		const persist = options?.persist ?? true;
	const assemble = options?.assemble ?? true;
		appendDebugLog(`db.load:fullLoad called (baseDir=${baseDir}, persist=${persist}, assemble=${assemble})`);

	function sanitizeName(name: string) {
		if (!name) return '';
		// Replace disallowed chars, trim, collapse spaces, limit length
		return name.replace(/[<>:\"/\\|?*]/g, '').trim().replace(/\s+/g, '-').slice(0, 128);
	}

	try {
		const p = await pool.query(`SELECT value AS user FROM prefs WHERE key = 'auth_user' LIMIT 1;`);
		const u = p.rows?.[0]?.user || null;
		const creatorId = u?.id ?? null;
		if (!creatorId) {
			appendDebugLog('db.load:fullLoad — no logged-in user found in prefs');
			return { ok: false, error: 'No logged in user' };
		}

		const ids = await getProjectIdsForCreator(String(creatorId));
		appendDebugLog(`db.load:fullLoad — fetched ${ids.length} project ids for creator ${creatorId}`);

		if (persist) {
			try {
				const payload = JSON.stringify({ ids, ts: new Date().toISOString() });
				await pool.query(
					`INSERT INTO prefs(key, value) VALUES ('last_full_upload_project_ids', $1::jsonb)
						 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();`,
					[payload]
				);
				appendDebugLog('db.load:fullLoad — persisted project ids to prefs:last_full_upload_project_ids');
			} catch (err) {
				appendDebugLog(`db.load:fullLoad — failed to persist ids to prefs: ${(err as Error).message}`);
			}
		}

		if (!assemble) return { ok: true, ids, created: [] };

		const created: Array<{ id: string; path: string }> = [];
			for (const pid of ids) {
				try {
					const project = await getProjectInfo(pid);
					const entries = await getProjectEntries(pid);
				// Choose folder name from title or id
				const title = project?.title ? String(project.title) : '';
				let folderName = sanitizeName(title) || String(pid);
				// Ensure folderName is unique under baseDir by appending suffix if exists
				let projectPath = path.join(baseDir, folderName);
				let suffix = 1;
				while (true) {
					try {
						const st = await fs.stat(projectPath);
						// If it's a file, or directory exists, append suffix
						folderName = `${sanitizeName(title) || String(pid)}-${suffix}`;
						projectPath = path.join(baseDir, folderName);
						suffix += 1;
						if (suffix > 1000) break; // avoid infinite loop
					} catch (e) {
						// stat failed -> path does not exist, use it
						break;
					}
				}

						// Create directories
						await fs.mkdir(path.join(projectPath, 'data'), { recursive: true });
						await fs.mkdir(path.join(projectPath, 'chapters'), { recursive: true });
						await fs.mkdir(path.join(projectPath, 'notes'), { recursive: true });
						await fs.mkdir(path.join(projectPath, 'refs'), { recursive: true });

						// Convert DB payload to local shapes
						const conv = await translateDbToLocal({ project, entries });
						if (!conv.ok || !Array.isArray(conv.projects) || conv.projects.length === 0) {
							appendDebugLog(`db.load:fullLoad — translateDbToLocal failed for ${pid}: ${conv.error || 'no projects'}`);
						} else {
							const lp = conv.projects[0];
							// Write data/project.json with project and summary entries
							const summaryEntries: any[] = [];
							const pushSummary = (e: any, type: string, idx: number) => {
								summaryEntries.push({ id: e.id ?? null, code: e.code ?? null, type, title: e.title ?? null, order_index: idx, updated_at: e.updated_at ?? null });
							};

							lp.entries.chapters.forEach((c: any, i: number) => pushSummary(c, 'chapter', i));
							lp.entries.notes.forEach((n: any, i: number) => pushSummary(n, 'note', i));
							lp.entries.refs.forEach((r: any, i: number) => pushSummary(r, 'reference', i));

							const pjPath = path.join(projectPath, 'data', 'project.json');
							await fs.writeFile(pjPath, JSON.stringify({ project: lp.project, entries: summaryEntries }, null, 2), 'utf8');

							// Write individual entry files
							const writeEntries = async (arr: any[], subdir: string) => {
								for (const e of arr) {
									const name = String(e.code || e.id || `entry-${Math.random().toString(36).slice(2,8)}`) + '.json';
									const fp = path.join(projectPath, subdir, name);
									try {
										await fs.writeFile(fp, JSON.stringify(e, null, 2), 'utf8');
									} catch (err) {
										appendDebugLog(`db.load:fullLoad — failed to write ${fp}: ${(err as Error).message}`);
									}
								}
							};

							await writeEntries(lp.entries.chapters, 'chapters');
							await writeEntries(lp.entries.notes, 'notes');
							await writeEntries(lp.entries.refs, 'refs');

							appendDebugLog(`db.load:fullLoad — created project folder and files for ${pid} at ${projectPath}`);
							created.push({ id: pid, path: projectPath });
						}
			} catch (err) {
				appendDebugLog(`db.load:fullLoad — failed processing project ${pid}: ${(err as Error).message}`);
				// continue with remaining ids
			}
		}

		return { ok: true, ids, created };
	} catch (err) {
		appendDebugLog(`db.load:fullLoad — error: ${(err as Error).message}`);
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Assemble payloads for the logged-in creator and write them to a
 * temporary JSON file. By default this writes `temporary.json` to the
 * current working directory (process.cwd()). This belongs in `db.load` as
 * it is a DB->local operation (pulling from DB and writing local files).
 */
export async function fullUploadToTemporaryJson(outPath?: string): Promise<{ ok: boolean; path?: string; ids?: string[]; payloads?: Array<any>; error?: string }> {
	const target = outPath || path.join(process.cwd(), 'temporary.json');
	appendDebugLog(`db.load:fullUploadToTemporaryJson writing to ${target}`);

	try {
		// Assemble payloads directly: fetch logged-in creator, project ids,
		// then for each project fetch project info and entries.
		const p = await pool.query(`SELECT value AS user FROM prefs WHERE key = 'auth_user' LIMIT 1;`);
		const u = p.rows?.[0]?.user || null;
		const creatorId = u?.id ?? null;
		if (!creatorId) return { ok: false, error: 'No logged in user' };

		const ids = await getProjectIdsForCreator(String(creatorId));
		const payloads: Array<any> = [];
		for (const pid of ids) {
			try {
				const project = await getProjectInfo(pid);
				const entries = await getProjectEntries(pid);
				payloads.push({ id: pid, project, entries });
			} catch (err) {
				appendDebugLog(`db.load:fullUploadToTemporaryJson — failed assembling payload for project ${pid}: ${(err as Error).message}`);
			}
		}

		const toWrite = { ids, payloads, ts: new Date().toISOString() };
		await fs.writeFile(target, JSON.stringify(toWrite, null, 2), 'utf8');
		appendDebugLog(`db.load:fullUploadToTemporaryJson wrote ${String((ids || []).length)} projects to ${target}`);
		return { ok: true, path: target, ids, payloads };
	} catch (err) {
		appendDebugLog(`db.load:fullUploadToTemporaryJson error: ${(err as Error).message}`);
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

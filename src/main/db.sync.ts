// db.sync.ts
const { app } = require("electron");
const path = require("path");
const fs = require("fs");
import { pool, downloadProjects, deleteProject } from "./db";
import { saveItem, deleteItem } from "./db.operations";
import { appendDebugLog } from "./log";
import { 
  dbToLocal,
  localToDb,
  getProjectDirectoryName, 
  findExistingProjectDirectory,
  LocalProjectData,
  LocalProject 
} from "./db.format";

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

// Helper to ensure fresh directory
function recreateDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

async function saveWorkspaceToLocal(projectDir: string): Promise<void> {
  const workspaceDir = path.join(app.getPath("userData"), "workspace");
  
  logWorkspaceOperation({ 
    operation: 'save-start',
    details: { workspaceDir, projectDir }
  });

  if (!fs.existsSync(workspaceDir)) {
    logWorkspaceOperation({
      operation: 'save-error',
      details: { error: 'No workspace directory found', workspaceDir }
    });
    return;
  }

  try {
    // Copy all files from workspace to project directory with detailed logging
    const copyDir = (src: string, dest: string, entryType?: string) => {
      if (!fs.existsSync(src)) {
        logWorkspaceOperation({
          operation: 'save-skip',
          entryType: entryType as any,
          details: { reason: 'source directory not found', src }
        });
        return;
      }

      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
        logWorkspaceOperation({
          operation: 'create-directory',
          entryType: entryType as any,
          details: { path: dest }
        });
      }
      
      const files = fs.readdirSync(src);
      for (const file of files) {
        const srcPath = path.join(src, file);
        const destPath = path.join(dest, file);
        
        if (fs.statSync(srcPath).isFile()) {
          const fileId = file.replace('.json', '');
          fs.copyFileSync(srcPath, destPath);
          
          logWorkspaceOperation({
            operation: 'save-entry',
            entryType: entryType as any,
            entryId: fileId,
            details: { 
              from: srcPath,
              to: destPath,
              size: fs.statSync(srcPath).size
            }
          });
        }
      }
    };

    // Copy each entry type directory with typed logging
    const entryTypes = {
      'chapters': 'chapter',
      'notes': 'note',
      'refs': 'reference'
    };

    Object.entries(entryTypes).forEach(([dir, type]) => {
      copyDir(
        path.join(workspaceDir, dir),
        path.join(projectDir, dir),
        type
      );
    });

    // Copy project data
    copyDir(path.join(workspaceDir, 'data'), path.join(projectDir, 'data'), 'project');
    
    logWorkspaceOperation({
      operation: 'save-complete',
      details: { projectDir }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWorkspaceOperation({
      operation: 'save-error',
      details: { error: msg }
    });
    throw err;
  }
}

export async function syncToDB(creatorId: number, projectDir: string) {
  try {
    logWorkspaceOperation({
      operation: 'sync-start',
      details: { creatorId, projectDir }
    });
    
    // First, save workspace state to project directory
    await saveWorkspaceToLocal(projectDir);
    
    logWorkspaceOperation({
      operation: 'sync-workspace-saved',
      details: { projectDir }
    });
    
    const result = {
      ok: true as const,
      synced: [] as Array<{localId: string, dbId: string}>
    };

    // Read project.json for project info
    const projectFile = path.join(projectDir, 'data', 'project.json');
    // Read and transform project data
    const projectData = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    const dbProjectData = localToDb(projectData.project, 'project');
    const title = dbProjectData.title || 'Untitled Project';
    const projectCode = dbProjectData.code;

    // Create or update project in DB first
    const projectQuery = projectCode 
      ? await pool.query(
          `SELECT id, code FROM projects WHERE code = $1 AND creator_id = $2`,
          [projectCode, creatorId]
        )
      : await pool.query(
          `INSERT INTO projects (title, creator_id) 
           VALUES ($1, $2)
           RETURNING id, code`,
          [title, creatorId]
        );

    if (!projectQuery.rows[0]) {
      throw new Error('Failed to create/find project in DB');
    }

    const dbProject = projectQuery.rows[0];
    
    // Update local project.json with DB-assigned code if needed
    if (!projectCode) {
      projectData.project.code = dbProject.code;
      fs.writeFileSync(projectFile, JSON.stringify(projectData, null, 2), 'utf8');
      appendDebugLog(`db:sync — Updated local project with DB-assigned code ${dbProject.code}`);
    }

    // Get list of all files in entry directories
    const entryTypes = ['chapters', 'notes', 'refs'];
    const typeMap = {
      'chapters': 'chapter',
      'notes': 'note',
      'refs': 'reference'
    };
    
    for (const type of entryTypes) {
      const typeDir = path.join(projectDir, type);
      if (!fs.existsSync(typeDir)) continue;

      const files = fs.readdirSync(typeDir).filter(f => f.endsWith('.json'));
      
      for (const file of files) {
        const entryPath = path.join(typeDir, file);
        const entryId = file.replace('.json', '');
        
        logWorkspaceOperation({
          operation: 'sync-read-entry',
          entryType: typeMap[type] as any,
          entryId,
          details: { path: entryPath }
        });

        // Read local format entry
        const localEntry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
        
        // Transform to DB format and add project info
        appendDebugLog(`db:sync:debug — Transforming ${typeMap[type]} data. Local data: ${JSON.stringify(localEntry)}`);
        const dbFormatData = localToDb(localEntry, typeMap[type] as any);
        appendDebugLog(`db:sync:debug — Transformed to DB format: ${JSON.stringify(dbFormatData)}`);
        
        // Always use the current project's ID from DB
        const finalData = {
          ...dbFormatData,
          project_id: dbProject.id,  // Override/set project_id from current DB project
          project_code: dbProject.code,
          creator_id: creatorId      // Ensure creator_id is set
        };
        
        appendDebugLog(`db:sync:debug — Final data for save: ${JSON.stringify(finalData)}`);
        const dbItem = await saveItem(typeMap[type], finalData, creatorId);

        logWorkspaceOperation({
          operation: 'sync-save-entry',
          entryType: typeMap[type] as any,
          entryId,
          details: { 
            localId: entryId,
            dbId: dbItem.code,
            projectCode: dbProject.code
          }
        });

        result.synced.push({
          localId: entryId,
          dbId: dbItem.code
        });
      }
    }

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendDebugLog(`db:sync — Error pushing changes: ${msg}`);
    return { ok: false as const, error: msg };
  }
}

export async function syncDeletions(creatorId: number, options: { ignoreMissing?: boolean } = {}): Promise<void> {
  try {
    appendDebugLog(`db:deletions — Starting deletion sync for creator ${creatorId}`);
    
    // 1. Get all projects from DB
    const dbProjects = await downloadProjects(creatorId);
    
    // 2. Get list of local projects
    const projectsRoot = path.join(app.getPath("documents"), "InkDoodleProjects");
    const localProjects = new Set<string>();
    
    if (fs.existsSync(projectsRoot)) {
      const dirs = fs.readdirSync(projectsRoot);
      for (const dir of dirs) {
        const projectPath = path.join(projectsRoot, dir);
        if (fs.statSync(projectPath).isDirectory()) {
          try {
            const projectFile = path.join(projectPath, 'data', 'project.json');
            if (fs.existsSync(projectFile)) {
              const data = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
              if (data.project?.code) {
                localProjects.add(data.project.code);
              }
            }
          } catch (e) {
            appendDebugLog(`db:deletions — Error reading project in ${dir}: ${e?.message || e}`);
          }
        }
      }
    }

    // If ignoreMissing is true and no local projects exist, don't delete anything
    if (options.ignoreMissing && localProjects.size === 0) {
      appendDebugLog(`db:deletions — No local projects found and ignoreMissing=true, skipping deletions`);
      return;
    }

    // 3. Delete projects that exist in DB but not locally
    let deletedCount = 0;
    for (const dbProject of dbProjects) {
      if (!localProjects.has(dbProject.code)) {
        appendDebugLog(`db:deletions — Deleting project "${dbProject.title}" (${dbProject.code}) from DB`);
        await deleteProject(dbProject.id);
        deletedCount++;
      }
    }

    appendDebugLog(`db:deletions — Completed. Deleted ${deletedCount} projects from DB`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendDebugLog(`db:deletions — Failed: ${msg}`);
    throw err;
  }
}

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

    // Ensure projects root exists
    if (!fs.existsSync(projectsRoot)) {
      fs.mkdirSync(projectsRoot, { recursive: true });
    }
    
    for (const project of projectList.rows) {
      // Generate directory name from project title
      const dirName = getProjectDirectoryName(project);
      let projectDir = path.join(projectsRoot, dirName);
      
      // Check for existing project directory with different name
      const existingDirs = fs.readdirSync(projectsRoot);
      const existingDir = findExistingProjectDirectory(project.code, existingDirs, projectsRoot);
      
      if (existingDir && existingDir !== dirName) {
        // Found project under different name - rename to match current title
        const oldPath = path.join(projectsRoot, existingDir);
        if (fs.existsSync(projectDir)) {
          fs.rmSync(projectDir, { recursive: true, force: true });
        }
        fs.renameSync(oldPath, projectDir);
        appendDebugLog(`db:sync — Renamed project directory from ${existingDir} to ${dirName}`);
      }
      
      // Create project directory structure
      fs.mkdirSync(path.join(projectDir, "data"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, "chapters"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, "notes"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, "refs"), { recursive: true });

      // Initialize basic project.json with metadata using format transformation
      const initialProjectData: LocalProjectData = {
        project: dbToLocal(project, 'project') as LocalProject,
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
      
      // Process chapters using format transformation
      for (const ch of chapters.rows) {
        const chapterEntry = dbToLocal(ch, 'chapter');
        
        // Add to entries list
        projectData.entries.push(chapterEntry);
        
        // Write chapter file with local format
        fs.writeFileSync(
          path.join(projectDir, "chapters", `${chapterEntry.id}.json`),
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

      // Process notes using format transformation
      for (const n of notes.rows) {
        const noteEntry = dbToLocal(n, 'note');
        
        // Add to entries list
        projectData.entries.push(noteEntry);
        
        // Write note file with local format
        fs.writeFileSync(
          path.join(projectDir, "notes", `${noteEntry.id}.json`),
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

      // Process references using format transformation
      for (const r of refs.rows) {
        const refEntry = dbToLocal(r, 'reference');
        
        // Add to entries list
        projectData.entries.push(refEntry);
        
        // Write reference file with local format
        fs.writeFileSync(
          path.join(projectDir, "refs", `${refEntry.id}.json`),
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
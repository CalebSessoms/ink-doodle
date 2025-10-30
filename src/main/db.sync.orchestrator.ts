// db.sync.orchestrator.ts - Coordinates sync operations
import { ipcMain, app } from 'electron';
import { syncFromDB, syncDeletions, syncToDB } from './db.sync';
import { pool } from './db';
import { appendDebugLog } from './log';
import * as path from 'path';
import * as fs from 'fs';

interface SyncResult {
  ok: boolean;
  reloadNeeded?: boolean;
  error?: string;
}

class SyncOrchestrator {
  private syncInProgress: boolean = false;
  private lastSyncTime: number = 0;
  private readonly minSyncInterval: number = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.setupHandlers();
  }

  private setupHandlers() {
    ipcMain.handle('sync:start', async () => {
      return this.startSync();
    });

    ipcMain.handle('sync:force', async () => {
      return this.forceSync();
    });

    ipcMain.handle('sync:status', () => {
      return {
        inProgress: this.syncInProgress,
        lastSync: this.lastSyncTime
      };
    });
  }

  private async getCurrentUser() {
    try {
      const result = await pool.query(
        `SELECT value->>'id' AS creator_id 
         FROM prefs 
         WHERE key = 'auth_user' 
         LIMIT 1;`
      );
      return Number(result.rows?.[0]?.creator_id) || null;
    } catch (err) {
      appendDebugLog(`sync:getCurrentUser — Failed: ${err?.message || err}`);
      return null;
    }
  }

  private async startSync(): Promise<SyncResult> {
    if (this.syncInProgress) {
      return { ok: false, error: 'Sync already in progress' };
    }

    const now = Date.now();
    if (now - this.lastSyncTime < this.minSyncInterval) {
      return { ok: false, error: 'Sync attempted too soon' };
    }

    return this.performSync();
  }

  private async forceSync(): Promise<SyncResult> {
    if (this.syncInProgress) {
      return { ok: false, error: 'Sync already in progress' };
    }

    return this.performSync();
  }

  private async performSync(): Promise<SyncResult> {
    this.syncInProgress = true;
    
    try {
      // Check if sync is enabled globally
      if (!global.DB_SYNC_ENABLED) {
        appendDebugLog('sync:perform — Sync disabled via DB_SYNC_ENABLED flag');
        return { ok: false, error: 'Sync is disabled' };
      }

      const creatorId = await this.getCurrentUser();
      if (!creatorId) {
        return { ok: false, error: 'No user logged in' };
      }

      // Get current project directory
      const projectsRoot = path.join(app.getPath("documents"), "InkDoodleProjects");
      const dirs = fs.readdirSync(projectsRoot).filter(dir => 
        fs.statSync(path.join(projectsRoot, dir)).isDirectory()
      );

      // For each project directory
      for (const dir of dirs) {
        const projectDir = path.join(projectsRoot, dir);
        
        // Push local state to DB
        appendDebugLog(`sync:perform — Syncing project directory: ${dir}`);
        const pushResult = await syncToDB(creatorId, projectDir);
        
        if (!pushResult.ok) {
          appendDebugLog(`sync:perform — Failed to sync project ${dir}`);
          continue;
        }
      }

      // Clean up deleted projects
      await syncDeletions(creatorId, { ignoreMissing: true });

      this.lastSyncTime = Date.now();
      return { ok: true, reloadNeeded: false };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendDebugLog(`sync:perform — Failed: ${msg}`);
      return { ok: false, error: msg };
    } finally {
      this.syncInProgress = false;
    }
  }

  private async pushChanges(creatorId: number, changes: any[]): Promise<SyncResult> {
    try {
      for (const change of changes) {
        if (change.deleted) {
          await this.handleDeletion(creatorId, change);
        } else {
          await this.handleUpdate(creatorId, change);
        }
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendDebugLog(`sync:pushChanges — Failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  private async handleDeletion(creatorId: number, change: any): Promise<void> {
    // Implement deletion logic
    appendDebugLog(`sync:handleDeletion — Deleting ${change.type} ${change.id}`);
    // ... deletion implementation ...
  }

  private async handleUpdate(creatorId: number, change: any): Promise<void> {
    // Implement update logic
    appendDebugLog(`sync:handleUpdate — Updating ${change.type} ${change.id}`);
    // ... update implementation ...
  }
}

// Export singleton instance
export const syncOrchestrator = new SyncOrchestrator();
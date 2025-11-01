// db.sync.orchestrator.ts - Coordinates sync operations
import { ipcMain, app } from 'electron';
import { syncFromDB } from './db.sync';
import { pool } from './db';
import { appendDebugLog } from './log';

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

      // Previously this orchestrator scanned local project directories and
      // pushed local changes to the DB. Uploads have been intentionally
      // removed across the app. We do not perform any local->DB scanning
      // or upload/deletion behavior here — only downloads/pulls from DB.
      try {
        const res = await syncFromDB(creatorId);
        this.lastSyncTime = Date.now();
        return { ok: !!res.ok, reloadNeeded: res.reloadNeeded || false };
      } catch (e) {
        appendDebugLog(`sync:perform — download-only sync failed: ${e?.message || e}`);
        return { ok: false, error: String(e) };
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendDebugLog(`sync:perform — Failed: ${msg}`);
      return { ok: false, error: msg };
    } finally {
      this.syncInProgress = false;
    }
  }

  private async pushChanges(creatorId: number, changes: any[]): Promise<SyncResult> {
    // Uploads are disabled. This method is retained as a safe no-op so
    // other modules that may call it won't trigger writes. It returns
    // a failure result to indicate the push was not performed.
    appendDebugLog('sync:pushChanges — Attempted push ignored: uploads are disabled');
    return { ok: false, error: 'Uploads are disabled' };
  }

  private async handleDeletion(creatorId: number, change: any): Promise<void> {
    // Deletions are disabled. Log and return.
    appendDebugLog(`sync:handleDeletion — Ignored deletion ${change.type} ${change.id} (uploads disabled)`);
    return;
  }

  private async handleUpdate(creatorId: number, change: any): Promise<void> {
    // Updates are disabled. Log and return.
    appendDebugLog(`sync:handleUpdate — Ignored update ${change.type} ${change.id} (uploads disabled)`);
    return;
  }
}

// Export singleton instance
export const syncOrchestrator = new SyncOrchestrator();
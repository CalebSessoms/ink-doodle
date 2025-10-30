// sync.manager.ts - Client-side sync management
export class SyncManager {
  private static instance: SyncManager;
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private lastSyncAttempt: number = 0;
  private readonly minSyncInterval = 5 * 60 * 1000; // 5 minutes

  private constructor() {
    this.setupEventListeners();
  }

  public static getInstance(): SyncManager {
    if (!SyncManager.instance) {
      SyncManager.instance = new SyncManager();
    }
    return SyncManager.instance;
  }

  public startAutoSync() {
    if (this.syncInterval) return;

    // Initial sync
    this.sync();

    // Set up interval
    this.syncInterval = setInterval(() => {
      const now = Date.now();
      if (now - this.lastSyncAttempt >= this.minSyncInterval) {
        this.sync();
      }
    }, 60000); // Check every minute
  }

  public stopAutoSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  public async forceSync(): Promise<boolean> {
    try {
      const result = await window.electron.invoke('sync:force');
      if (result.ok) {
        this.lastSyncAttempt = Date.now();
        if (result.reloadNeeded) {
          this.handleReload();
        }
        return true;
      } else {
        console.error('Sync failed:', result.error);
        return false;
      }
    } catch (err) {
      console.error('Sync error:', err);
      return false;
    }
  }

  private async sync() {
    try {
      const result = await window.electron.invoke('sync:start');
      this.lastSyncAttempt = Date.now();
      
      if (result.ok && result.reloadNeeded) {
        this.handleReload();
      }
    } catch (err) {
      console.error('Auto-sync failed:', err);
    }
  }

  private setupEventListeners() {
    // Listen for online/offline events
    window.addEventListener('online', () => {
      console.log('Network connected - resuming sync');
      this.startAutoSync();
    });

    window.addEventListener('offline', () => {
      console.log('Network disconnected - pausing sync');
      this.stopAutoSync();
    });

    // Listen for visibility changes
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.stopAutoSync();
      } else {
        this.startAutoSync();
      }
    });
  }

  private handleReload() {
    // Save any unsaved changes first
    if (window.app && typeof window.app.saveAll === 'function') {
      window.app.saveAll();
    }

    // Reload after a short delay
    setTimeout(() => {
      window.location.reload();
    }, 1000);
  }
}

// Initialize sync manager
const syncManager = SyncManager.getInstance();

// Export for use in other modules
export { syncManager };
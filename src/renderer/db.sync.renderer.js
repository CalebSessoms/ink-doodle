// db.sync.renderer.js - Handle DB sync in renderer process
const { ipcRenderer } = require('electron');
const SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes

let syncTimer = null;
let lastSyncAttempt = 0;

// Progress UI elements
let progressEl = null;
let progressPhaseEl = null;
let progressFillEl = null;
let progressDetailEl = null;

function initializeProgressUI() {
  progressEl = document.getElementById('sync-progress');
  progressPhaseEl = progressEl?.querySelector('.phase');
  progressFillEl = progressEl?.querySelector('.progress-fill');
  progressDetailEl = progressEl?.querySelector('.detail');
}

// Update progress UI
function updateProgress(progress) {
  if (!progressEl) initializeProgressUI();
  if (!progressEl) return; // UI not ready
  
  const { phase, current, total, detail } = progress;
  
  // Show progress element
  progressEl.classList.add('active');
  progressEl.classList.remove('error', 'complete');
  
  // Update phase text
  if (progressPhaseEl) {
    const phaseText = {
      'init': 'Initializing...',
      'check': 'Checking Changes',
      'upload': 'Uploading',
      'download': 'Downloading',
      'complete': 'Complete',
      'error': 'Error'
    }[phase] || phase;
    progressPhaseEl.textContent = phaseText;
  }
  
  // Update progress bar
  if (progressFillEl) {
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    progressFillEl.style.width = `${percent}%`;
  }
  
  // Update detail text
  if (progressDetailEl) {
    progressDetailEl.textContent = detail || '';
  }
  
  // Special states
  if (phase === 'error') {
    progressEl.classList.add('error');
    setTimeout(() => {
      progressEl.classList.remove('active');
    }, 5000); // Hide error after 5s
  } else if (phase === 'complete') {
    progressEl.classList.add('complete');
    setTimeout(() => {
      progressEl.classList.remove('active');
    }, 2000); // Hide completion after 2s
  }
}

// Set up IPC listeners for progress updates
ipcRenderer.on('sync:progress', (_evt, progress) => {
  updateProgress(progress);
});

// Start periodic sync
export async function startSync() {
  try {
    // Ask main process for DB_SYNC_ENABLED state
    const syncEnabled = await ipcRenderer.invoke('sync:isEnabled');
    if (!syncEnabled) {
      console.log('DB sync disabled via DB_SYNC_ENABLED flag');
      return;
    }
  } catch (err) {
    console.error('Failed to check sync enabled state:', err);
    return;
  }

  if (syncTimer) return;
  
  syncTimer = setInterval(async () => {
    const now = Date.now();
    // Don't sync more often than every 5 minutes
    if (now - lastSyncAttempt < SYNC_INTERVAL) return;
    
    try {
      lastSyncAttempt = now;
      await syncWithDB();
    } catch (err) {
      console.error('Sync failed:', err);
      updateProgress({
        phase: 'error',
        current: 0,
        total: 1,
        detail: err?.message || String(err)
      });
    }
  }, SYNC_INTERVAL);
}

// Stop periodic sync
export function stopSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

// Force immediate sync
export async function forceSyncWithDB() {
  lastSyncAttempt = Date.now();
  return syncWithDB();
}

// Main sync function
async function syncWithDB() {
  if (!ipcRenderer) return { ok: false, error: 'No IPC available' };
  
  try {
    // 1. Check if we're logged in
    updateProgress({
      phase: 'init',
      current: 0,
      total: 5,
      detail: 'Checking authentication...'
    });

    const auth = await ipcRenderer.invoke('auth:get');
    if (!auth?.ok || !auth.user) {
      return { ok: false, error: 'Not logged in' };
    }
    
    // 2. Get list of local changes
    updateProgress({
      phase: 'check',
      current: 1,
      total: 5,
      detail: 'Checking local changes...'
    });

    const changes = await ipcRenderer.invoke('db:checkSync', {
      projectDir: auth.workspaceDir
    });

    // 3. If we have local changes, push them first
    if (changes?.ok && changes.needsSync) {
      updateProgress({
        phase: 'upload',
        current: 2,
        total: 5,
        detail: 'Uploading local changes...'
      });

      const pushResult = await ipcRenderer.invoke('db:pushDirectory', {
        projectDir: auth.workspaceDir
      });

      if (!pushResult?.ok) {
        return { ok: false, error: pushResult?.error || 'Failed to push changes' };
      }
    }
    
    // 4. Pull latest from DB
    updateProgress({
      phase: 'download',
      current: 3,
      total: 5,
      detail: 'Downloading updates...'
    });

    const pullResult = await ipcRenderer.invoke('db:syncFromDB');
    if (!pullResult?.ok) {
      return { ok: false, error: pullResult?.error || 'Failed to sync from DB' };
    }
    
    // 5. Reload UI if needed
    if (pullResult.reloadNeeded) {
      updateProgress({
        phase: 'reload',
        current: 4,
        total: 5,
        detail: 'Reloading application...'
      });
      setTimeout(() => {
        window.location.reload();
      }, 500);
    } else {
      // Complete
      updateProgress({
        phase: 'complete',
        current: 5,
        total: 5,
        detail: 'Sync completed successfully'
      });
    }
    
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    updateProgress({
      phase: 'error',
      current: 0,
      total: 5,
      detail: error
    });
    return { ok: false, error };
  }
}
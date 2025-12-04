const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function getWorkspaceDir() {
  try {
    return path.join(app.getPath('userData'), 'workspace');
  } catch (e) {
    return null;
  }
}

function getProjectsRoot() {
  try {
    return path.join(app.getPath('documents'), 'InkDoodleProjects');
  } catch (e) {
    return null;
  }
}

function getGlobalLogPath() {
  // project root is two levels up from this module (src/main)
  return path.resolve(__dirname, '..', '..', 'debug.log');
}

// Append a timestamped line to workspace, per-project (optional), and global log.
function appendDebugLog(line, projectDir) {
  try {
    const stamp = new Date().toISOString();
    // Only write to the global app log in repo root
    try {
      const GLOBAL_LOG = getGlobalLogPath();
      try { fs.appendFileSync(GLOBAL_LOG, `[${stamp}] ${String(line)}\n`, 'utf8'); } catch (e) { /* best-effort */ }
    } catch (e) { /* best-effort */ }
  } catch (e) {
    // final best-effort fallback
    try { console.warn('[log] appendDebugLog failed:', e && e.message ? e.message : e); } catch (e2) { }
  }
}

module.exports = { appendDebugLog, getWorkspaceDir, getProjectsRoot, getGlobalLogPath };

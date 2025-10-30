// db.state.ts - Manages DB state tracking
const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const { appendDebugLog } = require("./log");

interface DBState {
  lastSync: string;  // ISO timestamp of last sync
  entries: {
    [id: string]: {
      type: "chapter" | "note" | "reference";
      localId: string;
      dbId: string;
      hash: string;  // Content hash for change detection
      synced: boolean;
      deleted: boolean;
    }
  }
}

let state: DBState = {
  lastSync: "",
  entries: {}
};

export function initDBState(projectDir: string) {
  const stateFile = path.join(projectDir, "data", ".db_state.json");
  
  try {
    if (fs.existsSync(stateFile)) {
      state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      appendDebugLog(`db:state — Loaded existing DB state from ${stateFile}`);
    } else {
      state = { lastSync: "", entries: {} };
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
      appendDebugLog(`db:state — Initialized new DB state in ${stateFile}`);
    }
  } catch (err) {
    appendDebugLog(`db:state — Error loading DB state: ${err?.message || err}`);
    state = { lastSync: "", entries: {} };
  }
}

export function saveDBState(projectDir: string) {
  const stateFile = path.join(projectDir, "data", ".db_state.json");
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
    appendDebugLog(`db:state — Saved DB state to ${stateFile}`);
  } catch (err) {
    appendDebugLog(`db:state — Error saving DB state: ${err?.message || err}`);
  }
}

export function trackEntry(entry: any, type: "chapter" | "note" | "reference") {
  const id = entry.id || entry.code;
  if (!id) {
    appendDebugLog(`db:state — Cannot track entry without id/code`);
    return;
  }
  
  state.entries[id] = {
    type,
    localId: entry.id,
    dbId: entry.code || "",
    hash: calculateHash(entry),
    synced: !!entry.code,
    deleted: false
  };
}

export function markDeleted(id: string) {
  if (state.entries[id]) {
    state.entries[id].deleted = true;
    state.entries[id].synced = false;
  }
}

export function getUnsyncedEntries() {
  return Object.entries(state.entries)
    .filter(([_, entry]) => !entry.synced)
    .map(([id, entry]) => ({
      id,
      type: entry.type,
      deleted: entry.deleted
    }));
}

export function calculateHash(entry: any): string {
  // Create a deterministic string representation for change detection
  const relevant = {
    title: entry.title || "",
    body: entry.body || "",
    updated_at: entry.updated_at,
    // Add type-specific fields
    ...(entry.type === "chapter" ? {
      status: entry.status,
      synopsis: entry.synopsis,
      tags: entry.tags
    } : entry.type === "note" ? {
      category: entry.category,
      pinned: entry.pinned,
      tags: entry.tags
    } : {
      reference_type: entry.reference_type,
      summary: entry.summary,
      source_link: entry.source_link,
      tags: entry.tags
    })
  };
  return JSON.stringify(relevant);
}

export function markSynced(localId: string, dbId: string) {
  if (state.entries[localId]) {
    state.entries[localId].dbId = dbId;
    state.entries[localId].synced = true;
  }
}

export function updateLastSync() {
  state.lastSync = new Date().toISOString();
}

export function hasChanges(): boolean {
  return Object.values(state.entries).some(e => !e.synced);
}

export function getLastSync(): string {
  return state.lastSync;
}
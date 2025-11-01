// db.state.ts — DB state tracking has been removed.
//
// All functions that managed a local->DB change state (initDBState,
// saveDBState, trackEntry, markDeleted, getUnsyncedEntries, markSynced,
// updateLastSync, hasChanges, getLastSync, calculateHash) were removed
// to eliminate any remaining local→DB upload logic. The file remains as
// a placeholder so imports won't fail; it intentionally exports no runtime
// functions. If you need to reintroduce state tracking later, re-implement
// with explicit design and clear call-sites.
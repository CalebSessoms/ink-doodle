// db.utils.ts
// Upload-related utilities (validation, transaction helpers, and DB error
// mapping) were removed because local->DB write flows were intentionally
// deleted from the application. If you need these helpers again later,
// reintroduce the functions here behind a controlled feature flag.

// NOTE: This file intentionally exports nothing now. All download/read
// flows in the app were audited to avoid depending on these utilities.
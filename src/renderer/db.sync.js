// Handle DB sync during app initialization
async function syncFromDBIfLoggedIn() {
  try {
    const auth = await ipcRenderer.invoke("auth:get");
    if (auth?.ok && auth.user) {
      dbg("Found logged in user - initiating DB sync");
      const syncResult = await ipcRenderer.invoke("db:syncFromDB");
      if (syncResult?.ok) {
        dbg(`DB sync successful - synced ${syncResult.projectCount} projects`);
      } else {
        dbg(`DB sync failed: ${syncResult?.error || "Unknown error"}`);
      }
    }
  } catch (err) {
    dbg(`DB sync error: ${err?.message || err}`);
  }
}
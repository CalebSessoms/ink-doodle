Syncing repo renderer to running workspace

Why
- The Electron app loads a workspace copy under %APPDATA%\ink-doodle\workspace. During development you may want to push local edits to that workspace so the running app reflects changes immediately.

How to use
1. Close the running app.
2. Open PowerShell and run this script from the repo root or run directly:

   scripts\sync-to-workspace.ps1

3. The script copies `index.html` and `src/renderer/app.js` into the workspace and then tails the workspace `debug.log` so you can watch for `dev-mark` lines and other debug messages.

If you prefer to run the app from the repo copy instead, use:

   cd C:\Users\caleb\Desktop\ink-doodle
   npm start

Notes
- This is a local developer convenience script. It does not modify your source control history except writing into %APPDATA% which is not part of the repo.
- If the app later overwrites workspace files, re-run this script.

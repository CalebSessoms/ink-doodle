// scripts/tester.js
// Small helper script to exercise `getProjectInfo` and `getProjectEntries`.
// Usage: node scripts/tester.js
// Note: This script requires a working DATABASE_URL environment variable
// and access to the project's Postgres DB. It uses ts-node to import .ts modules.

// Register ts-node so we can require TypeScript modules directly.
try {
  require('ts-node/register');
} catch (e) {
  console.error('ts-node/register not found. Install ts-node or run with a loader that supports TypeScript.');
  console.error('npm i -D ts-node typescript');
  process.exit(1);
}

(async function main() {
  try {
    const { getProjectInfo, getProjectEntries } = require('../src/main/db.query');

    const projectCode = 'PRJ-0001-000001';
    console.log('Fetching project info for code:', projectCode);

    const info = await getProjectInfo(projectCode);
    console.log('\n=== Project Info ===');
    console.log(info ? JSON.stringify(info, null, 2) : '(not found)');

    console.log('\nFetching project entries (chapters/notes/refs)...');
    const entries = await getProjectEntries(projectCode);
    console.log('\n=== Project Entries ===');
    console.log(JSON.stringify(entries, null, 2));

    process.exit(0);
  } catch (err) {
    console.error('Error running tester:', err && err.stack ? err.stack : err);
    process.exit(2);
  }
})();

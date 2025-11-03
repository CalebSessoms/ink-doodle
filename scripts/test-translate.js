// scripts/test-translate.js
// Test harness for db.format.translateDbToLocal
// Usage: node scripts/test-translate.js

try {
  require('ts-node/register');
} catch (e) {
  console.error('ts-node/register not found. Install ts-node or run with a loader that supports TypeScript.');
  console.error('npm i -D ts-node typescript');
  process.exit(1);
}

(async function main() {
  try {
    const { translateDbToLocal } = require('../src/main/db.format');
    console.log('Calling translateDbToLocal() — will read temporary.json from process.cwd()...');
    const res = await translateDbToLocal();
    console.log('Result:');
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Error running test-translate:', err && err.stack ? err.stack : err);
    process.exit(2);
  }
})();

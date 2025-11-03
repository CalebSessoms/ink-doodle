// scripts/test-upload.js
// Test harness for db.upload.fullUpload
// Usage: node scripts/test-upload.js

try {
  require('ts-node/register');
} catch (e) {
  console.error('ts-node/register not found. Install ts-node or run with a loader that supports TypeScript.');
  console.error('npm i -D ts-node typescript');
  process.exit(1);
}

(async function main() {
  try {
  const { fullUploadToTemporaryJson } = require('../src/main/db.load');
  console.log('Calling db.load.fullUploadToTemporaryJson() — will write temporary.json to process.cwd()...');
  const res = await fullUploadToTemporaryJson();
    console.log('Result:');
    console.log(JSON.stringify(res, null, 2));
    if (res.ok && res.path) {
      console.log('\nWrote temporary JSON to:', res.path);
    }
    process.exit(0);
  } catch (err) {
    console.error('Error running test-upload:', err && err.stack ? err.stack : err);
    process.exit(2);
  }
})();

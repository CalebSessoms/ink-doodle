// scripts/test-load.js
// Test harness for db.load.fullLoad
// Usage: node scripts/test-load.js

try {
  require('ts-node/register');
} catch (e) {
  console.error('ts-node/register not found. Install ts-node or run with a loader that supports TypeScript.');
  console.error('npm i -D ts-node typescript');
  process.exit(1);
}

(async function main() {
  try {
    const { fullLoad } = require('../src/main/db.load');
    console.log('Calling db.load.fullLoad() — will create project folders inside process.cwd()...');
    const res = await fullLoad();
    console.log('Result:');
    console.log(JSON.stringify(res, null, 2));
    if (res.ok && res.created && res.created.length) {
      console.log('\nCreated project folders:');
      for (const c of res.created) console.log('-', c.path);
    }
    process.exit(0);
  } catch (err) {
    console.error('Error running test-load:', err && err.stack ? err.stack : err);
    process.exit(2);
  }
})();

#!/usr/bin/env node
// run_sql.js - execute a .sql file against the DATABASE_URL env using node-postgres
// Usage: node .\scripts\run_sql.js path\to\file.sql

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  const sqlFile = process.argv[2];
  if (!sqlFile) {
    console.error('Usage: node .\\scripts\\run_sql.js path\\to\\file.sql');
    process.exit(2);
  }

  const filePath = path.resolve(process.cwd(), sqlFile);
  if (!fs.existsSync(filePath)) {
    console.error('SQL file not found:', filePath);
    process.exit(3);
  }

  const sql = fs.readFileSync(filePath, 'utf8');
  const connectionString = process.env.DATABASE_URL || process.env.PG_CONNECTION || process.argv[3];
  if (!connectionString) {
    console.error('No DATABASE_URL / PG_CONNECTION found in environment. Set DATABASE_URL before running.');
    process.exit(4);
  }

  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

  try {
    console.log('Connecting to DB...');
    const client = await pool.connect();
    try {
      console.log('Executing SQL file:', filePath);
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log('SQL executed successfully.');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error executing SQL:', err.message || err);
      process.exitCode = 1;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Connection error:', err.message || err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();

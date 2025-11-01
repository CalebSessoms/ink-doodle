// db.query.ts
// Lightweight DB query helpers for read-only access. The primary helper
// `getColumnValue` returns the first value for `column` from `table` as a
// string (or null when no row found). This is read-only and uses the
// existing application's `pool` exported from `src/main/db.ts`.

import { pool } from './db';

function validateIdentifier(name: string) {
  // Allow only letters, numbers and underscore, must start with letter or underscore
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Get a single column value from a table as a string.
 *
 * @param table - table name (validated)
 * @param column - column name (validated)
 * @param whereClause - optional SQL WHERE clause (without the `WHERE` keyword)
 * @param params - optional params for the where clause
 * @returns string value of the column for the first row, or null if none
 */
export async function getColumnValue(table: string, column: string, whereClause?: string, params: any[] = []): Promise<string | null> {
  if (!validateIdentifier(table)) throw new Error('Invalid table name');
  if (!validateIdentifier(column)) throw new Error('Invalid column name');

  const where = whereClause ? `WHERE ${whereClause}` : '';
  const q = `SELECT ${column} FROM ${table} ${where} LIMIT 1;`;

  const res = await pool.query(q, params);
  if (!res.rows || res.rows.length === 0) return null;
  const val = (res.rows[0] as any)[column];
  if (val === null || val === undefined) return null;
  return String(val);
}

/**
 * Convenience wrapper that returns the raw row object for the first matching row.
 * Use sparingly; prefer `getColumnValue` for single-value lookups.
 */
export async function getFirstRow(table: string, whereClause?: string, params: any[] = []): Promise<Record<string, any> | null> {
  if (!validateIdentifier(table)) throw new Error('Invalid table name');
  const where = whereClause ? `WHERE ${whereClause}` : '';
  const q = `SELECT * FROM ${table} ${where} LIMIT 1;`;
  const res = await pool.query(q, params);
  if (!res.rows || res.rows.length === 0) return null;
  return res.rows[0] as Record<string, any>;
}

/**
 * Get all project ids (strings) for a given creator id.
 * Returns an array of id strings (empty array if none found).
 */
export async function getProjectIdsForCreator(creatorId: string): Promise<string[]> {
  const q = `SELECT id FROM projects WHERE creator_id = $1;`;
  const res = await pool.query(q, [creatorId]);
  if (!res.rows || res.rows.length === 0) return [];
  const out: string[] = [];
  for (const r of res.rows) {
    const v = (r as any).id;
    if (v !== null && v !== undefined) out.push(String(v));
  }
  return out;
}

/**
 * Get all chapter ids (strings) for a given creator id.
 * Returns an array of id strings (empty array if none found).
 */
export async function getChapterIdsForCreator(creatorId: string): Promise<string[]> {
  const q = `SELECT id FROM chapters WHERE creator_id = $1;`;
  const res = await pool.query(q, [creatorId]);
  if (!res.rows || res.rows.length === 0) return [];
  const out: string[] = [];
  for (const r of res.rows) {
    const v = (r as any).id;
    if (v !== null && v !== undefined) out.push(String(v));
  }
  return out;
}

/**
 * Get all note ids (strings) for a given creator id.
 */
export async function getNoteIdsForCreator(creatorId: string): Promise<string[]> {
  const q = `SELECT id FROM notes WHERE creator_id = $1;`;
  const res = await pool.query(q, [creatorId]);
  if (!res.rows || res.rows.length === 0) return [];
  const out: string[] = [];
  for (const r of res.rows) {
    const v = (r as any).id;
    if (v !== null && v !== undefined) out.push(String(v));
  }
  return out;
}

/**
 * Get all ref ids (strings) for a given creator id.
 */
export async function getRefIdsForCreator(creatorId: string): Promise<string[]> {
  const q = `SELECT id FROM refs WHERE creator_id = $1;`;
  const res = await pool.query(q, [creatorId]);
  if (!res.rows || res.rows.length === 0) return [];
  const out: string[] = [];
  for (const r of res.rows) {
    const v = (r as any).id;
    if (v !== null && v !== undefined) out.push(String(v));
  }
  return out;
}

export default { getColumnValue, getFirstRow, getProjectIdsForCreator, getChapterIdsForCreator, getNoteIdsForCreator, getRefIdsForCreator };

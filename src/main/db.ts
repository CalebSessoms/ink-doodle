import 'dotenv/config';
import { Pool } from 'pg';
import { appendDebugLog } from './log';
import type { Project, Chapter, Note, Reference } from './types/db.types';

const DATABASE_URL = process.env.DATABASE_URL!;

export const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

// (Removed complex normalization helpers; child-item mapping is handled by upload flow)

export async function pingDB() {
  const { rows } = await pool.query('SELECT now() AS ts, version() AS version;');
  return rows[0];
}
// DB->local download functions removed per user request. This module now
// only exposes `pool` and `pingDB`. Any DB->local load logic must be
// reintroduced consciously and gated behind developer controls.

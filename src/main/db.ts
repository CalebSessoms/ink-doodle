import 'dotenv/config';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL!;

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function pingDB() {
  const { rows } = await pool.query('SELECT now() AS ts, version() AS version;');
  return rows[0];
}

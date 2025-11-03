// db.login.ts - Login-related helpers (NOT DB->local)
//
// This module contains lightweight, non-download helpers related to
// authentication/login startup. It intentionally does NOT perform any
// DB->local downloads or file writes — those flows were removed.

import { appendDebugLog } from './log';
import { pool } from './db';

// Login logic: creator lookup-or-create and persist prefs.auth_user
export async function loginByEmail(emailRaw: string) {
	try {
		const email = String(emailRaw || '').trim().toLowerCase();
		if (!email || !email.includes('@')) {
			return { ok: false, error: 'Please provide a valid email.' };
		}

		// 1) find creator by email
		let q = await pool.query(
			`SELECT id, email, display_name
				 FROM creators
				WHERE lower(email) = $1
				LIMIT 1;`,
			[email]
		);

		// 2) if not found, create one (MVP auto-create)
		if (q.rows.length === 0) {
			q = await pool.query(
				`INSERT INTO creators (email, display_name)
				 VALUES ($1, $2)
				 RETURNING id, email, display_name;`,
				[email, email.split('@')[0]]
			);
		}

		const creator = q.rows[0];

		// 3) persist as prefs.auth_user (id/email/name only)
		await pool.query(
			`INSERT INTO prefs(key, value)
					 VALUES ('auth_user', $1::jsonb)
			 ON CONFLICT (key)
				 DO UPDATE SET value = EXCLUDED.value, updated_at = now();`,
			[JSON.stringify({ id: creator.id, email: creator.email, name: creator.display_name || null })]
		);

		try { appendDebugLog(`auth:login — User logged in: ${creator.email} (${creator.id})`); } catch (e) {}

		return { ok: true, user: { ...creator } };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		appendDebugLog(`auth:login — failed: ${msg}`);
		return { ok: false, error: msg };
	}
}

export async function startupLoginSync(): Promise<void> {
	// Intentionally a no-op: login is not a DB->local operation.
	appendDebugLog('startupLoginSync — no-op (login is not DB->local)');
}

export default { loginByEmail, startupLoginSync };

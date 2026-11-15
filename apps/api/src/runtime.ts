import { Pool } from 'pg';
import { HttpException } from '@nestjs/common';
import { scrypt, createHash } from 'node:crypto';
export const derive = (password: string, salt: string) => new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,64,(err,key)=>err?reject(err):resolve(key)));
export const db = new Pool({ connectionString: process.env.DATABASE_URL });
export const fail = (status: number, message: string): never => { throw new HttpException({ message }, status); };
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function text(value: unknown, max: number) { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'Invalid input'); return (value as string).trim(); }
export function mutation(req: any) { if (req.headers.origin !== (process.env.ORVYN_ORIGIN || 'http://localhost:3000')) fail(403, 'Invalid origin'); if (!req.is('application/json')) fail(415, 'JSON required'); }
export async function user(req: any) {
  const token = /(?:^|;\s*)orvyn_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  if (!token) return fail(401, 'Sign in required');
  const result = await db.query('SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()', [hash(token)]);
  if (!result.rowCount) return fail(401, 'Session expired');
  return result.rows[0].user_id as string;
}
// One transaction and advisory lock make first-run schema installation atomic.
export async function migrate() {
  const c = await db.connect();
  try {
    await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock(782901)');
    await c.query(`CREATE TABLE IF NOT EXISTS auth_limits(key text PRIMARY KEY, attempts integer NOT NULL, reset_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, password_hash text NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS spaces(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id), name text NOT NULL);
      CREATE INDEX IF NOT EXISTS spaces_owner ON spaces(owner_id);
      CREATE TABLE IF NOT EXISTS pages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, title text NOT NULL, document jsonb NOT NULL DEFAULT '{"type":"doc","content":[]}', version integer NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS pages_space ON pages(space_id);
      INSERT INTO schema_migrations VALUES(1) ON CONFLICT DO NOTHING;`);
    await c.query('COMMIT');
  } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

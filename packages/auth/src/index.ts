import { createHash } from "node:crypto";
import type { Pool, PoolClient, PoolConfig } from "pg";

/** URL preserves pg TLS parameters; split fields permit Kubernetes password references without lookup. */
export function databaseConfiguration(env = process.env): PoolConfig {
  if (env.DATABASE_URL) {
    try {
      if (
        !["postgres:", "postgresql:"].includes(
          new URL(env.DATABASE_URL).protocol,
        )
      )
        throw Error();
    } catch {
      throw Error("DATABASE_URL must be a PostgreSQL URL");
    }
    return { connectionString: env.DATABASE_URL };
  }
  if (
    !["PGHOST", "PGUSER", "PGDATABASE", "PGPASSWORD"].every((key) => env[key])
  )
    throw Error(
      "Configure DATABASE_URL or PGHOST, PGUSER, PGDATABASE and PGPASSWORD",
    );
  const port = Number(env.PGPORT || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("PGPORT must be a valid port");
  return {
    host: env.PGHOST,
    user: env.PGUSER,
    database: env.PGDATABASE,
    password: env.PGPASSWORD,
    port,
  };
}
export function parseSessionCookie(header: string) {
  return /(?:^|;\s*)orvyn_session=([a-f0-9]{64})(?:;|$)/.exec(header)?.[1];
}
export function sessionDigest(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export async function authenticateCookie(
  c: Pool | PoolClient,
  header: string,
  lock = false,
) {
  const token = parseSessionCookie(header);
  if (!token) return null;
  const digest = sessionDigest(token);
  const r = await c.query(
    `SELECT s.user_id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() ${lock ? "FOR SHARE OF s" : ""}`,
    [digest],
  );
  return r.rowCount
    ? {
        userId: r.rows[0].user_id as string,
        email: r.rows[0].email as string,
        sessionHash: digest,
      }
    : null;
}

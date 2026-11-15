import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
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

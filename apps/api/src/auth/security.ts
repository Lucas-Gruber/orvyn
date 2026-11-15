import { parseSessionCookie } from "@orvyn/auth";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { db, hash, fail } from "../runtime.js";
import type { PoolClient } from "pg";
export const origin = () => process.env.ORVYN_ORIGIN || "http://localhost:3000";
export function encryptionKey() {
  const key = process.env.ORVYN_ENCRYPTION_KEY;
  if (!key || !/^[a-f0-9]{64}$/.test(key))
    throw Error("ORVYN_ENCRYPTION_KEY must be a 32-byte hex key");
  return Buffer.from(key, "hex");
}
export function encrypt(value: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  return Buffer.concat([
    iv,
    cipher.update(value, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64url");
}
export function decrypt(value: string) {
  const data = Buffer.from(value, "base64url");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    data.subarray(0, 12),
  );
  cipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([
    cipher.update(data.subarray(12, -16)),
    cipher.final(),
  ]).toString("utf8");
}
export function passwordInput(value: unknown) {
  if (typeof value !== "string" || value.length < 12 || value.length > 256)
    return fail(400, "Password must contain 12–256 characters");
  return value;
}
export function sessionToken(req: any) {
  return parseSessionCookie(req.headers.cookie || "");
}
export function cookie(
  name: string,
  value: string,
  maxAge: number,
  sameSite = "Strict",
) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
export async function issueSession(
  c: PoolClient,
  uid: string,
  res: any,
  providerId: string | null = null,
) {
  const token = randomBytes(32).toString("hex");
  await c.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at,provider_id) VALUES($1,$2,now()+interval '7 days',$3)",
    [hash(token), uid, providerId],
  );
  res.setHeader("Set-Cookie", cookie("orvyn_session", token, 604800));
}
export async function transaction<T>(fn: (c: PoolClient) => Promise<T>) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function audit(c: PoolClient, uid: string | null, event: string) {
  await c.query("INSERT INTO audit_events(actor_id,event) VALUES($1,$2)", [
    uid,
    event,
  ]);
}
export async function rateLimit(key: string, max = 30) {
  const r = await db.query(
    `INSERT INTO auth_limits VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN auth_limits.reset_at<now() THEN 1 ELSE auth_limits.attempts+1 END, reset_at=CASE WHEN auth_limits.reset_at<now() THEN now()+interval '15 minutes' ELSE auth_limits.reset_at END RETURNING attempts`,
    [hash(key)],
  );
  if (r.rows[0].attempts > max) fail(429, "Too many attempts; retry later");
}

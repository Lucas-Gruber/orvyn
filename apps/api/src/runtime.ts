import { Pool } from "pg";
import { HttpException } from "@nestjs/common";
import { scrypt, createHash } from "node:crypto";
export const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
export const db = new Pool({ connectionString: process.env.DATABASE_URL });
export const fail = (status: number, message: string): never => {
  throw new HttpException({ message }, status);
};
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function text(value: unknown, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail(400, "Invalid input");
  return (value as string).trim();
}
export function mutation(req: any) {
  if (
    req.headers.origin !== (process.env.ORVYN_ORIGIN || "http://localhost:3000")
  )
    fail(403, "Invalid origin");
  if (!req.is("application/json")) fail(415, "JSON required");
}
export async function user(req: any) {
  const token = /(?:^|;\s*)orvyn_session=([a-f0-9]{64})(?:;|$)/.exec(
    req.headers.cookie || "",
  )?.[1];
  if (!token) return fail(401, "Sign in required");
  const result = await db.query(
    "SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()",
    [hash(token)],
  );
  if (!result.rowCount) return fail(401, "Session expired");
  return result.rows[0].user_id as string;
}
export { migrate } from "./migrations";

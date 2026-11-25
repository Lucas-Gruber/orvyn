import { authenticateCookie, databaseConfiguration } from "@orvyn/auth";
import { Pool } from "pg";
import { HttpException } from "@nestjs/common";
import { scrypt, createHash } from "node:crypto";
import { runtimeOrigin, createDiagnostics } from "@orvyn/shared/server";
export const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
export const db = new Pool({
  ...databaseConfiguration(),
  connectionTimeoutMillis: 5000,
});
db.on("error", (error) =>
  createDiagnostics("database", process.env).error("connection.failed", {
    stage: "database",
    error,
  }),
);
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
  if (req.headers.origin !== runtimeOrigin(process.env))
    fail(403, "Invalid origin");
  if (!req.is("application/json")) fail(415, "JSON required");
}
export async function user(req: any) {
  const identity = await authenticateCookie(db, req.headers.cookie || "");
  return identity?.userId || fail(401, "Sign in required");
}
export { migrate } from "./migrations.js";

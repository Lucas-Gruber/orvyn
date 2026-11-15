import { openSync, closeSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
const target = process.argv[2],
  url = new URL(process.env.DATABASE_URL);
if (!target || process.argv.length !== 3)
  throw Error("Usage: pnpm backup:db backups/orvyn.dump");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  throw Error("This helper targets the local development PostgreSQL container");
const database = url.pathname.slice(1),
  username = decodeURIComponent(url.username);
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database))
  throw Error("Invalid local database name");
const path = resolve(target);
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const fd = openSync(path, "wx", 0o600);
const env = { ...process.env };
for (const name of [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
])
  delete env[name];
try {
  const child = spawn(
    "docker",
    [
      "--host=unix:///var/run/docker.sock",
      "compose",
      "--env-file",
      ".env",
      "-f",
      "infrastructure/compose/compose.yaml",
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-U",
      username,
      "-d",
      database,
      "--format=custom",
      "--no-owner",
      "--no-privileges",
    ],
    { env, stdio: ["ignore", fd, "ignore"] },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw Error("pg_dump failed with exit status " + code);
  console.log("Database archive created: " + path);
} catch (e) {
  unlinkSync(path);
  throw e;
} finally {
  closeSync(fd);
}

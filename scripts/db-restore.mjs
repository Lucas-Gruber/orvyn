import { openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(
    new URL("../apps/api/package.json", import.meta.url),
  ),
  { Pool } = require("pg");
const [archive, name] = process.argv.slice(2),
  url = new URL(process.env.DATABASE_URL);
if (
  !archive ||
  !name ||
  process.argv.length !== 4 ||
  !/^orvyn_restore_[a-z0-9_]+$/.test(name)
)
  throw Error(
    "Usage: pnpm restore:db archive.dump orvyn_restore_new_name (creates a new database only)",
  );
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  throw Error("This helper targets the local development PostgreSQL container");
const fd = openSync(archive, "r"),
  db = new Pool({ connectionString: url.toString() }),
  username = decodeURIComponent(url.username);
let created = false;
const env = { ...process.env };
for (const key of [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
])
  delete env[key];
try {
  await db.query("CREATE DATABASE " + name);
  created = true;
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
      "pg_restore",
      "-U",
      username,
      "-d",
      name,
      "--single-transaction",
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
    ],
    { env, stdio: [fd, "ignore", "ignore"] },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw Error("pg_restore failed with exit status " + code);
  const restoredUrl = new URL(url);
  restoredUrl.pathname = "/" + name;
  const restored = new Pool({ connectionString: restoredUrl.toString() });
  try {
    const r = await restored.query(
      "SELECT to_regclass('users') AS users,to_regclass('pages') AS pages,(SELECT count(*) FROM schema_migrations) AS versions",
    );
    if (!r.rows[0].users || !r.rows[0].pages || Number(r.rows[0].versions) < 1)
      throw Error("Archive is not an Orvyn database");
  } finally {
    await restored.end();
  }
  console.log("Restored into new database: " + name);
} catch (error) {
  if (created) await db.query("DROP DATABASE " + name + " WITH (FORCE)");
  throw error;
} finally {
  closeSync(fd);
  await db.end();
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, createConnection } from "node:net";
import { once } from "node:events";
import { mkdtemp, mkdir, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "./helpers.mjs";

async function until(task, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await task()) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  assert.fail(message);
}
function start(path, env, args = []) {
  const child = spawn(process.execPath, [path, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output += chunk;
    });
  const exit = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return {
    child,
    exit,
    get output() {
      return output;
    },
  };
}
async function stop(process) {
  if (process.child.exitCode !== null || process.child.signalCode !== null)
    return process.exit;
  process.child.kill("SIGTERM");
  const timer = setTimeout(() => process.child.kill("SIGKILL"), 4000);
  try {
    return await process.exit;
  } finally {
    clearTimeout(timer);
  }
}
async function healthy(env, live = false) {
  try {
    await promisify(execFile)(
      process.execPath,
      [
        "apps/api/dist/commands/configure-health.js",
        ...(live ? ["--live"] : []),
      ],
      { env, timeout: 5000 },
    );
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

test("configuration reconciles after database recovery while API storage fails, retries safely, restores settings and rolls back without another Helm hook", async () => {
  const rootUrl = new URL(process.env.DATABASE_URL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(rootUrl.hostname));
  const root = new Pool({ connectionString: rootUrl.toString() }),
    name = "orvyn_configuration_" + randomBytes(8).toString("hex");
  const directory = await mkdtemp(join(tmpdir(), "orvyn-configuration-test-")),
    children = [],
    connections = new Set();
  let created = false,
    online = false,
    db;
  const proxy = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    if (!online) {
      socket.destroy();
      return;
    }
    const upstream = createConnection({
      host: rootUrl.hostname,
      port: Number(rootUrl.port || 5432),
    });
    connections.add(upstream);
    upstream.on("close", () => {
      connections.delete(upstream);
      socket.destroy();
    });
    socket.on("close", () => upstream.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.pipe(upstream).pipe(socket);
  });
  try {
    await root.query("CREATE DATABASE " + name);
    created = true;
    const direct = new URL(rootUrl);
    direct.pathname = "/" + name;
    db = new Pool({ connectionString: direct.toString() });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxied = new URL(direct);
    proxied.hostname = "127.0.0.1";
    proxied.port = String(proxy.address().port);
    const markerDirectory = join(directory, "markers"),
      unwritable = join(directory, "attachments");
    await mkdir(markerDirectory);
    await mkdir(unwritable, { mode: 0o500 });
    const secret = "oidc-canary-" + randomBytes(24).toString("hex");
    const base = {
      ...process.env,
      NODE_ENV: "test",
      ORVYN_LOG_LEVEL: "debug",
      TMPDIR: markerDirectory,
      ORVYN_OIDC_BOOTSTRAP_MODE: "external",
      ORVYN_OIDC_ENABLED: "true",
      ORVYN_OIDC_ISSUER: "https://identity.example.test/application/o/orvyn/",
      ORVYN_OIDC_CLIENT_ID: "configuration",
      ORVYN_OIDC_CLIENT_SECRET: secret,
      ORVYN_OIDC_CLIENT_AUTH_METHOD: "client_secret_post",
      ORVYN_OIDC_NAME: "Company identity",
      ORVYN_OIDC_AUTO_PROVISION: "true",
      ORVYN_CONFIGURATION_RECONCILE_SECONDS: "1",
      ORVYN_CONFIGURATION_RETRY_SECONDS: "1",
      ORVYN_STORAGE_DRIVER: "local",
      ORVYN_STORAGE_LOCAL_PATH: unwritable,
    };
    for (const key of Object.keys(base))
      if (/^(S3_|SMTP_|VALKEY_|REDIS_URL)/.test(key)) delete base[key];
    const env = { ...base, DATABASE_URL: proxied.toString() };
    await writeFile(
      join(markerDirectory, "orvyn-configuration-ready"),
      "stale\n",
    );
    const watcher = start("apps/api/dist/commands/configure.js", env, [
      "--watch",
    ]);
    children.push(watcher);
    await until(
      () => watcher.output.includes("configuration.retrying"),
      "Configuration must diagnose and retry an unavailable database",
    );
    assert.equal(
      await healthy(env),
      false,
      "A stale marker from an earlier process must be cleared",
    );
    assert.equal(
      await healthy(env, true),
      true,
      "A retrying process is live without being ready",
    );
    // Reproduce the failed attachment mount independently of the reconciler.
    if (process.getuid?.() === 0) {
      await chmod(unwritable, 0o700);
      await rm(unwritable, { recursive: true });
      await writeFile(unwritable, "not a directory");
    }
    const apiEnv = { ...base, DATABASE_URL: direct.toString(), PORT: "0" };
    delete apiEnv.ORVYN_OIDC_CLIENT_SECRET;
    const api = start("apps/api/dist/main.js", apiEnv);
    children.push(api);
    const apiResult = await api.exit;
    assert.equal(apiResult.code, 1);
    assert.match(api.output, /"stage":"storage"/);
    assert.equal(
      (await db.query("SELECT count(*)::int AS count FROM oidc_providers"))
        .rows[0].count,
      0,
    );
    online = true;
    await until(
      () => healthy(env),
      "Configuration must become ready after database recovery without API readiness",
    );
    let provider = (
      await db.query(
        "SELECT * FROM oidc_providers WHERE managed_by='deployment' AND enabled",
      )
    ).rows[0];
    assert.equal(provider.issuer, base.ORVYN_OIDC_ISSUER);
    assert.equal(provider.name, base.ORVYN_OIDC_NAME);
    assert.notEqual(provider.encrypted_secret, secret);
    const providerId = provider.id,
      ciphertext = provider.encrypted_secret;
    await db.query(
      "UPDATE oidc_providers SET name='Unexpected settings' WHERE id=$1",
      [providerId],
    );
    await until(
      async () =>
        (
          await db.query("SELECT name FROM oidc_providers WHERE id=$1", [
            providerId,
          ])
        ).rows[0].name === base.ORVYN_OIDC_NAME,
      "Desired settings must recover idempotently",
    );
    const revision = (
      await db.query("SELECT config_version FROM oidc_providers WHERE id=$1", [
        providerId,
      ])
    ).rows[0].config_version;
    await new Promise((r) => setTimeout(r, 1200));
    provider = (
      await db.query("SELECT * FROM oidc_providers WHERE id=$1", [providerId])
    ).rows[0];
    assert.equal(
      provider.config_version,
      revision,
      "Identical polls must not invalidate sign-ins",
    );
    assert.equal(
      provider.encrypted_secret,
      ciphertext,
      "Identical credentials must not be re-encrypted",
    );
    online = false;
    for (const socket of connections) socket.destroy();
    await until(
      async () => !(await healthy(env)),
      "Readiness must clear after a failed reconciliation",
    );
    online = true;
    await until(
      () => healthy(env),
      "A second database recovery must not require restarting the workload",
    );
    assert.equal((await stop(watcher)).code, 0);
    assert.equal(await healthy(env), false);
    const disabled = start(
      "apps/api/dist/commands/configure.js",
      { ...env, ORVYN_OIDC_ENABLED: "false" },
      ["--watch"],
    );
    children.push(disabled);
    await until(
      () => healthy(env),
      "Rollback configuration must be applied by a fresh workload",
    );
    assert.equal(
      (
        await db.query("SELECT enabled FROM oidc_providers WHERE id=$1", [
          providerId,
        ])
      ).rows[0].enabled,
      false,
    );
    assert.equal((await stop(disabled)).code, 0);
    const restored = start("apps/api/dist/commands/configure.js", env);
    children.push(restored);
    assert.equal((await restored.exit).code, 0);
    assert.match(restored.output, /ORVYN_CONFIGURATION_READY/);
    assert.equal(
      (
        await db.query("SELECT enabled FROM oidc_providers WHERE id=$1", [
          providerId,
        ])
      ).rows[0].enabled,
      true,
    );
    const logs = children.map((child) => child.output).join("\n");
    for (const value of [
      secret,
      process.env.ORVYN_ENCRYPTION_KEY,
      rootUrl.password,
      proxied.toString(),
    ].filter((value) => value && value.length >= 8))
      assert.ok(
        !logs.includes(value),
        "Configuration diagnostics must never disclose credentials",
      );
  } finally {
    for (const child of children.reverse()) await stop(child);
    for (const socket of connections) socket.destroy();
    if (proxy.listening) await new Promise((resolve) => proxy.close(resolve));
    await db?.end();
    if (created) await root.query("DROP DATABASE " + name + " WITH (FORCE)");
    await root.end();
    await chmod(join(directory, "attachments"), 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("one-shot configuration migrates a fresh database without storage, SMTP, Valkey or a running API", async () => {
  const rootUrl = new URL(process.env.DATABASE_URL),
    root = new Pool({ connectionString: rootUrl.toString() }),
    name = "orvyn_configuration_fresh_" + randomBytes(6).toString("hex");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(rootUrl.hostname));
  let db,
    created = false,
    command;
  try {
    await root.query("CREATE DATABASE " + name);
    created = true;
    const url = new URL(rootUrl);
    url.pathname = "/" + name;
    const env = {
      ...process.env,
      DATABASE_URL: url.toString(),
      ORVYN_OIDC_ENABLED: "false",
    };
    for (const key of Object.keys(env))
      if (/^(S3_|SMTP_|VALKEY_|REDIS_URL)/.test(key)) delete env[key];
    command = start("apps/api/dist/commands/configure.js", env);
    assert.equal((await command.exit).code, 0, command.output);
    db = new Pool({ connectionString: url.toString() });
    assert.ok(
      (await db.query("SELECT count(*)::int AS count FROM schema_migrations"))
        .rows[0].count >= 47,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM deployment_configuration WHERE name='oidc'",
        )
      ).rows[0].count,
      1,
    );
  } finally {
    if (command) await stop(command);
    await db?.end();
    if (created) await root.query("DROP DATABASE " + name + " WITH (FORCE)");
    await root.end();
  }
});

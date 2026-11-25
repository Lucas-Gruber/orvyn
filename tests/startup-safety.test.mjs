import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as portServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

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
async function until(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}
async function freePort() {
  const s = portServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const p = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return p;
}

test(
  "API, worker and collaboration validate configuration before client imports and emit only safe structured failures",
  { timeout: 30000 },
  async () => {
    const secret = randomUUID();
    for (const [path, fields, code] of [
      [
        "apps/api/dist/main.js",
        { DATABASE_URL: "invalid://" + secret },
        "DATABASE_CONFIGURATION_INVALID",
      ],
      [
        "apps/api/dist/worker.js",
        { DATABASE_URL: "invalid://" + secret },
        "DATABASE_CONFIGURATION_INVALID",
      ],
      [
        "apps/collaboration/dist/main.js",
        { DATABASE_URL: "invalid://" + secret },
        "DATABASE_CONFIGURATION_INVALID",
      ],
      [
        "apps/collaboration/dist/main.js",
        { REDIS_URL: "invalid://" + secret },
        "VALKEY_CONFIGURATION_INVALID",
      ],
      [
        "apps/collaboration/dist/main.js",
        { REDIS_URL: undefined, VALKEY_HOST: undefined },
        "VALKEY_CONFIGURATION_INVALID",
      ],
      [
        "apps/api/dist/main.js",
        { ORVYN_ENCRYPTION_KEY: secret },
        "ENCRYPTION_KEY_INVALID",
      ],
      [
        "apps/api/dist/worker.js",
        { ORVYN_ENCRYPTION_KEY: secret },
        "ENCRYPTION_KEY_INVALID",
      ],
      [
        "apps/collaboration/dist/main.js",
        { ORVYN_LOG_LEVEL: secret },
        "LOG_LEVEL_INVALID",
      ],
    ]) {
      const process = start(path, {
        ...globalThis.process.env,
        NODE_ENV: "production",
        ORVYN_ORIGIN: "https://notes.example.test",
        ORVYN_LOG_LEVEL: "debug",
        ...fields,
      });
      try {
        const timer = setTimeout(() => process.child.kill("SIGKILL"), 5000);
        const result = await process.exit;
        clearTimeout(timer);
        assert.equal(result.code, 1, process.output);
        assert.equal(result.signal, null);
        assert.ok(!process.output.includes(secret));
        const lines = process.output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.ok(
          lines.some((line) => line.code === code),
          process.output,
        );
        assert.ok(lines.every((line) => !line.stack && !line.message));
      } finally {
        await stop(process);
      }
    }
  },
);

test("collaboration library errors discard arbitrary messages, nested payloads and stacks even in debug mode", async () => {
  const secret = randomUUID(),
    module = new URL(
      "../apps/collaboration/dist/diagnostics.js",
      import.meta.url,
    ).href;
  const process = start("--input-type=module", { ...globalThis.process.env }, [
    "-e",
    `import{configureDiagnostics}from${JSON.stringify(module)};configureDiagnostics({ORVYN_LOG_LEVEL:'debug'});const e=Object.assign(Error(${JSON.stringify(secret)}),{code:'28P01',detail:${JSON.stringify(secret)},stack:${JSON.stringify(secret)}});console.error('raw-library-context',e);console.warn(${JSON.stringify(secret)});`,
  ]);
  const result = await process.exit;
  assert.equal(result.code, 0, process.output);
  assert.ok(!process.output.includes(secret));
  const lines = process.output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines[0].code, "28P01");
  assert.equal(lines[0].event, "library.error");
  assert.equal(lines[1].event, "library.warn");
});

test(
  "storage bootstrap retries service failure, recovers without another process and preserves safe diagnostics and probe cleanup",
  { timeout: 30000 },
  async () => {
    let online = false,
      bucket = false,
      creates = 0;
    const objects = new Map(),
      requests = [],
      secret = randomUUID();
    const server = createServer(async (req, res) => {
      requests.push([req.method, req.url]);
      if (!online) {
        res.writeHead(503, { "Content-Type": "application/xml" });
        res.end(
          "<Error><Code>ServiceUnavailable</Code><Message>" +
            secret +
            "</Message></Error>",
        );
        return;
      }
      const path = new URL(req.url, "http://localhost").pathname;
      if (
        path === "/orvyn-bootstrap-test/" ||
        path === "/orvyn-bootstrap-test"
      ) {
        if (req.method === "PUT") {
          bucket = true;
          creates++;
          res.writeHead(200);
          res.end();
          return;
        }
        res.writeHead(bucket ? 200 : 404);
        res.end();
        return;
      }
      if (req.method === "PUT") {
        const body = [];
        for await (const chunk of req) body.push(chunk);
        objects.set(path, Buffer.concat(body));
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === "GET") {
        const bytes = objects.get(path);
        res.writeHead(
          bytes ? 200 : 404,
          bytes ? { "Content-Length": bytes.length } : {},
        );
        res.end(bytes);
        return;
      }
      if (req.method === "DELETE") {
        objects.delete(path);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const env = {
      PATH: globalThis.process.env.PATH,
      NODE_ENV: "test",
      ORVYN_LOG_LEVEL: "debug",
      ORVYN_CONFIGURATION_RETRY_SECONDS: "1",
      S3_ENDPOINT: "http://127.0.0.1:" + server.address().port,
      S3_BUCKET: "orvyn-bootstrap-test",
      S3_ACCESS_KEY_ID: secret,
      S3_SECRET_ACCESS_KEY: secret,
      S3_FORCE_PATH_STYLE: "true",
    };
    const child = start("apps/api/dist/commands/storage-init.js", env, [
      "--wait",
    ]);
    let cancelled;
    try {
      await until(
        () => child.output.includes("storage.retrying"),
        "Storage must diagnose/retry an unavailable backend",
      );
      assert.equal(child.child.exitCode, null);
      assert.match(child.output, /S3_SERVICE_UNAVAILABLE/);
      online = true;
      await until(
        () => child.child.exitCode !== null,
        "Storage must recover after the same backend is fixed",
      );
      assert.equal((await child.exit).code, 0, child.output);
      assert.match(child.output, /ORVYN_STORAGE_READY/);
      assert.equal(creates, 1);
      assert.equal(objects.size, 0);
      assert.ok(
        requests.some(
          ([method, path]) =>
            method === "PUT" && path.includes("setup-probes/"),
        ),
      );
      assert.ok(
        !requests.some(
          ([method, path]) =>
            method === "DELETE" && /^\/orvyn-bootstrap-test\/?$/.test(path),
        ),
      );
      assert.ok(!child.output.includes(secret));
      online = false;
      cancelled = start("apps/api/dist/commands/storage-init.js", env, [
        "--wait",
      ]);
      await until(
        () => cancelled.output.includes("storage.retrying"),
        "Cancelled bootstrap must reach a retry",
      );
      assert.equal((await stop(cancelled)).code, 0);
      assert.ok(!cancelled.output.includes("ORVYN_STORAGE_READY"));
      const invalid = start(
        "apps/api/dist/commands/storage-init.js",
        { ...env, S3_SECRET_ACCESS_KEY: undefined },
        ["--wait"],
      );
      assert.equal((await invalid.exit).code, 1);
      assert.match(invalid.output, /S3_CONFIGURATION_INVALID/);
      assert.ok(!invalid.output.includes(secret));
    } finally {
      await stop(child);
      if (cancelled) await stop(cancelled);
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

test(
  "an unavailable API cannot leak callback codes through web proxy errors and browser navigation returns to login",
  { timeout: 20000 },
  async () => {
    const secret = randomUUID(),
      port = await freePort(),
      upstream = await freePort(),
      origin = "http://127.0.0.1:" + port;
    const child = start("apps/web/.output/server/index.mjs", {
      ...process.env,
      NODE_ENV: "test",
      ORVYN_LOG_LEVEL: "debug",
      ORVYN_ORIGIN: origin,
      NITRO_HOST: "127.0.0.1",
      NITRO_PORT: String(port),
      NUXT_API_URL: "http://127.0.0.1:" + upstream,
      NUXT_COLLABORATION_UPSTREAM: "ws://127.0.0.1:1",
    });
    try {
      await until(async () => {
        try {
          const r = await fetch(origin);
          await r.body?.cancel();
          return r.ok;
        } catch {
          return false;
        }
      }, "Web must start independently of API readiness");
      const result = await fetch(
        origin +
          "/api/v1/oidc/deployment/callback?code=" +
          secret +
          "&state=" +
          secret,
        { headers: { Accept: "text/html" }, redirect: "manual" },
      );
      assert.equal(result.status, 303);
      assert.equal(
        result.headers.get("location"),
        "/?authError=provider_unavailable",
      );
      assert.equal(result.headers.get("referrer-policy"), "no-referrer");
      await result.body?.cancel();
      const json = await fetch(
        origin + "/api/v1/oidc/deployment/callback?code=" + secret,
        { headers: { Accept: "application/json" }, redirect: "manual" },
      );
      assert.equal(json.status, 502);
      assert.deepEqual(await json.json(), {
        message: "API is temporarily unavailable",
      });
      assert.ok(!child.output.includes(secret));
      assert.match(child.output, /proxy.upstream_failed/);
    } finally {
      await stop(child);
    }
  },
);

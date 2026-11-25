import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  createDiagnostics,
  diagnosticCode,
  runtimeOrigin,
  runtimeUpstream,
} from "../packages/shared/dist/server.js";

test("production components require an explicit canonical HTTPS origin and private upstreams", () => {
  assert.equal(runtimeOrigin({}), "http://localhost:3000");
  assert.equal(
    runtimeOrigin({
      NODE_ENV: "production",
      ORVYN_ORIGIN: "https://notes.example.test:8443",
    }),
    "https://notes.example.test:8443",
  );
  for (const value of [
    undefined,
    "",
    "http://notes.example.test",
    "https://notes.example.test/",
    "https://user:secret@notes.example.test",
    "https://notes.example.test?q=token",
    "https://notes.example.test/#secret",
    "https://notes.example.test/path",
  ])
    assert.throws(() =>
      runtimeOrigin({ NODE_ENV: "production", ORVYN_ORIGIN: value }),
    );
  assert.throws(() =>
    runtimeUpstream(
      { NODE_ENV: "production" },
      "NUXT_API_URL",
      ["http:", "https:"],
      "http://127.0.0.1:3001",
    ),
  );
  assert.throws(() =>
    runtimeUpstream(
      { NUXT_API_URL: "http://user:secret@api:3001" },
      "NUXT_API_URL",
      ["http:"],
      "http://127.0.0.1:3001",
    ),
  );
});
test("structured diagnostics classify dependency errors without serializing secrets, connection strings or arbitrary fields", async () => {
  const secret = randomUUID(),
    lines = [],
    log = createDiagnostics("api", { ORVYN_LOG_LEVEL: "debug" }, (line) =>
      lines.push(JSON.parse(line)),
    );
  const error = Object.assign(
    Error(`postgres://user:${secret}@database/private token=${secret}`),
    { code: "28P01", password: secret, stack: secret },
  );
  log.error("startup.failed", {
    stage: "database",
    error,
    password: secret,
    connectionString: secret,
  });
  assert.equal(lines[0].code, "28P01");
  assert.match(lines[0].action, /database Secret/);
  assert.equal(JSON.stringify(lines).includes(secret), false);
  assert.equal(
    diagnosticCode({ cause: { cause: { code: "EACCES" } } }),
    "EACCES",
  );
  assert.equal(diagnosticCode({ code: secret }), "UNKNOWN");
  assert.equal(
    diagnosticCode(
      Object.defineProperty({}, "code", {
        get() {
          throw Error(secret);
        },
      }),
    ),
    "UNKNOWN",
  );
  await assert.rejects(
    log.stage("storage", async () => {
      throw Object.assign(Error(secret), { code: "EPERM" });
    }),
  );
  assert.equal(lines.at(-1).stage, "storage");
  assert.equal(lines.at(-1).code, "EPERM");
  assert.equal(JSON.stringify(lines).includes(secret), false);
  const quiet = [];
  createDiagnostics("worker", { ORVYN_LOG_LEVEL: "error" }, (line) =>
    quiet.push(line),
  ).info("stage.ready");
  assert.deepEqual(quiet, []);
  assert.throws(() => createDiagnostics("api", { ORVYN_LOG_LEVEL: secret }));
});
test(
  "production web startup fails early and safely when its public origin or upstream configuration is absent",
  { timeout: 15000 },
  async () => {
    const secret = randomUUID();
    for (const fields of [
      { ORVYN_ORIGIN: undefined },
      {
        ORVYN_ORIGIN: "https://notes.example.test",
        NUXT_API_URL: `http://user:${secret}@internal:3001`,
      },
    ]) {
      const child = spawn(
        process.execPath,
        ["apps/web/.output/server/index.mjs"],
        {
          env: {
            ...process.env,
            NODE_ENV: "production",
            ORVYN_ORIGIN: "https://notes.example.test",
            NUXT_API_URL: "http://127.0.0.1:3001",
            NUXT_COLLABORATION_UPSTREAM: "ws://127.0.0.1:3002",
            ...fields,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (data) => (output += data));
      child.stderr.on("data", (data) => (output += data));
      const finished = once(child, "exit");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      const [code, signal] = await finished;
      clearTimeout(timer);
      assert.notEqual(signal, "SIGKILL", output);
      assert.notEqual(code, 0);
      assert.match(output, /startup.configuration_failed/);
      assert.equal(output.includes(secret), false);
    }
  },
);

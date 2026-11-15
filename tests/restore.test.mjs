import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { removeTestBucket } from "../scripts/s3-cleanup.mjs";
const require = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const {
  S3Client,
  CreateBucketCommand,
  CopyObjectCommand,
} = require("@aws-sdk/client-s3");
async function run(script, args) {
  const child = spawn(process.execPath, [script, ...args], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostic = "";
  child.stderr.on("data", (b) => (diagnostic += b));
  const [code] = await once(child, "exit");
  assert.equal(code, 0, diagnostic);
}
test("pg_dump/restore plus independent S3 bucket recover page, attachment bytes and access controls", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    directory = await mkdtemp(join(tmpdir(), "orvyn-restore-")),
    name = "orvyn_restore_" + randomUUID().replaceAll("-", ""),
    targetBucket = name.replaceAll("_", "-"),
    s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    });
  let api,
    created = false,
    bucketCreated = false;
  try {
    const registered = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    });
    assert.equal(registered.response.status, 201);
    const cookie = sessionCookie(registered.response);
    const space = (
      await request("spaces", {
        method: "POST",
        cookie,
        body: { name: "Restore evidence" },
      })
    ).data;
    const page = (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie,
        body: { title: "Restored private page" },
      })
    ).data;
    const content = "Restored from PostgreSQL and an independent object bucket";
    const body = new FormData();
    body.append("file", new Blob([content]), "restore.txt");
    const uploaded = await fetch(base + "/api/v1/pages/" + page.id + "/files", {
      method: "POST",
      headers: { Origin: process.env.TEST_ORIGIN, Cookie: cookie },
      body,
    });
    assert.equal(uploaded.status, 201);
    const file = await uploaded.json();
    const meta = (
      await db.query("SELECT object_key FROM files WHERE id=$1", [file.id])
    ).rows[0];
    const archive = join(directory, "database.dump");
    await run("scripts/db-backup.mjs", [archive]);
    await run("scripts/db-restore.mjs", [archive, name]);
    created = true;
    // The helper must refuse an existing database and preserve its data.
    const repeat = spawn(
      process.execPath,
      ["scripts/db-restore.mjs", archive, name],
      { env: process.env, stdio: "ignore" },
    );
    assert.notEqual((await once(repeat, "exit"))[0], 0);
    await s3.send(new CreateBucketCommand({ Bucket: targetBucket }));
    bucketCreated = true;
    const restoredUrl = new URL(process.env.DATABASE_URL);
    restoredUrl.pathname = "/" + name;
    const restoredDb = new Pool({ connectionString: restoredUrl.toString() });
    try {
      const keys = await restoredDb.query(
        "SELECT object_key FROM files WHERE state IN ('ready','deleted')",
      );
      for (const item of keys.rows)
        await s3.send(
          new CopyObjectCommand({
            Bucket: targetBucket,
            Key: item.object_key,
            CopySource:
              process.env.S3_BUCKET + "/" + encodeURIComponent(item.object_key),
          }),
        );
    } finally {
      await restoredDb.end();
    }
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    await new Promise((r) => server.close(r));
    api = spawn(process.execPath, ["apps/api/dist/main.js"], {
      env: {
        ...process.env,
        DATABASE_URL: restoredUrl.toString(),
        S3_BUCKET: targetBucket,
        PORT: String(port),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    api.stderr.on("data", () => {});
    let healthy = false;
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      try {
        healthy = (await fetch(`http://127.0.0.1:${port}/api/v1/health`)).ok;
        if (healthy) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(healthy, true);
    const restored = await fetch(
      `http://127.0.0.1:${port}/api/v1/pages/${page.id}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).title, "Restored private page");
    const download = await fetch(
      `http://127.0.0.1:${port}/api/v1/files/${file.id}/download`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(download.status, 200);
    assert.equal(await download.text(), content);
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/api/v1/files/${file.id}/download`))
        .status,
      401,
    );
  } finally {
    if (api && api.exitCode === null) {
      api.kill("SIGTERM");
      await once(api, "exit");
    }
    if (created) await db.query("DROP DATABASE " + name + " WITH (FORCE)");
    await db.end();
    if (bucketCreated) await removeTestBucket(s3, targetBucket);
    s3.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

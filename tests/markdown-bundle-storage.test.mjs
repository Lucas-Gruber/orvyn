import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request as proxyRequest } from "node:http";
import { createServer as createPortServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
const require = createRequire(
    new URL("../apps/api/package.json", import.meta.url),
  ),
  { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3"),
  { unzipSync, strFromU8 } = require("fflate");
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function account() {
  const registered = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(registered.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
test("slow attachment copies recheck current access before any ZIP bytes, and missing objects fail without a partial archive", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    gate = deferred(),
    intercepted = deferred();
  let child,
    proxy,
    fileId,
    armed = false,
    objectKey;
  try {
    const owner = await account(),
      viewer = await account(),
      space = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Copy review" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const page = (
        await request(`spaces/${space.id}/pages`, {
          method: "POST",
          cookie: owner.cookie,
          body: { title: "A portable note" },
        })
      ).data,
      form = new FormData();
    form.append(
      "file",
      new Blob([Buffer.from("An exact attachment copy.")]),
      "note.txt",
    );
    const upload = await fetch(base + `/api/v1/pages/${page.id}/files`, {
      method: "POST",
      headers: {
        Cookie: owner.cookie,
        Origin: process.env.TEST_ORIGIN || base,
      },
      body: form,
    });
    assert.equal(upload.status, 201);
    const file = await upload.json();
    fileId = file.id;
    objectKey = (
      await db.query("SELECT object_key FROM files WHERE id=$1", [file.id])
    ).rows[0].object_key;
    await db.query(
      "UPDATE pages SET document=$2,document_schema_version=13 WHERE id=$1",
      [
        page.id,
        {
          type: "doc",
          content: [
            {
              type: "orvynFile",
              attrs: { fileId: file.id, label: "note.txt" },
            },
            { type: "paragraph" },
          ],
        },
      ],
    );
    const sourceEndpoint = new URL(process.env.S3_ENDPOINT);
    assert.equal(sourceEndpoint.protocol, "http:");
    proxy = createServer(async (req, res) => {
      if (armed && req.method === "GET" && req.url.includes(objectKey)) {
        armed = false;
        intercepted.resolve();
        await gate.promise;
      }
      const upstream = proxyRequest(
        new URL(req.url, sourceEndpoint),
        { method: req.method, headers: req.headers },
        (remote) => {
          res.writeHead(remote.statusCode, remote.headers);
          remote.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const portServer = createPortServer();
    portServer.listen(0, "127.0.0.1");
    await once(portServer, "listening");
    const apiPort = portServer.address().port;
    await new Promise((resolve) => portServer.close(resolve));
    child = spawn(process.execPath, ["apps/api/dist/main.js"], {
      env: {
        ...process.env,
        PORT: String(apiPort),
        S3_ENDPOINT: `http://127.0.0.1:${proxy.address().port}`,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.resume();
    const target = `http://127.0.0.1:${apiPort}`,
      deadline = Date.now() + 15000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        healthy = (
          await fetch(target + "/api/v1/health", {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
        if (healthy) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    assert.equal(healthy, true, "isolated API must be healthy");
    const input = {
        pageIds: [page.id],
        includeAttachments: true,
        includePeopleNames: false,
      },
      preview = async (options) => {
        const result = await request(`pages/${page.id}/export/bundle/preview`, {
          method: "POST",
          cookie: viewer.cookie,
          body: options,
        });
        assert.equal(result.response.status, 201, JSON.stringify(result.data));
        return result.data;
      },
      download = (review, options = input) =>
        fetch(target + `/api/v1/pages/${page.id}/export/bundle`, {
          method: "POST",
          headers: {
            Cookie: viewer.cookie,
            Origin: process.env.TEST_ORIGIN || base,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...options, review: review.digest }),
          signal: AbortSignal.timeout(15000),
        });
    const reviewed = await preview(input);
    armed = true;
    const pending = download(reviewed);
    await Promise.race([
      intercepted.promise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(Error("Attachment GET did not reach the proxy")),
          10000,
        ).unref(),
      ),
    ]);
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [space.id, viewer.id],
    );
    gate.resolve();
    const rejected = await pending;
    assert.equal(rejected.status, 404);
    assert.ok(!rejected.headers.get("content-type").includes("zip"));
    await rejected.body.cancel();
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const fresh = await preview(input),
      s3 = new S3Client({
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION || "us-east-1",
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        },
      });
    try {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: objectKey,
        }),
      );
    } finally {
      s3.destroy();
    }
    const missing = await download(fresh);
    assert.equal(missing.status, 503);
    assert.match((await missing.json()).message, /could not be copied/);
    const withoutFiles = { ...input, includeAttachments: false },
      linked = await preview(withoutFiles),
      ok = await download(linked, withoutFiles);
    assert.equal(ok.status, 201);
    const archive = unzipSync(new Uint8Array(await ok.arrayBuffer()));
    assert.equal(
      JSON.parse(strFromU8(archive["manifest.json"])).files.length,
      0,
    );
  } finally {
    gate.resolve();
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      timer.unref();
      await exited;
      clearTimeout(timer);
    }
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
    }
    // The missing-object case must not leave a ready catalog entry for later
    // backup/restore tests sharing this disposable suite database.
    if (fileId) await db.query("DELETE FROM files WHERE id=$1", [fileId]);
    await db.end();
  }
});

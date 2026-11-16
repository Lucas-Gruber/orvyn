import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createCipheriv } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { Pool } from "./helpers.mjs";
import { migrate } from "../apps/api/dist/migrations.js";
const require = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
test("a stalled SMTP greeting cannot block authentication expiry or attachment retention", async () => {
  const root = new Pool({ connectionString: process.env.DATABASE_URL }),
    name = "orvyn_worker_" + randomBytes(8).toString("hex"),
    url = new URL(process.env.DATABASE_URL),
    sockets = new Set();
  const s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    }),
    key = "worker-test/" + randomUUID();
  let db,
    child,
    created = false,
    connectedResolve;
  const connected = new Promise((r) => (connectedResolve = r)),
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      connectedResolve();
    });
  try {
    await root.query("CREATE DATABASE " + name);
    created = true;
    url.pathname = "/" + name;
    db = new Pool({ connectionString: url.toString() });
    await migrate(db);
    const uid = (
        await db.query(
          "INSERT INTO users(email) VALUES('worker@example.test') RETURNING id",
        )
      ).rows[0].id,
      space = (
        await db.query(
          "INSERT INTO spaces(owner_id,name) VALUES($1,'Retention fixture') RETURNING id",
          [uid],
        )
      ).rows[0].id,
      page = (
        await db.query(
          "INSERT INTO pages(space_id,title) VALUES($1,'Retention page') RETURNING id",
          [space],
        )
      ).rows[0].id;
    const iv = randomBytes(12),
      cipher = createCipheriv(
        "aes-256-gcm",
        Buffer.from(process.env.ORVYN_ENCRYPTION_KEY, "hex"),
        iv,
      ),
      encrypted = Buffer.concat([
        iv,
        cipher.update(
          JSON.stringify({
            to: "worker@example.test",
            subject: "Blocked fixture",
            text: "Test mail",
          }),
        ),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString("base64url");
    await db.query("INSERT INTO mail_outbox(payload) VALUES($1)", [encrypted]);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    child = spawn(process.execPath, ["apps/api/dist/worker.js"], {
      env: {
        ...process.env,
        DATABASE_URL: url.toString(),
        SMTP_URL: "smtp://127.0.0.1:" + server.address().port,
      },
      stdio: "ignore",
    });
    let connectTimer;
    await Promise.race([
      connected,
      new Promise(
        (_, reject) =>
          (connectTimer = setTimeout(
            () =>
              reject(Error("Worker did not connect to stalled SMTP fixture")),
            6000,
          )),
      ),
    ]).finally(() => clearTimeout(connectTimer));
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: "Retention bytes",
      }),
    );
    const file = (
      await db.query(
        "INSERT INTO files(page_id,object_key,filename,media_type,size,uploaded_by,state,deleted_at) VALUES($1,$2,'expired','application/octet-stream',15,$3,'deleted',now()-interval '31 days') RETURNING id",
        [page, key, uid],
      )
    ).rows[0].id;
    const token = randomBytes(32).toString("hex");
    await db.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()-interval '1 minute')",
      [token, uid],
    );
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const state = (
        await db.query(
          "SELECT (SELECT count(*) FROM files WHERE id=$1) AS files,(SELECT count(*) FROM sessions WHERE token_hash=$2) AS sessions",
          [file, token],
        )
      ).rows[0];
      if (state.files === "0" && state.sessions === "0") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(
      (await db.query("SELECT id FROM files WHERE id=$1", [file])).rowCount,
      0,
    );
    assert.equal(
      (await db.query("SELECT id FROM sessions WHERE token_hash=$1", [token]))
        .rowCount,
      0,
    );
    assert.equal(
      (await db.query("SELECT sent_at FROM mail_outbox")).rows[0].sent_at,
      null,
    );
    assert.ok(
      sockets.size > 0,
      "SMTP is still blocked while both maintenance loops complete",
    );
    await assert.rejects(
      s3.send(
        new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
      ),
      (e) => e.$metadata?.httpStatusCode === 404,
    );
  } finally {
    if (child) {
      child.kill("SIGTERM");
      for (const socket of sockets) socket.destroy();
      let timer;
      await Promise.race([
        once(child, "exit"),
        new Promise(
          (r) =>
            (timer = setTimeout(() => {
              child.kill("SIGKILL");
              r();
            }, 3000)),
        ),
      ]).finally(() => clearTimeout(timer));
    }
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
    await s3.send(
      new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
    );
    s3.destroy();
    if (db) await db.end();
    if (created) {
      // Pool.end() closes local clients before PostgreSQL has necessarily read
      // every Terminate/FIN. Forcing DROP in that gap can send a fatal protocol
      // error back into this test's closing pool. The worker has exited, so no
      // new fixture connections can be created; wait for their normal teardown.
      const deadline = Date.now() + 3000;
      while (
        (
          await root.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1",
            [name],
          )
        ).rows[0].n
      ) {
        assert.ok(
          Date.now() < deadline,
          "Worker fixture connections must close before dropping its database",
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await root.query("DROP DATABASE " + name);
    }
    await root.end();
  }
});

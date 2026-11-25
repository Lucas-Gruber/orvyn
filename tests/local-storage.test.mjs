import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readdir,
  stat,
  writeFile,
  symlink,
  mkdir,
  utimes,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { LocalAttachmentStorage } from "../apps/api/dist/files/local.js";

const bytes = async (object) => {
  const parts = [];
  for await (const part of object.body) parts.push(part);
  return Buffer.concat(parts);
};
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "orvyn-storage-"));
  try {
    await run(new LocalAttachmentStorage(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("local attachment storage streams, copies and removes private objects", () =>
  fixture(async (store, root) => {
    const body = Buffer.alloc(8 * 1024 * 1024, 0x73);
    await store.put("attachments/stream", {
      body: Readable.from(
        (function* () {
          for (let i = 0; i < 128; i++)
            yield body.subarray(i * 65536, (i + 1) * 65536);
        })(),
      ),
      size: body.length,
    });
    assert.equal(await store.exists("attachments/stream"), true);
    const object = await store.get("attachments/stream");
    assert.equal(object.size, body.length);
    assert.deepEqual(await bytes(object), body);
    await store.copy("attachments/stream", "attachments/copy");
    assert.deepEqual(await bytes(await store.get("attachments/copy")), body);
    const hash = createHash("sha256")
      .update("attachments/stream")
      .digest("hex");
    assert.equal(
      (await stat(join(root, "orvyn-objects", hash.slice(0, 2), hash.slice(2))))
        .mode & 0o777,
      0o600,
    );
    await store.delete("attachments/stream");
    await store.delete("attachments/stream");
    assert.equal(await store.exists("attachments/stream"), false);
    await store.health();
  }));
test("failed, undersized and aborted writes preserve the previous complete generation", () =>
  fixture(async (store, root) => {
    await store.put("a", { body: Buffer.from("previous"), size: 8 });
    for (const size of [1, 30])
      await assert.rejects(
        store.put("a", { body: Buffer.from("replacement"), size }),
      );
    await assert.rejects(
      store.put("a", {
        body: Readable.from(["replacement"]),
        size: 11,
        signal: AbortSignal.abort(),
      }),
    );
    assert.equal((await bytes(await store.get("a"))).toString(), "previous");
    assert.deepEqual(await readdir(join(root, "orvyn-objects", "staging")), []);
  }));
test("local paths reject traversal and symlink reads", () =>
  fixture(async (store, root) => {
    for (const key of [
      "../escape",
      "/absolute",
      "a/../b",
      "a\\b",
      "a//b",
      "nul\0key",
      ".",
    ])
      await assert.rejects(store.put(key, { body: Buffer.from("x"), size: 1 }));
    await store.health();
    const hash = createHash("sha256").update("unsafe").digest("hex"),
      shard = join(root, "orvyn-objects", hash.slice(0, 2));
    await mkdir(shard, { mode: 0o700, recursive: true });
    await writeFile(join(root, "outside"), "private");
    await symlink(join(root, "outside"), join(shard, hash.slice(2)));
    await assert.rejects(store.get("unsafe"));
    // Atomic rename replaces the directory entry; it never follows the malicious target.
    await store.put("unsafe", { body: Buffer.from("safe"), size: 4 });
    assert.equal((await bytes(await store.get("unsafe"))).toString(), "safe");
  }));
test("stale staging files are cleaned without deleting live writes or completed attachments", () =>
  fixture(async (store, root) => {
    await store.put("keep", { body: Buffer.from("yes"), size: 3 });
    const dir = join(root, "orvyn-objects", "staging"),
      old = join(dir, "00000000-0000-4000-8000-000000000001.tmp"),
      fresh = join(dir, "00000000-0000-4000-8000-000000000002.tmp");
    await writeFile(old, "stale");
    await writeFile(fresh, "live");
    await utimes(old, new Date(0), new Date(0));
    await store.cleanup();
    assert.deepEqual(await readdir(dir), [fresh.split("/").at(-1)]);
    assert.equal(await store.exists("keep"), true);
  }));
test("two independent processes commit complete concurrent file generations", () =>
  fixture(async (store, root) => {
    await store.put("shared", {
      body: Buffer.alloc(1048576, 65),
      size: 1048576,
    });
    const module = new URL("../apps/api/dist/files/local.js", import.meta.url)
      .href;
    const run = async (value) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {LocalAttachmentStorage} from ${JSON.stringify(module)}; const s=new LocalAttachmentStorage(process.argv[1]); for(let i=0;i<5;i++) await s.put('shared',{body:Buffer.alloc(1048576,Number(process.argv[2])),size:1048576});`,
          root,
          String(value),
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let error = "";
      child.stderr.on("data", (b) => (error += b));
      const [code] = await once(child, "exit");
      assert.equal(code, 0, error);
    };
    let done = false;
    const writers = Promise.all([run(65), run(66)]).finally(() => {
      done = true;
    });
    let reads = 0;
    while (!done) {
      const value = await bytes(await store.get("shared"));
      assert.ok(
        value.equals(Buffer.alloc(1048576, 65)) ||
          value.equals(Buffer.alloc(1048576, 66)),
        "A concurrent reader sees an entire committed generation",
      );
      reads++;
    }
    await writers;
    assert.ok(reads > 0);
    const result = await bytes(await store.get("shared"));
    assert.equal(result.length, 1048576);
    assert.ok(
      result.equals(Buffer.alloc(result.length, 65)) ||
        result.equals(Buffer.alloc(result.length, 66)),
    );
  }));

test("a denied local mount reports safe numeric metadata and recovers without S3 configuration", () =>
  fixture(async (store, root) => {
    await chmod(root, 0o500);
    try {
      await assert.rejects(store.health(), (error) => error.code === "EACCES");
      const diagnostic = await store.diagnostics();
      assert.equal(diagnostic.mountPath, root);
      assert.equal(diagnostic.ownerUid, process.getuid());
      assert.equal(diagnostic.effectiveUid, process.getuid());
      assert.equal(diagnostic.permissions, "0500");
    } finally {
      await chmod(root, 0o700);
    }
    await store.health();
    const module = new URL("../apps/api/dist/files/storage.js", import.meta.url)
      .href;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("S3_")),
    );
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {storageHealth} from ${JSON.stringify(module)}; await storageHealth('worker')`,
      ],
      {
        env: {
          ...env,
          ORVYN_STORAGE_DRIVER: "local",
          ORVYN_STORAGE_LOCAL_PATH: root,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let error = "";
    child.stderr.on("data", (data) => {
      error += data;
    });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, error);
  }));

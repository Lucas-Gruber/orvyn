import { constants } from "node:fs";
import {
  mkdir,
  lstat,
  open,
  rename,
  unlink,
  readdir,
  realpath,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  AttachmentStorage,
  StoredAttachment,
  WriteAttachment,
} from "./storage.js";

function validKey(key: string) {
  if (
    !key ||
    key.length > 1024 ||
    key.includes("\\") ||
    key.includes("\0") ||
    isAbsolute(key) ||
    key.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw Error("Invalid attachment object key");
  return createHash("sha256").update(key).digest("hex");
}
async function directory(path: string) {
  await mkdir(path, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o022)
    throw Error(
      "Attachment directory must be private and must not be a symlink",
    );
}

/** Private, hashed object paths. The mounted root must be writable only by trusted Orvyn processes. */
export class LocalAttachmentStorage implements AttachmentStorage {
  readonly driver = "local";
  private root: string;
  private initialized?: Promise<void>;
  constructor(path: string) {
    if (!isAbsolute(path))
      throw Error("ORVYN_STORAGE_LOCAL_PATH must be absolute");
    this.root = join(resolve(path), "orvyn-objects");
  }
  private initialize() {
    return (this.initialized ||= (async () => {
      // Do not chmod the PVC root: kubelet's fsGroup owns that boundary.
      await mkdir(resolve(this.root, ".."), { recursive: true });
      if (
        (await realpath(resolve(this.root, ".."))) !== resolve(this.root, "..")
      )
        throw Error("Attachment root must not contain symlinks");
      await directory(this.root);
      await directory(join(this.root, "staging"));
    })().catch((error) => {
      this.initialized = undefined;
      throw error;
    }));
  }
  private async location(key: string) {
    const hash = validKey(key);
    await this.initialize();
    const shard = join(this.root, hash.slice(0, 2));
    await directory(shard);
    return join(shard, hash.slice(2));
  }
  async put(key: string, input: WriteAttachment) {
    const target = await this.location(key);
    if (!Number.isSafeInteger(input.size) || input.size < 0)
      throw Error("Invalid attachment size");
    const temporary = join(this.root, "staging", randomUUID() + ".tmp");
    const file = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    let bytes = 0;
    try {
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > input.size ? Error("Attachment size exceeded") : null,
            chunk,
          );
        },
      });
      const output = new Writable({
        write(chunk, _encoding, callback) {
          file.writeFile(chunk).then(() => callback(), callback);
        },
      });
      await pipeline(
        Buffer.isBuffer(input.body) ? Readable.from([input.body]) : input.body,
        limit,
        output,
        { signal: input.signal },
      );
      if (bytes !== input.size) throw Error("Attachment size changed");
      await file.sync();
      await file.close();
      // Atomic replacement: concurrent readers see either complete generation.
      await rename(temporary, target);
      const parent = await open(
        resolve(target, ".."),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await file.close().catch(() => {});
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  async get(key: string, signal?: AbortSignal): Promise<StoredAttachment> {
    const file = await open(
      await this.location(key),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1)
        throw Error("Attachment is not a private regular file");
      const body = file.createReadStream({ autoClose: true, signal });
      return { body, size: stat.size };
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  async exists(key: string) {
    try {
      const object = await this.get(key);
      object.body.destroy();
      return true;
    } catch (error: any) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
  async delete(key: string) {
    await unlink(await this.location(key)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  async copy(source: string, target: string) {
    const object = await this.get(source);
    await this.put(target, { body: object.body, size: object.size });
  }
  async health() {
    const key = "health/" + randomUUID();
    try {
      await this.put(key, { body: Buffer.from("ok"), size: 2 });
    } finally {
      await this.delete(key);
    }
  }
  async cleanup() {
    await this.initialize();
    const staging = join(this.root, "staging");
    for (const name of (await readdir(staging)).slice(0, 1000)) {
      if (!/^[0-9a-f-]{36}\.tmp$/.test(name)) continue;
      const path = join(staging, name);
      try {
        const stat = await lstat(path);
        if (stat.isFile() && stat.mtimeMs < Date.now() - 3600000)
          await unlink(path);
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  close() {}
}

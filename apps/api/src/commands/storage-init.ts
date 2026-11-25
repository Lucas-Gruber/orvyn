import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import {
  storage,
  bucket,
  attachments,
  type AttachmentStorage,
} from "../files/storage.js";
import {
  createDiagnostics,
  RuntimeConfigurationError,
} from "@orvyn/shared/server";

let log = createDiagnostics("storage-init", {}),
  backend: AttachmentStorage | undefined;
const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());
async function main() {
  log = createDiagnostics("storage-init", process.env);
  const wait = process.argv.slice(2).includes("--wait"),
    deadline = wait ? Infinity : Date.now() + 180000;
  const retry = Number(process.env.ORVYN_CONFIGURATION_RETRY_SECONDS || 5);
  if (
    process.argv.slice(2).some((arg) => arg !== "--wait") ||
    !Number.isInteger(retry) ||
    retry < 1 ||
    retry > 300
  )
    throw new RuntimeConfigurationError(
      "STORAGE_BOOTSTRAP_CONFIGURATION_INVALID",
      "Use storage-init.js [--wait] and a retry interval of 1–300 seconds.",
    );
  await log.stage("storage_configuration", async () => {
    try {
      const endpoint = new URL(process.env.S3_ENDPOINT || "");
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        !endpoint.hostname ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        !process.env.S3_BUCKET ||
        !process.env.S3_ACCESS_KEY_ID ||
        !process.env.S3_SECRET_ACCESS_KEY ||
        (process.env.ORVYN_STORAGE_DRIVER || "s3") !== "s3"
      )
        throw Error();
    } catch {
      throw new RuntimeConfigurationError(
        "S3_CONFIGURATION_INVALID",
        "Configure the private internal S3 service and credentials.",
      );
    }
  });
  backend = attachments();
  while (!stop.signal.aborted) {
    try {
      try {
        await backend.health();
      } catch (error: any) {
        if (error.$metadata?.httpStatusCode !== 404) throw error;
        try {
          await storage().send(new CreateBucketCommand({ Bucket: bucket() }));
        } catch (createError: any) {
          if (createError.$metadata?.httpStatusCode !== 409) throw createError;
          await backend.health();
        }
      }
      const key = "setup-probes/" + randomUUID();
      try {
        await backend.put(key, { body: Buffer.from("ok"), size: 2 });
        const result = await backend.get(key);
        let bytes = Buffer.alloc(0);
        try {
          for await (const chunk of result.body) {
            bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
            if (bytes.length > 2)
              throw new RuntimeConfigurationError(
                "STORAGE_INTEGRITY_FAILED",
                "Storage returned unexpected object bytes.",
              );
          }
        } finally {
          result.body.destroy();
        }
        if (!bytes.equals(Buffer.from("ok")))
          throw new RuntimeConfigurationError(
            "STORAGE_INTEGRITY_FAILED",
            "Storage returned unexpected object bytes.",
          );
      } catch (error) {
        await backend.delete(key).catch(() => {});
        throw error;
      }
      await backend.delete(key);
      if (stop.signal.aborted) return;
      log.info("storage.initialized", { stage: "storage_bootstrap" });
      console.log("ORVYN_STORAGE_READY");
      return;
    } catch (error) {
      if (stop.signal.aborted) return;
      log.warn("storage.retrying", { stage: "storage_bootstrap", error });
      if (Date.now() >= deadline) throw error;
      await pause(retry * 1000, undefined, { signal: stop.signal }).catch(
        (error) => {
          if (!stop.signal.aborted) throw error;
        },
      );
    }
  }
}
main()
  .catch((error) => {
    log.error("storage.initialization_failed", {
      stage: "storage_bootstrap",
      error,
    });
    process.exitCode = 1;
  })
  .finally(() => backend?.close());

import { cleanupFiles } from "./files/cleanup.js";
import { db } from "./runtime.js";
import { deliverMailBatch, cleanupAuth } from "./auth/mail.js";
import { encryptionKey } from "./auth/security.js";
import {
  createDiagnostics,
  runtimeOrigin,
  RuntimeConfigurationError,
} from "@orvyn/shared/server";
import { storageHealth } from "./files/storage.js";
let log = createDiagnostics("worker", {});
let stopping = false;
const stop = () => {
  stopping = true;
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
async function maintain(label: string, task: () => Promise<void>) {
  while (!stopping) {
    try {
      await task();
    } catch (error) {
      log.error("maintenance.failed", { stage: label, error });
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
async function run() {
  log = createDiagnostics("worker", process.env);
  await log.stage("configuration", async () => {
    runtimeOrigin(process.env);
  });
  await log.stage("encryption", async () => {
    encryptionKey();
  });
  await log.stage("database", async () => {
    await db.query("SELECT 1");
  });
  await log.stage("storage", storageHealth);
  await log.stage("smtp_configuration", async () => {
    let url: URL;
    try {
      url = new URL(process.env.SMTP_URL || "");
    } catch {
      throw new RuntimeConfigurationError(
        "SMTP_CONFIGURATION_INVALID",
        "Configure an SMTP transport URL.",
      );
    }
    if (!["smtp:", "smtps:"].includes(url.protocol))
      throw new RuntimeConfigurationError(
        "SMTP_CONFIGURATION_INVALID",
        "SMTP_URL requires smtp:// or smtps://.",
      );
  });
  await Promise.all([
    maintain("mail_delivery", deliverMailBatch),
    maintain("authentication", cleanupAuth),
    maintain("attachment", cleanupFiles),
  ]);
  await db.end();
}
run().catch((error) => {
  log.error("startup.failed", { stage: "startup", error });
  process.exit(1);
});

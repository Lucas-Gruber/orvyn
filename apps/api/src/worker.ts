import { cleanupFiles } from "./files/cleanup.js";
import { db } from "./runtime.js";
import { deliverMailBatch, cleanupAuth } from "./auth/mail.js";
import { encryptionKey } from "./auth/security.js";
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
    } catch {
      console.error(label + " maintenance failed");
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
async function run() {
  encryptionKey();
  if (!process.env.SMTP_URL) throw Error("SMTP_URL required for email worker");
  await Promise.all([
    maintain("Mail delivery", deliverMailBatch),
    maintain("Authentication", cleanupAuth),
    maintain("Attachment", cleanupFiles),
  ]);
  await db.end();
}
run().catch(() => {
  console.error("Worker startup failed; verify configuration");
  process.exit(1);
});

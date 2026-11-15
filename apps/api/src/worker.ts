import { db } from "./runtime";
import { deliverMailBatch, cleanupAuth } from "./auth/mail";
import { encryptionKey } from "./auth/security";
let stopping = false;
const stop = () => {
  stopping = true;
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
async function run() {
  encryptionKey();
  if (!process.env.SMTP_URL) throw Error("SMTP_URL required for email worker");
  while (!stopping) {
    try {
      await deliverMailBatch();
      await cleanupAuth();
    } catch {
      console.error("Background authentication maintenance failed");
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await db.end();
}
run().catch(() => {
  console.error("Worker startup failed; verify configuration");
  process.exit(1);
});

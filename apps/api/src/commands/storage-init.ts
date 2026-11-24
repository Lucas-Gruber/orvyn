import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { storage, bucket, attachments } from "../files/storage.js";

const deadline = Date.now() + 180000;
try {
  while (true) {
    try {
      try {
        await attachments().health();
      } catch (error: any) {
        if (error.$metadata?.httpStatusCode !== 404) throw error;
        await storage().send(new CreateBucketCommand({ Bucket: bucket() }));
      }
      const key = "setup-probes/" + randomUUID();
      try {
        await attachments().put(key, { body: Buffer.from("ok"), size: 2 });
        const result = await attachments().get(key);
        let body = "";
        for await (const chunk of result.body) body += chunk.toString();
        if (body !== "ok") throw Error("Storage integrity failed");
      } finally {
        await attachments().delete(key);
      }
      break;
    } catch {
      if (Date.now() >= deadline)
        throw Error("Storage initialization timed out");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  console.log("ORVYN_STORAGE_READY");
} catch {
  console.error(
    "Storage initialization failed; verify endpoint, credentials and bucket policy",
  );
  process.exitCode = 1;
} finally {
  attachments().close();
}

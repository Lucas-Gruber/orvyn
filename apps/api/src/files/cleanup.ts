import { transaction } from "../auth/security.js";
import { storage, bucket, DeleteObjectCommand } from "./storage.js";
export async function cleanupFiles() {
  for (let i = 0; i < 10; i++) {
    const found = await transaction(async (c) => {
      const r = await c.query(
        "SELECT id,object_key FROM files WHERE (state='pending' AND created_at<now()-interval '1 hour') OR (state='deleted' AND deleted_at<now()-interval '30 days') ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
      );
      if (!r.rowCount) return false;
      const file = r.rows[0];
      await storage().send(
        new DeleteObjectCommand({ Bucket: bucket(), Key: file.object_key }),
      );
      await c.query("DELETE FROM files WHERE id=$1", [file.id]);
      return true;
    });
    if (!found) break;
  }
}

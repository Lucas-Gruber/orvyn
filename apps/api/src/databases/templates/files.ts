import { randomUUID } from "node:crypto";
import { CopyObjectCommand } from "@aws-sdk/client-s3";
import { storage, bucket, DeleteObjectCommand } from "../../files/storage.js";
import { db } from "../../runtime.js";

export interface TemplateFile {
  id: string;
  page_id: string;
  object_key: string;
  filename: string;
  media_type: string;
  size: string | number;
}
export interface CopiedTemplateFile extends TemplateFile {
  sourceId: string;
}
export async function removeTemplateCopies(files: CopiedTemplateFile[]) {
  // A failed COMMIT response can be ambiguous. Never remove a committed file.
  const owned = files.length
      ? (
          await db.query(
            "SELECT object_key FROM files WHERE object_key=ANY($1::text[])",
            [files.map((f) => f.object_key)],
          )
        ).rows.map((f) => f.object_key)
      : [],
    keep = new Set(owned);
  await Promise.allSettled(
    files
      .filter((f) => !keep.has(f.object_key))
      .map((f) =>
        storage().send(
          new DeleteObjectCommand({ Bucket: bucket(), Key: f.object_key }),
        ),
      ),
  );
}
export async function copyTemplateFiles(
  source: TemplateFile[],
): Promise<CopiedTemplateFile[]> {
  const files = source.map((f) => ({
    ...f,
    sourceId: f.id,
    id: randomUUID(),
    object_key: "attachments/" + randomUUID(),
  }));
  let next = 0,
    error: unknown;
  await Promise.all(
    Array.from({ length: Math.min(4, files.length) }, async () => {
      while (!error) {
        const at = next++,
          target = files[at],
          original = source[at];
        if (!target || !original) return;
        try {
          await storage().send(
            new CopyObjectCommand({
              Bucket: bucket(),
              Key: target.object_key,
              CopySource:
                bucket() +
                "/" +
                original.object_key
                  .split("/")
                  .map(encodeURIComponent)
                  .join("/"),
              MetadataDirective: "COPY",
            }),
          );
        } catch (e) {
          error = e;
        }
      }
    }),
  );
  if (error) {
    await removeTemplateCopies(files);
    throw error;
  }
  return files;
}

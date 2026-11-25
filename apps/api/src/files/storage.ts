import {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { LocalAttachmentStorage } from "./local.js";
import {
  createDiagnostics,
  RuntimeConfigurationError,
} from "@orvyn/shared/server";
export {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
};
let client: S3Client | undefined;
export function storage() {
  const names = [
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ];
  if (names.some((name) => !process.env[name]))
    throw new RuntimeConfigurationError(
      "S3_CONFIGURATION_INVALID",
      "S3 configuration required",
    );
  return (client ||= new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "us-east-1",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 10000 },
  }));
}
export const bucket = () => process.env.S3_BUCKET!;
export interface WriteAttachment {
  body: Buffer | Readable;
  size: number;
  contentType?: string;
  signal?: AbortSignal;
}
export interface StoredAttachment {
  body: Readable;
  size: number;
}
export interface AttachmentStorage {
  readonly driver: "local" | "s3";
  put(key: string, input: WriteAttachment): Promise<void>;
  get(key: string, signal?: AbortSignal): Promise<StoredAttachment>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  copy(source: string, target: string): Promise<void>;
  health(): Promise<void>;
  cleanup(): Promise<void>;
  close(): void;
}
class S3AttachmentStorage implements AttachmentStorage {
  readonly driver = "s3";
  async put(key: string, input: WriteAttachment) {
    await storage().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: input.body,
        ContentLength: input.size,
        ContentType: input.contentType,
        ...(Buffer.isBuffer(input.body)
          ? {
              ContentMD5: createHash("md5").update(input.body).digest("base64"),
            }
          : {}),
      }),
      { abortSignal: input.signal },
    );
  }
  async get(key: string, signal?: AbortSignal): Promise<StoredAttachment> {
    const object = await storage().send(
      new GetObjectCommand({ Bucket: bucket(), Key: key }),
      { abortSignal: signal },
    );
    if (!(object.Body instanceof Readable))
      throw Error("Attachment is not readable");
    if (object.ContentLength === undefined) {
      object.Body.destroy();
      throw Error("Attachment size is unavailable");
    }
    return { body: object.Body, size: object.ContentLength };
  }
  async exists(key: string) {
    try {
      await storage().send(
        new HeadObjectCommand({ Bucket: bucket(), Key: key }),
      );
      return true;
    } catch (error: any) {
      if (error.$metadata?.httpStatusCode === 404) return false;
      throw error;
    }
  }
  async delete(key: string) {
    await storage().send(
      new DeleteObjectCommand({ Bucket: bucket(), Key: key }),
    );
  }
  async copy(source: string, target: string) {
    await storage().send(
      new CopyObjectCommand({
        Bucket: bucket(),
        Key: target,
        CopySource:
          bucket() + "/" + source.split("/").map(encodeURIComponent).join("/"),
        MetadataDirective: "COPY",
      }),
    );
  }
  async health() {
    await storage().send(new HeadBucketCommand({ Bucket: bucket() }));
  }
  async cleanup() {}
  close() {
    client?.destroy();
  }
}
let backend: AttachmentStorage | undefined;
export function attachments(): AttachmentStorage {
  if (backend) return backend;
  const driver = process.env.ORVYN_STORAGE_DRIVER || "s3";
  if (driver === "s3") return (backend = new S3AttachmentStorage());
  if (driver === "local") {
    if (!process.env.ORVYN_STORAGE_LOCAL_PATH)
      throw new RuntimeConfigurationError(
        "STORAGE_CONFIGURATION_INVALID",
        "ORVYN_STORAGE_LOCAL_PATH required",
      );
    return (backend = new LocalAttachmentStorage(
      process.env.ORVYN_STORAGE_LOCAL_PATH,
    ));
  }
  throw new RuntimeConfigurationError(
    "STORAGE_CONFIGURATION_INVALID",
    "ORVYN_STORAGE_DRIVER must be local or s3",
  );
}
export async function storageHealth(component = "api") {
  const backend = attachments();
  try {
    await backend.health();
  } catch (error) {
    const log = createDiagnostics(component, process.env);
    if (backend instanceof LocalAttachmentStorage)
      log.error("storage.filesystem_unavailable", {
        stage: "storage",
        ...(await backend.diagnostics()),
        error,
      });
    else log.error("storage.s3_unavailable", { stage: "storage", error });
    throw error;
  }
}

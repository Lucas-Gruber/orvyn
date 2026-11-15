import {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
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
    throw Error("S3 configuration required");
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
export async function storageHealth() {
  await storage().send(new HeadBucketCommand({ Bucket: bucket() }));
}

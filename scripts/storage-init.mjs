import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
const require = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const { CreateBucketCommand } = require("@aws-sdk/client-s3");
import {
  storage,
  bucket,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "../apps/api/dist/files/storage.js";
const client = storage(),
  name = bucket();
try {
  try {
    await client.send(new HeadBucketCommand({ Bucket: name }));
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 404) throw error;
    await client.send(new CreateBucketCommand({ Bucket: name }));
  }
  const key = "setup-probes/" + randomUUID(),
    body = Buffer.from("orvyn storage readiness");
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: name,
        Key: key,
        Body: body,
        ContentMD5: createHash("md5").update(body).digest("base64"),
      }),
    );
    const result = await client.send(
      new GetObjectCommand({ Bucket: name, Key: key }),
    );
    if (!Buffer.from(await result.Body.transformToByteArray()).equals(body))
      throw Error("Storage integrity probe failed");
    const anonymous = new URL(process.env.S3_ENDPOINT);
    anonymous.pathname = `/${name}/${key}`;
    const response = await fetch(anonymous);
    await response.arrayBuffer();
    if (response.status !== 403 && response.status !== 401)
      throw Error("Bucket privacy probe failed");
  } finally {
    await client.send(new DeleteObjectCommand({ Bucket: name, Key: key }));
  }
  console.log(
    "S3 write/read/integrity and anonymous-access rejection verified",
  );
} catch {
  console.error(
    "Storage setup failed; verify endpoint, bucket and access policy",
  );
  process.exitCode = 1;
} finally {
  client.destroy();
}

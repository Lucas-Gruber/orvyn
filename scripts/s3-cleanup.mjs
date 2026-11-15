import { createRequire } from "node:module";
const require = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const {
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
} = require("@aws-sdk/client-s3");
// Call only for a disposable bucket newly created and owned by the caller.
export async function removeTestBucket(s3, bucket) {
  for (;;) {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    if (!list.Contents?.length) break;
    const r = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: list.Contents.map((o) => ({ Key: o.Key })) },
      }),
    );
    if (r.Errors?.length) throw Error("Test object cleanup failed");
  }
  // SeaweedFS keeps physical empty prefix directories, exposed with Delimiter.
  const queue = [""],
    directories = new Set();
  while (queue.length) {
    const prefix = queue.shift();
    let continuation;
    do {
      const list = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: "/",
          ContinuationToken: continuation,
        }),
      );
      for (const p of list.CommonPrefixes || []) {
        if (p.Prefix !== prefix && !directories.has(p.Prefix)) {
          directories.add(p.Prefix);
          queue.push(p.Prefix);
          if (directories.size > 10000)
            throw Error("Test prefix cleanup limit exceeded");
        }
      }
      continuation = list.NextContinuationToken;
    } while (continuation);
  }
  for (const key of [...directories].sort((a, b) => b.length - a.length))
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
}

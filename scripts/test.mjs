import { removeTestBucket } from "./s3-cleanup.mjs";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
const require = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const { Pool } = require("pg");
const {
  S3Client,
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
} = require("@aws-sdk/client-s3");
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(process.env.S3_ENDPOINT).hostname,
  )
)
  throw Error("Use local disposable S3 storage for tests");
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || "us-east-1",
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});
let bucketCreated = false;
const url = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  throw Error("Use a local disposable PostgreSQL instance for tests");
const root = new Pool({ connectionString: url.toString() }),
  name = "orvyn_suite_" + randomBytes(8).toString("hex");
const storageBucket = name.replaceAll("_", "-");
const children = [];
const port = async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const p = server.address().port;
  await new Promise((r) => server.close(r));
  return p;
};
async function ready(address, child) {
  const deadline = Date.now() + 30000;
  let last = "No response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw Error("Test service exited during startup");
    try {
      const r = await fetch(address, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
      last = "HTTP " + r.status;
      await r.body?.cancel();
    } catch (error) {
      last = error.message;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(
    `Test service did not become ready within 30s: ${address} (${last})`,
  );
}
function start(args, env) {
  const c = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(c);
  c.stdout.resume();
  c.stderr.on("data", (b) => process.stderr.write(b));
  return c;
}
let created = false;
try {
  await root.query("CREATE DATABASE " + name);
  created = true;
  url.pathname = "/" + name;
  await s3.send(new CreateBucketCommand({ Bucket: storageBucket }));
  bucketCreated = true;
  const apiPort = await port(),
    webPort = await port(),
    base = `http://127.0.0.1:${webPort}`;
  const common = {
    ...process.env,
    DATABASE_URL: url.toString(),
    S3_BUCKET: storageBucket,
    ORVYN_ORIGIN: base,
    NODE_ENV: "test",
    ORVYN_OIDC_ALLOW_HTTP_LOCAL: "true",
    TEST_ORIGIN: base,
    TEST_URL: base,
  };
  const api = start(["apps/api/dist/main.js"], {
    ...common,
    PORT: String(apiPort),
  });
  await ready(`http://127.0.0.1:${apiPort}/api/v1/health`, api);
  const worker = start(["apps/api/dist/worker.js"], common);
  const collaborationUrls = [];
  for (let i = 0; i < 2; i++) {
    const p = await port();
    const service = start(["apps/collaboration/dist/main.js"], {
      ...common,
      COLLABORATION_PORT: String(p),
      COLLABORATION_NAMESPACE: name,
    });
    await ready(`http://127.0.0.1:${p}/health`, service);
    collaborationUrls.push(`ws://127.0.0.1:${p}`);
  }
  common.COLLABORATION_TEST_URLS = JSON.stringify(collaborationUrls);
  common.NUXT_PUBLIC_COLLABORATION_URL = "";
  common.NUXT_COLLABORATION_UPSTREAM = collaborationUrls[0];
  const web = start(["apps/web/.output/server/index.mjs"], {
    ...common,
    NITRO_PORT: String(webPort),
    NUXT_API_URL: `http://127.0.0.1:${apiPort}`,
  });
  await ready(base + "/api/v1/health", web);
  const args = process.argv.slice(2),
    testArgs = args.length
      ? args
      : [
          "tests/accounts.test.mjs",
          "tests/browser.test.mjs",
          "tests/migrations.test.mjs",
          "tests/oidc.test.mjs",
          "tests/workspace.test.mjs",
          "tests/permissions.test.mjs",
          "tests/collaboration.test.mjs",
          "tests/editor.test.mjs",
          "tests/files.test.mjs",
          "tests/restore.test.mjs",
          "tests/databases.test.mjs",
          "tests/database-events.test.mjs",
          "tests/database-browser.test.mjs",
          "tests/kanban.test.mjs",
          "tests/rate-limit.test.mjs",
          "tests/embedded-database.test.mjs",
          "tests/database-transfer.test.mjs",
          "tests/database-person.test.mjs",
          "tests/database-files.test.mjs",
          "tests/database-relations.test.mjs",
          "tests/cross-space-relations.test.mjs",
          "tests/reciprocal-relations.test.mjs",
          "tests/database-formulas.test.mjs",
          "tests/database-rollups.test.mjs",
          "tests/multi-hop-rollups.test.mjs",
          "tests/database-templates.test.mjs",
          "tests/database-ux.test.mjs",
          "tests/database-drafts.test.mjs",
          "tests/database-properties.test.mjs",
          "tests/database-view-layout.test.mjs",
          "tests/database-column-widths.test.mjs",
          "tests/worker.test.mjs",
          "tests/preview.test.mjs",
          "tests/local-preview.test.mjs",
          "tests/ui-workflow.test.mjs",
          "tests/search.test.mjs",
          "tests/fulltext-search.test.mjs",
          "tests/property-search.test.mjs",
          "tests/property-conversion.test.mjs",
          "tests/property-conversion-browser.test.mjs",
          "tests/document-links.test.mjs",
          "tests/backlinks.test.mjs",
          "tests/editor-blocks.test.mjs",
          "tests/editor-ux.test.mjs",
          "tests/editor-tables.test.mjs",
          "tests/whiteboards.test.mjs",
          "tests/publications.test.mjs",
          "tests/database-publications.test.mjs",
          "tests/publication-navigation.test.mjs",
          "tests/record-publications.test.mjs",
          "tests/editor-assets.test.mjs",
          "tests/page-previews.test.mjs",
          "tests/video-embeds.test.mjs",
          "tests/editor-layout.test.mjs",
          "tests/column-resizing.test.mjs",
          "tests/block-controls.test.mjs",
          "tests/nested-blocks.test.mjs",
          "tests/appearance.test.mjs",
          "tests/editor-batching.test.mjs",
          "tests/hierarchy.test.mjs",
          "tests/comments.test.mjs",
          "tests/comment-anchors.test.mjs",
          "tests/notifications.test.mjs",
          "tests/document-mentions.test.mjs",
          "tests/activity.test.mjs",
        ];
  const tests = spawn(
    process.execPath,
    ["--test", "--test-concurrency=1", ...testArgs],
    { env: common, stdio: "inherit" },
  );
  process.exitCode = await new Promise((resolve) =>
    tests.on("exit", (code) => resolve(code ?? 1)),
  );
} finally {
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null) return;
      let timer;
      await Promise.race([
        once(child, "exit"),
        new Promise((r) => {
          timer = setTimeout(() => {
            child.kill("SIGKILL");
            r();
          }, 3000);
        }),
      ]);
      clearTimeout(timer);
    }),
  );
  if (created) await root.query("DROP DATABASE " + name + " WITH (FORCE)");
  await root.end();
  if (bucketCreated) await removeTestBucket(s3, storageBucket);
  s3.destroy();
}

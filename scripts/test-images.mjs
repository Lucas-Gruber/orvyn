import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as tlsServer, request as tlsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { createServer as portServer } from "node:net";
import { once } from "node:events";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import * as Y from "yjs";
import { removeTestBucket } from "./s3-cleanup.mjs";
import { redactTestDiagnostics } from "./test-diagnostics.mjs";
const execute = promisify(execFile),
  require = createRequire(new URL("../apps/api/package.json", import.meta.url)),
  { Pool } = require("pg"),
  { S3Client, CreateBucketCommand } = require("@aws-sdk/client-s3"),
  WS = createRequire(new URL("../apps/web/package.json", import.meta.url))(
    "ws",
  );
const loopback = (url) => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};
if (!loopback(process.env.DATABASE_URL) || !loopback(process.env.S3_ENDPOINT))
  throw Error(
    "Image tests require the local disposable development infrastructure.",
  );
const suffix = randomBytes(8).toString("hex"),
  name = "orvyn_image_" + suffix,
  bucket = name.replaceAll("_", "-"),
  prefix = bucket,
  databaseUrl = new URL(process.env.DATABASE_URL),
  root = new Pool({ connectionString: databaseUrl.toString() }),
  s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "us-east-1",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  }),
  directory = await mkdtemp(join(tmpdir(), "orvyn-images-")),
  containers = [],
  peers = [],
  sockets = new Set();
let databaseCreated = false,
  bucketCreated = false,
  proxy;
async function docker(args) {
  const result = await execute(
    "docker",
    ["--host=unix:///var/run/docker.sock", ...args],
    {
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return (result.stdout + (args[0] === "logs" ? result.stderr : "")).trim();
}
async function port() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const value = 20000 + Math.floor(Math.random() * 9000),
      server = portServer();
    try {
      server.listen(value, "127.0.0.1");
      await once(server, "listening");
      await new Promise((resolve) => server.close(resolve));
      return value;
    } catch (error) {
      server.close();
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  throw Error("No local image-test port is available.");
}
async function waitFor(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(label);
}
async function main() {
  await rm(".local/test-results/production-images.log", { force: true });
  for (const component of ["web", "api", "collaboration", "worker"]) {
    const image = JSON.parse(
      await docker(["image", "inspect", `orvyn/${component}:ci`]),
    )[0];
    assert.equal(
      image.Config.User,
      "node",
      component + " must run without root",
    );
    const result = await docker([
      "run",
      "--rm",
      "--entrypoint",
      "node",
      `orvyn/${component}:ci`,
      "-e",
      "if(process.getuid()===0 || require('node:fs').existsSync('/app/.env'))process.exit(1); console.log(process.versions.node)",
    ]);
    assert.match(result, /^24\./);
  }
  const infra = [];
  for (const service of ["postgres", "storage", "redis", "mailpit"]) {
    const id = await docker([
      "compose",
      "--env-file",
      ".env",
      "-f",
      "infrastructure/compose/compose.yaml",
      "ps",
      "-q",
      service,
    ]);
    if (!id)
      throw Error("Start the local Compose infrastructure before image tests.");
    infra.push(JSON.parse(await docker(["inspect", id]))[0]);
  }
  const network = Object.keys(infra[0].NetworkSettings.Networks).find((name) =>
    infra.every((item) => item.NetworkSettings.Networks[name]),
  );
  if (!network)
    throw Error("Test infrastructure must share one Docker network.");
  await root.query("CREATE DATABASE " + name);
  databaseCreated = true;
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  bucketCreated = true;
  const keyPath = join(directory, "tls.key"),
    certPath = join(directory, "tls.crt");
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  const cert = await readFile(certPath),
    webPort = await port(),
    httpsPort = await port(),
    origin = `https://127.0.0.1:${httpsPort}`;
  proxy = tlsServer({ key: await readFile(keyPath), cert }, (req, res) => {
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: webPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (remote) => {
        res.writeHead(remote.statusCode, remote.headers);
        remote.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(503);
      res.end();
    });
    req.pipe(upstream);
  });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  proxy.on("upgrade", (req, socket, head) => {
    const upstream = httpRequest({
      host: "127.0.0.1",
      port: webPort,
      path: req.url,
      headers: req.headers,
    });
    upstream.on("upgrade", (res, remote, remoteHead) => {
      socket.write(
        `HTTP/1.1 101 ${res.statusMessage}\r\n` +
          res.rawHeaders.reduce(
            (text, value, index) => text + value + (index % 2 ? "\r\n" : ": "),
            "",
          ) +
          "\r\n",
      );
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.pipe(socket);
      socket.pipe(remote);
      socket.on("close", () => remote.destroy());
      remote.on("error", () => socket.destroy());
    });
    upstream.on("response", (res) => {
      socket.end(
        `HTTP/1.1 ${res.statusCode} Rejected\r\nConnection: close\r\n\r\n`,
      );
      res.resume();
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  proxy.listen(httpsPort, "127.0.0.1");
  await once(proxy, "listening");
  databaseUrl.hostname = "postgres";
  databaseUrl.port = "5432";
  databaseUrl.pathname = "/" + name;
  const envFile = join(directory, "runtime.env"),
    settings = {
      DATABASE_URL: databaseUrl.toString(),
      ORVYN_ORIGIN: origin,
      ORVYN_ENCRYPTION_KEY: process.env.ORVYN_ENCRYPTION_KEY,
      SMTP_URL: "smtp://mailpit:1025",
      MAIL_FROM: "release-smoke@localhost.test",
      S3_ENDPOINT: "http://storage:8333",
      S3_BUCKET: bucket,
      S3_REGION: process.env.S3_REGION || "us-east-1",
      S3_FORCE_PATH_STYLE: "true",
      S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
      S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
      REDIS_URL: "redis://redis:6379",
      COLLABORATION_NAMESPACE: name,
      NUXT_API_URL: `http://${prefix}-api:3001`,
      NUXT_COLLABORATION_UPSTREAM: `ws://${prefix}-collaboration:3002`,
      NUXT_PUBLIC_COLLABORATION_URL: "",
      NO_PROXY: [
        process.env.NO_PROXY || "",
        "postgres",
        "storage",
        "redis",
        "mailpit",
        prefix + "-api",
        prefix + "-collaboration",
        "127.0.0.1",
        "localhost",
      ].join(","),
    };
  if (
    Object.values(settings).some(
      (value) => typeof value !== "string" || /[\r\n]/.test(value),
    )
  )
    throw Error("Missing or invalid local test configuration.");
  await writeFile(
    envFile,
    Object.entries(settings)
      .map(([key, value]) => key + "=" + value)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  async function start(component) {
    const container = prefix + "-" + component;
    containers.push(container);
    await docker([
      "run",
      "-d",
      "--name",
      container,
      "--network",
      network,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--env-file",
      envFile,
      ...(component === "web" ? ["-p", `127.0.0.1:${webPort}:3000`] : []),
      `orvyn/${component}:ci`,
    ]);
    if (component !== "worker")
      await waitFor(
        async () => {
          const value = JSON.parse(await docker(["inspect", container]))[0];
          if (!value.State.Running)
            throw Error(component + " image exited during startup.");
          return value.State.Health?.Status === "healthy";
        },
        component + " image did not become healthy.",
        90000,
      );
  }
  await start("api");
  await start("collaboration");
  await start("web");
  await start("worker");
  async function request(
    path,
    { method = "GET", body, cookie, raw = false } = {},
  ) {
    const bytes =
      body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = tlsRequest(
        new URL(path, origin),
        {
          method,
          ca: cert,
          headers: {
            Origin: origin,
            ...(cookie ? { Cookie: cookie } : {}),
            ...(bytes
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": bytes.length,
                }
              : {}),
            ...(raw ? { "Content-Type": raw } : {}),
          },
        },
        (res) => {
          const parts = [];
          res.on("data", (chunk) => parts.push(chunk));
          res.on("end", () => {
            const buffer = Buffer.concat(parts);
            let data;
            try {
              data = JSON.parse(buffer);
            } catch {
              data = buffer.toString();
            }
            resolve({
              status: res.statusCode,
              headers: res.headers,
              bytes: buffer,
              data,
            });
          });
        },
      );
      req.setTimeout(10000, () =>
        req.destroy(Error("HTTPS image request timed out.")),
      );
      req.on("error", reject);
      req.end(bytes);
    });
  }
  const html = await request("/");
  assert.equal(html.status, 200);
  const assets = [
    ...new Set(
      [
        ...html.data.matchAll(/(?:src|href)="(\/_nuxt\/[^"?]+\.(?:js|css))/g),
      ].map((match) => match[1]),
    ),
  ];
  assert.ok(assets.length > 0);
  for (const path of assets)
    assert.equal((await request(path)).status, 200, "Missing built web asset");
  const email = randomUUID() + "@example.test",
    registered = await request("/api/v1/auth/register", {
      method: "POST",
      body: { email, password: randomUUID() },
    });
  assert.equal(registered.status, 201);
  const session = registered.headers["set-cookie"].find((value) =>
    value.startsWith("orvyn_session="),
  );
  assert.match(session, /; Secure/);
  assert.match(session, /HttpOnly/);
  const cookie = session.split(";")[0];
  const ownerId = (await request("/api/v1/auth/me", { cookie })).data.id;
  const second = await request("/api/v1/auth/register", {
    method: "POST",
    body: { email: randomUUID() + "@example.test", password: randomUUID() },
  });
  assert.equal(second.status, 201);
  const editorCookie = second.headers["set-cookie"]
    .find((value) => value.startsWith("orvyn_session="))
    .split(";")[0];
  const editorId = (await request("/api/v1/auth/me", { cookie: editorCookie }))
    .data.id;
  const space = (
    await request("/api/v1/spaces", {
      method: "POST",
      cookie,
      body: { name: "Production image check" },
    })
  ).data;
  const fixtureUrl = new URL(process.env.DATABASE_URL);
  fixtureUrl.pathname = "/" + name;
  const fixtureDb = new Pool({ connectionString: fixtureUrl.toString() });
  try {
    await fixtureDb.query(
      "UPDATE spaces SET kind='team' WHERE id=$1 AND owner_id=$2",
      [space.id, ownerId],
    );
    await fixtureDb.query(
      "INSERT INTO space_members(space_id,user_id,role) VALUES($1,$2,'Editor')",
      [space.id, editorId],
    );
  } finally {
    await fixtureDb.end();
  }
  const page = (
    await request(`/api/v1/spaces/${space.id}/pages`, {
      method: "POST",
      cookie,
      body: { title: "Release image document" },
    })
  ).data;
  assert.ok(page.id);
  assert.equal((await request(`/api/v1/pages/${page.id}`)).status, 401);
  const boundary = "orvyn-" + randomUUID(),
    payload = Buffer.from("Production attachment integrity"),
    multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="release.txt"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      payload,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    uploaded = await request(`/api/v1/pages/${page.id}/files`, {
      method: "POST",
      cookie,
      body: multipart,
      raw: "multipart/form-data; boundary=" + boundary,
    });
  assert.equal(uploaded.status, 201);
  assert.deepEqual(
    (await request(`/api/v1/files/${uploaded.data.id}/download`, { cookie }))
      .bytes,
    payload,
  );
  assert.equal(
    (await request(`/api/v1/files/${uploaded.data.id}/download`)).status,
    401,
  );
  const rejectedOrigin = await new Promise((resolve, reject) => {
    const socket = new WS(
      origin.replace(/^https:/, "wss:") + "/collaboration",
      {
        ca: cert,
        headers: { Origin: "https://untrusted.example.test", Cookie: cookie },
      },
    );
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
      socket.terminate();
    });
    socket.on("error", () => {});
    socket.on("open", () => {
      socket.close();
      reject(Error("A foreign WebSocket origin was accepted"));
    });
  });
  assert.equal(rejectedOrigin, 403);
  function connect(clientCookie = cookie) {
    class Socket extends WS {
      constructor(url, protocols) {
        super(url, protocols, {
          ca: cert,
          headers: { Origin: origin, Cookie: clientCookie },
        });
      }
    }
    const doc = new Y.Doc(),
      socket = new HocuspocusProviderWebsocket({
        url: origin.replace(/^https:/, "wss:") + "/collaboration",
        WebSocketPolyfill: Socket,
        delay: 50,
        minDelay: 50,
        maxDelay: 200,
      }),
      provider = new HocuspocusProvider({
        websocketProvider: socket,
        name: page.id,
        document: doc,
        token: "cookie",
      });
    provider.attach();
    const peer = { doc, provider, socket };
    peers.push(peer);
    return peer;
  }
  const a = connect(),
    b = connect(editorCookie),
    text = (doc) => doc.getXmlFragment("default").toString();
  await waitFor(
    () => a.provider.synced && b.provider.synced,
    "Production WebSocket proxy did not synchronize.",
  );
  a.doc.transact(() => {
    const paragraph = a.doc.getXmlFragment("default").get(0),
      value = new Y.XmlText();
    value.insert(0, "Release collaboration persisted");
    paragraph.insert(0, [value]);
  });
  await waitFor(
    () =>
      text(b.doc).includes("Release collaboration persisted") &&
      !a.provider.hasUnsyncedChanges,
    "Production collaboration edit was not acknowledged.",
  );
  b.doc.transact(() => {
    const node = b.doc.getXmlFragment("default").get(0).get(0);
    node.insert(node.length, " Editor collaboration persisted");
  });
  await waitFor(
    () =>
      text(a.doc).includes("Editor collaboration persisted") &&
      !b.provider.hasUnsyncedChanges,
    "A second authorized user did not synchronize through the public WSS origin",
  );
  assert.ok(
    JSON.stringify(
      (await request(`/api/v1/pages/${page.id}`, { cookie })).data.document,
    ).includes("Release collaboration persisted"),
  );
  const c = connect();
  await waitFor(
    () =>
      c.provider.synced &&
      text(c.doc).includes("Release collaboration persisted"),
    "Production collaboration did not retain its document.",
  );
  const mailbox = process.env.TEST_MAIL_URL || "http://127.0.0.1:8025";
  if (!loopback(mailbox)) throw Error("Use the local Mailpit test mailbox.");
  await waitFor(
    async () => {
      const response = await fetch(
        mailbox + "/api/v1/search?query=" + encodeURIComponent("to:" + email),
      );
      const value = await response.json();
      return value.messages?.some(
        (message) => message.Subject === "Verify your Orvyn email",
      );
    },
    "The production worker did not deliver its verification email.",
    20000,
  );
  console.log(
    "Four non-root production images passed HTTPS, secure-session, private-file, durable WebSocket and worker-mail checks; " +
      assets.length +
      " built assets verified.",
  );
}
try {
  await main();
} catch (error) {
  const failure = redactTestDiagnostics(
    error.message || "Production image validation failed",
  );
  console.error("IMAGE_CHECK: " + failure.replaceAll("\n", "\nIMAGE_CHECK: "));
  if (process.env.GITHUB_ACTIONS === "true")
    console.error(
      "::error title=Production image validation failed::" +
        failure
          .replaceAll("%", "%25")
          .replaceAll("\r", "%0D")
          .replaceAll("\n", "%0A"),
    );
  const report = [failure];
  process.exitCode = 1;
  for (const container of containers)
    try {
      const diagnostic = redactTestDiagnostics(
        await docker(["logs", "--tail", "35", container]),
      );
      await writeFile(join(directory, container + ".log"), diagnostic, {
        mode: 0o600,
      });
      report.push(container + "\n" + diagnostic);
    } catch {}
  await mkdir(".local/test-results", { recursive: true });
  await writeFile(
    ".local/test-results/production-images.log",
    report.join("\n\n"),
    { mode: 0o600 },
  );
} finally {
  for (const peer of peers) {
    peer.provider.destroy();
    peer.socket.destroy();
    peer.doc.destroy();
  }
  for (const socket of sockets) socket.destroy();
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  for (const container of containers.reverse())
    try {
      await docker(["rm", "-f", container]);
    } catch {
      console.error("Could not remove an owned image-test container.");
      process.exitCode = 1;
    }
  if (databaseCreated)
    await root.query("DROP DATABASE " + name + " WITH (FORCE)");
  await root.end();
  if (bucketCreated) await removeTestBucket(s3, bucket);
  s3.destroy();
  if (!process.exitCode) await rm(directory, { recursive: true, force: true });
  else console.error("Image-test diagnostics retained in " + directory);
}

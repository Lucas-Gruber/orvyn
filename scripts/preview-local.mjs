import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const cwd = fileURLToPath(new URL("../", import.meta.url)),
  args = process.argv.slice(2),
  children = new Set();
let stopping = false,
  exitCode = 0;
const option = args.indexOf("--port"),
  webPort = option >= 0 ? Number(args[option + 1]) : 5000;
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535)
  throw Error("Use --port with a number between 1 and 65535");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port") {
    i++;
    continue;
  }
  if (args[i] !== "--skip-setup") throw Error("Unknown option: " + args[i]);
}
const inCodespaces = process.env.CODESPACES === "true";
let browserOrigin = process.env.ORVYN_PREVIEW_ORIGIN;
if (!browserOrigin && inCodespaces) {
  const name = process.env.CODESPACE_NAME;
  const domain =
    process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || "app.github.dev";
  if (!name || !/^[a-z0-9-]+$/i.test(name) || !/^[a-z0-9.-]+$/i.test(domain))
    throw Error("Missing or invalid Codespaces forwarding configuration");
  browserOrigin = `https://${name}-${webPort}.${domain}`;
}
const origin = new URL(browserOrigin || "http://localhost:" + webPort);
if (
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash ||
  (origin.protocol !== "https:" &&
    !(
      origin.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
    ))
)
  throw Error(
    "Preview origin must be an HTTPS origin or a local HTTP origin without a path, credentials or query",
  );
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function start(command, argv, env = process.env) {
  const child = spawn(command, argv, { cwd, env, stdio: "inherit" });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
async function step(script) {
  const entry = process.env.npm_execpath;
  if (!entry) throw Error("Start with pnpm preview:local");
  console.log("Preparing: " + script);
  const child = start(process.execPath, [entry, "run", script]);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  if (stopping) throw Error("Startup stopped");
  if (code !== 0) throw Error("Preparation failed: " + script);
}
async function ready(url, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (stopping || child.exitCode !== null || child.signalCode)
      throw Error("Preview service exited during startup");
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error("Preview service did not become ready");
}
async function stop() {
  if (stopping) return;
  stopping = true;
  const active = [...children];
  for (const child of active) child.kill("SIGTERM");
  await Promise.all(
    active.map(async (child) => {
      if (child.exitCode !== null || child.signalCode) return;
      let timer;
      await Promise.race([
        once(child, "exit"),
        new Promise(
          (resolve) =>
            (timer = setTimeout(() => {
              child.kill("SIGKILL");
              resolve();
            }, 5000)),
        ),
      ]).finally(() => clearTimeout(timer));
    }),
  );
  process.exitCode = exitCode;
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
try {
  if (!args.includes("--skip-setup"))
    for (const script of [
      "setup:local",
      "infra:up",
      "build",
      "storage:init",
      "db:migrate",
    ])
      await step(script);
  if (stopping) throw Error("Startup stopped");
  const apiPort = await freePort(),
    collaborationPort = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: origin.protocol === "https:" ? "production" : "development",
    ORVYN_ORIGIN: origin.origin,
    NUXT_PUBLIC_COLLABORATION_URL: "",
    COLLABORATION_NAMESPACE: "orvyn:local-preview:" + randomUUID(),
  };
  const run = (path, extra = {}) =>
    start(process.execPath, ["--env-file=.env", path], { ...env, ...extra });
  const api = run("apps/api/dist/main.js", { PORT: String(apiPort) });
  await ready("http://127.0.0.1:" + apiPort + "/api/v1/health", api);
  const worker = run("apps/api/dist/worker.js");
  const collaboration = run("apps/collaboration/dist/main.js", {
    COLLABORATION_PORT: String(collaborationPort),
  });
  await ready(
    "http://127.0.0.1:" + collaborationPort + "/health",
    collaboration,
  );
  const web = run("apps/web/.output/server/index.mjs", {
    NITRO_PORT: String(webPort),
    NITRO_HOST: inCodespaces ? "0.0.0.0" : "127.0.0.1",
    NUXT_API_URL: "http://127.0.0.1:" + apiPort,
    NUXT_COLLABORATION_UPSTREAM: "ws://127.0.0.1:" + collaborationPort,
  });
  await ready("http://127.0.0.1:" + webPort + "/api/v1/health", web);
  if (
    [api, worker, collaboration, web].some(
      (child) => child.exitCode !== null || child.signalCode,
    )
  )
    throw Error("A preview service failed during startup");
  console.log(
    "\nORVYN_LOCAL_PREVIEW_READY " +
      origin.origin +
      (inCodespaces
        ? `\nOpen forwarded port ${webPort} from the Codespaces Ports tab. Keep its visibility private.\n`
        : "\nOpen this address on the same computer running this command. Press Ctrl+C to stop the application.\n"),
  );
  for (const child of [api, worker, collaboration, web])
    child.once("exit", (code) => {
      if (!stopping) {
        console.error("A preview service exited (" + code + ").");
        exitCode = 1;
        void stop();
      }
    });
} catch (error) {
  if (!stopping) {
    console.error(error.message);
    exitCode = 1;
  }
  await stop();
}

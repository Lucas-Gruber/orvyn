import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Pool } from "./helpers.mjs";
import { decrypt } from "../apps/api/dist/auth/security.js";

async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
export async function oidcTestApp() {
  const databaseUrl = new URL(process.env.DATABASE_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname));
  const root = new Pool({ connectionString: databaseUrl.toString() }),
    name = "orvyn_oidc_browser_" + randomBytes(8).toString("hex"),
    children = [];
  const directory = await mkdtemp(join(tmpdir(), "orvyn-oidc-browser-"));
  let created = false,
    db,
    output = "";
  const close = async () => {
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
      await exited;
      clearTimeout(timer);
    }
    await db?.end();
    if (created) await root.query("DROP DATABASE " + name + " WITH (FORCE)");
    await root.end();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await root.query("CREATE DATABASE " + name);
    created = true;
    databaseUrl.pathname = "/" + name;
    const apiPort = await port(),
      webPort = await port(),
      origin = "http://127.0.0.1:" + webPort;
    const common = {
      ...process.env,
      DATABASE_URL: databaseUrl.toString(),
      NODE_ENV: "test",
      ORVYN_ORIGIN: origin,
      ORVYN_LOG_LEVEL: "debug",
      ORVYN_REGISTRATION_ENABLED: "false",
      ORVYN_REGISTRATION_ALLOWED_EMAIL_DOMAINS: "",
      ORVYN_OIDC_BOOTSTRAP_MODE: "external",
      ORVYN_OIDC_ALLOW_HTTP_LOCAL: "true",
      ORVYN_STORAGE_DRIVER: "local",
      ORVYN_STORAGE_LOCAL_PATH: directory,
    };
    for (const key of Object.keys(common))
      if (/^(S3_|SMTP_|VALKEY_|REDIS_URL)/.test(key)) delete common[key];
    const start = async (path, env, health) => {
      const child = spawn(process.execPath, [path], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk) => {
          output += chunk;
        });
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        assert.equal(child.exitCode, null, output);
        try {
          const response = await fetch(health, {
            signal: AbortSignal.timeout(1000),
          });
          if (response.ok) return;
          await response.body?.cancel();
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      assert.fail("SSO test application did not become ready");
    };
    await start(
      "apps/api/dist/main.js",
      { ...common, PORT: String(apiPort) },
      `http://127.0.0.1:${apiPort}/api/v1/health`,
    );
    await start(
      "apps/web/.output/server/index.mjs",
      {
        ...common,
        NITRO_HOST: "127.0.0.1",
        NITRO_PORT: String(webPort),
        NUXT_API_URL: `http://127.0.0.1:${apiPort}`,
        NUXT_COLLABORATION_UPSTREAM: "ws://127.0.0.1:1",
      },
      origin + "/api/v1/health",
    );
    db = new Pool({ connectionString: databaseUrl.toString() });
    const owner = (
      await db.query(
        "INSERT INTO users(email,email_verified,is_admin,display_name) VALUES('owner@example.test',true,true,'Workspace owner') RETURNING id",
      )
    ).rows[0];
    const session = randomBytes(32).toString("hex"),
      cookie = "orvyn_session=" + session;
    await db.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [createHash("sha256").update(session).digest("hex"), owner.id],
    );
    const space = (
      await db.query(
        "INSERT INTO spaces(owner_id,name,kind) VALUES($1,'Product studio','team') RETURNING id",
        [owner.id],
      )
    ).rows[0];
    const call = async (
      path,
      { method = "GET", body, cookie, accept, requestOrigin = origin } = {},
    ) => {
      const response = await fetch(origin + "/api/v1/" + path, {
        method,
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          Origin: requestOrigin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(accept ? { Accept: accept } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { response, data };
    };
    const invite = async (email) => {
      const result = await call(`spaces/${space.id}/invitations`, {
        method: "POST",
        cookie,
        body: { email, role: "Editor" },
      });
      assert.equal(result.response.status, 201, JSON.stringify(result.data));
      const messages = (
        await db.query(
          "SELECT payload FROM mail_outbox ORDER BY created_at DESC",
        )
      ).rows.map((row) => JSON.parse(decrypt(row.payload)));
      const link = messages
          .find((message) => message.to === email)
          .text.match(/http[^\s]+/)[0],
        token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
      return { link, token, email };
    };
    return {
      db,
      origin,
      owner,
      cookie,
      space,
      call,
      invite,
      close,
      get output() {
        return output;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool } from "./helpers.mjs";
import { oidcProvider } from "./oidc-provider.mjs";
import {
  readDeploymentOidc,
  configureDeploymentOidc,
  deploymentOidcFingerprint,
  initializeDeploymentOidc,
} from "../apps/api/dist/auth/deployment-oidc.js";
import { configuration } from "../apps/api/dist/auth/oidc.js";
import { encrypt } from "../apps/api/dist/auth/security.js";
import { createServer as httpsServer } from "node:https";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("OIDC issuer configuration preserves exact root and path identities, including all trailing slashes", () => {
  const env = {
    NODE_ENV: "production",
    ORVYN_OIDC_ENABLED: "true",
    ORVYN_OIDC_CLIENT_ID: "orvyn",
    ORVYN_OIDC_CLIENT_SECRET: "fixture",
    ORVYN_OIDC_CLIENT_AUTH_METHOD: "client_secret_post",
  };
  const ids = new Set();
  for (const issuer of [
    "https://identity.example.test",
    "https://identity.example.test/",
    "https://identity.example.test/application/o/orvyn/",
    "https://identity.example.test/application/o/orvyn//",
    "https://identity.example.test/realms/company",
  ]) {
    const config = readDeploymentOidc({ ...env, ORVYN_OIDC_ISSUER: issuer });
    assert.equal(config.issuer, issuer);
    ids.add(config.id);
    assert.equal(
      deploymentOidcFingerprint(config),
      deploymentOidcFingerprint({
        ...config,
        id: randomUUID(),
        repairLegacyIssuer: true,
      }),
      "Derived IDs and the one-time repair operation are not desired configuration identity",
    );
  }
  assert.equal(ids.size, 5);
});

async function admin(db) {
  const result = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(result.response);
  const me = (await request("auth/me", { cookie })).data;
  await db.query("UPDATE users SET is_admin=true WHERE id=$1", [me.id]);
  return { ...me, cookie };
}
function settings(fixture, issuer = fixture.issuer) {
  return {
    name: "OIDC fixture",
    issuer,
    clientId: fixture.clientId,
    clientSecret: fixture.secret,
    clientAuthMethod: "client_secret_post",
    scopes: "openid email profile",
    enabled: true,
    autoProvision: true,
  };
}
async function login(provider) {
  const start = await request(`oidc/${provider.id}/start`, {
    method: "POST",
    body: {},
  });
  assert.equal(start.response.status, 201, JSON.stringify(start.data));
  const browser = start.response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const auth = await fetch(start.data.url, { redirect: "manual" }),
    callback = new URL(auth.headers.get("location"));
  return request(callback.pathname.replace("/api/v1/", "") + callback.search, {
    cookie: browser,
  });
}

test("Authentik slash and Keycloak realm issuers sign in strictly; safe legacy repairs preserve manual provider IDs and identities", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const fixtures = [];
  try {
    const actor = await admin(db);
    for (const path of ["/application/o/orvyn/", "/realms/company"]) {
      const f = await oidcProvider(path);
      fixtures.push(f);
      const created = await request("admin/oidc/providers", {
        method: "POST",
        cookie: actor.cookie,
        body: settings(f),
      });
      assert.equal(created.response.status, 201, JSON.stringify(created.data));
      assert.equal(created.data.issuer, f.issuer);
      const result = await login(created.data);
      assert.equal(result.response.status, 303, JSON.stringify(result.data));
      assert.equal(
        (await request("auth/me", { cookie: sessionCookie(result.response) }))
          .data.email,
        f.claims.email,
      );
    }
    const f = await oidcProvider("/legacy/empty/");
    fixtures.push(f);
    const oldIssuer = f.issuer.slice(0, -1);
    const provider = (
      await request("admin/oidc/providers", {
        method: "POST",
        cookie: actor.cookie,
        body: settings(f, oldIssuer),
      })
    ).data;
    await db.query(
      "UPDATE oidc_providers SET legacy_issuer_normalized=true WHERE id=$1",
      [provider.id],
    );
    const result = await login(provider);
    assert.equal(result.response.status, 303, JSON.stringify(result.data));
    assert.equal(
      (
        await db.query("SELECT issuer FROM oidc_providers WHERE id=$1", [
          provider.id,
        ])
      ).rows[0].issuer,
      f.issuer,
    );
    const user = (
      await request("auth/me", { cookie: sessionCookie(result.response) })
    ).data;
    assert.equal(
      (
        await db.query(
          "SELECT user_id FROM external_identities WHERE provider_id=$1",
          [provider.id],
        )
      ).rows[0].user_id,
      user.id,
    );
    // A fresh provider with a mismatching issuer cannot use the legacy exception.
    const fresh = await oidcProvider("/fresh/");
    fixtures.push(fresh);
    const bad = (
      await request("admin/oidc/providers", {
        method: "POST",
        cookie: actor.cookie,
        body: settings(fresh, fresh.issuer.slice(0, -1)),
      })
    ).data;
    assert.equal(
      (await request(`oidc/${bad.id}/start`, { method: "POST", body: {} }))
        .response.status,
      502,
    );
    assert.equal(
      (
        await db.query("SELECT issuer FROM oidc_providers WHERE id=$1", [
          bad.id,
        ])
      ).rows[0].issuer,
      fresh.issuer.slice(0, -1),
    );
  } finally {
    await db.end();
    for (const fixture of fixtures) await fixture.close();
  }
});

test("managed issuer repair requires linked-account approval, preserves the historical UUID and survives repeated/concurrent configuration", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    f = await oidcProvider("/managed/");
  const touched = [];
  try {
    const env = {
      NODE_ENV: "test",
      ORVYN_OIDC_ALLOW_HTTP_LOCAL: "true",
      ORVYN_OIDC_ENABLED: "true",
      ORVYN_OIDC_ISSUER: f.issuer,
      ORVYN_OIDC_CLIENT_ID: f.clientId,
      ORVYN_OIDC_CLIENT_SECRET: f.secret,
      ORVYN_OIDC_CLIENT_AUTH_METHOD: "client_secret_post",
      ORVYN_OIDC_AUTO_PROVISION: "true",
    };
    const config = readDeploymentOidc(env),
      legacy = readDeploymentOidc({
        ...env,
        ORVYN_OIDC_ISSUER: f.issuer.slice(0, -1),
      });
    touched.push(legacy.id);
    const actor = await admin(db),
      secret = encrypt(f.secret);
    await db.query(
      "INSERT INTO oidc_providers(id,name,issuer,client_id,encrypted_secret,scopes,enabled,auto_provision,managed_by,auth_method,legacy_issuer_normalized) VALUES($1,$2,$3,$4,$5,$6,true,true,'deployment','client_secret_post',true)",
      [
        legacy.id,
        config.name,
        legacy.issuer,
        f.clientId,
        secret,
        config.scopes,
      ],
    );
    await db.query("INSERT INTO external_identities VALUES($1,$2,$3)", [
      legacy.id,
      f.claims.sub,
      actor.id,
    ]);
    await db.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at,provider_id) VALUES($1,$2,now()+interval '1 day',$3)",
      [randomUUID(), actor.id, legacy.id],
    );
    await assert.rejects(
      configureDeploymentOidc(db, config),
      (error) => error.diagnosticCode === "OIDC_REPAIR_APPROVAL_REQUIRED",
    );
    assert.equal(
      (
        await db.query("SELECT issuer FROM oidc_providers WHERE id=$1", [
          legacy.id,
        ])
      ).rows[0].issuer,
      legacy.issuer,
    );
    const reviewed = { ...config, repairLegacyIssuer: true };
    await Promise.all([
      configureDeploymentOidc(db, reviewed),
      configureDeploymentOidc(db, reviewed),
    ]);
    const before = (
      await db.query("SELECT * FROM oidc_providers WHERE id=$1", [legacy.id])
    ).rows[0];
    assert.equal(before.issuer, f.issuer);
    assert.equal(before.encrypted_secret, secret);
    assert.equal(before.legacy_issuer_normalized, false);
    assert.equal(
      (await db.query("SELECT id FROM oidc_providers WHERE id=$1", [config.id]))
        .rowCount,
      0,
    );
    assert.equal(
      (
        await db.query(
          "SELECT user_id FROM external_identities WHERE provider_id=$1",
          [legacy.id],
        )
      ).rows[0].user_id,
      actor.id,
    );
    assert.equal(
      (
        await db.query("SELECT 1 FROM sessions WHERE provider_id=$1", [
          legacy.id,
        ])
      ).rowCount,
      0,
    );
    await configureDeploymentOidc(db, config);
    const after = (
      await db.query("SELECT * FROM oidc_providers WHERE id=$1", [legacy.id])
    ).rows[0];
    assert.equal(after.config_version, before.config_version);
    assert.equal(after.encrypted_secret, secret);
    assert.equal(
      (
        await db.query(
          "SELECT 1 FROM oidc_issuer_repairs WHERE provider_id=$1",
          [legacy.id],
        )
      ).rowCount,
      1,
    );
    await initializeDeploymentOidc(db, {
      ...env,
      ORVYN_OIDC_BOOTSTRAP_MODE: "wait",
    });
    await assert.rejects(
      configureDeploymentOidc(db, {
        ...config,
        clientId: "different-client",
        id: randomUUID(),
      }),
    );
    assert.equal(
      (
        await db.query("SELECT enabled FROM oidc_providers WHERE id=$1", [
          legacy.id,
        ])
      ).rows[0].enabled,
      true,
    );
    // A real issuer change never reuses the repaired identity or its subject.
    const changed = readDeploymentOidc({
      ...env,
      ORVYN_OIDC_ISSUER: f.issuer + "different",
    });
    touched.push(changed.id);
    await configureDeploymentOidc(db, changed);
    assert.notEqual(changed.id, legacy.id);
    assert.equal(
      (
        await db.query(
          "SELECT 1 FROM external_identities WHERE provider_id=$1",
          [changed.id],
        )
      ).rowCount,
      0,
    );
  } finally {
    for (const table of ["sessions", "oidc_flows", "external_identities"])
      await db.query(`DELETE FROM ${table} WHERE provider_id=ANY($1::uuid[])`, [
        touched,
      ]);
    await db.query("DELETE FROM oidc_providers WHERE id=ANY($1::uuid[])", [
      touched,
    ]);
    await db.end();
    await f.close();
  }
});

test("OIDC diagnostics classify issuer, metadata, client authentication and decryption failures without accepting normalized identities", async () => {
  const f = await oidcProvider("/");
  const provider = {
    issuer: f.issuer,
    client_id: f.clientId,
    encrypted_secret: encrypt(f.secret),
    auth_method: "client_secret_post",
  };
  try {
    await configuration(provider);
    await assert.rejects(
      configuration({ ...provider, issuer: f.issuer.slice(0, -1) }),
      (error) => error.diagnosticCode === "OIDC_ISSUER_MISMATCH",
    );
    await assert.rejects(
      configuration({
        ...provider,
        encrypted_secret: "invalid-encrypted-secret",
      }),
      (error) => error.diagnosticCode === "OIDC_SECRET_DECRYPTION_FAILED",
    );
    f.metadata.token_endpoint_auth_methods_supported = ["none"];
    await assert.rejects(
      configuration(provider),
      (error) => error.diagnosticCode === "OIDC_CLIENT_AUTH_UNSUPPORTED",
    );
    f.metadata.token_endpoint_auth_methods_supported = ["client_secret_post"];
    delete f.metadata.jwks_uri;
    await assert.rejects(
      configuration(provider),
      (error) => error.diagnosticCode === "OIDC_METADATA_INVALID",
    );
  } finally {
    await f.close();
  }
});

test("linked manual providers require explicit verified repair and refuse issuer collisions or real identity changes", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    f = await oidcProvider("/manual-linked/");
  try {
    const actor = await admin(db),
      old = settings(f, f.issuer.slice(0, -1));
    const provider = (
      await request("admin/oidc/providers", {
        method: "POST",
        cookie: actor.cookie,
        body: old,
      })
    ).data;
    await db.query(
      "UPDATE oidc_providers SET legacy_issuer_normalized=true WHERE id=$1",
      [provider.id],
    );
    await db.query("INSERT INTO external_identities VALUES($1,$2,$3)", [
      provider.id,
      f.claims.sub,
      actor.id,
    ]);
    assert.equal(
      (await request(`oidc/${provider.id}/start`, { method: "POST", body: {} }))
        .response.status,
      502,
    );
    const update = (extra) =>
      request(`admin/oidc/providers/${provider.id}`, {
        method: "PUT",
        cookie: actor.cookie,
        body: { ...old, clientSecret: undefined, issuer: f.issuer, ...extra },
      });
    assert.equal((await update({})).response.status, 409);
    const collision = (
      await request("admin/oidc/providers", {
        method: "POST",
        cookie: actor.cookie,
        body: settings(f),
      })
    ).data;
    assert.equal(
      (await update({ repairLegacyIssuer: true })).response.status,
      409,
    );
    assert.equal(
      (
        await db.query("SELECT issuer FROM oidc_providers WHERE id=$1", [
          provider.id,
        ])
      ).rows[0].issuer,
      old.issuer,
    );
    await db.query("DELETE FROM oidc_providers WHERE id=$1", [collision.id]);
    const repaired = await update({
      repairLegacyIssuer: true,
      autoProvision: false,
    });
    assert.equal(repaired.response.status, 200, JSON.stringify(repaired.data));
    assert.equal(repaired.data.id, provider.id);
    assert.equal(repaired.data.issuer, f.issuer);
    const result = await login(provider);
    assert.equal(result.response.status, 303, JSON.stringify(result.data));
    assert.equal(
      (await request("auth/me", { cookie: sessionCookie(result.response) }))
        .data.id,
      actor.id,
      "Existing identity signs in without provisioning or email linking",
    );
    assert.equal(
      (
        await update({
          issuer: f.issuer + "different",
          repairLegacyIssuer: true,
        })
      ).response.status,
      409,
    );
    assert.equal(
      (
        await db.query(
          "SELECT user_id FROM external_identities WHERE provider_id=$1",
          [provider.id],
        )
      ).rows[0].user_id,
      actor.id,
    );
  } finally {
    await db.end();
    await f.close();
  }
});

test("OIDC discovery enforces its network deadline and reports a sanitized timeout", async () => {
  const f = await oidcProvider("/slow/");
  try {
    f.discoveryDelayMs = 11000;
    await assert.rejects(
      configuration({
        issuer: f.issuer,
        client_id: f.clientId,
        auth_method: "none",
      }),
      (error) => error.diagnosticCode === "ETIMEDOUT",
    );
  } finally {
    await f.close();
  }
});

test("OIDC rejects an untrusted TLS certificate and diagnostic output never contains provider secrets or metadata bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orvyn-oidc-tls-"));
  const original = console.error,
    logs = [];
  let server;
  try {
    console.error = (line) => logs.push(String(line));
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ]);
    server = httpsServer(
      {
        key: await readFile(join(directory, "key.pem")),
        cert: await readFile(join(directory, "cert.pem")),
      },
      (_req, res) => res.end("{}"),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await assert.rejects(
      configuration({
        issuer: `https://127.0.0.1:${server.address().port}/`,
        client_id: "fixture",
        auth_method: "none",
      }),
      (error) => error.diagnosticCode === "DEPTH_ZERO_SELF_SIGNED_CERT",
    );
    const f = await oidcProvider("/diagnostics/");
    try {
      f.metadata.private_canary = f.secret;
      f.metadata.issuer = f.issuer + "mismatch";
      await assert.rejects(
        configuration({
          issuer: f.issuer,
          client_id: f.clientId,
          encrypted_secret: encrypt(f.secret),
          auth_method: "client_secret_post",
        }),
      );
      assert.ok(!logs.join("\n").includes(f.secret));
      assert.ok(!logs.join("\n").includes("private_canary"));
      assert.ok(
        logs
          .map((line) => JSON.parse(line))
          .some((line) => line.code === "OIDC_ISSUER_MISMATCH"),
      );
    } finally {
      await f.close();
    }
  } finally {
    console.error = original;
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

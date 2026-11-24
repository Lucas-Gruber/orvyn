import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import {
  readDeploymentOidc,
  configureDeploymentOidc,
  deploymentOidcFingerprint,
  initializeDeploymentOidc,
} from "../apps/api/dist/auth/deployment-oidc.js";
import { decrypt } from "../apps/api/dist/auth/security.js";

test("declarative OIDC validates HTTPS, authentication methods, scopes and exact bootstrap subjects", () => {
  const env = {
    NODE_ENV: "production",
    ORVYN_OIDC_ENABLED: "true",
    ORVYN_OIDC_ISSUER: "https://identity.example.test/realm",
    ORVYN_OIDC_CLIENT_ID: "orvyn",
    ORVYN_OIDC_CLIENT_SECRET: " secret-with-significant-spaces ",
    ORVYN_OIDC_CLIENT_AUTH_METHOD: "client_secret_basic",
    ORVYN_OIDC_ADMIN_SUBJECT: "exact-subject",
  };
  const config = readDeploymentOidc(env);
  assert.equal(config.clientSecret, env.ORVYN_OIDC_CLIENT_SECRET);
  assert.equal(config.adminSubject, "exact-subject");
  assert.equal(config.clientAuthMethod, "client_secret_basic");
  assert.equal(readDeploymentOidc({ ...env }).id, config.id);
  assert.notEqual(
    readDeploymentOidc({ ...env, ORVYN_OIDC_CLIENT_ID: "another-client" }).id,
    config.id,
  );
  assert.equal(
    readDeploymentOidc({
      ...env,
      ORVYN_OIDC_CLIENT_SECRET: undefined,
      ORVYN_OIDC_CLIENT_AUTH_METHOD: "none",
    }).clientAuthMethod,
    "none",
  );
  for (const changes of [
    { ORVYN_OIDC_ENABLED: "yes" },
    { ORVYN_OIDC_ISSUER: "http://127.0.0.1:1234" },
    { ORVYN_OIDC_ISSUER: "https://user:secret@identity.example.test" },
    { ORVYN_OIDC_SCOPES: "email profile" },
    { ORVYN_OIDC_SCOPES: "openid bad!scope" },
    { ORVYN_OIDC_CLIENT_SECRET: undefined },
    { ORVYN_OIDC_CLIENT_AUTH_METHOD: "none" },
    { ORVYN_OIDC_AUTO_PROVISION: "yes" },
  ])
    assert.throws(() => readDeploymentOidc({ ...env, ...changes }));
  assert.deepEqual(readDeploymentOidc({ ORVYN_OIDC_ENABLED: "false" }), {
    enabled: false,
  });
  assert.notEqual(
    deploymentOidcFingerprint(config),
    deploymentOidcFingerprint({ ...config, clientSecret: "rotated-secret" }),
  );
});

test("externally configured API replicas never rewrite deployment settings during startup", async () => {
  await initializeDeploymentOidc(
    {
      query() {
        throw Error("Unexpected configuration access");
      },
    },
    {
      ORVYN_OIDC_BOOTSTRAP_MODE: "external",
      ORVYN_OIDC_ENABLED: "invalid-on-purpose",
    },
  );
});
test("deployment OIDC is idempotent across replicas, encrypted, read-only in the UI API and revokes only its own privileges and sessions", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    secret = randomUUID(),
    issuer = `https://identity-${randomUUID()}.example.test`,
    subject = randomUUID();
  const config = readDeploymentOidc({
    ORVYN_OIDC_ENABLED: "true",
    ORVYN_OIDC_ISSUER: issuer,
    ORVYN_OIDC_CLIENT_ID: "orvyn",
    ORVYN_OIDC_CLIENT_SECRET: secret,
    ORVYN_OIDC_CLIENT_AUTH_METHOD: "client_secret_basic",
    ORVYN_OIDC_AUTO_PROVISION: "true",
    ORVYN_OIDC_ADMIN_SUBJECT: subject,
  });
  let uid, manual;
  try {
    await Promise.all([
      configureDeploymentOidc(db, config),
      configureDeploymentOidc(db, config),
    ]);
    const initial = (
      await db.query("SELECT * FROM oidc_providers WHERE id=$1", [config.id])
    ).rows[0];
    assert.equal(initial.config_version, 1);
    assert.notEqual(initial.encrypted_secret, secret);
    assert.equal(decrypt(initial.encrypted_secret), secret);
    assert.equal(initial.managed_by, "deployment");
    await configureDeploymentOidc(db, config);
    assert.equal(
      (
        await db.query(
          "SELECT encrypted_secret FROM oidc_providers WHERE id=$1",
          [config.id],
        )
      ).rows[0].encrypted_secret,
      initial.encrypted_secret,
    );
    const registered = await request("auth/register", {
        method: "POST",
        body: { email: randomUUID() + "@example.test", password: randomUUID() },
      }),
      cookie = sessionCookie(registered.response);
    uid = (
      await db.query("SELECT id FROM users WHERE email=$1", [
        registered.data.email,
      ])
    ).rows[0].id;
    assert.equal((await request("auth/me", { cookie })).data.isAdmin, false);
    await db.query(
      "INSERT INTO external_identities(provider_id,subject,user_id) VALUES($1,$2,$3)",
      [config.id, subject, uid],
    );
    assert.equal((await request("auth/me", { cookie })).data.isAdmin, true);
    assert.equal(
      (await db.query("SELECT is_admin FROM users WHERE id=$1", [uid])).rows[0]
        .is_admin,
      false,
    );
    const providers = await request("admin/oidc/providers", { cookie }),
      provider = providers.data.find((p) => p.id === config.id);
    assert.equal(provider.managed, true);
    assert.equal(provider.clientAuthMethod, "client_secret_basic");
    assert.equal(
      provider.redirectUri,
      base + "/api/v1/oidc/deployment/callback",
    );
    assert.ok(!JSON.stringify(providers.data).includes(secret));
    const edit = await request("admin/oidc/providers/" + config.id, {
      method: "PUT",
      cookie,
      body: { ...provider, name: "Changed" },
    });
    assert.equal(edit.response.status, 409);
    manual = (
      await db.query(
        "INSERT INTO oidc_providers(name,issuer,client_id,enabled) VALUES('Manual',$1,'client',true) RETURNING id",
        [issuer + "/manual"],
      )
    ).rows[0].id;
    await assert.rejects(
      configureDeploymentOidc(db, {
        ...config,
        id: randomUUID(),
        issuer: issuer + "/manual",
      }),
      /different provider identity/,
    );
    assert.equal(
      (
        await db.query("SELECT enabled FROM oidc_providers WHERE id=$1", [
          config.id,
        ])
      ).rows[0].enabled,
      true,
    );
    await db.query(
      "INSERT INTO oidc_flows(state_hash,provider_id,browser_hash,encrypted_verifier,nonce,expires_at) VALUES($1,$2,'browser','encrypted','nonce',now()+interval '1 minute')",
      [randomUUID(), config.id],
    );
    await configureDeploymentOidc(db, {
      ...config,
      clientSecret: "rotated-" + secret,
    });
    assert.equal(
      (
        await db.query("SELECT count(*) FROM oidc_flows WHERE provider_id=$1", [
          config.id,
        ])
      ).rows[0].count,
      "0",
    );
    assert.equal(
      (
        await db.query(
          "SELECT config_version FROM oidc_providers WHERE id=$1",
          [config.id],
        )
      ).rows[0].config_version,
      2,
    );
    await configureDeploymentOidc(db, { ...config, adminSubject: null });
    assert.equal((await request("auth/me", { cookie })).data.isAdmin, false);
    await db.query("UPDATE users SET is_admin=true WHERE id=$1", [uid]);
    const token = randomBytes(32).toString("hex"),
      digest = createHash("sha256").update(token).digest("hex");
    await db.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at,provider_id) VALUES($1,$2,now()+interval '1 day',$3)",
      [digest, uid, config.id],
    );
    await configureDeploymentOidc(db, { enabled: false });
    assert.equal(
      (
        await db.query("SELECT count(*) FROM sessions WHERE token_hash=$1", [
          digest,
        ])
      ).rows[0].count,
      "0",
    );
    assert.equal((await request("auth/me", { cookie })).data.isAdmin, true);
    const available = (await request("oidc/providers")).data;
    assert.ok(!available.some((p) => p.id === config.id));
    assert.ok(available.some((p) => p.id === manual));
  } finally {
    await configureDeploymentOidc(db, { enabled: false });
    if (uid) await db.query("DELETE FROM users WHERE id=$1", [uid]);
    await db.query("DELETE FROM oidc_providers WHERE id=$1", [config.id]);
    if (manual)
      await db.query("DELETE FROM oidc_providers WHERE id=$1", [manual]);
    await db.end();
  }
});

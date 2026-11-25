import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { generateKeyPairSync, randomUUID, createHash, sign } from "node:crypto";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
test("OIDC verifies signed tokens, PKCE, browser binding, replay and provider revocation", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }),
    jwk = {
      ...publicKey.export({ format: "jwk" }),
      kid: "fixture",
      alg: "RS256",
      use: "sig",
    };
  const codes = new Map();
  const clientId = "orvyn-fixture",
    secret = randomUUID();
  let issuer,
    claims = {
      sub: randomUUID(),
      email: randomUUID() + "@example.test",
      email_verified: true,
      name: "Alex Morgan",
      preferred_username: "alex.m",
    },
    badSignature = false,
    exchanges = 0;
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, issuer);
    res.setHeader("Content-Type", "application/json");
    if (u.pathname === "/.well-known/openid-configuration")
      return res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          jwks_uri: issuer + "/jwks",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
    if (u.pathname === "/jwks") return res.end(JSON.stringify({ keys: [jwk] }));
    if (u.pathname === "/authorize") {
      assert.equal(u.searchParams.get("code_challenge_method"), "S256");
      assert.ok(u.searchParams.get("nonce"));
      assert.equal(u.searchParams.get("client_id"), clientId);
      const code = randomUUID();
      codes.set(code, {
        nonce: u.searchParams.get("nonce"),
        challenge: u.searchParams.get("code_challenge"),
        redirect: u.searchParams.get("redirect_uri"),
        claims: { ...claims },
        badSignature,
      });
      const redirect = new URL(u.searchParams.get("redirect_uri"));
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", u.searchParams.get("state"));
      res.writeHead(302, { Location: redirect.toString() });
      return res.end();
    }
    if (u.pathname === "/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body),
        code = codes.get(params.get("code"));
      codes.delete(params.get("code"));
      assert.ok(code);
      assert.equal(params.get("client_secret"), secret);
      assert.equal(params.get("redirect_uri"), code.redirect);
      assert.equal(
        createHash("sha256")
          .update(params.get("code_verifier"))
          .digest("base64url"),
        code.challenge,
      );
      exchanges++;
      const now = Math.floor(Date.now() / 1000),
        unsigned =
          b64({ alg: "RS256", kid: "fixture" }) +
          "." +
          b64({
            iss: issuer,
            aud: clientId,
            iat: now,
            exp: now + 300,
            nonce: code.nonce,
            ...code.claims,
          });
      let signature = sign("RSA-SHA256", Buffer.from(unsigned), privateKey);
      if (code.badSignature) signature[0] ^= 1;
      return res.end(
        JSON.stringify({
          token_type: "Bearer",
          access_token: randomUUID(),
          expires_in: 300,
          id_token: unsigned + "." + signature.toString("base64url"),
        }),
      );
    }
    res.writeHead(404);
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  issuer = "http://127.0.0.1:" + server.address().port;
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let provider;
  try {
    const registered = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    });
    const adminCookie = sessionCookie(registered.response);
    assert.ok(adminCookie);
    assert.equal(
      (await request("admin/oidc/providers", { cookie: adminCookie })).response
        .status,
      403,
    );
    await db.query(
      "UPDATE users SET is_admin=true,email_verified=true WHERE email=$1",
      [registered.data.email],
    );
    const body = {
      name: "Integration provider",
      issuer,
      clientId,
      clientSecret: secret,
      scopes: "openid email profile",
      enabled: true,
      autoProvision: true,
    };
    const created = await request("admin/oidc/providers", {
      method: "POST",
      cookie: adminCookie,
      body,
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    provider = created.data;
    assert.equal(provider.hasClientSecret, true);
    assert.equal(JSON.stringify(provider).includes(secret), false);
    const stored = (
      await db.query(
        "SELECT encrypted_secret FROM oidc_providers WHERE id=$1",
        [provider.id],
      )
    ).rows[0].encrypted_secret;
    assert.notEqual(stored, secret);
    assert.equal(stored.includes(secret), false);
    const start = async () => {
      const r = await request("oidc/" + provider.id + "/start", {
        method: "POST",
        body: {},
      });
      assert.equal(r.response.status, 201, JSON.stringify(r.data));
      const browser = r.response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      const auth = await fetch(r.data.url, { redirect: "manual" });
      const callback = new URL(auth.headers.get("location"));
      return { browser, callback };
    };
    const complete = async (flow) =>
      request(
        flow.callback.pathname.replace("/api/v1/", "") + flow.callback.search,
        { cookie: flow.browser },
      );
    const flow = await start();
    const missing = await request(
      flow.callback.pathname.replace("/api/v1/", "") + flow.callback.search,
    );
    assert.equal(missing.response.status, 400);
    const login = await complete(flow);
    assert.equal(login.response.status, 303, JSON.stringify(login.data));
    const session = sessionCookie(login.response);
    assert.ok(session);
    assert.equal(
      (await request("auth/me", { cookie: session })).data.email,
      claims.email,
    );
    let profile = (await request("auth/me", { cookie: session })).data;
    assert.equal(profile.displayName, "Alex Morgan");
    assert.equal(profile.displayNameSource, "provider");
    const originalId = profile.id;
    delete claims.name;
    const usernameLogin = await complete(await start());
    profile = (
      await request("auth/me", {
        cookie: sessionCookie(usernameLogin.response),
      })
    ).data;
    assert.equal(profile.id, originalId);
    assert.equal(profile.displayName, "alex.m");
    assert.equal(
      (
        await request("auth/profile", {
          method: "PATCH",
          cookie: session,
          body: { displayName: "Alex · Product" },
        })
      ).response.status,
      200,
    );
    claims.name = "Provider renamed Alex";
    const afterCustom = await complete(await start());
    profile = (
      await request("auth/me", { cookie: sessionCookie(afterCustom.response) })
    ).data;
    assert.equal(profile.displayName, "Alex · Product");
    assert.equal(profile.displayNameSource, "user");
    assert.equal((await complete(flow)).response.status, 400);
    const repeat = await complete(await start());
    assert.equal(repeat.response.status, 303);
    assert.equal(
      (await request("auth/me", { cookie: sessionCookie(repeat.response) }))
        .data.email,
      claims.email,
    );
    badSignature = true;
    assert.equal((await complete(await start())).response.status, 401);
    badSignature = false;
    const oldClaims = claims;
    claims = { ...claims, sub: randomUUID() };
    assert.equal((await complete(await start())).response.status, 409);
    claims = oldClaims;
    claims = {
      ...claims,
      sub: randomUUID(),
      email: randomUUID() + "@example.test",
      email_verified: false,
    };
    assert.equal((await complete(await start())).response.status, 403);
    claims = oldClaims;
    const pending = await start();
    const disabled = await request("admin/oidc/providers/" + provider.id, {
      method: "PUT",
      cookie: adminCookie,
      body: { ...body, enabled: false, clientSecret: undefined },
    });
    assert.equal(disabled.response.status, 200);
    assert.equal(
      (await request("auth/me", { cookie: session })).response.status,
      401,
    );
    assert.equal((await complete(pending)).response.status, 400);
    assert.equal(
      (
        await request("oidc/" + provider.id + "/start", {
          method: "POST",
          body: {},
        })
      ).response.status,
      404,
    );
    assert.ok(exchanges >= 5);
  } finally {
    if (provider) {
      await db.query("DELETE FROM sessions WHERE provider_id=$1", [
        provider.id,
      ]);
      await db.query("DELETE FROM external_identities WHERE provider_id=$1", [
        provider.id,
      ]);
      await db.query("DELETE FROM oidc_providers WHERE id=$1", [provider.id]);
    }
    await db.end();
    await new Promise((resolve) => server.close(resolve));
  }
});

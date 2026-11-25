import { createServer } from "node:http";
import { once } from "node:events";
import { generateKeyPairSync, randomUUID, createHash, sign } from "node:crypto";
import assert from "node:assert/strict";

// A real code/PKCE/JWKS fixture shared by issuer repair and invitation tests.
export async function oidcProvider(path = "/application/o/orvyn/") {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "integration",
    alg: "RS256",
    use: "sig",
  };
  const fixture = {
    clientId: "orvyn",
    secret: randomUUID(),
    claims: {
      sub: randomUUID(),
      email: randomUUID() + "@example.test",
      email_verified: true,
      name: "Jordan Lee",
    },
    requests: 0,
  };
  const codes = new Map();
  let issuer;
  const server = createServer(async (req, res) => {
    fixture.requests++;
    const url = new URL(req.url, issuer);
    res.setHeader("Content-Type", "application/json");
    if (
      url.pathname ===
      new URL(issuer).pathname.replace(/\/$/, "") +
        "/.well-known/openid-configuration"
    ) {
      if (fixture.discoveryDelayMs) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, fixture.discoveryDelayMs);
          res.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (res.destroyed) return;
      }
      return res.end(JSON.stringify(fixture.metadata));
    }
    if (url.pathname === "/jwks")
      return res.end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname === "/authorize") {
      const code = randomUUID();
      codes.set(code, {
        nonce: url.searchParams.get("nonce"),
        challenge: url.searchParams.get("code_challenge"),
        redirect: url.searchParams.get("redirect_uri"),
        claims: { ...fixture.claims },
      });
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.get("client_id"), fixture.clientId);
      const target = new URL(url.searchParams.get("redirect_uri"));
      target.searchParams.set("code", code);
      target.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { Location: target.toString() });
      return res.end();
    }
    if (url.pathname === "/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body),
        code = codes.get(params.get("code"));
      codes.delete(params.get("code"));
      assert.ok(code);
      assert.equal(params.get("redirect_uri"), code.redirect);
      assert.equal(params.get("client_secret"), fixture.secret);
      assert.equal(
        createHash("sha256")
          .update(params.get("code_verifier"))
          .digest("base64url"),
        code.challenge,
      );
      const b64 = (value) =>
          Buffer.from(JSON.stringify(value)).toString("base64url"),
        now = Math.floor(Date.now() / 1000);
      const unsigned =
        b64({ alg: "RS256", kid: jwk.kid }) +
        "." +
        b64({
          iss: issuer,
          aud: fixture.clientId,
          iat: now,
          exp: now + 300,
          nonce: code.nonce,
          ...code.claims,
        });
      return res.end(
        JSON.stringify({
          token_type: "Bearer",
          access_token: randomUUID(),
          expires_in: 300,
          id_token:
            unsigned +
            "." +
            sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString(
              "base64url",
            ),
        }),
      );
    }
    res.writeHead(404);
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  issuer = origin + path;
  Object.assign(fixture, {
    issuer,
    metadata: {
      issuer,
      authorization_endpoint: origin + "/authorize",
      token_endpoint: origin + "/token",
      jwks_uri: origin + "/jwks",
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  });
  return fixture;
}

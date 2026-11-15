import {
  Module,
  Controller,
  Get,
  Post,
  Put,
  Req,
  Res,
  Body,
  Param,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import * as client from "openid-client";
import { db, user, fail, text, hash, mutation } from "./runtime.js";
import {
  encrypt,
  decrypt,
  origin,
  cookie,
  issueSession,
  transaction,
  audit,
  rateLimit,
} from "./auth/security.js";
import { configuration, redirectUri, validateIssuer } from "./auth/oidc.js";
const safeFields =
  'id,name,issuer,client_id AS "clientId",scopes,enabled,auto_provision AS "autoProvision",encrypted_secret IS NOT NULL AS "hasClientSecret"';
async function admin(req: any) {
  const uid = await user(req);
  const r = await db.query("SELECT is_admin FROM users WHERE id=$1", [uid]);
  if (!r.rows[0]?.is_admin) fail(403, "Administrator required");
  return uid;
}
function providerInput(body: any) {
  const issuer = validateIssuer(text(body?.issuer, 2000))
    .toString()
    .replace(/\/$/, "");
  const name = text(body?.name, 120),
    clientId = text(body?.clientId, 300);
  const scopes = text(body?.scopes || "openid email profile", 500).split(/\s+/);
  if (
    !scopes.includes("openid") ||
    scopes.some((s: string) => !/^[a-zA-Z0-9:._/-]+$/.test(s))
  )
    fail(400, "Invalid OIDC scopes");
  if (
    typeof body?.enabled !== "boolean" ||
    typeof body?.autoProvision !== "boolean"
  )
    fail(400, "Boolean settings required");
  let secret: string | undefined | null;
  if (body.clientSecret === null) secret = null;
  else if (body.clientSecret !== undefined)
    secret = encrypt(text(body.clientSecret, 4000));
  return {
    name,
    issuer,
    clientId,
    scopes: scopes.join(" "),
    enabled: body.enabled,
    autoProvision: body.autoProvision,
    secret,
  };
}
@Controller("api/v1")
class OidcController {
  @Get("oidc/providers") async available() {
    return (
      await db.query(
        "SELECT id,name FROM oidc_providers WHERE enabled=true ORDER BY name",
      )
    ).rows;
  }
  @Get("admin/oidc/providers") async list(@Req() req: any) {
    await admin(req);
    return (
      await db.query(`SELECT ${safeFields} FROM oidc_providers ORDER BY name`)
    ).rows.map((p) => ({ ...p, redirectUri: redirectUri(p.id) }));
  }
  @Post("admin/oidc/providers") async create(
    @Req() req: any,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await admin(req),
      p = providerInput(body);
    return transaction(async (c) => {
      const r = await c.query(
        `INSERT INTO oidc_providers(name,issuer,client_id,encrypted_secret,scopes,enabled,auto_provision) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(issuer) DO NOTHING RETURNING ${safeFields}`,
        [
          p.name,
          p.issuer,
          p.clientId,
          p.secret || null,
          p.scopes,
          p.enabled,
          p.autoProvision,
        ],
      );
      if (!r.rowCount) fail(409, "Issuer is already configured");
      await audit(c, uid, "oidc.provider_created");
      return { ...r.rows[0], redirectUri: redirectUri(r.rows[0].id) };
    });
  }
  @Put("admin/oidc/providers/:id") async update(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await admin(req),
      p = providerInput(body);
    return transaction(async (c) => {
      const existing = await c.query(
        "SELECT issuer,client_id,enabled FROM oidc_providers WHERE id::text=$1 FOR UPDATE",
        [id],
      );
      if (!existing.rowCount) fail(404, "Provider not found");
      if (
        existing.rows[0].issuer !== p.issuer ||
        existing.rows[0].client_id !== p.clientId
      )
        fail(
          400,
          "Issuer and client identity are immutable; create a new provider",
        );
      const r = await c.query(
        `UPDATE oidc_providers SET config_version=config_version+1,name=$1,encrypted_secret=CASE WHEN $2 THEN $3 ELSE encrypted_secret END,scopes=$4,enabled=$5,auto_provision=$6 WHERE id::text=$7 RETURNING ${safeFields}`,
        [
          p.name,
          p.secret !== undefined,
          p.secret ?? null,
          p.scopes,
          p.enabled,
          p.autoProvision,
          id,
        ],
      );
      // Config changes invalidate in-flight logins; disabling also revokes all provider sessions.
      await c.query("DELETE FROM oidc_flows WHERE provider_id::text=$1", [id]);
      if (!p.enabled)
        await c.query("DELETE FROM sessions WHERE provider_id::text=$1", [id]);
      await audit(c, uid, "oidc.provider_updated");
      return { ...r.rows[0], redirectUri: redirectUri(id) };
    });
  }
  @Post("oidc/:id/start") async start(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
    @Param("id") id: string,
  ) {
    mutation(req);
    await rateLimit("oidc:" + req.ip);
    const r = await db.query(
      "SELECT * FROM oidc_providers WHERE id::text=$1 AND enabled=true",
      [id],
    );
    if (!r.rowCount) fail(404, "Provider not found");
    let config;
    try {
      config = await configuration(r.rows[0]);
    } catch {
      return fail(502, "Identity provider discovery failed");
    }
    const state = client.randomState(),
      nonce = client.randomNonce(),
      verifier = client.randomPKCECodeVerifier(),
      browser = randomBytes(32).toString("hex");
    await db.query(
      "INSERT INTO oidc_flows(state_hash,provider_id,browser_hash,encrypted_verifier,nonce,expires_at,provider_version) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes',$6)",
      [
        hash(state),
        id,
        hash(browser),
        encrypt(verifier),
        nonce,
        r.rows[0].config_version,
      ],
    );
    res.setHeader(
      "Set-Cookie",
      cookie("orvyn_oidc_" + state.slice(0, 16), browser, 600, "Lax"),
    );
    return {
      url: client
        .buildAuthorizationUrl(config, {
          redirect_uri: redirectUri(id),
          scope: r.rows[0].scopes,
          state,
          nonce,
          code_challenge: await client.calculatePKCECodeChallenge(verifier),
          code_challenge_method: "S256",
        })
        .toString(),
    };
  }
  @Get("oidc/:id/callback") async callback(
    @Req() req: any,
    @Res() res: any,
    @Param("id") id: string,
  ) {
    const callback = new URL(req.originalUrl, origin()),
      state = callback.searchParams.get("state");
    if (!state || !/^[a-zA-Z0-9_-]{20,128}$/.test(state))
      return fail(400, "Invalid login state");
    const cookieName = "orvyn_oidc_" + state.slice(0, 16);
    const browser = (req.headers.cookie || "")
      .split(";")
      .map((s: string) => s.trim())
      .find((s: string) => s.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    if (!browser) return fail(400, "Missing login browser binding");
    const flow = await db.query(
      "DELETE FROM oidc_flows WHERE state_hash=$1 AND provider_id::text=$2 AND browser_hash=$3 AND expires_at>now() RETURNING *",
      [hash(state), id, hash(browser)],
    );
    if (!flow.rowCount) return fail(400, "Invalid or expired login");
    const r = await db.query(
      "SELECT * FROM oidc_providers WHERE id::text=$1 AND enabled=true",
      [id],
    );
    if (
      !r.rowCount ||
      r.rows[0].config_version !== flow.rows[0].provider_version
    )
      return fail(400, "Provider configuration changed");
    let claims: ReturnType<
      Awaited<ReturnType<typeof client.authorizationCodeGrant>>["claims"]
    >;
    try {
      const config = await configuration(r.rows[0]);
      const tokens = await client.authorizationCodeGrant(config, callback, {
        expectedState: state,
        expectedNonce: flow.rows[0].nonce,
        pkceCodeVerifier: decrypt(flow.rows[0].encrypted_verifier),
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch {
      return fail(401, "Identity provider response could not be verified");
    }
    if (
      !claims ||
      typeof claims.sub !== "string" ||
      !claims.sub ||
      claims.sub.length > 1000
    )
      return fail(401, "Invalid identity");
    await transaction(async (c) => {
      // Serialize provisioning and provider disabling; never link a local account solely by email.
      const p = await c.query(
        "SELECT enabled,auto_provision,config_version FROM oidc_providers WHERE id::text=$1 FOR UPDATE",
        [id],
      );
      if (
        !p.rows[0]?.enabled ||
        p.rows[0].config_version !== flow.rows[0].provider_version
      )
        fail(401, "Provider configuration changed");
      const identity = await c.query(
        "SELECT user_id FROM external_identities WHERE provider_id::text=$1 AND subject=$2",
        [id, claims!.sub],
      );
      let uid = identity.rows[0]?.user_id;
      if (!uid) {
        if (!p.rows[0].auto_provision)
          fail(403, "Automatic account creation is disabled");
        const email = claims!.email;
        if (
          typeof email !== "string" ||
          email.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          claims!.email_verified !== true
        )
          return fail(403, "A verified email address is required");
        const created = await c.query(
          "INSERT INTO users(email,email_verified) VALUES($1,true) ON CONFLICT DO NOTHING RETURNING id",
          [email.toLowerCase()],
        );
        if (!created.rowCount)
          fail(
            409,
            "Email belongs to an existing account; automatic account linking is prohibited",
          );
        uid = created.rows[0].id;
        await c.query("INSERT INTO external_identities VALUES($1,$2,$3)", [
          id,
          claims!.sub,
          uid,
        ]);
        await audit(c, uid, "account.oidc_provisioned");
      }
      await issueSession(c, uid, res, id);
      await audit(c, uid, "account.oidc_login");
    });
    res.append("Set-Cookie", cookie(cookieName, "", 0, "Lax"));
    return res.redirect(303, origin());
  }
}
@Module({ controllers: [OidcController] })
export class OidcModule {}

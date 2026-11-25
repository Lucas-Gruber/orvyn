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
  Delete,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import * as client from "openid-client";
import { generatedProfileName, oidcProfileName } from "@orvyn/shared";
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
import {
  configuration,
  redirectUri,
  validateIssuer,
  OidcDiscoveryError,
} from "./auth/oidc.js";
import {
  applyIssuerRepair,
  prepareIssuerRepair,
  type IssuerRepair,
  IssuerRepairError,
} from "./auth/issuer-repair.js";
import { createDiagnostics } from "@orvyn/shared/server";
import {
  OidcLoginError,
  loginFail,
  browserNavigation,
} from "./auth/oidc-feedback.js";
import {
  prepareInvitation,
  invitationCookie,
  invitationBrowser,
  bindInvitation,
  resumeInvitation,
  forgetInvitation,
} from "./auth/oidc-invitations.js";
import {
  administratorSql,
  type OidcClientAuth,
} from "./auth/deployment-oidc.js";
const safeFields = `id,name,issuer,legacy_issuer_normalized AS "legacyIssuerNormalized",client_id AS "clientId",scopes,enabled,auto_provision AS "autoProvision",encrypted_secret IS NOT NULL AS "hasClientSecret",managed_by IS NOT NULL AS managed,coalesce(auth_method,CASE WHEN encrypted_secret IS NULL THEN 'none' ELSE 'client_secret_post' END) AS "clientAuthMethod"`;
async function admin(req: any) {
  const uid = await user(req);
  const r = await db.query(
    `SELECT ${administratorSql} AS is_admin FROM users u WHERE u.id=$1`,
    [uid],
  );
  if (!r.rows[0]?.is_admin) fail(403, "Administrator required");
  return uid;
}
function providerInput(body: any) {
  const issuer = text(body?.issuer, 2000);
  validateIssuer(issuer);
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
  else if (body.clientSecret !== undefined) {
    if (
      typeof body.clientSecret !== "string" ||
      !body.clientSecret.trim() ||
      body.clientSecret.length > 4000
    )
      fail(400, "Invalid client secret");
    secret = encrypt(body.clientSecret);
  }
  const method = body.clientAuthMethod;
  if (
    method !== undefined &&
    !["none", "client_secret_post", "client_secret_basic"].includes(method)
  )
    fail(400, "Invalid OIDC client authentication method");
  return {
    name,
    issuer,
    clientId,
    scopes: scopes.join(" "),
    enabled: body.enabled,
    autoProvision: body.autoProvision,
    secret,
    method: method as OidcClientAuth | undefined,
  };
}
function clientAuth(p: ReturnType<typeof providerInput>, existing?: any) {
  const hasSecret =
    p.secret === undefined ? !!existing?.encrypted_secret : !!p.secret;
  const method =
    p.method ||
    (p.secret === null
      ? "none"
      : existing?.auth_method || (hasSecret ? "client_secret_post" : "none"));
  if (method !== "none" && !hasSecret)
    fail(400, "A client secret is required for this authentication method");
  if (method === "none") {
    if (p.secret)
      fail(400, "Public OIDC clients must not configure a client secret");
    p.secret = null;
  }
  return method;
}
async function resolveProviderRoute(id: string) {
  if (id !== "deployment") return id;
  const result = await db.query(
    "SELECT id FROM oidc_providers WHERE managed_by='deployment' AND enabled",
  );
  if (!result.rowCount) fail(404, "Provider not found");
  return result.rows[0].id as string;
}
@Controller("api/v1")
class OidcController {
  @Post("oidc/invitation/resume") async resumeInvitation(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
  ) {
    mutation(req);
    return resumeInvitation(req, res);
  }
  @Delete("oidc/invitation/resume") async forgetInvitation(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
  ) {
    mutation(req);
    return forgetInvitation(req, res);
  }
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
    ).rows.map((p) => ({ ...p, redirectUri: redirectUri(p.id, p.managed) }));
  }
  @Post("admin/oidc/providers") async create(
    @Req() req: any,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await admin(req),
      p = providerInput(body);
    return transaction(async (c) => {
      const method = clientAuth(p);
      const r = await c.query(
        `INSERT INTO oidc_providers(name,issuer,client_id,encrypted_secret,scopes,enabled,auto_provision,auth_method) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(issuer) DO NOTHING RETURNING ${safeFields}`,
        [
          p.name,
          p.issuer,
          p.clientId,
          p.secret || null,
          p.scopes,
          p.enabled,
          p.autoProvision,
          method,
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
    if (
      body?.repairLegacyIssuer !== undefined &&
      typeof body.repairLegacyIssuer !== "boolean"
    )
      fail(400, "Choose whether to repair the legacy issuer");
    const snapshot = (
      await db.query("SELECT * FROM oidc_providers WHERE id::text=$1", [id])
    ).rows[0];
    if (!snapshot) fail(404, "Provider not found");
    if (snapshot.managed_by)
      fail(
        409,
        "This provider is managed by deployment configuration; update its Helm values or environment settings",
      );
    if (snapshot.client_id !== p.clientId)
      fail(
        400,
        "Issuer and client identity are immutable; create a new provider",
      );
    let repair: IssuerRepair | undefined;
    if (snapshot.issuer !== p.issuer) {
      try {
        repair = await prepareIssuerRepair(
          db,
          snapshot,
          p.issuer,
          body.repairLegacyIssuer === true,
        );
      } catch (error) {
        createDiagnostics("oidc", process.env).error("issuer.repair_failed", {
          stage: "oidc_configuration",
          error,
        });
        fail(
          409,
          "Issuer repair was not verified. Confirm repair for linked accounts and check the issuer metadata and diagnostics; other identity changes require a new provider.",
        );
      }
    }
    return transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(782945)");
      if (repair) {
        try {
          await applyIssuerRepair(c, repair, uid);
        } catch (error) {
          if (!(error instanceof IssuerRepairError)) throw error;
          createDiagnostics("oidc", process.env).error("issuer.repair_failed", {
            stage: "oidc_configuration",
            error,
          });
          fail(
            409,
            "Issuer repair conflicts with current provider settings. Reload and inspect the configuration diagnostics.",
          );
        }
      }
      const existing = await c.query(
        "SELECT issuer,client_id,enabled,managed_by,encrypted_secret,auth_method FROM oidc_providers WHERE id::text=$1 FOR UPDATE",
        [id],
      );
      if (!existing.rowCount) fail(404, "Provider not found");
      if (existing.rows[0].managed_by)
        fail(
          409,
          "This provider is managed by deployment configuration; update its Helm values or environment settings",
        );
      if (
        existing.rows[0].issuer !== p.issuer ||
        existing.rows[0].client_id !== p.clientId
      )
        fail(
          400,
          "Issuer and client identity are immutable; create a new provider",
        );
      const method = clientAuth(p, existing.rows[0]);
      const r = await c.query(
        `UPDATE oidc_providers SET config_version=config_version+1,name=$1,encrypted_secret=CASE WHEN $2 THEN $3 ELSE encrypted_secret END,scopes=$4,enabled=$5,auto_provision=$6,auth_method=$8 WHERE id::text=$7 RETURNING ${safeFields}`,
        [
          p.name,
          p.secret !== undefined,
          p.secret ?? null,
          p.scopes,
          p.enabled,
          p.autoProvision,
          id,
          method,
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
    @Body() body: any,
    @Param("id") id: string,
  ) {
    mutation(req);
    await rateLimit("oidc:" + req.ip);
    id = await resolveProviderRoute(id);
    const r = await db.query(
      "SELECT * FROM oidc_providers WHERE id::text=$1 AND enabled=true",
      [id],
    );
    if (!r.rowCount) fail(404, "Provider not found");
    let config;
    try {
      config = await configuration(r.rows[0]);
    } catch (error) {
      const provider = r.rows[0];
      if (
        !provider.managed_by &&
        provider.legacy_issuer_normalized &&
        error instanceof OidcDiscoveryError &&
        error.actualIssuer === provider.issuer + "/"
      ) {
        try {
          const proof = await prepareIssuerRepair(
            db,
            provider,
            error.actualIssuer,
          );
          const repaired = await transaction(async (c) => {
            await c.query("SELECT pg_advisory_xact_lock(782945)");
            return applyIssuerRepair(c, proof);
          });
          r.rows[0] = repaired;
          config = await configuration(repaired);
        } catch (repairError) {
          createDiagnostics("oidc", process.env).error("issuer.repair_failed", {
            stage: "oidc_configuration",
            error: repairError,
          });
          return fail(
            502,
            "Identity provider discovery failed; contact your administrator",
          );
        }
      } else return fail(502, "Identity provider discovery failed");
    }
    const state = client.randomState(),
      nonce = client.randomNonce(),
      verifier = client.randomPKCECodeVerifier(),
      browser = randomBytes(32).toString("hex");
    const invitation = await transaction(async (c) => {
      const continuation = await prepareInvitation(
        c,
        req,
        body?.invitationToken,
      );
      await c.query(
        "INSERT INTO oidc_flows(state_hash,provider_id,browser_hash,encrypted_verifier,nonce,expires_at,provider_version,invitation_continuation) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes',$6,$7)",
        [
          hash(state),
          id,
          hash(browser),
          encrypt(verifier),
          nonce,
          r.rows[0].config_version,
          continuation ? hash(continuation) : null,
        ],
      );
      return continuation;
    });
    if (invitation) invitationCookie(res, invitation);
    res.append(
      "Set-Cookie",
      cookie("orvyn_oidc_" + state.slice(0, 16), browser, 600, "Lax"),
    );
    return {
      url: client
        .buildAuthorizationUrl(config, {
          redirect_uri: redirectUri(id, !!r.rows[0].managed_by),
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
    const cookieName =
      state && /^[a-zA-Z0-9_-]{20,128}$/.test(state)
        ? "orvyn_oidc_" + state.slice(0, 16)
        : null;
    const clearBinding = () => {
      if (cookieName)
        res.append("Set-Cookie", cookie(cookieName, "", 0, "Lax"));
    };
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      const resume = await this.completeLogin(req, res, id, callback, state);
      clearBinding();
      return res.redirect(
        303,
        origin() + (resume ? "/?resume=invitation" : ""),
      );
    } catch (error) {
      clearBinding();
      const code =
        error instanceof OidcLoginError
          ? error.feedback
          : "provider_unavailable";
      const log = createDiagnostics("oidc", process.env);
      if (error instanceof OidcLoginError)
        log.warn("login.failed", {
          stage: "oidc_callback",
          code: "OIDC_" + code.toUpperCase(),
        });
      else log.error("login.failed", { stage: "oidc_callback", error });
      if (!browserNavigation(req)) throw error;
      const destination = new URL(origin());
      destination.searchParams.set("authError", code);
      if (invitationBrowser(req))
        destination.searchParams.set("resume", "invitation");
      return res.redirect(303, destination.toString());
    }
  }
  private async completeLogin(
    req: any,
    res: any,
    id: string,
    callback: URL,
    state: string | null,
  ) {
    id = await resolveProviderRoute(id);
    if (!state || !/^[a-zA-Z0-9_-]{20,128}$/.test(state))
      return loginFail(400, "invalid_login", "Invalid login state");
    const cookieName = "orvyn_oidc_" + state.slice(0, 16);
    const browser = (req.headers.cookie || "")
      .split(";")
      .map((s: string) => s.trim())
      .find((s: string) => s.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    if (!browser)
      return loginFail(400, "invalid_login", "Missing login browser binding");
    const flow = await db.query(
      "DELETE FROM oidc_flows WHERE state_hash=$1 AND provider_id::text=$2 AND browser_hash=$3 AND expires_at>now() RETURNING *",
      [hash(state), id, hash(browser)],
    );
    if (!flow.rowCount)
      return loginFail(400, "invalid_login", "Invalid or expired login");
    const r = await db.query(
      "SELECT * FROM oidc_providers WHERE id::text=$1 AND enabled=true",
      [id],
    );
    if (
      !r.rowCount ||
      r.rows[0].config_version !== flow.rows[0].provider_version
    )
      return loginFail(
        400,
        "provider_changed",
        "Provider configuration changed",
      );
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
    } catch (error) {
      return loginFail(
        401,
        error instanceof OidcDiscoveryError
          ? "provider_unavailable"
          : "provider_response",
        "Identity provider response could not be verified",
      );
    }
    if (
      !claims ||
      typeof claims.sub !== "string" ||
      !claims.sub ||
      claims.sub.length > 1000
    )
      return loginFail(401, "provider_response", "Invalid identity");
    let resume = false;
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
        loginFail(401, "provider_changed", "Provider configuration changed");
      const identity = await c.query(
        "SELECT user_id FROM external_identities WHERE provider_id::text=$1 AND subject=$2",
        [id, claims!.sub],
      );
      let uid = identity.rows[0]?.user_id;
      if (!uid) {
        if (!p.rows[0].auto_provision)
          loginFail(
            403,
            "provisioning_disabled",
            "Automatic account creation is disabled",
          );
        const email = claims!.email;
        if (
          typeof email !== "string" ||
          email.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          claims!.email_verified !== true
        )
          return loginFail(
            403,
            "email_unverified",
            "A verified email address is required",
          );
        const created = await c.query(
          "INSERT INTO users(email,email_verified,display_name,display_name_source) VALUES($1,true,$2,$3) ON CONFLICT DO NOTHING RETURNING id",
          [
            email.toLowerCase(),
            oidcProfileName(claims!) || generatedProfileName(email),
            oidcProfileName(claims!) ? "provider" : "generated",
          ],
        );
        if (!created.rowCount)
          loginFail(
            409,
            "account_exists",
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
      const displayName = oidcProfileName(claims!);
      if (displayName)
        await c.query(
          "UPDATE users SET display_name=$2,display_name_source='provider' WHERE id=$1 AND display_name_source<>'user'",
          [uid, displayName],
        );
      await issueSession(c, uid, res, id);
      resume = await bindInvitation(
        c,
        req,
        flow.rows[0].invitation_continuation,
        uid,
      );
      await audit(c, uid, "account.oidc_login");
    });
    return resume;
  }
}
@Module({ controllers: [OidcController] })
export class OidcModule {}

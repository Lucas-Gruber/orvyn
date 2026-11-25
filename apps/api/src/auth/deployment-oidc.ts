import { createHash, createHmac } from "node:crypto";
import type { Pool } from "pg";
import { encrypt, decrypt, encryptionKey, audit } from "./security.js";
import { validateIssuer } from "./oidc.js";
import { applyIssuerRepair, prepareIssuerRepair } from "./issuer-repair.js";
import { RuntimeConfigurationError } from "@orvyn/shared/server";

export class DeploymentConfigurationError extends RuntimeConfigurationError {
  constructor(message: string) {
    const setting = /^ORVYN_OIDC_([A-Z_]+)/u.exec(message)?.[1];
    const code = setting
      ? "OIDC_" + setting + "_INVALID"
      : message.startsWith("Existing OIDC credentials")
        ? "OIDC_SECRET_DECRYPTION_FAILED"
        : "OIDC_CONFIGURATION_CONFLICT";
    super(code, message);
  }
}
export type OidcClientAuth =
  "none" | "client_secret_post" | "client_secret_basic";
export type DeploymentOidc =
  | { enabled: false }
  | {
      enabled: true;
      id: string;
      name: string;
      issuer: string;
      clientId: string;
      clientSecret: string | null;
      clientAuthMethod: OidcClientAuth;
      scopes: string;
      autoProvision: boolean;
      adminSubject: string | null;
      repairLegacyIssuer: boolean;
    };
const problem = (message: string): never => {
  throw new DeploymentConfigurationError(message);
};
function boolean(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: boolean,
) {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  if (value !== "true" && value !== "false")
    return problem(name + " must be true or false");
  return value === "true";
}
function value(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  limit: number,
  fallback = "",
) {
  const result = env[name] ?? fallback;
  if (!result.trim() || result.length > limit)
    return problem(name + " is required and must have a valid length");
  return result.trim();
}
export function readDeploymentOidc(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DeploymentOidc {
  if (!boolean(env, "ORVYN_OIDC_ENABLED", false)) return { enabled: false };
  let issuer: string;
  try {
    issuer = value(env, "ORVYN_OIDC_ISSUER", 2000);
    validateIssuer(issuer, env);
  } catch {
    return problem("ORVYN_OIDC_ISSUER must be a valid HTTPS issuer URL");
  }
  const clientId = value(env, "ORVYN_OIDC_CLIENT_ID", 300),
    clientSecret = env.ORVYN_OIDC_CLIENT_SECRET || null,
    method =
      env.ORVYN_OIDC_CLIENT_AUTH_METHOD ||
      (clientSecret ? "client_secret_post" : "none");
  if (!["none", "client_secret_post", "client_secret_basic"].includes(method))
    return problem(
      "ORVYN_OIDC_CLIENT_AUTH_METHOD must be none, client_secret_post or client_secret_basic",
    );
  if (clientSecret && (clientSecret.length > 4000 || !clientSecret.trim()))
    return problem("ORVYN_OIDC_CLIENT_SECRET has an invalid length");
  if (method !== "none" && !clientSecret)
    return problem(
      "ORVYN_OIDC_CLIENT_SECRET is required for this client authentication method",
    );
  if (method === "none" && clientSecret)
    return problem("Public OIDC clients must not configure a client secret");
  const scopes = [
    ...new Set(
      value(env, "ORVYN_OIDC_SCOPES", 500, "openid email profile").split(/\s+/),
    ),
  ];
  if (
    !scopes.includes("openid") ||
    scopes.some((scope) => !/^[a-zA-Z0-9:._/-]+$/.test(scope))
  )
    return problem(
      "ORVYN_OIDC_SCOPES must include openid and valid scope names",
    );
  const adminSubject = env.ORVYN_OIDC_ADMIN_SUBJECT || null;
  if (adminSubject && (adminSubject.length > 1000 || !adminSubject.trim()))
    return problem("ORVYN_OIDC_ADMIN_SUBJECT has an invalid length");
  const bytes = createHash("sha256")
    .update("orvyn:deployment:oidc\0" + issuer + "\0" + clientId)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x80;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString("hex"),
    id = [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  return {
    enabled: true,
    id,
    name: value(env, "ORVYN_OIDC_NAME", 120, "Single sign-on"),
    issuer,
    clientId,
    clientSecret,
    clientAuthMethod: method as OidcClientAuth,
    scopes: scopes.join(" "),
    autoProvision: boolean(env, "ORVYN_OIDC_AUTO_PROVISION", false),
    adminSubject,
    repairLegacyIssuer: boolean(env, "ORVYN_OIDC_REPAIR_LEGACY_ISSUER", false),
  };
}
export function deploymentOidcFingerprint(config: DeploymentOidc) {
  const canonical = config.enabled
    ? {
        enabled: true,
        name: config.name,
        issuer: config.issuer,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        clientAuthMethod: config.clientAuthMethod,
        scopes: config.scopes,
        autoProvision: config.autoProvision,
        adminSubject: config.adminSubject,
      }
    : { enabled: false };
  return createHmac("sha256", encryptionKey())
    .update(JSON.stringify(canonical))
    .digest("hex");
}
export async function configureDeploymentOidc(
  pool: Pool,
  config = readDeploymentOidc(),
) {
  // Network verification happens before taking configuration/database locks.
  const candidates = config.enabled
    ? (
        await pool.query(
          "SELECT * FROM oidc_providers WHERE managed_by='deployment' AND issuer=$1 AND client_id=$2 AND legacy_issuer_normalized",
          [config.issuer.slice(0, -1), config.clientId],
        )
      ).rows.filter((row) => config.issuer === row.issuer + "/")
    : [];
  const repair = candidates.length
    ? await prepareIssuerRepair(
        pool,
        candidates[0],
        config.enabled ? config.issuer : "",
        config.enabled && config.repairLegacyIssuer,
      )
    : undefined;
  const fingerprint = deploymentOidcFingerprint(config),
    c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(782945)");
    if (repair) await applyIssuerRepair(c, repair);
    const previous = await c.query(
      "SELECT fingerprint FROM deployment_configuration WHERE name='oidc' FOR UPDATE",
    );
    const current = await c.query(
      "SELECT * FROM oidc_providers WHERE managed_by='deployment' FOR UPDATE",
    );
    let providerId = config.enabled ? config.id : null;
    if (config.enabled) {
      const bound = current.rows.find((row) => row.id === config.id);
      if (
        bound &&
        (bound.issuer !== config.issuer || bound.client_id !== config.clientId)
      )
        problem(
          "This provider UUID is already bound to a different issuer/client identity. Keep the exact repaired issuer or plan an explicit identity migration.",
        );
      const match = current.rows.find((row) => row.issuer === config.issuer);
      if (match && match.client_id !== config.clientId)
        problem(
          "An existing issuer cannot change its client identity. Plan an explicit identity migration.",
        );
      if (match) providerId = match.id;
    }
    const disabled = await c.query(
      "UPDATE oidc_providers SET enabled=false,config_version=config_version+1 WHERE managed_by='deployment' AND enabled AND ($1::uuid IS NULL OR id<>$1) RETURNING id",
      [providerId],
    );
    let changed = !!disabled.rowCount;
    if (config.enabled) {
      const collision = await c.query(
        "SELECT id,managed_by FROM oidc_providers WHERE issuer=$1",
        [config.issuer],
      );
      if (
        collision.rowCount &&
        (collision.rows[0].managed_by !== "deployment" ||
          collision.rows[0].id !== providerId)
      )
        return problem(
          "This issuer already has a different provider identity. Keep its existing configuration or plan an explicit identity migration.",
        );
      const existing = current.rows.find((row) => row.id === providerId);
      let existingSecret: string | null = null;
      try {
        existingSecret = existing?.encrypted_secret
          ? decrypt(existing.encrypted_secret)
          : null;
      } catch {
        return problem(
          "Existing OIDC credentials cannot be decrypted. Restore the original ORVYN_ENCRYPTION_KEY before changing configuration.",
        );
      }
      changed ||=
        !existing ||
        !existing.enabled ||
        existing.name !== config.name ||
        existing.scopes !== config.scopes ||
        existing.auto_provision !== config.autoProvision ||
        existing.admin_subject !== config.adminSubject ||
        existing.auth_method !== config.clientAuthMethod ||
        existingSecret !== config.clientSecret;
      if (changed) {
        await c.query(
          `INSERT INTO oidc_providers(id,name,issuer,client_id,encrypted_secret,scopes,enabled,auto_provision,managed_by,admin_subject,auth_method)
          VALUES($1,$2,$3,$4,$5,$6,true,$7,'deployment',$8,$9)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,encrypted_secret=excluded.encrypted_secret,scopes=excluded.scopes,enabled=true,auto_provision=excluded.auto_provision,admin_subject=excluded.admin_subject,auth_method=excluded.auth_method,config_version=oidc_providers.config_version+1`,
          [
            providerId,
            config.name,
            config.issuer,
            config.clientId,
            config.clientSecret
              ? existing && existingSecret === config.clientSecret
                ? existing.encrypted_secret
                : encrypt(config.clientSecret)
              : null,
            config.scopes,
            config.autoProvision,
            config.adminSubject,
            config.clientAuthMethod,
          ],
        );
        await c.query("DELETE FROM oidc_flows WHERE provider_id=$1", [
          providerId,
        ]);
      }
    }
    if (disabled.rowCount) {
      const ids = disabled.rows.map((row) => row.id);
      await c.query(
        "DELETE FROM oidc_flows WHERE provider_id=ANY($1::uuid[])",
        [ids],
      );
      await c.query("DELETE FROM sessions WHERE provider_id=ANY($1::uuid[])", [
        ids,
      ]);
    }
    await c.query(
      "INSERT INTO deployment_configuration(name,fingerprint) VALUES('oidc',$1) ON CONFLICT(name) DO UPDATE SET fingerprint=excluded.fingerprint,updated_at=now() WHERE deployment_configuration.fingerprint IS DISTINCT FROM excluded.fingerprint",
      [fingerprint],
    );
    if (changed || previous.rows[0]?.fingerprint !== fingerprint)
      await audit(c, null, "oidc.deployment_configured");
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}
export async function initializeDeploymentOidc(
  pool: Pool,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const mode = env.ORVYN_OIDC_BOOTSTRAP_MODE || "auto";
  if (mode === "external") return;
  const config = readDeploymentOidc(env);
  if (mode === "auto") return configureDeploymentOidc(pool, config);
  if (mode !== "wait")
    return problem("ORVYN_OIDC_BOOTSTRAP_MODE must be auto, wait or external");
  const fingerprint = deploymentOidcFingerprint(config),
    deadline = Date.now() + 120000;
  do {
    const result = await pool.query(
      "SELECT fingerprint FROM deployment_configuration WHERE name='oidc'",
    );
    if (result.rows[0]?.fingerprint === fingerprint) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  return problem(
    "OIDC deployment configuration is pending; check the configuration workload and its Secret references",
  );
}
export const administratorSql = `(u.is_admin OR EXISTS(SELECT 1 FROM external_identities i JOIN oidc_providers p ON p.id=i.provider_id WHERE i.user_id=u.id AND p.managed_by='deployment' AND p.enabled AND p.admin_subject=i.subject))`;

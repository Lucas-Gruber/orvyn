import type { Pool, PoolClient } from "pg";
import { RuntimeConfigurationError } from "@orvyn/shared/server";
import { configuration } from "./oidc.js";
import { audit } from "./security.js";

export class IssuerRepairError extends RuntimeConfigurationError {
  constructor(code: string) {
    super(
      code,
      "Legacy issuer repair requires verified metadata, the same client identity and an explicit administrator decision for linked accounts.",
    );
  }
}
export interface IssuerRepair {
  providerId: string;
  oldIssuer: string;
  newIssuer: string;
  clientId: string;
  version: number;
  allowLinked: boolean;
}

/** Only the single slash removed by old Orvyn is eligible for repair. The
 * old and proposed issuers must use the same authoritative discovery URL.
 * This is deliberately narrower than URL equivalence or generic migration. */
export async function prepareIssuerRepair(
  pool: Pool,
  provider: any,
  issuer: string,
  allowLinked = false,
): Promise<IssuerRepair> {
  if (
    !provider.legacy_issuer_normalized ||
    provider.issuer.endsWith("/") ||
    issuer !== provider.issuer + "/"
  )
    throw new IssuerRepairError("OIDC_REPAIR_NOT_ELIGIBLE");
  const linked = await pool.query(
    "SELECT 1 FROM external_identities WHERE provider_id=$1 LIMIT 1",
    [provider.id],
  );
  if (linked.rowCount && !allowLinked)
    throw new IssuerRepairError("OIDC_REPAIR_APPROVAL_REQUIRED");
  // Strict discovery of old + '/' reads the very same well-known endpoint as
  // old without '/'. TLS, exact issuer and client-auth validation stay enabled.
  await configuration({ ...provider, issuer });
  return {
    providerId: provider.id,
    oldIssuer: provider.issuer,
    newIssuer: issuer,
    clientId: provider.client_id,
    version: provider.config_version,
    allowLinked,
  };
}

/** Caller holds the configuration advisory lock and a transaction. */
export async function applyIssuerRepair(
  c: PoolClient,
  proof: IssuerRepair,
  actor: string | null = null,
) {
  const result = await c.query(
    "SELECT * FROM oidc_providers WHERE id=$1 FOR UPDATE",
    [proof.providerId],
  );
  const current = result.rows[0];
  if (
    current?.issuer === proof.newIssuer &&
    current.client_id === proof.clientId
  )
    return current;
  if (
    !current ||
    !current.legacy_issuer_normalized ||
    current.issuer !== proof.oldIssuer ||
    current.client_id !== proof.clientId ||
    current.config_version !== proof.version
  )
    throw new IssuerRepairError("OIDC_REPAIR_CONFLICT");
  if (
    (
      await c.query("SELECT 1 FROM oidc_providers WHERE issuer=$1 AND id<>$2", [
        proof.newIssuer,
        proof.providerId,
      ])
    ).rowCount
  )
    throw new IssuerRepairError("OIDC_REPAIR_COLLISION");
  if (
    !proof.allowLinked &&
    (
      await c.query(
        "SELECT 1 FROM external_identities WHERE provider_id=$1 LIMIT 1",
        [proof.providerId],
      )
    ).rowCount
  )
    throw new IssuerRepairError("OIDC_REPAIR_APPROVAL_REQUIRED");
  const repaired = await c.query(
    "UPDATE oidc_providers SET issuer=$2,legacy_issuer_normalized=false,config_version=config_version+1 WHERE id=$1 RETURNING *",
    [proof.providerId, proof.newIssuer],
  );
  await c.query("DELETE FROM oidc_flows WHERE provider_id=$1", [
    proof.providerId,
  ]);
  await c.query("DELETE FROM sessions WHERE provider_id=$1", [
    proof.providerId,
  ]);
  await c.query(
    "INSERT INTO oidc_issuer_repairs(provider_id,old_issuer,new_issuer,actor_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [proof.providerId, proof.oldIssuer, proof.newIssuer, actor],
  );
  await audit(c, actor, "oidc.legacy_issuer_repaired");
  return repaired.rows[0];
}

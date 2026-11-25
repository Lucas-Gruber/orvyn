/** Server-only configuration and diagnostics. Never export this through the browser entry point. */
export type ServerEnvironment = Readonly<Record<string, string | undefined>>;
export const logLevels = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof logLevels)[number];
export class RuntimeConfigurationError extends Error {
  constructor(
    public readonly diagnosticCode: string,
    message: string,
  ) {
    super(message);
  }
}
export function runtimeOrigin(env: ServerEnvironment): string {
  const value =
    env.ORVYN_ORIGIN ||
    (env.NODE_ENV !== "production" ? "http://localhost:3000" : "");
  if (!value)
    throw new RuntimeConfigurationError(
      "ORIGIN_MISSING",
      "ORVYN_ORIGIN is required in production.",
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeConfigurationError(
      "ORIGIN_INVALID",
      "ORVYN_ORIGIN must be an exact HTTP(S) origin.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.origin !== value ||
    url.username ||
    url.password
  )
    throw new RuntimeConfigurationError(
      "ORIGIN_INVALID",
      "ORVYN_ORIGIN must be an exact HTTP(S) origin without path, credentials, query or trailing slash.",
    );
  if (env.NODE_ENV === "production" && url.protocol !== "https:")
    throw new RuntimeConfigurationError(
      "ORIGIN_HTTPS_REQUIRED",
      "Production ORVYN_ORIGIN requires HTTPS.",
    );
  return value;
}
export function runtimeUpstream(
  env: ServerEnvironment,
  name: string,
  protocols: string[],
  fallback: string,
): string {
  const value = env[name] || (env.NODE_ENV !== "production" ? fallback : "");
  if (!value)
    throw new RuntimeConfigurationError(
      "UPSTREAM_MISSING",
      "Production upstream configuration is incomplete.",
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeConfigurationError(
      "UPSTREAM_INVALID",
      "An upstream URL is invalid.",
    );
  }
  if (
    !protocols.includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new RuntimeConfigurationError(
      "UPSTREAM_INVALID",
      "Upstreams require an approved protocol without credentials, query or fragment.",
    );
  return value;
}
const recognized = new Set([
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOSPC",
  "EDQUOT",
  "ENOENT",
  "ENOTDIR",
  "ELOOP",
  "EINVAL",
  "ENOTSUP",
  "ESTALE",
  "EIO",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "28P01",
  "28000",
  "3D000",
  "53300",
  "57P03",
  "08001",
  "08006",
  "42501",
  "42P01",
  "EAUTH",
  "ECONNECTION",
  "ETLS",
  "ESOCKET",
  "EMESSAGE",
  "OAUTH_INVALID_RESPONSE",
  "OAUTH_RESPONSE_IS_NOT_CONFORM",
  "OAUTH_UNSUPPORTED_OPERATION",
  "OAUTH_INVALID_SERVER_METADATA",
  "OAUTH_INVALID_REQUEST",
  "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
]);
export function diagnosticCode(error: unknown): string {
  try {
    let current: unknown = error;
    for (let depth = 0; current && depth < 8; depth++) {
      if (current instanceof RuntimeConfigurationError)
        return /^[A-Z][A-Z0-9_]{1,63}$/.test(current.diagnosticCode)
          ? current.diagnosticCode
          : "CONFIGURATION_INVALID";
      if (typeof current !== "object") break;
      const value = current as {
        code?: unknown;
        cause?: unknown;
        name?: unknown;
      };
      if (typeof value.code === "string" && recognized.has(value.code))
        return value.code;
      if (value.name === "TimeoutError" || value.name === "AbortError")
        return "ETIMEDOUT";
      current = value.cause;
    }
    return "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}
const actions: Record<string, string> = {
  OIDC_ISSUER_MISMATCH:
    "Copy the exact issuer from the provider metadata, including trailing slashes. Repair legacy normalization explicitly for linked identities; keep issuer validation enabled.",
  OIDC_METADATA_INVALID:
    "Check the HTTPS discovery response and its issuer, authorization, token and JWKS endpoints. Keep TLS and signature verification enabled.",
  OIDC_CLIENT_AUTH_UNSUPPORTED:
    "Choose a token-endpoint authentication method advertised by the provider and registered for this client.",
  OIDC_CLIENT_AUTH_INVALID:
    "Configure a client secret for Basic/POST authentication, or choose a registered public PKCE client with method none.",
  OIDC_SECRET_DECRYPTION_FAILED:
    "Restore the original encryption key and verify the stored credential. Never replace an existing encryption key to work around this error.",
  OIDC_REPAIR_APPROVAL_REQUIRED:
    "This legacy provider has linked identities. Review its exact issuer and enable repairLegacyIssuer for a verified slash correction; other issuer changes require a separate identity migration.",
  OIDC_REPAIR_NOT_ELIGIBLE:
    "Only the single trailing slash removed by legacy normalization can be repaired. Keep provider/client identity stable or plan an explicit migration.",
  OIDC_REPAIR_COLLISION:
    "Another provider already owns the corrected issuer. Resolve the duplicate identity configuration explicitly; existing identities were not moved.",
  OIDC_REPAIR_CONFLICT:
    "Provider settings changed during verification. Reload the configuration and retry the verified repair.",
  ENCRYPTION_KEY_INVALID:
    "ORVYN_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters (32 bytes). Restore the existing key; never generate a replacement for existing data.",
  REGISTRATION_CONFIGURATION_INVALID:
    "ORVYN_REGISTRATION_ENABLED must be true or false; configure at most 20 exact local registration email domains.",
  EACCES:
    "Check the volume owner, numeric UID/GID and server-side NFS ACLs. Root-squashed exports may require provisioning permissions on the storage server.",
  EPERM:
    "The storage server or security policy denied this operation. Configure the dataset owner/ACL or select fsGroup mode; do not disable root squashing automatically.",
  EROFS: "Mount writable storage for this component.",
  ENOSPC: "Free or expand storage before retrying.",
  EDQUOT: "Increase the storage quota before retrying.",
  ENOTFOUND: "Check DNS resolution from this workload.",
  EAI_AGAIN: "Check DNS availability and retry.",
  ECONNREFUSED:
    "Check the endpoint, service port, readiness and network policy.",
  ETIMEDOUT: "Check network reachability, readiness and configured timeouts.",
  "28P01":
    "Check the selected database Secret and server-side credentials without regenerating existing encryption keys.",
  ORIGIN_MISSING:
    "Set ORVYN_ORIGIN to the public HTTPS origin in every application component.",
  ORIGIN_INVALID:
    "Configure the exact public origin without path, credentials, query or trailing slash.",
  ORIGIN_HTTPS_REQUIRED: "Terminate TLS and configure the public HTTPS origin.",
};
export interface DiagnosticFields {
  stage?: string;
  error?: unknown;
  code?: string;
  status?: number;
  durationMs?: number;
  mountPath?: string;
  expectedUid?: number;
  expectedGid?: number;
  effectiveUid?: number;
  effectiveGid?: number;
  ownerUid?: number;
  ownerGid?: number;
  permissions?: string;
  operation?: string;
}
export function createDiagnostics(
  component: string,
  env: ServerEnvironment,
  write: (line: string) => void = console.error,
) {
  const configured = env.ORVYN_LOG_LEVEL || "info";
  if (!(logLevels as readonly string[]).includes(configured))
    throw new RuntimeConfigurationError(
      "LOG_LEVEL_INVALID",
      "ORVYN_LOG_LEVEL must be debug, info, warn or error.",
    );
  const threshold = logLevels.indexOf(configured as LogLevel);
  const emit = (
    level: LogLevel,
    event: string,
    input: DiagnosticFields = {},
  ) => {
    if (logLevels.indexOf(level) < threshold) return;
    const output: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      component: /^[a-z0-9-]{1,64}$/.test(component)
        ? component
        : "application",
      event: /^[a-z0-9_.-]{1,100}$/.test(event) ? event : "diagnostic",
    };
    for (const field of ["stage", "operation"] as const)
      if (input[field] && /^[a-z0-9_.-]{1,100}$/.test(input[field]!))
        output[field] = input[field];
    const code = input.error ? diagnosticCode(input.error) : input.code;
    if (code && /^[A-Z0-9][A-Z0-9_]{1,63}$/.test(code)) {
      output.code = code;
      output.action =
        actions[code] ||
        (code.includes("CERT") || code.includes("TLS")
          ? "Check certificate trust, hostname and expiry; keep TLS validation enabled."
          : "Check this stage's configuration and dependency readiness. Credentials and raw error payloads are intentionally omitted.");
    }
    for (const field of [
      "status",
      "durationMs",
      "expectedUid",
      "expectedGid",
      "effectiveUid",
      "effectiveGid",
      "ownerUid",
      "ownerGid",
    ] as const)
      if (Number.isSafeInteger(input[field]) && input[field]! >= 0)
        output[field] = input[field];
    if (input.permissions && /^[0-7]{3,4}$/.test(input.permissions))
      output.permissions = input.permissions;
    if (
      input.mountPath?.startsWith("/") &&
      input.mountPath.length <= 500 &&
      !/[\u0000-\u001f\u007f?#]/u.test(input.mountPath)
    )
      output.mountPath = input.mountPath;
    write(JSON.stringify(output));
  };
  return {
    debug: (event: string, fields?: DiagnosticFields) =>
      emit("debug", event, fields),
    info: (event: string, fields?: DiagnosticFields) =>
      emit("info", event, fields),
    warn: (event: string, fields?: DiagnosticFields) =>
      emit("warn", event, fields),
    error: (event: string, fields?: DiagnosticFields) =>
      emit("error", event, fields),
    async stage<T>(stage: string, task: () => Promise<T>): Promise<T> {
      const started = Date.now();
      emit("debug", "stage.started", { stage });
      try {
        const result = await task();
        emit("info", "stage.ready", {
          stage,
          durationMs: Date.now() - started,
        });
        return result;
      } catch (error) {
        emit("error", "stage.failed", { stage, error });
        throw error;
      }
    },
  };
}

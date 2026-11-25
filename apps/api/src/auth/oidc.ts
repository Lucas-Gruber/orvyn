import * as client from "openid-client";
import { fail } from "../runtime.js";
import { decrypt, origin } from "./security.js";
import {
  createDiagnostics,
  diagnosticCode,
  RuntimeConfigurationError,
} from "@orvyn/shared/server";

export class OidcDiscoveryError extends RuntimeConfigurationError {
  constructor(
    code: string,
    readonly actualIssuer?: string,
  ) {
    super(
      code,
      "Identity provider discovery failed. Check the structured diagnostics.",
    );
  }
}
function discoveryFailure(error: unknown): OidcDiscoveryError {
  if (error instanceof OidcDiscoveryError) return error;
  const value = error as any;
  if (value?.code === "OAUTH_TIMEOUT")
    return new OidcDiscoveryError("ETIMEDOUT");
  if (
    value?.code === "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED" &&
    value?.cause?.attribute === "issuer"
  )
    return new OidcDiscoveryError(
      "OIDC_ISSUER_MISMATCH",
      typeof value.cause.body?.issuer === "string"
        ? value.cause.body.issuer
        : undefined,
    );
  const code = diagnosticCode(error);
  if (code !== "UNKNOWN" && !code.startsWith("OAUTH_"))
    return new OidcDiscoveryError(code);
  return new OidcDiscoveryError("OIDC_METADATA_INVALID");
}
export function validateIssuer(
  input: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (input.length > 2000 || /[\u0000-\u0020\u007f]/u.test(input))
    return fail(400, "Invalid issuer URL");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail(400, "Invalid issuer URL");
  }
  if (url.username || url.password || url.search || url.hash)
    fail(400, "Invalid issuer URL");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const localTest =
    env.NODE_ENV !== "production" && env.ORVYN_OIDC_ALLOW_HTTP_LOCAL === "true";
  if (
    url.protocol !== "https:" &&
    !(local && localTest && url.protocol === "http:")
  )
    fail(400, "OIDC requires HTTPS");
  return url;
}
export function redirectUri(id: string, managed = false) {
  return `${origin()}/api/v1/oidc/${managed ? "deployment" : id}/callback`;
}
export async function configuration(provider: any) {
  try {
    return await discover(provider);
  } catch (error) {
    const safe = discoveryFailure(error);
    createDiagnostics("oidc", process.env).error("discovery.failed", {
      stage: "oidc_discovery",
      error: safe,
    });
    throw safe;
  }
}
async function discover(provider: any) {
  const issuer = validateIssuer(provider.issuer);
  let secret: string | undefined;
  try {
    secret = provider.encrypted_secret
      ? decrypt(provider.encrypted_secret)
      : undefined;
  } catch {
    throw new OidcDiscoveryError("OIDC_SECRET_DECRYPTION_FAILED");
  }
  const method =
    provider.auth_method || (secret ? "client_secret_post" : "none");
  if (method !== "none" && !secret)
    throw new OidcDiscoveryError("OIDC_CLIENT_AUTH_INVALID");
  const auth =
    method === "none"
      ? client.None()
      : method === "client_secret_basic"
        ? client.ClientSecretBasic(secret!)
        : client.ClientSecretPost(secret!);
  const options: client.DiscoveryRequestOptions = {
    timeout: 10,
    execute: [client.enableNonRepudiationChecks],
  };
  if (issuer.protocol === "http:")
    options.execute!.push(client.allowInsecureRequests);
  options[client.customFetch] = async (url, options) => {
    // Endpoint URLs may carry provider-defined queries. Transport, credentials
    // and redirects remain restricted just as they are for issuer discovery.
    const destination = new URL(String(url));
    validateIssuer(destination.origin + destination.pathname);
    if (destination.username || destination.password || destination.hash)
      throw new OidcDiscoveryError("OIDC_METADATA_INVALID");
    return fetch(url, { ...options, redirect: "manual" } as RequestInit);
  };
  const config = await client.discovery(
    issuer,
    provider.client_id,
    secret ? { client_secret: secret } : {},
    auth,
    options,
  );
  const metadata = config.serverMetadata();
  // The library compares URL.href, which normalizes a root's trailing slash.
  // OIDC issuer identity is an exact string, including root/path slashes.
  if (metadata.issuer !== provider.issuer)
    throw new OidcDiscoveryError("OIDC_ISSUER_MISMATCH", metadata.issuer);
  const supported = metadata.token_endpoint_auth_methods_supported || [
    "client_secret_basic",
  ];
  if (
    !Array.isArray(supported) ||
    supported.some((method) => typeof method !== "string")
  )
    throw new OidcDiscoveryError("OIDC_METADATA_INVALID");
  if (!supported.includes(method))
    throw new OidcDiscoveryError("OIDC_CLIENT_AUTH_UNSUPPORTED");
  for (const endpoint of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.jwks_uri,
  ]) {
    if (!endpoint) throw new OidcDiscoveryError("OIDC_METADATA_INVALID");
    const url = new URL(endpoint);
    validateIssuer(url.origin + url.pathname);
    if (url.username || url.password || url.hash)
      throw new OidcDiscoveryError("OIDC_METADATA_INVALID");
  }
  return config;
}

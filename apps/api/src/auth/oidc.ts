import * as client from "openid-client";
import { fail } from "../runtime";
import { decrypt, origin } from "./security";
export function validateIssuer(input: string) {
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
    process.env.NODE_ENV !== "production" &&
    process.env.ORVYN_OIDC_ALLOW_HTTP_LOCAL === "true";
  if (
    url.protocol !== "https:" &&
    !(local && localTest && url.protocol === "http:")
  )
    fail(400, "OIDC requires HTTPS");
  return url;
}
export function redirectUri(id: string) {
  return `${origin()}/api/v1/oidc/${id}/callback`;
}
export async function configuration(provider: any) {
  const issuer = validateIssuer(provider.issuer);
  const secret = provider.encrypted_secret
    ? decrypt(provider.encrypted_secret)
    : undefined;
  const auth = secret ? client.ClientSecretPost(secret) : client.None();
  const options: client.DiscoveryRequestOptions = {
    timeout: 10,
    execute: [client.enableNonRepudiationChecks],
  };
  if (issuer.protocol === "http:")
    options.execute!.push(client.allowInsecureRequests);
  options[client.customFetch] = async (url, options) => {
    validateIssuer(String(url)); // all metadata-driven network destinations must also use approved transport
    return fetch(url, { ...options, redirect: "manual" } as RequestInit);
  };
  return client.discovery(
    issuer,
    provider.client_id,
    secret ? { client_secret: secret } : {},
    auth,
    options,
  );
}

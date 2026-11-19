import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z, type PublicationInput } from "@orvyn/shared";
import { encryptionKey, origin, cookie } from "../auth/security.js";
import { fail } from "../runtime.js";

const key = (purpose: string) =>
  createHmac("sha256", encryptionKey())
    .update("orvyn:publication:" + purpose + ":v1")
    .digest();
const preview = z.strictObject({
  version: z.literal(1),
  actor: z.uuid(),
  root: z.uuid(),
  target: z.uuid().nullable(),
  targetVersion: z.number().int().positive().nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  expires: z.number().int().positive(),
});
export type PublicationPreviewToken = z.infer<typeof preview>;
function sign(value: unknown, purpose: string) {
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  return (
    encoded +
    "." +
    createHmac("sha256", key(purpose)).update(encoded).digest("base64url")
  );
}
function decode(value: string, purpose: string): unknown {
  const parts = value.split(".");
  if (
    parts.length !== 2 ||
    !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  )
    throw Error();
  const expected = createHmac("sha256", key(purpose))
      .update(parts[0]!)
      .digest(),
    actual = Buffer.from(parts[1]!, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual))
    throw Error();
  return JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
}
export const signPublicationPreview = (value: PublicationPreviewToken) =>
  sign(value, "preview");
export function decodePublicationPreview(value: string) {
  try {
    return preview.parse(decode(value, "preview"));
  } catch {
    return fail(400, "Invalid publication preview");
  }
}
export function publicationDigest(
  input: PublicationInput,
  plan: { snapshot: unknown; fingerprint: unknown },
) {
  const settings = {
    ...input.settings,
    password: input.settings.password
      ? createHmac("sha256", key("password-input"))
          .update(input.settings.password)
          .digest("hex")
      : null,
  };
  return createHash("sha256")
    .update(
      JSON.stringify({
        input: { ...input, settings },
        snapshot: plan.snapshot,
        fingerprint: plan.fingerprint,
      }),
    )
    .digest("hex");
}
export const publicToken = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
export const publicURL = (token: string) =>
  new URL("/s/" + token, origin()).toString();
const gate = z.strictObject({
  id: z.uuid(),
  version: z.number().int().positive(),
  expires: z.number().int().positive(),
});
const gateName = (id: string) => "orvyn_public_" + id.replaceAll("-", "");
export function publicationGateAllowed(
  req: any,
  publication: { id: string; version: number; password_hash: unknown },
) {
  if (!publication.password_hash) return true;
  const prefix = gateName(publication.id) + "=";
  const value = String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
  if (!value || value.length > 1024) return false;
  try {
    const data = gate.parse(decode(value, "gate"));
    return (
      data.id === publication.id &&
      data.version === publication.version &&
      data.expires > Date.now()
    );
  } catch {
    return false;
  }
}
export function publicationGateCookie(publication: {
  id: string;
  version: number;
  expires_at: string | null;
}) {
  const expires = Math.min(
    Date.now() + 8 * 60 * 60 * 1000,
    publication.expires_at
      ? new Date(publication.expires_at).getTime()
      : Infinity,
  );
  const value = sign(
    { id: publication.id, version: publication.version, expires },
    "gate",
  );
  return cookie(
    gateName(publication.id),
    value,
    Math.max(0, Math.floor((expires - Date.now()) / 1000)),
    "Lax",
  );
}

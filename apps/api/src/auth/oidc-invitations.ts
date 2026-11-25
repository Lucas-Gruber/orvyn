import type { PoolClient } from "pg";
import { randomBytes } from "node:crypto";
import { db, hash, fail, user } from "../runtime.js";
import { cookie, encrypt, decrypt } from "./security.js";

const cookieName = "orvyn_oidc_invitation";
export function invitationBrowser(req: any): string | undefined {
  const value = (req.headers.cookie || "")
    .split(";")
    .map((s: string) => s.trim())
    .find((s: string) => s.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}
export async function prepareInvitation(
  c: PoolClient,
  req: any,
  token: unknown,
) {
  if (token === undefined) return null;
  if (typeof token !== "string" || !/^[a-zA-Z0-9_-]{20,64}$/.test(token))
    fail(400, "Invalid invitation");
  const invitation = await c.query(
    "SELECT token_hash FROM space_invitations WHERE token_hash=$1 AND expires_at>now() FOR SHARE",
    [hash(token as string)],
  );
  if (!invitation.rowCount) fail(400, "Invalid or expired invitation");
  const previous = invitationBrowser(req);
  if (previous)
    await c.query(
      "DELETE FROM oidc_invitation_continuations WHERE browser_hash=$1",
      [hash(previous)],
    );
  const browser = randomBytes(32).toString("hex");
  await c.query(
    "INSERT INTO oidc_invitation_continuations(browser_hash,invitation_hash,encrypted_invitation,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
    [hash(browser), hash(token as string), encrypt(token as string)],
  );
  return browser;
}
export function invitationCookie(res: any, browser: string) {
  res.append("Set-Cookie", cookie(cookieName, browser, 600, "Lax"));
}
export async function bindInvitation(
  c: PoolClient,
  req: any,
  continuation: string | null,
  uid: string,
) {
  const browser = invitationBrowser(req);
  if (!browser || hash(browser) !== continuation) return false;
  const result = await c.query(
    "UPDATE oidc_invitation_continuations SET user_id=$2 WHERE browser_hash=$1 AND expires_at>now() RETURNING browser_hash",
    [continuation, uid],
  );
  return !!result.rowCount;
}
export async function resumeInvitation(req: any, res: any) {
  const browser = invitationBrowser(req);
  if (!browser) return { invitationToken: null };
  const row = (
    await db.query(
      "SELECT encrypted_invitation,user_id FROM oidc_invitation_continuations WHERE browser_hash=$1 AND expires_at>now()",
      [hash(browser)],
    )
  ).rows[0];
  if (!row) {
    res.append("Set-Cookie", cookie(cookieName, "", 0, "Lax"));
    return { invitationToken: null };
  }
  if (row.user_id && (await user(req)) !== row.user_id)
    fail(
      403,
      "Sign in with the account that completed this invitation login, or reopen your original invitation link",
    );
  return { invitationToken: decrypt(row.encrypted_invitation) };
}
export async function forgetInvitation(req: any, res: any) {
  const browser = invitationBrowser(req);
  if (browser)
    await db.query(
      "DELETE FROM oidc_invitation_continuations WHERE browser_hash=$1",
      [hash(browser)],
    );
  res.append("Set-Cookie", cookie(cookieName, "", 0, "Lax"));
  return { ok: true };
}

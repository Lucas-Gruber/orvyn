import nodemailer from "nodemailer";
import { PoolClient } from "pg";
import { randomBytes } from "node:crypto";
import { hash, db } from "../runtime";
import { encrypt, decrypt, origin, transaction } from "./security";
export async function queueMail(
  c: PoolClient,
  to: string,
  subject: string,
  body: string,
) {
  await c.query("INSERT INTO mail_outbox(payload) VALUES($1)", [
    encrypt(JSON.stringify({ to, subject, text: body })),
  ]);
}
export async function accountLink(
  c: PoolClient,
  uid: string,
  email: string,
  purpose: "verify-email" | "reset-password",
) {
  const token = randomBytes(32).toString("hex");
  await c.query("DELETE FROM account_tokens WHERE user_id=$1 AND purpose=$2", [
    uid,
    purpose,
  ]);
  await c.query(
    "INSERT INTO account_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,$3,now()+interval '30 minutes')",
    [hash(token), uid, purpose],
  );
  const url = new URL("/", origin());
  url.hash = new URLSearchParams({ action: purpose, token }).toString();
  const subject =
    purpose === "verify-email"
      ? "Verify your Orvyn email"
      : "Reset your Orvyn password";
  await c.query("INSERT INTO mail_outbox(payload) VALUES($1)", [
    encrypt(
      JSON.stringify({
        to: email,
        subject,
        text: `${subject}\n\n${url}\n\nThis link expires in 30 minutes. If you did not request this, ignore this email.`,
      }),
    ),
  ]);
}
export async function deliverMailBatch() {
  if (!process.env.SMTP_URL) return;
  const transport = nodemailer.createTransport(process.env.SMTP_URL);
  try {
    for (let i = 0; i < 10; i++) {
      const found = await transaction(async (c) => {
        const r = await c.query(
          "SELECT id,payload,attempts FROM mail_outbox WHERE sent_at IS NULL AND available_at<=now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
        );
        if (!r.rowCount) return false;
        const item = r.rows[0];
        try {
          await transport.sendMail({
            ...JSON.parse(decrypt(item.payload)),
            from: process.env.MAIL_FROM || "orvyn@localhost.test",
          });
          await c.query(
            "UPDATE mail_outbox SET sent_at=now(),payload='' WHERE id=$1",
            [item.id],
          );
        } catch {
          await c.query(
            "UPDATE mail_outbox SET attempts=attempts+1,available_at=now()+interval '1 minute'*least(60,power(2,least(attempts,6))) WHERE id=$1",
            [item.id],
          );
          console.error("Mail delivery deferred");
        }
        return true;
      });
      if (!found) break;
    }
  } finally {
    transport.close();
  }
}
export async function cleanupAuth() {
  await db.query("DELETE FROM sessions WHERE expires_at<now()");
  await db.query("DELETE FROM account_tokens WHERE expires_at<now()");
  await db.query("DELETE FROM oidc_flows WHERE expires_at<now()");
  await db.query("DELETE FROM space_invitations WHERE expires_at<now()");
  await db.query("DELETE FROM auth_limits WHERE reset_at<now()");
  await db.query(
    "DELETE FROM mail_outbox WHERE sent_at < now()-interval '7 days'",
  );
}

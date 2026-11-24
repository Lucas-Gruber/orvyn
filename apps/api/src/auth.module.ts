import {
  Module,
  Controller,
  Get,
  Post,
  Delete,
  Req,
  Res,
  Body,
  Param,
} from "@nestjs/common";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { db, derive, hash, fail, text, mutation, user } from "./runtime.js";
import {
  transaction,
  audit,
  issueSession,
  sessionToken,
  passwordInput,
  cookie,
  rateLimit,
} from "./auth/security.js";
import { accountLink } from "./auth/mail.js";
import { administratorSql } from "./auth/deployment-oidc.js";

function emailInput(value: unknown) {
  const email = text(value, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Invalid email");
  return email;
}
async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await derive(password, salt)).toString("hex")}`;
}
async function validPassword(
  password: string,
  stored: string | null | undefined,
) {
  const [salt, digest] = (
    stored || "00000000000000000000000000000000:" + "0".repeat(128)
  ).split(":");
  return (
    timingSafeEqual(await derive(password, salt), Buffer.from(digest, "hex")) &&
    !!stored
  );
}
async function consumeToken(c: PoolClient, token: string, purpose: string) {
  const found = await c.query(
    "SELECT user_id FROM account_tokens WHERE token_hash=$1 AND purpose=$2 AND expires_at>now()",
    [hash(token), purpose],
  );
  if (!found.rowCount) return fail(400, "Invalid or expired link");
  // Always lock the user before token rows, matching token issuance and login.
  await c.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [
    found.rows[0].user_id,
  ]);
  const r = await c.query(
    "DELETE FROM account_tokens WHERE token_hash=$1 AND purpose=$2 AND expires_at>now() RETURNING user_id",
    [hash(token), purpose],
  );
  if (!r.rowCount) return fail(400, "Invalid or expired link");
  return r.rows[0].user_id as string;
}
@Controller("api/v1/auth")
class AuthController {
  @Post("register") async register(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
    @Body() body: any,
  ) {
    mutation(req);
    await rateLimit("credentials-peer:" + req.ip, 500);
    const email = emailInput(body?.email),
      password = passwordInput(body?.password);
    await rateLimit("credentials-account-peer:" + req.ip + ":" + email, 30);
    await rateLimit("credentials-account:" + email, 100);
    const digest = await passwordHash(password);
    return transaction(async (c) => {
      const r = await c.query(
        "INSERT INTO users(email,password_hash) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id",
        [email, digest],
      );
      if (!r.rowCount)
        return fail(409, "Account cannot be created with these details");
      const uid = r.rows[0].id;
      await accountLink(c, uid, email, "verify-email");
      await audit(c, uid, "account.registered");
      await issueSession(c, uid, res);
      return { email, emailVerified: false };
    });
  }
  @Post("login") async login(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
    @Body() body: any,
  ) {
    mutation(req);
    await rateLimit("credentials-peer:" + req.ip, 500);
    const email = emailInput(body?.email),
      password = passwordInput(body?.password);
    await rateLimit("credentials-account-peer:" + req.ip + ":" + email, 30);
    await rateLimit("credentials-account:" + email, 100);
    return transaction(async (c) => {
      const r = await c.query(
        "SELECT id,password_hash,email_verified FROM users WHERE email=$1 FOR NO KEY UPDATE",
        [email],
      );
      if (!(await validPassword(password, r.rows[0]?.password_hash))) {
        await audit(c, null, "account.login_failed");
        return { invalid: true } as const;
      }
      await issueSession(c, r.rows[0].id, res);
      await audit(c, r.rows[0].id, "account.login");
      return { email, emailVerified: r.rows[0].email_verified };
    }).then((result) => {
      if ("invalid" in result) return fail(401, "Invalid credentials");
      return result;
    });
  }
  @Post("logout") async logout(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
  ) {
    mutation(req);
    const token = sessionToken(req);
    if (token)
      await transaction(async (c) => {
        const r = await c.query(
          "DELETE FROM sessions WHERE token_hash=$1 RETURNING user_id",
          [hash(token)],
        );
        if (r.rowCount) await audit(c, r.rows[0].user_id, "session.logout");
      });
    res.setHeader("Set-Cookie", cookie("orvyn_session", "", 0));
    return { ok: true };
  }
  @Get("me") async me(@Req() req: any) {
    const r = await db.query(
      `SELECT u.id,u.email,u.email_verified AS "emailVerified",${administratorSql} AS "isAdmin" FROM users u WHERE u.id=$1`,
      [await user(req)],
    );
    return r.rows[0];
  }
  @Get("sessions") async sessions(@Req() req: any) {
    const uid = await user(req);
    return (
      await db.query(
        'SELECT id,created_at AS "createdAt",expires_at AS "expiresAt",token_hash=$2 AS current FROM sessions WHERE user_id=$1 AND expires_at>now() ORDER BY created_at DESC',
        [uid, hash(sessionToken(req)!)],
      )
    ).rows;
  }
  @Delete("sessions/:id") async revoke(
    @Req() req: any,
    @Param("id") id: string,
    @Res({ passthrough: true }) res: any,
  ) {
    mutation(req);
    const uid = await user(req);
    await transaction(async (c) => {
      const r = await c.query(
        "DELETE FROM sessions WHERE id::text=$1 AND user_id=$2 RETURNING token_hash",
        [id, uid],
      );
      if (!r.rowCount) fail(404, "Session not found");
      await audit(c, uid, "session.revoked");
      if (r.rows[0].token_hash === hash(sessionToken(req)!))
        res.setHeader("Set-Cookie", cookie("orvyn_session", "", 0));
    });
    return { ok: true };
  }
  @Post("logout-all") async logoutAll(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
  ) {
    mutation(req);
    const uid = await user(req);
    await transaction(async (c) => {
      await c.query("DELETE FROM sessions WHERE user_id=$1", [uid]);
      await audit(c, uid, "session.revoked_all");
    });
    res.setHeader("Set-Cookie", cookie("orvyn_session", "", 0));
    return { ok: true };
  }
  @Post("request-verification") async requestVerification(@Req() req: any) {
    mutation(req);
    const uid = await user(req);
    await rateLimit("verify:" + uid, 5);
    await transaction(async (c) => {
      const r = await c.query(
        "SELECT email,email_verified FROM users WHERE id=$1 FOR NO KEY UPDATE",
        [uid],
      );
      if (!r.rows[0].email_verified)
        await accountLink(c, uid, r.rows[0].email, "verify-email");
    });
    return { ok: true };
  }
  @Post("verify-email") async verify(@Req() req: any, @Body() body: any) {
    mutation(req);
    await rateLimit("verify-token:" + req.ip);
    const token = text(body?.token, 64);
    await transaction(async (c) => {
      const uid = await consumeToken(c, token, "verify-email");
      await c.query("UPDATE users SET email_verified=true WHERE id=$1", [uid]);
      await audit(c, uid, "account.email_verified");
    });
    return { ok: true };
  }
  @Post("request-password-reset") async requestReset(
    @Req() req: any,
    @Body() body: any,
  ) {
    mutation(req);
    await rateLimit("reset:" + req.ip, 10);
    const email = emailInput(body?.email);
    await transaction(async (c) => {
      const r = await c.query(
        "SELECT id FROM users WHERE email=$1 AND password_hash IS NOT NULL FOR NO KEY UPDATE",
        [email],
      );
      if (r.rowCount)
        await accountLink(c, r.rows[0].id, email, "reset-password");
    });
    return { ok: true };
  }
  @Post("reset-password") async resetPassword(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
    @Body() body: any,
  ) {
    mutation(req);
    await rateLimit("reset-token:" + req.ip);
    const token = text(body?.token, 64),
      digest = await passwordHash(passwordInput(body?.password));
    await transaction(async (c) => {
      const uid = await consumeToken(c, token, "reset-password");
      await c.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
        digest,
        uid,
      ]);
      await c.query("DELETE FROM sessions WHERE user_id=$1", [uid]);
      await c.query("DELETE FROM account_tokens WHERE user_id=$1", [uid]);
      await audit(c, uid, "account.password_reset");
    });
    res.setHeader("Set-Cookie", cookie("orvyn_session", "", 0));
    return { ok: true };
  }
}
@Module({ controllers: [AuthController] })
export class AuthModule {}

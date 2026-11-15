import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  request,
  sessionCookie,
  waitForMail,
  emailToken,
  Pool,
} from "./helpers.mjs";
test("SMTP verification, one-use password reset, session ownership and revocation", async () => {
  const email = randomUUID() + "@example.test",
    password = "  " + randomUUID() + "  ";
  const registered = await request("auth/register", {
    method: "POST",
    body: { email, password },
  });
  assert.equal(registered.response.status, 201);
  const first = sessionCookie(registered.response);
  assert.ok(first);
  assert.equal(
    (await request("auth/me", { cookie: first })).data.emailVerified,
    false,
  );
  const mail = await waitForMail(email, "Verify your Orvyn email");
  const token = emailToken(mail);
  assert.equal(
    (await request("auth/verify-email", { method: "POST", body: { token } }))
      .response.status,
    201,
  );
  assert.equal(
    (await request("auth/verify-email", { method: "POST", body: { token } }))
      .response.status,
    400,
  );
  assert.equal(
    (await request("auth/me", { cookie: first })).data.emailVerified,
    true,
  );
  const login = await request("auth/login", {
    method: "POST",
    body: { email, password },
  });
  assert.equal(login.response.status, 201);
  const second = sessionCookie(login.response);
  // Password whitespace must remain significant.
  assert.equal(
    (
      await request("auth/login", {
        method: "POST",
        body: { email, password: password.trim() },
      })
    ).response.status,
    401,
  );
  const sessions = await request("auth/sessions", { cookie: first });
  assert.equal(sessions.data.length, 2);
  const current = sessions.data.find((s) => s.current);
  assert.ok(current);
  assert.equal(JSON.stringify(sessions.data).includes("token_hash"), false);
  const otherEmail = randomUUID() + "@example.test";
  const outsider = await request("auth/register", {
    method: "POST",
    body: { email: otherEmail, password },
  });
  const foreign = sessionCookie(outsider.response);
  assert.equal(
    (
      await request("auth/sessions/" + current.id, {
        method: "DELETE",
        body: {},
        cookie: foreign,
      })
    ).response.status,
    404,
  );
  assert.equal(
    (
      await request("auth/sessions/" + current.id, {
        method: "DELETE",
        body: {},
        cookie: second,
      })
    ).response.status,
    200,
  );
  assert.equal(
    (await request("auth/me", { cookie: first })).response.status,
    401,
  );
  const missing = await request("auth/request-password-reset", {
    method: "POST",
    body: { email: "missing-" + email },
  });
  const reset = await request("auth/request-password-reset", {
    method: "POST",
    body: { email },
  });
  assert.deepEqual(missing.data, reset.data);
  assert.equal(reset.response.status, 201);
  const resetToken = emailToken(
      await waitForMail(email, "Reset your Orvyn password"),
    ),
    nextPassword = randomUUID();
  assert.equal(
    (
      await request("auth/reset-password", {
        method: "POST",
        body: { token: resetToken, password: nextPassword },
      })
    ).response.status,
    201,
  );
  assert.equal(
    (
      await request("auth/reset-password", {
        method: "POST",
        body: { token: resetToken, password: nextPassword },
      })
    ).response.status,
    400,
  );
  assert.equal(
    (await request("auth/me", { cookie: second })).response.status,
    401,
  );
  assert.equal(
    (await request("auth/login", { method: "POST", body: { email, password } }))
      .response.status,
    401,
  );
  const nextLogin = await request("auth/login", {
    method: "POST",
    body: { email, password: nextPassword },
  });
  assert.equal(nextLogin.response.status, 201);
  const last = sessionCookie(nextLogin.response);
  await request("auth/logout-all", { method: "POST", body: {}, cookie: last });
  assert.equal(
    (await request("auth/me", { cookie: last })).response.status,
    401,
  );
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const audit = await db.query(
      "SELECT event FROM audit_events WHERE actor_id=(SELECT id FROM users WHERE email=$1)",
      [email],
    );
    for (const event of [
      "account.registered",
      "account.email_verified",
      "account.password_reset",
      "session.revoked",
      "session.revoked_all",
    ])
      assert.ok(
        audit.rows.some((r) => r.event === event),
        event,
      );
    const outbox = await db.query(
      "SELECT payload FROM mail_outbox WHERE sent_at IS NOT NULL",
    );
    assert.ok(outbox.rows.every((r) => r.payload === ""));
  } finally {
    await db.end();
  }
});

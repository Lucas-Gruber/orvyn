import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { oidcProvider } from "./oidc-provider.mjs";
import { oidcTestApp } from "./oidc-test-app.mjs";
import { chromium, expect } from "./browser-tools.mjs";
import { sessionCookie } from "./helpers.mjs";
const cookies = (response) =>
  response.headers
    .getSetCookie()
    .filter((value) => !/Max-Age=0(?:;|$)/.test(value))
    .map((value) => value.split(";")[0])
    .join("; ");
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function provider(app, f, autoProvision = true) {
  const result = await app.call("admin/oidc/providers", {
    method: "POST",
    cookie: app.cookie,
    body: {
      name: "Company SSO",
      issuer: f.issuer,
      clientId: f.clientId,
      clientSecret: f.secret,
      clientAuthMethod: "client_secret_post",
      scopes: "openid email profile",
      enabled: true,
      autoProvision,
    },
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  return result.data;
}
async function begin(app, p, invitationToken) {
  const result = await app.call(`oidc/${p.id}/start`, {
    method: "POST",
    body: {
      ...(invitationToken ? { invitationToken } : {}),
      returnTo: "https://evil.example/stolen",
    },
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  const authorization = await fetch(result.data.url, { redirect: "manual" }),
    callback = new URL(authorization.headers.get("location"));
  return { cookie: cookies(result.response), callback, start: result };
}
async function finish(app, attempt, accept = "text/html") {
  return app.call(
    attempt.callback.pathname.replace("/api/v1/", "") + attempt.callback.search,
    { cookie: attempt.cookie, accept },
  );
}
async function unchanged(app, invitation) {
  assert.equal(
    (
      await app.db.query(
        "SELECT count(*)::int AS n FROM space_invitations WHERE token_hash=$1",
        [digest(invitation.token)],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await app.db.query(
        "SELECT count(*)::int AS n FROM space_members WHERE space_id=$1",
        [app.space.id],
      )
    ).rows[0].n,
    0,
  );
}

test(
  "browser callback errors return safe login codes; JSON clients retain statuses, strict verification and existing identity behavior",
  { timeout: 120000 },
  async () => {
    const app = await oidcTestApp(),
      f = await oidcProvider();
    try {
      const p = await provider(app, f, false);
      for (const browser of [true, false]) {
        const attempt = await begin(app, p),
          result = await finish(
            app,
            attempt,
            browser ? "text/html" : "application/json",
          );
        if (browser) {
          assert.equal(result.response.status, 303);
          assert.equal(
            result.response.headers.get("location"),
            app.origin + "/?authError=provisioning_disabled",
          );
          assert.equal(
            result.response.headers.get("referrer-policy"),
            "no-referrer",
          );
        } else {
          assert.equal(result.response.status, 403);
          assert.match(result.data.message, /disabled/);
        }
        assert.equal(sessionCookie(result.response), undefined);
        assert.ok(
          result.response.headers
            .getSetCookie()
            .some((value) => /orvyn_oidc_.*Max-Age=0/.test(value)),
        );
        assert.ok(
          !JSON.stringify([...result.response.headers]).includes(
            attempt.callback.searchParams.get("code"),
          ),
        );
      }
      await app.db.query(
        "UPDATE oidc_providers SET auto_provision=true WHERE id=$1",
        [p.id],
      );
      f.claims.email_verified = false;
      let result = await finish(app, await begin(app, p));
      assert.equal(
        new URL(result.response.headers.get("location")).searchParams.get(
          "authError",
        ),
        "email_unverified",
      );
      f.claims.email_verified = true;
      f.claims.email = "owner@example.test";
      result = await finish(app, await begin(app, p));
      assert.equal(
        new URL(result.response.headers.get("location")).searchParams.get(
          "authError",
        ),
        "account_exists",
      );
      assert.equal(
        (
          await app.db.query(
            "SELECT count(*)::int AS n FROM external_identities",
          )
        ).rows[0].n,
        0,
      );
      f.claims.email = randomUUID() + "@example.test";
      result = await finish(app, await begin(app, p));
      assert.equal(result.response.status, 303);
      assert.ok(sessionCookie(result.response));
      await app.db.query(
        "UPDATE oidc_providers SET auto_provision=false WHERE id=$1",
        [p.id],
      );
      result = await finish(app, await begin(app, p));
      assert.ok(
        sessionCookie(result.response),
        "An already linked identity still signs in with provisioning disabled",
      );
      const invalid = await app.call(
        `oidc/${p.id}/callback?state=invalid&error_description=${encodeURIComponent(f.secret)}`,
        { accept: "text/html" },
      );
      assert.equal(invalid.response.status, 303);
      assert.equal(
        invalid.response.headers.get("location"),
        app.origin + "/?authError=invalid_login",
      );
      assert.ok(!app.output.includes(f.secret));
    } finally {
      await app.close();
      await f.close();
    }
  },
);

test(
  "SSO invitations remain browser-bound, encrypted, explicit and protected from failure, wrong identities, replay, CSRF and expiry",
  { timeout: 120000 },
  async () => {
    const app = await oidcTestApp(),
      f = await oidcProvider();
    try {
      const p = await provider(app, f),
        invitation = await app.invite(f.claims.email),
        attempt = await begin(app, p, invitation.token);
      const continuation = (
        await app.db.query("SELECT * FROM oidc_invitation_continuations")
      ).rows[0];
      assert.equal(continuation.invitation_hash, digest(invitation.token));
      assert.notEqual(continuation.encrypted_invitation, invitation.token);
      assert.ok(!JSON.stringify(continuation).includes(invitation.token));
      assert.match(
        attempt.start.response.headers
          .getSetCookie()
          .find((c) => c.startsWith("orvyn_oidc_invitation=")),
        /HttpOnly; SameSite=Lax; Max-Age=600/,
      );
      assert.ok(!attempt.start.data.url.includes(invitation.token));
      const missing = await app.call("oidc/invitation/resume", {
        method: "POST",
        body: {},
      });
      assert.equal(missing.data.invitationToken, null);
      const csrf = await app.call("oidc/invitation/resume", {
        method: "POST",
        body: {},
        cookie: attempt.cookie,
        requestOrigin: "https://evil.example",
      });
      assert.equal(csrf.response.status, 403);
      const tampered = { ...attempt, callback: new URL(attempt.callback) };
      tampered.callback.searchParams.set(
        "state",
        randomUUID().replaceAll("-", ""),
      );
      const failed = await finish(app, tampered);
      assert.equal(
        new URL(failed.response.headers.get("location")).searchParams.get(
          "authError",
        ),
        "invalid_login",
      );
      assert.equal(
        (
          await app.call("oidc/invitation/resume", {
            method: "POST",
            body: {},
            cookie: attempt.cookie,
          })
        ).data.invitationToken,
        invitation.token,
        "A failed callback preserves the anonymous browser-bound invitation",
      );
      assert.equal(
        (await app.call("oidc/invitation/resume")).response.status,
        404,
      );
      const result = await finish(app, attempt),
        session = sessionCookie(result.response);
      assert.equal(
        result.response.headers.get("location"),
        app.origin + "/?resume=invitation",
      );
      assert.ok(session);
      await unchanged(app, invitation);
      assert.equal(
        (
          await app.call("oidc/invitation/resume", {
            method: "POST",
            body: {},
            cookie: attempt.cookie,
          })
        ).response.status,
        401,
        "A bound receipt also requires the completed session",
      );
      const cookie = attempt.cookie + "; " + session;
      for (let i = 0; i < 2; i++)
        assert.equal(
          (
            await app.call("oidc/invitation/resume", {
              method: "POST",
              body: {},
              cookie,
            })
          ).data.invitationToken,
          invitation.token,
          "Reloading the confirmation preserves the invitation",
        );
      const accepted = await app.call("spaces/invitations/accept", {
        method: "POST",
        body: { token: invitation.token },
        cookie,
      });
      assert.equal(accepted.response.status, 201);
      assert.equal(
        (
          await app.db.query(
            "SELECT count(*)::int AS n FROM oidc_invitation_continuations",
          )
        ).rows[0].n,
        0,
        "Accepting removes encrypted continuation records",
      );
      assert.equal(
        (
          await app.call("spaces/invitations/accept", {
            method: "POST",
            body: { token: invitation.token },
            cookie,
          })
        ).response.status,
        400,
      );

      const other = await app.invite(randomUUID() + "@example.test"),
        wrong = await begin(app, p, other.token),
        wrongResult = await finish(app, wrong),
        wrongCookie = wrong.cookie + "; " + sessionCookie(wrongResult.response);
      assert.equal(
        (
          await app.call("spaces/invitations/accept", {
            method: "POST",
            body: { token: other.token },
            cookie: wrongCookie,
          })
        ).response.status,
        403,
      );
      assert.equal(
        (
          await app.db.query(
            "SELECT count(*)::int AS n FROM space_invitations WHERE token_hash=$1",
            [digest(other.token)],
          )
        ).rows[0].n,
        1,
      );
      await app.db.query(
        "UPDATE users SET email_verified=false WHERE email=$1",
        [f.claims.email],
      );
      const unverified = await app.invite(f.claims.email);
      assert.equal(
        (
          await app.call("spaces/invitations/accept", {
            method: "POST",
            body: { token: unverified.token },
            cookie,
          })
        ).response.status,
        403,
      );
      assert.equal(
        (
          await app.db.query(
            "SELECT count(*)::int AS n FROM space_invitations WHERE token_hash=$1",
            [digest(unverified.token)],
          )
        ).rows[0].n,
        1,
      );
      await app.db.query(
        "UPDATE oidc_invitation_continuations SET expires_at=now()-interval '1 second'",
      );
      assert.equal(
        (
          await app.call("oidc/invitation/resume", {
            method: "POST",
            body: {},
            cookie: wrongCookie,
          })
        ).data.invitationToken,
        null,
      );
      const cancelled = await begin(app, p, other.token);
      assert.equal(
        (
          await app.call("oidc/invitation/resume", {
            method: "DELETE",
            body: {},
            cookie: cancelled.cookie,
          })
        ).response.status,
        200,
      );
      assert.equal(
        (
          await app.call("oidc/invitation/resume", {
            method: "POST",
            body: {},
            cookie: cancelled.cookie,
          })
        ).data.invitationToken,
        null,
      );
      assert.ok(!app.output.includes(invitation.token));
      assert.ok(!app.output.includes(other.token));
      assert.ok(!app.output.includes(f.secret));
    } finally {
      await app.close();
      await f.close();
    }
  },
);

test(
  "Chromium: closed registration supports invitation SSO, failure recovery, display names, account switching and explicit acceptance",
  { timeout: 120000 },
  async () => {
    const app = await oidcTestApp(),
      f = await oidcProvider(),
      browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
        headless: true,
        args: ["--no-sandbox"],
      });
    try {
      f.claims.email = "mara.keller@example.test";
      const p = await provider(app, f, false),
        invitation = await app.invite(f.claims.email),
        context = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
        });
      await context.addInitScript(() =>
        localStorage.setItem("orvyn.theme", "light"),
      );
      const page = await context.newPage(),
        requests = [];
      page.on("request", (request) =>
        requests.push({
          url: request.url(),
          referrer: request.headers().referer || "",
        }),
      );
      assert.equal(
        (
          await app.call("auth/register", {
            method: "POST",
            body: {
              email: randomUUID() + "@example.test",
              password: randomUUID(),
            },
          })
        ).response.status,
        403,
      );
      await app.db.query(
        "UPDATE oidc_providers SET enabled=false WHERE id=$1",
        [p.id],
      );
      await page.goto(invitation.link);
      await expect(
        page.getByRole("heading", { name: "Accept space invitation" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Continue with Company SSO" }),
      ).toHaveCount(0);
      await app.db.query("UPDATE oidc_providers SET enabled=true WHERE id=$1", [
        p.id,
      ]);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(
        page.getByRole("button", { name: "Continue with Company SSO" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Create account", exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: "Continue with Company SSO" })
        .click();
      await expect(
        page.getByText(/not enabled account creation through single sign-on/),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Accept space invitation" }),
      ).toBeVisible();
      await unchanged(app, invitation);
      assert.ok(!page.url().includes(invitation.token));
      await mkdir(".local/ui-review", { recursive: true });
      await page.screenshot({
        path: ".local/ui-review/sso-invitation-error.png",
        fullPage: true,
      });
      await app.db.query(
        "UPDATE oidc_providers SET auto_provision=true WHERE id=$1",
        [p.id],
      );
      f.claims.email = randomUUID() + "@example.test";
      await page
        .getByRole("button", { name: "Continue with Company SSO" })
        .click();
      await expect(
        page.getByRole("button", { name: "Accept invitation", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Accept invitation", exact: true })
        .click();
      await expect(
        page.getByRole("alert").filter({ hasText: /invited verified email/ }),
      ).toBeVisible();
      await unchanged(app, invitation);
      await page
        .getByRole("button", { name: "Switch account", exact: true })
        .click();
      f.claims = {
        sub: randomUUID(),
        email: invitation.email,
        email_verified: false,
        name: "Mara Keller",
      };
      await page
        .getByRole("button", { name: "Continue with Company SSO" })
        .click();
      await expect(
        page.getByText(/must supply a verified email address/),
      ).toBeVisible();
      await unchanged(app, invitation);
      f.claims.email_verified = true;
      await page
        .getByRole("button", { name: "Continue with Company SSO" })
        .click();
      await expect(page.locator(".invite-account strong")).toHaveText(
        "Mara Keller",
      );
      await unchanged(app, invitation);
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Accept invitation", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: ".local/ui-review/sso-invitation-confirmation.png",
        fullPage: true,
      });
      assert.ok(
        !JSON.stringify(
          await page.evaluate(() => ({
            local: { ...localStorage },
            session: { ...sessionStorage },
          })),
        ).includes(invitation.token),
      );
      assert.ok(
        !requests.some(
          (request) =>
            request.url.includes(invitation.token) ||
            request.referrer.includes(invitation.token),
        ),
        "Invitation tokens never enter network URLs or referrers",
      );
      assert.ok(
        !page.url().includes("authError") && !page.url().includes("resume"),
      );
      await page
        .getByRole("button", { name: "Accept invitation", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Accept space invitation" }),
      ).toHaveCount(0);
      assert.equal(
        (
          await app.db.query(
            "SELECT count(*)::int AS n FROM space_members WHERE space_id=$1",
            [app.space.id],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (await app.db.query("SELECT count(*)::int AS n FROM space_invitations"))
          .rows[0].n,
        0,
      );
      assert.ok(!app.output.includes(invitation.token));
      assert.ok(!app.output.includes(f.secret));
    } finally {
      await browser.close();
      await app.close();
      await f.close();
    }
  },
);

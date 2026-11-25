import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "./browser-tools.mjs";
import { Pool, base } from "./helpers.mjs";
import {
  readDeploymentOidc,
  configureDeploymentOidc,
} from "../apps/api/dist/auth/deployment-oidc.js";
const execute = promisify(execFile);
const image =
  "quay.io/keycloak/keycloak@sha256:5f3fb534cde6bf006d79f5912473e5d2c828c707cdfc52e16972803aca9d43dd";

test(
  "real Keycloak: deployment OIDC, PKCE, HTTP Basic client authentication and subject-based administrator bootstrap",
  { timeout: 240000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "orvyn-keycloak-")),
      suffix = randomUUID(),
      container = "orvyn-oidc-" + suffix;
    const password = randomUUID(),
      secret = randomUUID(),
      adminPassword = randomUUID(),
      subject = randomUUID();
    const db = new Pool({ connectionString: process.env.DATABASE_URL });
    let browser,
      config,
      uid,
      started = false;
    try {
      let port;
      do {
        const probe = createServer();
        probe.listen(0, "127.0.0.1");
        await once(probe, "listening");
        port = probe.address().port;
        await new Promise((resolve) => probe.close(resolve));
      } while (port === 50002);
      const origin = "http://127.0.0.1:" + port,
        realm = "orvyn-" + suffix,
        issuer = origin + "/realms/" + realm;
      const clientId = "orvyn-" + suffix;
      await writeFile(
        join(directory, "realm.json"),
        JSON.stringify({
          realm,
          enabled: true,
          sslRequired: "none",
          registrationAllowed: false,
          users: [
            {
              id: subject,
              username: "oidc-user",
              email: suffix + "@example.test",
              enabled: true,
              emailVerified: true,
              firstName: "OIDC",
              lastName: "Test",
              credentials: [
                { type: "password", value: password, temporary: false },
              ],
            },
          ],
          clients: [
            {
              clientId,
              enabled: true,
              protocol: "openid-connect",
              publicClient: false,
              secret,
              standardFlowEnabled: true,
              directAccessGrantsEnabled: false,
              redirectUris: [base + "/api/v1/oidc/deployment/callback"],
              webOrigins: [base],
              defaultClientScopes: ["profile", "email"],
              attributes: { "pkce.code.challenge.method": "S256" },
            },
          ],
        }),
        { mode: 0o644 },
      );
      await writeFile(
        join(directory, "keycloak.env"),
        "KC_BOOTSTRAP_ADMIN_USERNAME=fixture-admin\nKC_BOOTSTRAP_ADMIN_PASSWORD=" +
          adminPassword +
          "\nJAVA_OPTS_KC_HEAP=-Xms128m -Xmx512m\n",
        { mode: 0o600 },
      );
      await execute(
        "docker",
        [
          "run",
          "-d",
          "--name",
          container,
          "--env-file",
          join(directory, "keycloak.env"),
          "-p",
          `127.0.0.1:${port}:8080`,
          "--mount",
          `type=bind,src=${join(directory, "realm.json")},dst=/opt/keycloak/data/import/realm.json,readonly`,
          image,
          "start-dev",
          "--http-port=8080",
          "--hostname=" + origin,
          "--import-realm",
          "--log-level=warn",
        ],
        { timeout: 120000 },
      );
      started = true;
      const deadline = Date.now() + 90000;
      while (true) {
        try {
          const response = await fetch(
            issuer + "/.well-known/openid-configuration",
            { signal: AbortSignal.timeout(2000) },
          );
          if (response.ok) {
            assert.equal((await response.json()).issuer, issuer);
            break;
          }
        } catch {}
        if (Date.now() >= deadline)
          throw Error("Keycloak did not become ready");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      config = readDeploymentOidc({
        NODE_ENV: "test",
        ORVYN_OIDC_ALLOW_HTTP_LOCAL: "true",
        ORVYN_OIDC_ENABLED: "true",
        ORVYN_OIDC_ISSUER: issuer,
        ORVYN_OIDC_CLIENT_ID: clientId,
        ORVYN_OIDC_CLIENT_SECRET: secret,
        ORVYN_OIDC_CLIENT_AUTH_METHOD: "client_secret_basic",
        ORVYN_OIDC_NAME: "Deployment Keycloak",
        ORVYN_OIDC_AUTO_PROVISION: "true",
        ORVYN_OIDC_ADMIN_SUBJECT: subject,
      });
      await configureDeploymentOidc(db, config);
      browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
        headless: true,
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      await page.goto(base);
      if (process.env.ORVYN_REGISTRATION_ENABLED === "false") {
        await expect(
          page.getByRole("button", { name: "Create account", exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByText(/Contact your administrator if you need access/),
        ).toBeVisible();
        await mkdir(".local/ui-review", { recursive: true });
        await page.screenshot({
          path: ".local/ui-review/registration-sso-only.png",
          fullPage: true,
        });
      }
      await page
        .getByRole("button", {
          name: "Continue with Deployment Keycloak",
          exact: true,
        })
        .click();
      await page.locator("#username").fill("oidc-user");
      await page.locator("#password").fill(password);
      await page.locator("#kc-login").click();
      await page.waitForURL(
        (url) => url.origin === new URL(base).origin && url.pathname === "/",
      );
      await expect(
        page.getByRole("button", { name: "Account menu", exact: true }),
      ).toBeVisible();
      const response = await page.request.get(base + "/api/v1/auth/me"),
        me = await response.json();
      assert.equal(response.status(), 200);
      assert.equal(me.isAdmin, true);
      assert.equal(me.emailVerified, true);
      uid = me.id;
      const identity = (
        await db.query(
          "SELECT subject FROM external_identities WHERE provider_id=$1 AND user_id=$2",
          [config.id, uid],
        )
      ).rows[0];
      assert.equal(identity.subject, subject);
      assert.equal(
        (await db.query("SELECT is_admin FROM users WHERE id=$1", [uid]))
          .rows[0].is_admin,
        false,
      );
      await page
        .getByRole("button", { name: "SSO administration", exact: true })
        .click();
      await page
        .getByRole("button", { name: /Deployment Keycloak.*Enabled/ })
        .click();
      await expect(
        page.getByLabel("Display name", { exact: true }),
      ).toBeDisabled();
      await expect(
        page
          .locator(".providers li")
          .filter({
            has: page.getByRole("button", {
              name: /Deployment Keycloak.*Enabled/,
            }),
          })
          .getByText("Managed by deployment", { exact: true }),
      ).toBeVisible();
      await mkdir(".local/ui-review", { recursive: true });
      await page.screenshot({
        path: ".local/ui-review/oidc-keycloak-managed.png",
        fullPage: true,
      });
    } catch (error) {
      if (started) {
        const log = await execute("docker", [
          "logs",
          "--tail",
          "20",
          container,
        ]).catch(() => ({ stdout: "", stderr: "" }));
        let safe = log.stdout + log.stderr;
        for (const value of [password, secret, adminPassword])
          safe = safe.replaceAll(value, "[redacted]");
        console.error(safe);
      }
      throw error;
    } finally {
      await browser?.close();
      await configureDeploymentOidc(db, { enabled: false });
      if (uid) {
        await db.query("DELETE FROM spaces WHERE owner_id=$1", [uid]);
        await db.query("DELETE FROM users WHERE id=$1", [uid]);
      }
      if (config)
        await db.query("DELETE FROM oidc_providers WHERE id=$1", [config.id]);
      await db.end();
      await execute("docker", ["rm", "-f", "-v", container]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
);

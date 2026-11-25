import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Pool, base, request } from "./helpers.mjs";
import { chromium, expect } from "./browser-tools.mjs";
import {
  readRegistrationPolicy,
  registrationAllowsEmail,
} from "../apps/api/dist/auth/registration.js";

test("local registration policy validates configuration and matches exact canonical email domains", () => {
  assert.deepEqual(readRegistrationPolicy({}), {
    enabled: true,
    allowedEmailDomains: [],
  });
  const policy = readRegistrationPolicy({
    ORVYN_REGISTRATION_ALLOWED_EMAIL_DOMAINS:
      " Company.Example, büro.example,company.example ",
  });
  assert.deepEqual(policy.allowedEmailDomains, [
    "company.example",
    "xn--bro-hoa.example",
  ]);
  for (const email of [
    "a@company.example",
    "A@COMPANY.EXAMPLE",
    "a@büro.example",
    "a@xn--bro-hoa.example",
  ])
    assert.equal(registrationAllowsEmail(policy, email), true, email);
  for (const email of [
    "a@sub.company.example",
    "a@company.example.evil.test",
    "a@cоmpany.example",
    "company.example",
    "a@company.example.",
    "a@company.example/path",
    "a@@company.example",
  ])
    assert.equal(registrationAllowsEmail(policy, email), false, email);
  assert.equal(
    registrationAllowsEmail({ ...policy, enabled: false }, "a@company.example"),
    false,
  );
  for (const value of ["yes", "FALSE", "", " false "])
    assert.throws(() =>
      readRegistrationPolicy({ ORVYN_REGISTRATION_ENABLED: value }),
    );
  for (const value of [
    "*.company.example",
    "https://company.example",
    "company.example,",
    "company.example?x",
    "company.example\nother.example",
    "-bad.example",
    "company.example/",
    "localhost",
    "a".repeat(64) + ".example",
    Array(21).fill("company.example").join(","),
  ])
    assert.throws(() =>
      readRegistrationPolicy({
        ORVYN_REGISTRATION_ALLOWED_EMAIL_DOMAINS: value,
      }),
    );
});

test(
  "registration restrictions are enforced by the API and login UI while existing access and recovery remain available",
  { timeout: 120000 },
  async () => {
    const children = [],
      db = new Pool({ connectionString: process.env.DATABASE_URL });
    let browser;
    async function freePort() {
      const server = createServer();
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const port = server.address().port;
      await new Promise((resolve) => server.close(resolve));
      return port;
    }
    async function ready(url, child) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null)
          throw Error("Registration test service exited during startup");
        try {
          const response = await fetch(url, {
            signal: AbortSignal.timeout(1000),
          });
          if (response.ok) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw Error("Registration test service did not become ready");
    }
    async function instance(policy) {
      const apiPort = await freePort();
      let webPort;
      do {
        webPort = await freePort();
      } while (webPort === apiPort);
      const origin = "http://127.0.0.1:" + webPort;
      const common = {
        ...process.env,
        ...policy,
        ORVYN_ORIGIN: origin,
        ORVYN_OIDC_BOOTSTRAP_MODE: "external",
      };
      const api = spawn(process.execPath, ["apps/api/dist/main.js"], {
        env: { ...common, PORT: String(apiPort) },
        stdio: "ignore",
      });
      children.push(api);
      await ready(`http://127.0.0.1:${apiPort}/api/v1/health`, api);
      const web = spawn(
        process.execPath,
        ["apps/web/.output/server/index.mjs"],
        {
          env: {
            ...common,
            NITRO_HOST: "127.0.0.1",
            NITRO_PORT: String(webPort),
            NUXT_API_URL: `http://127.0.0.1:${apiPort}`,
          },
          stdio: "ignore",
        },
      );
      children.push(web);
      await ready(origin + "/api/v1/health", web);
      const call = async (path, body) =>
        fetch(origin + "/api/v1/" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      return { origin, call };
    }
    try {
      const email = randomUUID() + "@outside.example",
        password = randomUUID();
      assert.equal(
        (
          await request("auth/register", {
            method: "POST",
            body: { email, password },
          })
        ).response.status,
        201,
      );
      const closed = await instance({
        ORVYN_REGISTRATION_ENABLED: "false",
        ORVYN_REGISTRATION_ALLOWED_EMAIL_DOMAINS: "company.example",
      });
      const options = await closed.call("auth/options");
      assert.equal(options.status, 200);
      assert.equal(options.headers.get("cache-control"), "no-store");
      assert.deepEqual(await options.json(), {
        registration: {
          enabled: false,
          allowedEmailDomains: ["company.example"],
        },
      });
      const blockedEmail = randomUUID() + "@company.example";
      const blocked = await closed.call("auth/register", {
        email: blockedEmail,
        password,
        registration: { enabled: true },
      });
      assert.equal(blocked.status, 403);
      assert.equal(blocked.headers.getSetCookie().length, 0);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM users WHERE email=$1",
            [blockedEmail],
          )
        ).rows[0].count,
        0,
      );
      assert.equal((await closed.call("oidc/providers")).status, 200);
      assert.ok(
        (await closed.call("auth/request-password-reset", { email })).ok,
      );

      const restricted = await instance({
        ORVYN_REGISTRATION_ENABLED: "true",
        ORVYN_REGISTRATION_ALLOWED_EMAIL_DOMAINS: "company.example",
      });
      for (const domain of [
        "outside.example",
        "sub.company.example",
        "company.example.evil.test",
      ]) {
        const rejected = randomUUID() + "@" + domain;
        assert.equal(
          (
            await restricted.call("auth/register", {
              email: rejected,
              password,
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int AS count FROM users WHERE email=$1",
              [rejected],
            )
          ).rows[0].count,
          0,
        );
      }
      const accepted = randomUUID() + "@COMPANY.EXAMPLE";
      assert.equal(
        (await restricted.call("auth/register", { email: accepted, password }))
          .status,
        201,
      );
      assert.equal(
        (
          await restricted.call("auth/register", {
            email: "bad\u0000@company.example",
            password,
          })
        ).status,
        400,
      );
      assert.ok(
        (await restricted.call("auth/login", { email, password })).ok,
        "Domain policy must not lock out existing accounts",
      );

      browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
        headless: true,
        args: ["--no-sandbox"],
      });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      await context.addInitScript(() =>
        localStorage.setItem("orvyn.theme", "light"),
      );
      const page = await context.newPage();
      await page.goto(closed.origin);
      await expect(
        page.getByRole("button", { name: "Sign in", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Create account", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText(/Contact your administrator if you need access/),
      ).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await mkdir(".local/ui-review", { recursive: true });
      await page.screenshot({
        path: ".local/ui-review/registration-closed.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.screenshot({
        path: ".local/ui-review/registration-closed-mobile.png",
        fullPage: true,
      });
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page
        .getByLabel("Password · at least 12 characters", { exact: true })
        .fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Account menu", exact: true }),
      ).toBeVisible();
      await context.clearCookies();

      const allowedPage = await context.newPage();
      await allowedPage.goto(restricted.origin);
      await expect(
        allowedPage.getByRole("button", {
          name: "Create account",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        allowedPage.getByText(
          "New accounts require an email address at company.example.",
          { exact: true },
        ),
      ).toBeVisible();
      await allowedPage.screenshot({
        path: ".local/ui-review/registration-domain.png",
        fullPage: true,
      });
      const longDomain = [
        "a".repeat(63),
        "b".repeat(63),
        "c".repeat(63),
        "example",
      ].join(".");
      await allowedPage.route("**/api/v1/auth/options", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            registration: { enabled: true, allowedEmailDomains: [longDomain] },
          }),
        }),
      );
      await allowedPage.setViewportSize({ width: 390, height: 844 });
      await allowedPage.reload();
      await expect(
        allowedPage.locator(".auth-registration-note"),
      ).toContainText(longDomain);
      assert.equal(
        await allowedPage.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        "Long valid domain names must wrap on mobile",
      );

      const failure = await context.newPage();
      await failure.route("**/api/v1/auth/options", (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"message":"Unavailable"}',
        }),
      );
      await failure.goto(base);
      await expect(
        failure.getByText(/Account creation options could not be loaded/),
      ).toBeVisible();
      await expect(
        failure.getByRole("button", { name: "Create account", exact: true }),
      ).toHaveCount(0);
      await expect(
        failure.getByRole("button", { name: "Sign in", exact: true }),
      ).toBeVisible();
      await failure.unroute("**/api/v1/auth/options");
      await failure
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await expect(
        failure.getByRole("button", { name: "Create account", exact: true }),
      ).toBeVisible();
    } finally {
      await browser?.close();
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null) return;
          const exited = once(child, "exit");
          child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
          timer.unref();
          await exited;
          clearTimeout(timer);
        }),
      );
      await db.end();
    }
  },
);

test("invalid registration settings stop API startup without echoing their value", async () => {
  const value = "invalid-private-value-" + randomUUID();
  const child = spawn(process.execPath, ["apps/api/dist/main.js"], {
    env: { ...process.env, ORVYN_REGISTRATION_ENABLED: value },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.match(output, /ORVYN_REGISTRATION_ENABLED must be true or false/);
  assert.equal(output.includes(value), false);
});

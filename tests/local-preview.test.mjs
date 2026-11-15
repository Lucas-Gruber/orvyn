import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { base } from "./helpers.mjs";
for (const codespaces of [false, true])
  test(
    codespaces
      ? "Codespaces preview derives HTTPS origin and secure cookies while preserving process isolation"
      : "local preview starts the full stack with one command and stops only its own services",
    async () => {
      const reservation = createServer();
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      const port = reservation.address().port;
      await new Promise((r) => reservation.close(r));
      const child = spawn(
        process.execPath,
        ["scripts/preview-local.mjs", "--skip-setup", "--port", String(port)],
        {
          env: {
            ...process.env,
            CODESPACES: codespaces ? "true" : "false",
            CODESPACE_NAME: "orvyn-test",
            GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "forwarded.example.test",
            ORVYN_PREVIEW_ORIGIN: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (b) => (output += b));
      child.stderr.on("data", (b) => (output += b));
      const preview = "http://127.0.0.1:" + port;
      const browserOrigin = codespaces
        ? `https://orvyn-test-${port}.forwarded.example.test`
        : "http://localhost:" + port;
      try {
        const deadline = Date.now() + 12000;
        while (
          Date.now() < deadline &&
          !output.includes("ORVYN_LOCAL_PREVIEW_READY")
        ) {
          assert.equal(child.exitCode, null, output.slice(-1500));
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.ok(
          output.includes("ORVYN_LOCAL_PREVIEW_READY"),
          output.slice(-1500),
        );
        assert.equal((await fetch(preview + "/api/v1/health")).status, 200);
        assert.ok(
          (await (await fetch(preview)).text()).includes("Your knowledge"),
        );
        const valid = await fetch(preview + "/api/v1/auth/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: browserOrigin,
          },
          body: "{}",
        });
        assert.equal(
          valid.status,
          400,
          "own browser port is accepted before payload validation",
        );
        const forbidden = await fetch(preview + "/api/v1/auth/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://untrusted.example.test",
          },
          body: "{}",
        });
        assert.equal(forbidden.status, 403);
        assert.ok(
          output.includes("ORVYN_LOCAL_PREVIEW_READY " + browserOrigin),
        );
        const signup = await fetch(preview + "/api/v1/auth/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: browserOrigin,
          },
          body: JSON.stringify({
            email: randomUUID() + "@example.test",
            password: randomUUID(),
          }),
        });
        assert.equal(signup.status, 201);
        const cookie = signup.headers
          .getSetCookie()
          .find((c) => c.startsWith("orvyn_session="));
        assert.ok(cookie.includes("HttpOnly"));
        assert.equal(
          cookie.includes("Secure"),
          codespaces,
          "HTTPS previews use secure session cookies",
        );
        assert.equal(
          (
            await fetch(preview + "/api/v1/auth/me", {
              headers: { Cookie: cookie.split(";")[0] },
            })
          ).status,
          200,
        );
      } finally {
        if (child.exitCode === null) {
          const finished = once(child, "exit");
          child.kill("SIGTERM");
          let timer;
          await Promise.race([
            finished,
            new Promise(
              (_, reject) =>
                (timer = setTimeout(() => {
                  child.kill("SIGKILL");
                  reject(Error("Local preview failed to stop"));
                }, 8000)),
            ),
          ]).finally(() => clearTimeout(timer));
        }
      }
      assert.equal(child.exitCode, 0, output.slice(-1500));
      const api = /ORVYN_READY http:\/\/127\.0\.0\.1:(\d+)/.exec(output),
        collaboration =
          /ORVYN_COLLABORATION_READY http:\/\/0\.0\.0\.0:(\d+)/.exec(output);
      assert.ok(api);
      assert.ok(collaboration);
      for (const p of [port, Number(api[1]), Number(collaboration[1])])
        await assert.rejects(
          fetch("http://127.0.0.1:" + p + "/api/v1/health", {
            signal: AbortSignal.timeout(1000),
          }),
        );
      assert.equal(
        (await fetch(base + "/api/v1/health")).status,
        200,
        "unrelated running application remains available",
      );
    },
  );

test("preview rejects remote plaintext origins before starting services", async () => {
  const child = spawn(
    process.execPath,
    ["scripts/preview-local.mjs", "--skip-setup"],
    {
      env: {
        ...process.env,
        ORVYN_PREVIEW_ORIGIN: "http://untrusted.example.test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.ok(stderr.includes("Preview origin must be an HTTPS origin"));
});

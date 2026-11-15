import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "./helpers.mjs";
test("credential throttling blocks repeated account attempts without locking every user behind the proxy", async () => {
  const email = randomUUID() + "@example.test",
    password = randomUUID();
  for (let i = 0; i < 30; i++)
    assert.equal(
      (
        await request("auth/login", {
          method: "POST",
          body: { email, password },
        })
      ).response.status,
      401,
    );
  assert.equal(
    (await request("auth/login", { method: "POST", body: { email, password } }))
      .response.status,
    429,
  );
  assert.equal(
    (
      await request("auth/register", {
        method: "POST",
        body: { email: randomUUID() + "@example.test", password },
      })
    ).response.status,
    201,
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { request, Pool } from "./helpers.mjs";
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

test("the 500-attempt peer ceiling remains enforced within a test file", async () => {
  const email = randomUUID() + "@example.test",
    password = randomUUID();
  assert.equal(
    (await request("auth/login", { method: "POST", body: { email, password } }))
      .response.status,
    401,
  );
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const keys = ["127.0.0.1", "::ffff:127.0.0.1", "::1"].map((ip) =>
      createHash("sha256")
        .update("credentials-peer:" + ip)
        .digest("hex"),
    );
    const seeded = await db.query(
      "UPDATE auth_limits SET attempts=499,reset_at=now()+interval '15 minutes' WHERE key=ANY($1::text[]) RETURNING key",
      [keys],
    );
    assert.equal(seeded.rowCount, 1, "Seed the actual loopback peer counter");
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
      (
        await request("auth/register", {
          method: "POST",
          body: { email, password },
        })
      ).response.status,
      429,
    );
    // Leave the counter exhausted: the next test file must start independently.
  } finally {
    await db.end();
  }
});

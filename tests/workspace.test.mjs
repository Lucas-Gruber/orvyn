import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "./helpers.mjs";
test("private workspace persists documents, enforces isolation, CSRF, conflicts and logout", async () => {
  const password = "test-only-" + randomUUID();
  const account = async () => {
    const r = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password },
    });
    assert.equal(r.response.status, 201);
    const cookie = r.response.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    return cookie.split(";")[0];
  };
  const a = await account(),
    b = await account();
  assert.equal((await request("spaces")).response.status, 401);
  assert.equal(
    (
      await request("spaces", {
        method: "POST",
        cookie: a,
        origin: "https://evil.example",
        body: { name: "invalid" },
      })
    ).response.status,
    403,
  );
  const s = await request("spaces", {
    method: "POST",
    cookie: a,
    body: { name: "Private test" },
  });
  assert.equal(s.response.status, 201);
  assert.equal(
    (await request("spaces", { cookie: b })).data.some(
      (x) => x.id === s.data.id,
    ),
    false,
  );
  const p = await request(`spaces/${s.data.id}/pages`, {
    method: "POST",
    cookie: a,
    body: { title: "Persistent document" },
  });
  assert.equal(p.response.status, 201);
  assert.deepEqual(
    (await request(`spaces/${s.data.id}/pages`, { cookie: b })).data,
    [],
  );
  assert.equal(
    (
      await request(`spaces/${s.data.id}/pages`, {
        method: "POST",
        cookie: b,
        body: { title: "Intrusion" },
      })
    ).response.status,
    404,
  );
  const update = {
    title: "Saved title",
    version: 1,
    document: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Persisted content <script> is text" },
          ],
        },
      ],
    },
  };
  assert.equal(
    (
      await request("pages/" + p.data.id, {
        method: "PUT",
        cookie: b,
        body: update,
      })
    ).response.status,
    404,
  );
  const saved = await request("pages/" + p.data.id, {
    method: "PUT",
    cookie: a,
    body: update,
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.version, 2);
  assert.equal(
    (
      await request("pages/" + p.data.id, {
        method: "PUT",
        cookie: a,
        body: update,
      })
    ).response.status,
    409,
  );
  const list = await request(`spaces/${s.data.id}/pages`, { cookie: a });
  assert.deepEqual(list.data[0].document, update.document);
  await request("auth/logout", { method: "POST", cookie: a, body: {} });
  assert.equal((await request("spaces", { cookie: a })).response.status, 401);
});

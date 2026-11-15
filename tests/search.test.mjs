import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool } from "./helpers.mjs";
test("workspace search spans authorized spaces and excludes restricted, trashed and unrelated pages", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const account = async () => {
    const r = await request("auth/register", {
        method: "POST",
        body: { email: randomUUID() + "@example.test", password: randomUUID() },
      }),
      cookie = sessionCookie(r.response);
    return { ...(await request("auth/me", { cookie })).data, cookie };
  };
  try {
    const owner = await account(),
      viewer = await account(),
      outsider = await account();
    const space = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Search team" },
      })
    ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const create = async (s, title) =>
      (
        await request("spaces/" + s + "/pages", {
          method: "POST",
          cookie: owner.cookie,
          body: { title },
        })
      ).data;
    const visible = await create(space.id, "Needle public"),
      privatePage = await create(space.id, "Needle private");
    const restrict = await request("pages/" + privatePage.id + "/permissions", {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        version: privatePage.version,
        confirm: true,
        visibility: "restricted",
        grants: [],
      },
    });
    assert.equal(restrict.response.status, 200);
    const second = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Another private space" },
      })
    ).data;
    await create(second.id, "Needle personal");
    const search = (cookie, q = "needle") =>
      request("search?q=" + encodeURIComponent(q), { cookie });
    assert.deepEqual(
      (await search(viewer.cookie, "NEEDLE")).data.map((p) => p.id),
      [visible.id],
    );
    assert.equal((await search(viewer.cookie)).data[0].space_name, space.name);
    assert.equal((await search(owner.cookie)).data.length, 3);
    assert.deepEqual((await search(outsider.cookie)).data, []);
    assert.equal((await search(undefined)).response.status, 401);
    assert.equal(
      (await search(owner.cookie, "x".repeat(201))).response.status,
      400,
    );
    assert.deepEqual((await search(owner.cookie, "%' OR true --")).data, []);
    await request("pages/" + visible.id, {
      method: "DELETE",
      cookie: owner.cookie,
      body: { confirm: true },
    });
    assert.deepEqual((await search(viewer.cookie)).data, []);
  } finally {
    await db.end();
  }
});

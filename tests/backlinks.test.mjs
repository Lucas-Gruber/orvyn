import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool } from "./helpers.mjs";
import { documentReferences, pageLink } from "../packages/editor/dist/links.js";
test("backlinks index real writes, deduplicate headings, paginate authorized sources and respect deletion/revocation", async () => {
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
      outsider = await account(),
      space = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Backlinks team" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const create = async (title) =>
      (
        await request(`spaces/${space.id}/pages`, {
          method: "POST",
          cookie: owner.cookie,
          body: { title },
        })
      ).data;
    const target = await create("Destination"),
      first = await create("First source"),
      second = await create("Second source"),
      hidden = await create("Private source");
    const body = (...hrefs) => ({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: hrefs.map((href) => ({
            type: "text",
            text: "A reference",
            marks: [{ type: "link", attrs: { href, target: "_self" } }],
          })),
        },
      ],
    });
    const save = async (page, document) => {
      const current = (
        await request("pages/" + page.id, { cookie: owner.cookie })
      ).data;
      const r = await request("pages/" + page.id, {
        method: "PUT",
        cookie: owner.cookie,
        body: { title: page.title, version: current.version, document },
      });
      assert.equal(r.response.status, 200);
    };
    await save(
      first,
      body(
        pageLink(target.id),
        pageLink(target.id, randomUUID()),
        pageLink(target.id),
      ),
    );
    await save(second, body(pageLink(target.id)));
    await save(hidden, body(pageLink(target.id)));
    const h = (await request("pages/" + hidden.id, { cookie: owner.cookie }))
      .data;
    await request(`pages/${hidden.id}/permissions`, {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        version: h.version,
        confirm: true,
        visibility: "restricted",
        grants: [],
      },
    });
    const get = (cookie, query = "") =>
      request(`pages/${target.id}/backlinks` + query, { cookie });
    assert.equal((await get(owner.cookie)).data.length, 3);
    assert.deepEqual(
      (await get(viewer.cookie)).data.map((p) => p.id).sort(),
      [first.id, second.id].sort(),
    );
    assert.equal((await get(outsider.cookie)).response.status, 404);
    assert.equal((await get()).response.status, 401);
    const chunk = await get(viewer.cookie, "?limit=1"),
      cursor = chunk.response.headers.get("X-Next-Cursor");
    assert.ok(cursor);
    const next = await get(viewer.cookie, "?limit=1&after=" + cursor);
    assert.equal(next.data.length, 1);
    assert.notEqual(chunk.data[0].id, next.data[0].id);
    assert.equal(
      (await get(viewer.cookie, "?limit=10000")).response.status,
      400,
    );
    await save(first, body("https://elsewhere.example/?page=" + target.id));
    assert.deepEqual(
      (await get(viewer.cookie)).data.map((p) => p.id),
      [second.id],
    );
    await request("pages/" + second.id, {
      method: "DELETE",
      cookie: owner.cookie,
      body: { confirm: true },
    });
    assert.deepEqual((await get(viewer.cookie)).data, []);
    await request("pages/" + second.id + "/restore", {
      method: "POST",
      cookie: owner.cookie,
      body: {},
    });
    assert.deepEqual(
      (await get(viewer.cookie)).data.map((p) => p.id),
      [second.id],
    );
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [space.id, viewer.id],
    );
    assert.equal((await get(viewer.cookie)).response.status, 404);
    const doc = body(
      pageLink(target.id),
      "https://elsewhere.example/?page=" + target.id,
      "javascript:alert(1)",
      "/?page=not-a-uuid",
    );
    assert.deepEqual(documentReferences(doc, process.env.TEST_ORIGIN), [
      { pageId: target.id, headingId: "" },
    ]);
  } finally {
    await db.end();
  }
});

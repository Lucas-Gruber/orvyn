import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool } from "./helpers.mjs";
test("record-pages and saved views enforce types, filters, pagination and inherited permissions", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const account = async () => {
    const r = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    });
    assert.equal(r.response.status, 201);
    const cookie = sessionCookie(r.response),
      me = (await request("auth/me", { cookie })).data;
    return { ...me, cookie };
  };
  try {
    const owner = await account(),
      viewer = await account(),
      outsider = await account();
    const space = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Structured records" },
      })
    ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const result = await request(`spaces/${space.id}/databases`, {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Real project data" },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    const database = result.data;
    assert.equal(database.page.kind, "database");
    assert.equal(database.views.length, 5);
    assert.equal(
      (await request("databases/" + database.id, { cookie: outsider.cookie }))
        .response.status,
      404,
    );
    assert.deepEqual(
      (
        await request(`spaces/${space.id}/databases`, {
          cookie: outsider.cookie,
        })
      ).data,
      [],
    );
    const status = database.properties.find((p) => p.type === "Status"),
      date = database.properties.find((p) => p.type === "Date");
    async function property(name, type, options = []) {
      const r = await request("databases/" + database.id + "/properties", {
        method: "POST",
        cookie: owner.cookie,
        body: { name, type, options },
      });
      assert.equal(r.response.status, 201, JSON.stringify(r.data));
      return r.data;
    }
    const number = await property("Estimate", "Number"),
      labels = await property("Labels", "MultiSelect", ["Research", "Build"]),
      created = await property("Created", "CreatedTime");
    assert.equal(
      (
        await request("databases/" + database.id + "/properties", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Unsafe formula", type: "Formula" },
        })
      ).response.status,
      400,
    );
    async function record(title, values) {
      const r = await request("databases/" + database.id + "/records", {
        method: "POST",
        cookie: owner.cookie,
        body: { title, values },
      });
      assert.equal(r.response.status, 201, JSON.stringify(r.data));
      return r.data;
    }
    const first = await record("First record", {
      [number.id]: 3,
      [date.id]: "2026-11-20",
      [status.id]: status.config.options[0].id,
      [labels.id]: [labels.config.options[0].id],
    });
    const second = await record("Second record", {
      [number.id]: 8,
      [date.id]: "2026-12-01",
      [status.id]: status.config.options[1].id,
    });
    const page = (
      await request("pages/" + first.pageId, { cookie: owner.cookie })
    ).data;
    assert.equal(page.kind, "record");
    assert.equal(page.parent_id, database.id);
    assert.equal(first.createdBy.id, owner.id);
    assert.ok(first.values[created.id]);
    assert.equal(
      (
        await request("databases/" + database.id + "/records", {
          method: "POST",
          cookie: viewer.cookie,
          body: { title: "Forbidden", values: {} },
        })
      ).response.status,
      404,
    );
    assert.equal(
      (
        await request("databases/" + database.id + "/records", {
          method: "POST",
          cookie: owner.cookie,
          body: { title: "Bad values", values: { [number.id]: "3" } },
        })
      ).response.status,
      400,
    );
    assert.equal(
      (
        await request("databases/" + database.id + "/records", {
          method: "POST",
          cookie: owner.cookie,
          body: { title: "Bad date", values: { [date.id]: "2026-02-30" } },
        })
      ).response.status,
      400,
    );
    assert.equal(
      (
        await request("databases/" + database.id + "/records", {
          method: "POST",
          cookie: owner.cookie,
          body: {
            title: "Readonly metadata",
            values: { [created.id]: "2020-01-01" },
          },
        })
      ).response.status,
      400,
    );
    const query = async (body = {}, cookie = viewer.cookie) =>
      request("databases/" + database.id + "/query", {
        method: "POST",
        cookie,
        body,
      });
    let q = await query({ limit: 1 });
    assert.equal(q.response.status, 200, JSON.stringify(q.data));
    assert.equal(q.data.records.length, 1);
    assert.equal(q.data.nextOffset, 1);
    assert.equal(
      (await query({ offset: 1, limit: 1 })).data.records[0].pageId,
      second.pageId,
    );
    q = await query({
      filters: [{ propertyId: number.id, operator: "gt", value: 4 }],
      sorts: [{ propertyId: number.id, direction: "desc" }],
    });
    assert.deepEqual(
      q.data.records.map((r) => r.pageId),
      [second.pageId],
    );
    q = await query({
      filters: [
        {
          propertyId: labels.id,
          operator: "contains",
          value: labels.config.options[0].id,
        },
      ],
    });
    assert.deepEqual(
      q.data.records.map((r) => r.pageId),
      [first.pageId],
    );
    const calendar = database.views.find((v) => v.type === "Calendar");
    q = await query({
      viewId: calendar.id,
      rangeStart: "2026-11-01",
      rangeEnd: "2026-11-30",
    });
    assert.deepEqual(
      q.data.records.map((r) => r.pageId),
      [first.pageId],
    );
    const saved = await request("databases/" + database.id + "/views", {
      method: "POST",
      cookie: owner.cookie,
      body: {
        name: "Large estimates",
        type: "Table",
        config: {
          filters: [{ propertyId: number.id, operator: "gte", value: 5 }],
          visibleProperties: [number.id],
        },
      },
    });
    assert.equal(saved.response.status, 201, JSON.stringify(saved.data));
    q = await query({ viewId: saved.data.id });
    assert.equal(q.data.records.length, 1);
    assert.equal(q.data.records[0].values[date.id], undefined);
    assert.equal(q.data.records[0].title, "Second record");
    const move = await request(
      "databases/" + database.id + "/records/" + first.pageId,
      {
        method: "PATCH",
        cookie: owner.cookie,
        body: {
          version: first.version,
          values: { [status.id]: status.config.options[2].id },
        },
      },
    );
    assert.equal(move.response.status, 200, JSON.stringify(move.data));
    assert.equal(
      (
        await request("databases/" + database.id + "/records/" + first.pageId, {
          method: "PATCH",
          cookie: owner.cookie,
          body: { version: first.version, values: { [status.id]: null } },
        })
      ).response.status,
      409,
    );
    const fresh = (
      await request("pages/" + second.pageId, { cookie: owner.cookie })
    ).data;
    assert.equal(
      (
        await request("pages/" + second.pageId + "/permissions", {
          method: "PUT",
          cookie: owner.cookie,
          body: {
            version: fresh.version,
            confirm: true,
            visibility: "restricted",
            grants: [],
          },
        })
      ).response.status,
      200,
    );
    q = await query();
    assert.deepEqual(
      q.data.records.map((r) => r.pageId),
      [first.pageId],
    );
    assert.equal((await query({ search: "Second" })).data.records.length, 0);
    assert.equal(
      (await request("pages/" + second.pageId, { cookie: viewer.cookie }))
        .response.status,
      404,
    );
    assert.equal(
      (
        await query({
          filters: [{ propertyId: number.id, operator: "gt", value: 7 }],
        })
      ).data.records.length,
      0,
    );
    const outsiderQuery = await query({}, outsider.cookie);
    assert.equal(outsiderQuery.response.status, 404);
    const rowPage = (
      await request("pages/" + first.pageId, { cookie: owner.cookie })
    ).data;
    assert.equal(
      (
        await request("pages/" + first.pageId + "/move", {
          method: "POST",
          cookie: owner.cookie,
          body: { parentId: null, sortOrder: 0, version: rowPage.version },
        })
      ).response.status,
      400,
    );
    assert.equal(
      (
        await request("pages/" + first.pageId, {
          method: "DELETE",
          cookie: owner.cookie,
          body: {},
        })
      ).response.status,
      200,
    );
    assert.equal((await query()).data.records.length, 0);
    await request("pages/" + first.pageId + "/restore", {
      method: "POST",
      cookie: owner.cookie,
      body: {},
    });
    assert.equal((await query()).data.records.length, 1);
  } finally {
    await db.end();
  }
});

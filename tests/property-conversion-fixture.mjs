import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie } from "./helpers.mjs";

async function account() {
  const r = await request("auth/register", {
    method: "POST",
    body: { email: randomUUID() + "@example.test", password: randomUUID() },
  });
  const cookie = sessionCookie(r.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
export async function conversionFixture(db) {
  const owner = await account(),
    editor = await account(),
    viewer = await account();
  const space = (
    await request("spaces", {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Product studio" },
    })
  ).data;
  await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
  for (const [actor, role] of [
    [editor, "Editor"],
    [viewer, "Viewer"],
  ])
    await db.query("INSERT INTO space_members VALUES($1,$2,$3)", [
      space.id,
      actor.id,
      role,
    ]);
  const database = (
    await request(`spaces/${space.id}/databases`, {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Planning decisions" },
    })
  ).data;
  const path = `databases/${database.id}`;
  const add = async (name, type, extra = {}) => {
    const r = await request(path + "/properties", {
      method: "POST",
      cookie: owner.cookie,
      body: { name, type, ...extra },
    });
    assert.equal(r.response.status, 201, JSON.stringify(r.data));
    return r.data;
  };
  const notes = await add("Estimate", "Text"),
    other = await add("Notes", "Text");
  const make = async (title, value, visibility = "space") => {
    const r = await request(path + "/records", {
      method: "POST",
      cookie: owner.cookie,
      body: {
        title,
        visibility,
        values:
          value === undefined
            ? {}
            : { [notes.id]: value, [other.id]: "Keep this independent value" },
      },
    });
    assert.equal(r.response.status, 201, JSON.stringify(r.data));
    return r.data;
  };
  const rows = [];
  for (const [title, value, visibility] of [
    ["Design", "0012"],
    ["Research", "two"],
    ["Blank", ""],
    ["Null", null],
    ["Missing", undefined],
    ["Private plan", "8", "restricted"],
    ["Archived plan", "9"],
    ["Huge", "1e309"],
    ["Review", "-1.5"],
  ])
    rows.push(await make(title, value, visibility));
  await db.query("UPDATE pages SET deleted_at=now() WHERE id=$1", [
    rows[6].pageId,
  ]);
  const get = async () => (await request(path, { cookie: owner.cookie })).data;
  const endpoint = `${path}/properties/${notes.id}`;
  const preview = (body, actor = owner) =>
    request(endpoint + "/conversion-preview", {
      method: "POST",
      cookie: actor.cookie,
      body,
    });
  const apply = (value, extra = {}, actor = owner) =>
    request(endpoint + "/convert", {
      method: "POST",
      cookie: actor.cookie,
      body: {
        previewToken: value.previewToken,
        requestId: randomUUID(),
        confirm: true,
        acceptEmpty: true,
        ...extra,
      },
    });
  const history = (actor = owner) =>
    request(endpoint + "/type-history", { cookie: actor.cookie });
  const patch = async (row, value) => {
    const saved = (
      await request(path + "/records/" + row.pageId, { cookie: owner.cookie })
    ).data.record;
    const r = await request(path + "/records/" + row.pageId, {
      method: "PATCH",
      cookie: owner.cookie,
      body: { version: saved.version, values: { [notes.id]: value } },
    });
    assert.equal(r.response.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const stored = async () =>
    (
      await db.query(
        "SELECT page_id,values,version FROM database_records WHERE database_id=$1 ORDER BY page_id",
        [database.id],
      )
    ).rows;
  return {
    owner,
    editor,
    viewer,
    space,
    database,
    path,
    endpoint,
    notes,
    other,
    rows,
    get,
    add,
    make,
    preview,
    apply,
    history,
    patch,
    stored,
  };
}

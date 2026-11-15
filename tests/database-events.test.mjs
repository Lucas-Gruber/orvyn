import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool } from "./helpers.mjs";
import { peer, waitFor } from "./collaboration-peer.mjs";
test("database invalidations cross replicas without announcing hidden record activity", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    urls = JSON.parse(process.env.COLLABORATION_TEST_URLS),
    peers = [];
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
      space = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Live database" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const database = (
      await request(`spaces/${space.id}/databases`, {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Shared records" },
      })
    ).data;
    const a = peer(urls[0], database.id, owner.cookie),
      b = peer(urls[1], database.id, viewer.cookie);
    peers.push(a, b);
    let ownerChanges = 0,
      viewerChanges = 0,
      watched = -1;
    a.provider.on("stateless", ({ payload }) => {
      if (JSON.parse(payload).type === "database-changed") ownerChanges++;
    });
    b.provider.on("stateless", ({ payload }) => {
      const message = JSON.parse(payload);
      if (message.type === "database-changed") viewerChanges++;
      if (message.type === "records-watched") watched = message.count;
    });
    await waitFor(
      () => a.provider.isSynced && b.provider.isSynced,
      "Both database clients must connect",
    );
    const visible = await request("databases/" + database.id + "/records", {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "Initially visible", values: {} },
    });
    assert.equal(visible.response.status, 201);
    await waitFor(
      () => viewerChanges >= 1,
      "Committed record creation must invalidate another replica",
    );
    b.provider.sendStateless(
      JSON.stringify({
        type: "watch-records",
        recordIds: [visible.data.pageId],
      }),
    );
    await waitFor(
      () => watched === 1,
      "Server must register only readable record subscriptions",
    );
    const page = (
        await request("pages/" + visible.data.pageId, { cookie: owner.cookie })
      ).data,
      previous = viewerChanges;
    await request("pages/" + page.id + "/permissions", {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        version: page.version,
        confirm: true,
        visibility: "restricted",
        grants: [],
      },
    });
    await waitFor(
      () => viewerChanges > previous,
      "A formerly visible record must be removed promptly after restriction",
    );
    const empty = await request("databases/" + database.id + "/query", {
      method: "POST",
      cookie: viewer.cookie,
      body: {},
    });
    assert.deepEqual(empty.data.records, []);
    b.provider.sendStateless(
      JSON.stringify({ type: "watch-records", recordIds: [] }),
    );
    await waitFor(
      () => watched === 0,
      "Obsolete subscriptions must be removed",
    );
    const baseline = viewerChanges,
      ownerBefore = ownerChanges;
    const hidden = await request("databases/" + database.id + "/records", {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "Never visible", visibility: "restricted", values: {} },
    });
    assert.equal(hidden.response.status, 201);
    await waitFor(
      () => ownerChanges > ownerBefore,
      "Owner must receive the private record update",
    );
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(
      viewerChanges,
      baseline,
      "Hidden record existence must not be announced",
    );
    assert.equal(
      (await request("pages/" + hidden.data.pageId, { cookie: viewer.cookie }))
        .response.status,
      404,
    );
    const third = await request("databases/" + database.id + "/records", {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "Shared later", values: {} },
    });
    assert.equal(third.response.status, 201);
    await waitFor(
      () => viewerChanges > baseline,
      "Authorized subsequent updates must still be delivered",
    );
    await request(`spaces/${space.id}/members/${viewer.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
      body: {},
    });
    await waitFor(
      () => !b.provider.isAuthenticated,
      "Space revocation must close the active database subscription",
    );
  } finally {
    for (const p of peers) p.destroy();
    await db.end();
  }
});

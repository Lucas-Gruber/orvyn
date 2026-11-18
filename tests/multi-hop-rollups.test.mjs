import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { peer, waitFor } from "./collaboration-peer.mjs";

async function account() {
  const r = await request("auth/register", {
    method: "POST",
    body: { email: randomUUID() + "@example.test", password: randomUUID() },
  });
  const cookie = sessionCookie(r.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
async function add(f, database, name, type, extra = {}) {
  const r = await request(`databases/${database.id}/properties`, {
    method: "POST",
    cookie: f.owner.cookie,
    body: { name, type, ...extra },
  });
  assert.equal(r.response.status, 201, JSON.stringify(r.data));
  return r.data;
}
async function record(f, database, title, values = {}, visibility = "space") {
  const r = await request(`databases/${database.id}/records`, {
    method: "POST",
    cookie: f.owner.cookie,
    body: { title, values, visibility },
  });
  assert.equal(r.response.status, 201, JSON.stringify(r.data));
  return r.data;
}
async function fixture(db, { total = true } = {}) {
  const f = { owner: await account(), viewer: await account(), spaces: [] };
  for (const name of ["Studio", "Delivery", "Engineering"]) {
    const space = (
      await request("spaces", {
        method: "POST",
        cookie: f.owner.cookie,
        body: { name },
      })
    ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      f.viewer.id,
    ]);
    f.spaces.push(space);
  }
  for (const [i, key, name] of [
    [0, "root", "Areas"],
    [1, "middle", "Projects"],
    [2, "leaf", "Tasks"],
  ])
    f[key] = (
      await request(`spaces/${f.spaces[i].id}/databases`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: { name },
      })
    ).data;
  f.hours = await add(f, f.leaf, "Hours", "Number");
  f.tasks = await add(f, f.middle, "Tasks", "Relation", {
    relationDatabaseId: f.leaf.id,
  });
  f.taskHours = await add(f, f.middle, "Task hours", "Rollup", {
    rollup: {
      relationId: f.tasks.id,
      aggregation: "sum",
      targetPropertyId: f.hours.id,
    },
  });
  f.taskCount = await add(f, f.middle, "Task count", "Rollup", {
    rollup: { relationId: f.tasks.id, aggregation: "count" },
  });
  f.projects = await add(f, f.root, "Projects", "Relation", {
    relationDatabaseId: f.middle.id,
  });
  if (total)
    f.total = await rootRollup(f, "Total hours", "sum", f.taskHours.id);
  f.a = await record(f, f.leaf, "Research", { [f.hours.id]: 2 });
  f.b = await record(f, f.leaf, "Prototype", { [f.hours.id]: 3 });
  f.secret = await record(
    f,
    f.leaf,
    "Private estimate",
    { [f.hours.id]: 11 },
    "restricted",
  );
  f.c = await record(f, f.leaf, "Review", { [f.hours.id]: 5 });
  f.d = await record(f, f.leaf, "Release", { [f.hours.id]: 0 });
  f.alpha = await record(f, f.middle, "Discovery", {
    [f.tasks.id]: [f.a.pageId, f.b.pageId, f.secret.pageId],
  });
  f.beta = await record(f, f.middle, "Delivery", {
    [f.tasks.id]: [f.b.pageId, f.c.pageId, f.d.pageId],
  });
  f.privateProject = await record(
    f,
    f.middle,
    "Confidential",
    { [f.tasks.id]: [f.c.pageId] },
    "restricted",
  );
  f.area = await record(f, f.root, "Product launch", {
    [f.projects.id]: [f.alpha.pageId, f.beta.pageId, f.privateProject.pageId],
  });
  return f;
}
const rootRollup = (f, name, aggregation, targetPropertyId) =>
  add(f, f.root, name, "Rollup", {
    rollup: { relationId: f.projects.id, aggregation, targetPropertyId },
  });
const query = (f, user = f.owner, body = {}) =>
  request(`databases/${f.root.id}/query`, {
    method: "POST",
    cookie: user.cookie,
    body,
  });
async function patch(f, database, row, values) {
  const current = await request(
    `databases/${database.id}/records/${row.pageId}`,
    { cookie: f.owner.cookie },
  );
  const r = await request(`databases/${database.id}/records/${row.pageId}`, {
    method: "PATCH",
    cookie: f.owner.cookie,
    body: { version: current.data.record.version, values },
  });
  assert.equal(r.response.status, 200, JSON.stringify(r.data));
  return r.data;
}
async function configure(f, database, property, rollup) {
  const meta = (
    await request(`databases/${database.id}`, { cookie: f.owner.cookie })
  ).data;
  return request(`databases/${database.id}/properties/${property.id}`, {
    method: "PATCH",
    cookie: f.owner.cookie,
    body: { name: property.name, schemaVersion: meta.schemaVersion, rollup },
  });
}
async function watch(f, snapshot, user = f.viewer, extra = {}) {
  const client = peer(
      JSON.parse(process.env.COLLABORATION_TEST_URLS)[1],
      f.root.id,
      user.cookie,
    ),
    messages = [];
  client.provider.on("stateless", ({ payload }) =>
    messages.push(JSON.parse(payload)),
  );
  await waitFor(
    () => client.provider.isSynced,
    "Two-step observer synchronized",
  );
  client.provider.sendStateless(
    JSON.stringify({
      type: "watch-records",
      recordIds: snapshot.records.map((r) => r.pageId),
      relationProperties: snapshot.relationProperties,
      fingerprint: snapshot.fingerprint,
      ...extra,
    }),
  );
  await waitFor(
    () => messages.some((m) => m.type === "records-watched"),
    "Two-step snapshot watched",
  );
  return { client, messages };
}
const changed = (messages) =>
  messages.filter((m) => m.type === "database-changed").length;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("two-step rollups compose per readable intermediate record before formulas, filters, sorts and exports", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      fields = { sum: f.total };
    for (const aggregation of [
      "average",
      "min",
      "max",
      "countValues",
      "unique",
    ])
      fields[aggregation] = await rootRollup(
        f,
        aggregation,
        aggregation,
        f.taskHours.id,
      );
    const count = await rootRollup(
      f,
      "Task contributions",
      "sum",
      f.taskCount.id,
    );
    const budget = await add(f, f.root, "Budget", "Formula", {
      formula: 'prop("Total hours") * 100',
    });
    for (const [user, expected] of [
      [
        f.owner,
        {
          sum: 29,
          average: 29 / 3,
          min: 5,
          max: 16,
          countValues: 3,
          unique: 3,
        },
      ],
      [
        f.viewer,
        { sum: 13, average: 6.5, min: 5, max: 8, countValues: 2, unique: 2 },
      ],
    ]) {
      const r = await query(f, user);
      assert.equal(r.response.status, 200, JSON.stringify(r.data));
      const row = r.data.records[0];
      for (const [key, value] of Object.entries(expected))
        assert.equal(row.values[fields[key].id], value, key);
      assert.equal(row.values[count.id], user === f.owner ? 7 : 5);
      assert.equal(row.values[budget.id], expected.sum * 100);
      assert.equal(r.data.requiresPolling, false);
      const single = await request(
        `databases/${f.root.id}/records/${f.area.pageId}`,
        { cookie: user.cookie },
      );
      assert.equal(single.data.record.values[f.total.id], expected.sum);
    }
    assert.equal(
      (
        await query(f, f.viewer, {
          filters: [{ propertyId: f.total.id, operator: "gt", value: 20 }],
        })
      ).data.records.length,
      0,
    );
    await record(f, f.root, "No projects");
    assert.equal(
      (
        await query(f, f.viewer, {
          sorts: [{ propertyId: f.total.id, direction: "desc" }],
          limit: 1,
        })
      ).data.records[0].pageId,
      f.area.pageId,
    );
    const exported = (
      await request(`databases/${f.root.id}/export.json`, {
        cookie: f.viewer.cookie,
      })
    ).data;
    assert.equal(
      exported.records.find((r) => r.pageId === f.area.pageId).values[
        f.total.id
      ],
      13,
    );
    const csv = (
      await request(`databases/${f.root.id}/export.csv`, {
        cookie: f.viewer.cookie,
      })
    ).data;
    assert.match(csv, /1300/);
    for (const hidden of [
      f.secret.pageId,
      f.privateProject.pageId,
      "Private estimate",
      "Confidential",
      "Task hours",
    ])
      assert.equal(JSON.stringify(exported).includes(hidden), false, hidden);
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.spaces[2].id, f.viewer.id],
    );
    assert.equal(
      (await query(f, f.viewer)).data.records.find(
        (r) => r.pageId === f.area.pageId,
      ).values[f.total.id],
      null,
      "missing leaf schema is unavailable, not a zero total",
    );
  } finally {
    await db.end();
  }
});

test("two-step configuration rejects cycles and third steps; later target changes become unavailable without breaking source queries", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db);
    const self = await add(f, f.root, "Other areas", "Relation", {
      relationDatabaseId: f.root.id,
    });
    assert.equal(
      (
        await configure(f, f.root, f.total, {
          relationId: self.id,
          aggregation: "sum",
          targetPropertyId: f.total.id,
        })
      ).response.status,
      400,
    );
    const top = (
      await request(`spaces/${f.spaces[0].id}/databases`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: { name: "Portfolios" },
      })
    ).data;
    const relation = await add(f, top, "Areas", "Relation", {
      relationDatabaseId: f.root.id,
    });
    const third = await request(`databases/${top.id}/properties`, {
      method: "POST",
      cookie: f.owner.cookie,
      body: {
        name: "Third step",
        type: "Rollup",
        rollup: {
          relationId: relation.id,
          aggregation: "sum",
          targetPropertyId: f.total.id,
        },
      },
    });
    assert.equal(third.response.status, 400);
    const peers = await add(f, f.leaf, "Peer tasks", "Relation", {
      relationDatabaseId: f.leaf.id,
    });
    const peerHours = await add(f, f.leaf, "Peer hours", "Rollup", {
      rollup: {
        relationId: peers.id,
        aggregation: "sum",
        targetPropertyId: f.hours.id,
      },
    });
    const extended = await configure(f, f.middle, f.taskHours, {
      relationId: f.tasks.id,
      aggregation: "sum",
      targetPropertyId: peerHours.id,
    });
    assert.equal(extended.response.status, 200, JSON.stringify(extended.data));
    let r = await query(f);
    assert.equal(r.response.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.records[0].values[f.total.id], null);
    assert.equal(
      (
        await configure(f, f.middle, f.taskHours, {
          relationId: f.tasks.id,
          aggregation: "sum",
          targetPropertyId: f.hours.id,
        })
      ).response.status,
      200,
    );
    assert.equal((await query(f)).data.records[0].values[f.total.id], 29);
  } finally {
    await db.end();
  }
});

test("leaf edits and schema/access changes invalidate two-step snapshots across replicas without exposing private activity", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const clients = [];
  try {
    const f = await fixture(db),
      snapshot = (await query(f, f.viewer)).data;
    const { client, messages } = await watch(f, snapshot, f.viewer, {
      supportsPolling: true,
      watchId: 7,
    });
    clients.push(client);
    assert.equal(messages.find((m) => m.type === "records-watched").watchId, 7);
    await patch(f, f.leaf, f.secret, { [f.hours.id]: 99 });
    await pause(1100);
    assert.equal(changed(messages), 0, "unreadable leaf activity is silent");
    const beforeMid = (
      await request(`databases/${f.middle.id}/records/${f.alpha.pageId}`, {
        cookie: f.owner.cookie,
      })
    ).data.record.version;
    await patch(f, f.leaf, f.a, { [f.hours.id]: 4 });
    await waitFor(
      () => changed(messages) > 0,
      "Leaf value invalidates an unchanged intermediate",
    );
    assert.equal(
      (await query(f, f.viewer)).data.records[0].values[f.total.id],
      15,
    );
    assert.equal(
      (
        await request(`databases/${f.middle.id}/records/${f.alpha.pageId}`, {
          cookie: f.owner.cookie,
        })
      ).data.record.version,
      beforeMid,
    );
    const stale = await watch(f, snapshot, f.viewer, { supportsPolling: true });
    clients.push(stale.client);
    await waitFor(
      () => changed(stale.messages) > 0,
      "Stale HTTP dependency fingerprint invalidates on registration",
    );
    let previous = changed(messages);
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.spaces[2].id, f.viewer.id],
    );
    await waitFor(
      () => changed(messages) > previous,
      "Leaf space revocation invalidates the source",
    );
    assert.equal(
      (await query(f, f.viewer)).data.records[0].values[f.total.id],
      null,
    );
    await pause(600);
    previous = changed(messages);
    await patch(f, f.leaf, f.b, { [f.hours.id]: 9 });
    await pause(1100);
    assert.equal(
      changed(messages),
      previous,
      "revoked leaf activity stays silent",
    );
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      f.spaces[2].id,
      f.viewer.id,
    ]);
    await waitFor(
      () => changed(messages) > previous,
      "Access grant restores the source calculation",
    );
    await patch(f, f.middle, f.alpha, { [f.tasks.id]: [] });
    await patch(f, f.middle, f.beta, { [f.tasks.id]: [] });
    await waitFor(
      async () =>
        (await query(f, f.viewer)).data.records[0].values[f.total.id] === 0,
      "Empty intermediate links",
    );
    await pause(700);
    previous = changed(messages);
    await db.query(
      "UPDATE database_properties SET deleted_at=now() WHERE id=$1",
      [f.hours.id],
    );
    await waitFor(
      () => changed(messages) > previous,
      "Leaf schema marker survives a zero-record dependency set",
    );
    assert.equal(
      (await query(f, f.viewer)).data.records[0].values[f.total.id],
      null,
    );
  } finally {
    for (const client of clients) client.destroy();
    await db.end();
  }
});

test("two-step schema catalogs, values and subscription fingerprints use one repeatable snapshot", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const gate = await db.connect();
  let wrapped = false,
    pending;
  try {
    const f = await fixture(db),
      key = 782391;
    await db.query(
      "ALTER FUNCTION orvyn_page_role(uuid,uuid,boolean) RENAME TO orvyn_page_role_snapshot_test",
    );
    wrapped = true;
    await db.query(
      `CREATE FUNCTION orvyn_page_role(target uuid,actor uuid,include_deleted boolean DEFAULT false) RETURNS integer LANGUAGE plpgsql STABLE AS $$ BEGIN IF target='${f.leaf.id}'::uuid AND actor='${f.owner.id}'::uuid THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN orvyn_page_role_snapshot_test(target,actor,include_deleted); END $$`,
    );
    await gate.query("BEGIN");
    await gate.query("SELECT pg_advisory_xact_lock($1)", [key]);
    pending = query(f);
    await waitFor(
      async () =>
        (
          await db.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND pid<>pg_backend_pid()",
          )
        ).rowCount > 0,
      "Query paused while loading its leaf catalog",
    );
    await db.query(
      "UPDATE database_records SET values=jsonb_set(values,ARRAY[$1::text],'20'::jsonb),version=version+1 WHERE page_id=$2",
      [f.hours.id, f.a.pageId],
    );
    await db.query(
      "UPDATE database_properties SET name='Renamed hours' WHERE id=$1",
      [f.hours.id],
    );
    await gate.query("COMMIT");
    const r = await pending;
    assert.equal(r.response.status, 200, JSON.stringify(r.data));
    assert.equal(
      r.data.records[0].values[f.total.id],
      29,
      "a later value statement retains the catalog snapshot",
    );
    const fresh = await query(f);
    assert.equal(fresh.data.records[0].values[f.total.id], 47);
    assert.notEqual(fresh.data.fingerprint, r.data.fingerprint);
  } finally {
    await gate.query("ROLLBACK");
    if (pending) await pending;
    if (wrapped) {
      await db.query(
        "DROP FUNCTION IF EXISTS orvyn_page_role(uuid,uuid,boolean)",
      );
      await db.query(
        "ALTER FUNCTION orvyn_page_role_snapshot_test(uuid,uuid,boolean) RENAME TO orvyn_page_role",
      );
    }
    gate.release();
    await db.end();
  }
});

async function dense(db, f) {
  const leaves = Array.from({ length: 50 }, () => randomUUID()),
    middles = Array.from({ length: 250 }, () => randomUUID()),
    roots = Array.from({ length: 5 }, () => randomUUID());
  const rows = [
    ...leaves.map((id) => ({
      id,
      database: f.leaf.id,
      space: f.spaces[2].id,
      title: "Dense task",
      values: { [f.hours.id]: 1 },
    })),
    ...middles.map((id) => ({
      id,
      database: f.middle.id,
      space: f.spaces[1].id,
      title: "Dense project",
      values: { [f.tasks.id]: leaves },
    })),
    ...roots.map((id, i) => ({
      id,
      database: f.root.id,
      space: f.spaces[0].id,
      title: "Dense area " + i,
      values: { [f.projects.id]: middles.slice(i * 50, (i + 1) * 50) },
    })),
  ];
  await db.query(
    `INSERT INTO pages(id,space_id,parent_id,title,kind,created_by,last_edited_by) SELECT x.id,x.space,x.database,x.title,'record',$2,$2 FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,space uuid,database uuid,title text)`,
    [JSON.stringify(rows), f.owner.id],
  );
  await db.query(
    `INSERT INTO database_records(page_id,database_id,values) SELECT x.id,x.database,x.values FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,database uuid,values jsonb)`,
    [JSON.stringify(rows)],
  );
  await db.query(
    "SELECT orvyn_replace_record_relations(page_id) FROM database_records WHERE page_id=ANY($1::uuid[])",
    [[...middles, ...roots]],
  );
  return { leaves, roots };
}

test("dense dependency watches fall back to bounded refreshes, preserve pagination and do not count unreadable leaf paths", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    clients = [];
  try {
    const f = await fixture(db),
      data = await dense(db, f);
    const snapshot = (await query(f, f.viewer, { search: "Dense area" })).data;
    assert.equal(snapshot.records.length, 5, JSON.stringify(snapshot));
    assert.equal(snapshot.requiresPolling, true);
    assert.equal(snapshot.records[0].values[f.total.id], 2500);
    const single = (
      await query(f, f.viewer, { search: "Dense area", limit: 3 })
    ).data;
    assert.equal(
      single.requiresPolling,
      false,
      "the pagination lookahead record does not affect the visible dependency budget",
    );
    const watched = await watch(f, snapshot, f.viewer, {
      supportsPolling: true,
      watchId: 23,
    });
    clients.push(watched.client);
    assert.equal(
      watched.messages.find((m) => m.type === "records-watched")
        .requiresPolling,
      true,
    );
    assert.equal(
      watched.messages.find((m) => m.type === "records-watched").watchId,
      23,
    );
    await patch(f, f.leaf, { pageId: data.leaves[0] }, { [f.hours.id]: 2 });
    assert.equal(
      (await query(f, f.viewer, { search: "Dense area", limit: 1 })).data
        .records[0].values[f.total.id],
      2550,
    );
    const legacy = await watch(
      f,
      (await query(f, f.viewer, { search: "Dense area" })).data,
    );
    clients.push(legacy.client);
    await waitFor(
      () => changed(legacy.messages) > 0,
      "Legacy clients receive a fixed refresh interval for dense dependencies",
    );
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.spaces[2].id, f.viewer.id],
    );
    const revoked = (await query(f, f.viewer, { search: "Dense area" })).data;
    assert.equal(
      revoked.requiresPolling,
      false,
      "hidden leaf density does not alter the observer's mode",
    );
    assert.equal(revoked.records[0].values[f.total.id], null);
  } finally {
    for (const client of clients) client.destroy();
    await db.end();
  }
});

test("Chromium: configure two-step rollups, update leaf values live for independent readers and review desktop/mobile layouts", async () => {
  const { chromium, expect } = await import("@playwright/test");
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db, { total: false });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await context.addCookies([
      {
        name: "orvyn_session",
        value: f.owner.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/?page=${f.root.id}`);
    await page.getByText("Add a property", { exact: true }).click();
    await page.getByLabel("Property name", { exact: true }).fill("Total hours");
    await page
      .getByLabel("Property type", { exact: true })
      .selectOption("Rollup");
    await page
      .getByLabel("Relation property", { exact: true })
      .selectOption(f.projects.id);
    await page.getByLabel("Calculation", { exact: true }).selectOption("sum");
    await page
      .getByLabel("Related property", { exact: true })
      .selectOption(f.taskHours.id);
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/multi-hop-rollup-editor.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Add property", exact: true })
      .click();
    await expect(page.locator(".property-rollup")).toHaveText("29");
    const readerContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await readerContext.addCookies([
      {
        name: "orvyn_session",
        value: f.viewer.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const reader = await readerContext.newPage();
    await reader.goto(`${base}/?page=${f.root.id}`);
    await expect(reader.locator(".property-rollup")).toHaveText("13");
    await patch(f, f.leaf, f.a, { [f.hours.id]: 7 });
    await expect(page.locator(".property-rollup")).toHaveText("34", {
      timeout: 12000,
    });
    await expect(reader.locator(".property-rollup")).toHaveText("18", {
      timeout: 12000,
    });
    await page.screenshot({
      path: ".local/ui-review/multi-hop-rollup-table.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Edit Total hours rollup", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("dialog", { name: "Edit rollup", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: ".local/ui-review/multi-hop-rollup-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await context.close();
    const graph = await dense(db, f);
    await reader.reload();
    await reader
      .getByRole("searchbox", { name: "Search records", exact: true })
      .fill("Dense area");
    await reader
      .getByRole("searchbox", { name: "Search records", exact: true })
      .press("Enter");
    const denseRow = reader.getByRole("row").filter({
      has: reader.getByRole("button", { name: "Dense area 0", exact: true }),
    });
    await expect(denseRow.locator(".property-rollup")).toHaveText("2,500", {
      timeout: 30000,
    });
    await expect(reader.locator(".database-live")).toHaveAttribute(
      "title",
      "Large calculation graphs refresh every five seconds",
      { timeout: 30000 },
    );
    await patch(f, f.leaf, { pageId: graph.leaves[0] }, { [f.hours.id]: 2 });
    await expect(denseRow.locator(".property-rollup")).toHaveText("2,550", {
      timeout: 30000,
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await db.end();
  }
});

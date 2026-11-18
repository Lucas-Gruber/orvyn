import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { peer, waitFor } from "./collaboration-peer.mjs";
async function account() {
  const result = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(result.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
async function property(f, database, name, type, extra = {}) {
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
async function fixture(db) {
  const owner = await account(),
    viewer = await account(),
    space = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Design studio" },
      })
    ).data;
  await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
  await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
    space.id,
    viewer.id,
  ]);
  const create = async (name) =>
      (
        await request(`spaces/${space.id}/databases`, {
          method: "POST",
          cookie: owner.cookie,
          body: { name },
        })
      ).data,
    target = await create("Work items"),
    source = await create("Projects"),
    f = { owner, viewer, space, source, target };
  f.hours = await property(f, target, "Hours", "Number");
  f.label = await property(f, target, "Discipline", "Text");
  f.doubled = await property(f, target, "Double hours", "Formula", {
    formula: 'prop("Hours") * 2',
  });
  f.relation = await property(f, source, "Work", "Relation", {
    relationDatabaseId: target.id,
  });
  f.a = await record(f, target, "Design", {
    [f.hours.id]: 4,
    [f.label.id]: "Design",
  });
  f.b = await record(f, target, "Build", {
    [f.hours.id]: 8,
    [f.label.id]: "Design",
  });
  f.empty = await record(f, target, "Planning");
  f.secret = await record(
    f,
    target,
    "Private bid",
    { [f.hours.id]: 100, [f.label.id]: "Secret" },
    "restricted",
  );
  return f;
}
const rollup = (f, name, aggregation, targetPropertyId) =>
  property(f, f.source, name, "Rollup", {
    rollup: {
      relationId: f.relation.id,
      aggregation,
      ...(targetPropertyId ? { targetPropertyId } : {}),
    },
  });
const query = (f, user = f.owner, body = {}) =>
  request(`databases/${f.source.id}/query`, {
    method: "POST",
    cookie: user.cookie,
    body,
  });
async function restrict(f, id) {
  const p = (await request(`pages/${id}`, { cookie: f.owner.cookie })).data,
    r = await request(`pages/${id}/permissions`, {
      method: "PUT",
      cookie: f.owner.cookie,
      body: {
        visibility: "restricted",
        grants: [],
        version: p.version,
        confirm: true,
      },
    });
  assert.equal(r.response.status, 200, JSON.stringify(r.data));
}
test("rollups aggregate current readable targets, local formulas, nulls and unique values before filters/sorts/exports and reject value writes", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      fields = {};
    for (const mode of [
      "count",
      "sum",
      "average",
      "min",
      "max",
      "countValues",
      "unique",
    ])
      fields[mode] = await rollup(
        f,
        mode,
        mode,
        mode === "count"
          ? undefined
          : ["unique", "countValues"].includes(mode)
            ? f.label.id
            : f.hours.id,
      );
    const doubled = await rollup(f, "Double total", "sum", f.doubled.id),
      budget = await property(f, f.source, "Budget", "Formula", {
        formula: 'prop("sum") * 80',
      }),
      project = await record(f, f.source, "Website launch", {
        [f.relation.id]: [
          f.a.pageId,
          f.b.pageId,
          f.empty.pageId,
          f.secret.pageId,
        ],
      }),
      blank = await record(f, f.source, "Empty project");
    assert.equal(project.values[fields.sum.id], 112);
    assert.equal(project.values[fields.count.id], 4);
    let r = await query(f, f.viewer),
      row = r.data.records.find((r) => r.pageId === project.pageId);
    assert.equal(r.response.status, 200, JSON.stringify(r.data));
    for (const [mode, expected] of Object.entries({
      count: 3,
      sum: 12,
      average: 6,
      min: 4,
      max: 8,
      countValues: 2,
      unique: 1,
    }))
      assert.equal(row.values[fields[mode].id], expected, mode);
    assert.equal(row.values[doubled.id], 24);
    assert.equal(row.values[budget.id], 960);
    assert.equal(blank.values[fields.sum.id], 0);
    assert.equal(blank.values[fields.average.id], null);
    r = await query(f, f.viewer, {
      filters: [{ propertyId: fields.sum.id, operator: "gt", value: 20 }],
    });
    assert.equal(
      r.data.records.length,
      0,
      "private values never influence filters",
    );
    r = await query(f, f.viewer, {
      sorts: [{ propertyId: fields.sum.id, direction: "desc" }],
      limit: 1,
    });
    assert.equal(r.data.records[0].pageId, project.pageId);
    const exportData = await request(`databases/${f.source.id}/export.json`, {
      cookie: f.viewer.cookie,
    });
    assert.equal(
      exportData.response.status,
      200,
      JSON.stringify(exportData.data),
    );
    assert.equal(
      exportData.data.records.find((r) => r.pageId === project.pageId).values[
        fields.sum.id
      ],
      12,
    );
    assert.equal(
      JSON.stringify(exportData.data).includes(f.secret.pageId),
      false,
    );
    const csv = await request(`databases/${f.source.id}/export.csv`, {
      cookie: f.viewer.cookie,
    });
    assert.match(csv.data, /960/);
    assert.equal(csv.data.includes("Private bid"), false);
    for (const value of [999, null]) {
      r = await request(`databases/${f.source.id}/records/${project.pageId}`, {
        method: "PATCH",
        cookie: f.owner.cookie,
        body: { version: project.version, values: { [fields.sum.id]: value } },
      });
      assert.equal(r.response.status, 400);
    }
    const huge = await record(f, f.target, "Huge", { [f.hours.id]: 1e308 });
    const another = await record(f, f.target, "Another huge", {
      [f.hours.id]: 1e308,
    });
    const overflow = await record(f, f.source, "Overflow", {
      [f.relation.id]: [huge.pageId, another.pageId],
    });
    assert.equal(
      overflow.values[fields.sum.id],
      null,
      "overflow is an empty value, not a failed query",
    );
    const maximum = await record(f, f.target, "Maximum finite", {
        [f.hours.id]: Number.MAX_VALUE,
      }),
      single = await record(f, f.source, "Single finite", {
        [f.relation.id]: [maximum.pageId],
      });
    assert.equal(
      single.values[fields.sum.id],
      Number.MAX_VALUE,
      "a single finite boundary value survives numeric aggregation",
    );
    await restrict(f, f.a.pageId);
    await restrict(f, f.b.pageId);
    r = await query(f, f.viewer);
    row = r.data.records.find((r) => r.pageId === project.pageId);
    assert.equal(row.values[fields.sum.id], 0);
    assert.equal(row.values[fields.average.id], null);
    assert.equal(row.values[fields.count.id], 1);
    const csvText = "Name,sum\nCSV rollup,999999\n",
      upload = async (action, settings = {}) => {
        const body = new FormData();
        body.append(
          "file",
          new Blob([csvText], { type: "text/csv" }),
          "rollups.csv",
        );
        body.append("settings", JSON.stringify(settings));
        const response = await fetch(
          `${base}/api/v1/databases/${f.source.id}/import/csv/${action}`,
          {
            method: "POST",
            headers: {
              Origin: process.env.TEST_ORIGIN,
              Cookie: f.owner.cookie,
            },
            body,
          },
        );
        return { status: response.status, data: await response.json() };
      },
      preview = await upload("preview");
    assert.equal(preview.status, 201, JSON.stringify(preview.data));
    assert.equal(preview.data.mapping.find((m) => m.column === 1).skip, true);
    assert.equal(
      (await upload("confirm", { token: preview.data.token })).status,
      201,
    );
    const imported = await query(f, f.owner, { search: "CSV rollup" });
    assert.equal(imported.data.records[0].values[fields.sum.id], 0);
  } finally {
    await db.end();
  }
});

test("rollup configuration validates compatible target scope/permissions, blocks externally dependent formulas, preserves versions and hides unavailable target schemas", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      total = await rollup(f, "Total hours", "sum", f.hours.id),
      targetRelation = await property(f, f.target, "Other work", "Relation", {
        relationDatabaseId: f.target.id,
      }),
      externalFormula = await property(
        f,
        f.target,
        "External count",
        "Formula",
        { formula: 'length(prop("Other work"))' },
      );
    const add = (config, user = f.owner) =>
      request(`databases/${f.source.id}/properties`, {
        method: "POST",
        cookie: user.cookie,
        body: { name: "Invalid", type: "Rollup", rollup: config },
      });
    for (const config of [
      {
        relationId: f.hours.id,
        aggregation: "sum",
        targetPropertyId: f.hours.id,
      },
      {
        relationId: f.relation.id,
        aggregation: "sum",
        targetPropertyId: f.label.id,
      },
      {
        relationId: f.relation.id,
        aggregation: "sum",
        targetPropertyId: externalFormula.id,
      },
      {
        relationId: f.relation.id,
        aggregation: "countValues",
        targetPropertyId: targetRelation.id,
      },
      {
        relationId: f.relation.id,
        aggregation: "count",
        targetPropertyId: f.hours.id,
      },
      {
        relationId: f.relation.id,
        aggregation: "sum",
        targetPropertyId: randomUUID(),
      },
    ])
      assert.equal(
        (await add(config)).response.status,
        400,
        JSON.stringify(config),
      );
    assert.equal(
      (await add({ relationId: f.relation.id, aggregation: "count" }, f.viewer))
        .response.status,
      404,
    );
    const derived = await rollup(f, "Derived total", "sum", f.doubled.id);
    const meta = (
        await request(`databases/${f.source.id}`, { cookie: f.owner.cookie })
      ).data,
      edit = (version) =>
        request(`databases/${f.source.id}/properties/${total.id}`, {
          method: "PATCH",
          cookie: f.owner.cookie,
          body: {
            name: "Average hours",
            schemaVersion: version,
            rollup: {
              relationId: f.relation.id,
              targetPropertyId: f.hours.id,
              aggregation: "average",
            },
          },
        });
    assert.equal((await edit(meta.schemaVersion - 1)).response.status, 409);
    assert.equal((await edit(meta.schemaVersion)).response.status, 200);
    const project = await record(f, f.source, "Project", {
      [f.relation.id]: [f.a.pageId],
    });
    assert.equal(project.values[total.id], 4);
    assert.equal(project.values[derived.id], 8);
    const targetMetadata = (
        await request(`databases/${f.target.id}`, { cookie: f.owner.cookie })
      ).data,
      changedFormula = await request(
        `databases/${f.target.id}/properties/${f.doubled.id}`,
        {
          method: "PATCH",
          cookie: f.owner.cookie,
          body: {
            name: "Double hours",
            schemaVersion: targetMetadata.schemaVersion,
            formula: 'length(prop("Other work"))',
          },
        },
      );
    assert.equal(
      changedFormula.response.status,
      200,
      JSON.stringify(changedFormula.data),
    );
    const changedResult = await query(f);
    assert.equal(
      changedResult.response.status,
      200,
      JSON.stringify(changedResult.data),
    );
    assert.equal(
      changedResult.data.records[0].values[derived.id],
      null,
      "an externally dependent target formula becomes unavailable without failing the source query",
    );
    await restrict(f, f.target.id);
    const directory = await request(
      `databases/${f.source.id}/properties/${f.relation.id}/target-properties`,
      { cookie: f.viewer.cookie },
    );
    assert.equal(directory.response.status, 404);
    const queried = await query(f, f.viewer);
    assert.equal(queried.response.status, 200, JSON.stringify(queried.data));
    assert.equal(queried.data.records[0].values[total.id], null);
    assert.equal(
      JSON.stringify(queried.data).includes("External count"),
      false,
    );
    assert.equal(JSON.stringify(queried.data).includes(f.secret.pageId), false);
    const visibleMetadata = await request(`databases/${f.source.id}`, {
      cookie: f.viewer.cookie,
    });
    assert.equal(
      JSON.stringify(visibleMetadata.data).includes("Double hours"),
      false,
      "target schema sidecars are never serialized",
    );
  } finally {
    await db.end();
  }
});

test("rollup subscriptions cross replicas for target value edits and revoke private targets even in totals-only views", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let client;
  try {
    const f = await fixture(db),
      total = await rollup(f, "Total hours", "sum", f.hours.id),
      project = await record(f, f.source, "Website launch", {
        [f.relation.id]: [f.a.pageId, f.secret.pageId],
      }),
      view = (
        await request(`databases/${f.source.id}/views`, {
          method: "POST",
          cookie: f.owner.cookie,
          body: {
            name: "Totals",
            type: "Table",
            config: { visibleProperties: [total.id] },
          },
        })
      ).data,
      initial = (await query(f, f.viewer, { viewId: view.id })).data,
      messages = [];
    assert.equal(initial.records[0].values[total.id], 4);
    assert.equal(initial.records[0].relations, undefined);
    client = peer(
      JSON.parse(process.env.COLLABORATION_TEST_URLS)[1],
      f.source.id,
      f.viewer.cookie,
    );
    client.provider.on("stateless", ({ payload }) =>
      messages.push(JSON.parse(payload)),
    );
    await waitFor(() => client.provider.isSynced, "Rollup observer synced");
    client.provider.sendStateless(
      JSON.stringify({
        type: "watch-records",
        recordIds: [project.pageId],
        relationProperties: initial.relationProperties,
        fingerprint: initial.fingerprint,
      }),
    );
    await waitFor(
      () => messages.some((m) => m.type === "records-watched"),
      "Rollup snapshot watched",
    );
    assert.equal(
      messages.some((m) => m.type === "database-changed"),
      false,
    );
    const changed = await request(
      `databases/${f.target.id}/records/${f.a.pageId}`,
      {
        method: "PATCH",
        cookie: f.owner.cookie,
        body: { version: f.a.version, values: { [f.hours.id]: 10 } },
      },
    );
    assert.equal(changed.response.status, 200, JSON.stringify(changed.data));
    await waitFor(
      () => messages.some((m) => m.type === "database-changed"),
      "Target number edit invalidates the rollup",
    );
    assert.equal(
      (await query(f, f.viewer, { viewId: view.id })).data.records[0].values[
        total.id
      ],
      10,
    );
    const before = messages.filter((m) => m.type === "database-changed").length;
    await restrict(f, f.a.pageId);
    await waitFor(
      () =>
        messages.filter((m) => m.type === "database-changed").length > before,
      "Rights revoke clears target contribution",
    );
    assert.equal(
      (await query(f, f.viewer, { viewId: view.id })).data.records[0].values[
        total.id
      ],
      0,
    );
  } finally {
    client?.destroy();
    await db.end();
  }
});

test("Chromium: build/edit rollups, update a related record live, reload and keep calculations read-only", async () => {
  const { chromium, expect } = await import("@playwright/test"),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    }),
    db = new Pool({ connectionString: process.env.DATABASE_URL });
  let releaseDirectory = () => {};
  try {
    const f = await fixture(db);
    await record(f, f.source, "Website launch", {
      [f.relation.id]: [f.a.pageId, f.b.pageId],
    });
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
    await page.goto(`${base}/?page=${f.source.id}`);
    await page.getByText("Add a property", { exact: true }).click();
    await page.getByLabel("Property name", { exact: true }).fill("Total hours");
    await page
      .getByLabel("Property type", { exact: true })
      .selectOption("Rollup");
    await page
      .getByLabel("Relation property", { exact: true })
      .selectOption(f.relation.id);
    await page.getByLabel("Calculation", { exact: true }).selectOption("sum");
    await page
      .getByLabel("Related property", { exact: true })
      .selectOption(f.hours.id);
    await page
      .getByRole("button", { name: "Add property", exact: true })
      .click();
    const row = page.getByRole("row").filter({
      has: page.getByRole("button", { name: "Website launch", exact: true }),
    });
    await expect(row.locator(".property-rollup")).toHaveText("12");
    const directoryGate = new Promise((resolve) => {
      releaseDirectory = resolve;
    });
    await page.route(
      "**/target-properties",
      async (route) => {
        await directoryGate;
        await route.continue();
      },
      { times: 1 },
    );
    await page
      .getByRole("button", { name: "Edit Total hours rollup", exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Edit rollup",
      exact: true,
    });
    await expect(
      editor.getByText("Loading related fields…", { exact: true }),
    ).toBeVisible();
    await editor
      .getByLabel("Calculation", { exact: true })
      .selectOption("average");
    releaseDirectory();
    await expect(
      editor.getByLabel("Related property", { exact: true }),
    ).toHaveValue(f.hours.id, { timeout: 12000 });
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/database-rollup-editor.png",
      fullPage: true,
    });
    await editor
      .getByRole("button", { name: "Save rollup", exact: true })
      .click();
    await expect(row.locator(".property-rollup")).toHaveText("6");
    const changed = await request(
      `databases/${f.target.id}/records/${f.a.pageId}`,
      {
        method: "PATCH",
        cookie: f.owner.cookie,
        body: { version: f.a.version, values: { [f.hours.id]: 12 } },
      },
    );
    assert.equal(changed.response.status, 200);
    await expect(row.locator(".property-rollup")).toHaveText("10", {
      timeout: 12000,
    });
    await page.reload();
    await expect(row.locator(".property-rollup")).toHaveText("10");
    const readContext = await browser.newContext();
    await readContext.addCookies([
      {
        name: "orvyn_session",
        value: f.viewer.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const reader = await readContext.newPage();
    await reader.goto(`${base}/?page=${f.source.id}`);
    await expect(reader.locator(".property-rollup")).toHaveText("10");
    await expect(
      reader.getByRole("button", {
        name: "Edit Total hours rollup",
        exact: true,
      }),
    ).toHaveCount(0);
    await restrict(f, f.a.pageId);
    await expect(reader.locator(".property-rollup")).toHaveText("8", {
      timeout: 12000,
    });
    assert.deepEqual(errors, []);
  } finally {
    releaseDirectory();
    await browser.close();
    await db.end();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";

async function fixture(db) {
  const registered = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(registered.response),
    space = (
      await request("spaces", {
        method: "POST",
        cookie,
        body: { name: "Product studio" },
      })
    ).data,
    database = (
      await request(`spaces/${space.id}/databases`, {
        method: "POST",
        cookie,
        body: { name: "The launch plan" },
      })
    ).data,
    id = database.id,
    title = database.properties.find((p) => p.type === "Title");
  async function property(name, type, extra = {}) {
    const result = await request(`databases/${id}/properties`, {
      method: "POST",
      cookie,
      body: { name, type, ...extra },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  const estimate = await property("Estimate", "Number"),
    category = await property("Category", "Text"),
    doubled = await property("Double estimate", "Formula", {
      formula: 'prop("Estimate") * 2',
    }),
    relation = await property("Related work", "Relation", {
      relationDatabaseId: id,
    }),
    rollups = {};
  for (const [aggregation, name] of Object.entries({
    count: "Shared tasks",
    sum: "Total",
    average: "Average",
    min: "Smallest",
    max: "Largest",
    countValues: "With a category",
    unique: "Unique categories",
  })) {
    rollups[aggregation] = await property(name, "Rollup", {
      rollup: {
        relationId: relation.id,
        aggregation,
        ...(aggregation === "count"
          ? {}
          : {
              targetPropertyId: ["unique", "countValues"].includes(aggregation)
                ? category.id
                : estimate.id,
            }),
      },
    });
  }
  const formula = await property("Twice total", "Formula", {
      formula: 'prop("Total") * 2',
    }),
    formulaTarget = await property("Doubled work", "Rollup", {
      rollup: {
        relationId: relation.id,
        aggregation: "sum",
        targetPropertyId: doubled.id,
      },
    });
  async function record(title, values = {}) {
    const result = await request(`databases/${id}/records`, {
      method: "POST",
      cookie,
      body: { title, values },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  const a = await record("Shape the experience", {
      [estimate.id]: 0.1,
      [category.id]: "Design",
    }),
    b = await record("Review the details", {
      [estimate.id]: 0.2,
      [category.id]: "Design",
    }),
    hidden = await record("PRIVATE commercial work", {
      [estimate.id]: 98,
      [category.id]: "PRIVATE cost",
    }),
    root = await record("Prepare the handover", {
      [relation.id]: [a.pageId, b.pageId, hidden.pageId],
    }),
    fields = [
      title,
      estimate,
      category,
      doubled,
      relation,
      ...Object.values(rollups),
      formula,
      formulaTarget,
    ],
    input = {
      scope: {
        pageIds: [],
        records: [],
        extraFileIds: [],
        databases: [
          {
            databaseId: id,
            viewId: database.views.find((v) => v.type === "Table").id,
            recordIds: [root.pageId, a.pageId, b.pageId],
            propertyIds: fields.map((p) => p.id),
          },
        ],
      },
      settings: {
        label: "Launch handover",
        passwordProtected: false,
        indexable: false,
        expiresAt: null,
      },
      target: null,
    },
    path = `pages/${id}/publications`,
    preview = (value = input) =>
      request(path + "/preview", { method: "POST", cookie, body: value });
  async function publish(value = input) {
    const reviewed = await preview(value);
    assert.equal(reviewed.response.status, 201, JSON.stringify(reviewed.data));
    const result = await request(path, {
      method: "POST",
      cookie,
      body: {
        requestId: randomUUID(),
        previewToken: reviewed.data.previewToken,
        input: value,
      },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  async function write(row, values) {
    await db.query(
      "UPDATE database_records SET values=values||$2::jsonb,version=version+1 WHERE page_id=$1",
      [row.pageId, values],
    );
    await db.query("SELECT orvyn_replace_record_relations($1)", [row.pageId]);
  }
  const projection = (review) => {
    assert.equal(review.response.status, 201, JSON.stringify(review.data));
    return review.data.snapshot.pages.find((p) => p.id === id).database;
  };
  return {
    cookie,
    database,
    id,
    title,
    estimate,
    category,
    doubled,
    relation,
    rollups,
    formula,
    formulaTarget,
    root,
    a,
    b,
    hidden,
    input,
    path,
    property,
    preview,
    publish,
    write,
    projection,
  };
}

test("public rollups recompute all aggregates and dependent formulas from the shared subset without cached private results", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db);
    await f.write(f.root, { [f.rollups.sum.id]: "PRIVATE cached result" });
    const privateQuery = await request(`databases/${f.id}/query`, {
      method: "POST",
      cookie: f.cookie,
      body: {},
    });
    assert.equal(
      privateQuery.response.status,
      200,
      JSON.stringify(privateQuery.data),
    );
    assert.equal(
      privateQuery.data.records.find((r) => r.pageId === f.root.pageId).values[
        f.rollups.sum.id
      ],
      98.3,
    );
    const reviewed = await f.preview(),
      projection = f.projection(reviewed),
      values = projection.records.find(
        (r) => r.pageId === f.root.pageId,
      ).values;
    for (const [aggregation, expected] of Object.entries({
      count: 2,
      sum: 0.3,
      average: 0.15,
      min: 0.1,
      max: 0.2,
      countValues: 2,
      unique: 1,
    }))
      assert.equal(values[f.rollups[aggregation].id], expected, aggregation);
    assert.equal(values[f.formula.id], 0.6);
    assert.equal(values[f.formulaTarget.id], 0.6);
    assert.deepEqual(
      values[f.relation.id].sort(),
      [f.a.pageId, f.b.pageId].sort(),
    );
    assert.equal(
      projection.properties.find((p) => p.id === f.rollups.sum.id).resultType,
      "number",
    );
    const serialized = JSON.stringify(reviewed.data.snapshot);
    assert.ok(!serialized.includes("PRIVATE"));
    assert.ok(!serialized.includes(f.hidden.pageId));
    assert.ok(!serialized.includes('"rollup"'));
    assert.ok(!serialized.includes('"expression"'));
    const published = await f.publish(),
      token = new URL(published.url).pathname.split("/").at(-1);
    await f.write(f.a, { [f.estimate.id]: 7 });
    const reader = await request(`publications/${token}`);
    assert.equal(reader.response.status, 200);
    assert.equal(
      reader.data.snapshot.pages
        .find((p) => p.id === f.id)
        .database.records.find((r) => r.pageId === f.root.pageId).values[
        f.rollups.sum.id
      ],
      0.3,
    );
  } finally {
    await db.end();
  }
});

test("public rollups require explicit source relations and target fields, including direct-record scopes", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      missing = structuredClone(f.input);
    missing.scope.databases[0].propertyIds =
      missing.scope.databases[0].propertyIds.filter(
        (id) => id !== f.relation.id,
      );
    assert.equal((await f.preview(missing)).response.status, 400);
    const direct = structuredClone(f.input);
    direct.scope.databases[0].recordIds = [f.root.pageId];
    direct.scope.databases[0].propertyIds = [
      f.title.id,
      f.relation.id,
      f.rollups.sum.id,
      f.formula.id,
    ];
    direct.scope.records = [f.a, f.b].map((r) => ({
      recordId: r.pageId,
      propertyIds: [f.title.id, f.estimate.id],
    }));
    assert.equal(
      f.projection(await f.preview(direct)).records[0].values[f.rollups.sum.id],
      0.3,
    );
    direct.scope.records[1].propertyIds = [f.title.id];
    const failed = await f.preview(direct);
    assert.equal(failed.response.status, 400);
    assert.match(failed.data.message, /target field/i);
    assert.ok(!JSON.stringify(failed.data).includes("PRIVATE"));
    const meta = await request(f.path + "/databases/" + f.id, {
        cookie: f.cookie,
      }),
      rollup = meta.data.views
        .find((v) => v.id === f.input.scope.databases[0].viewId)
        .properties.find((p) => p.id === f.rollups.sum.id);
    assert.equal(rollup.allowed, true);
    assert.deepEqual(rollup.dependencies, [
      { id: f.relation.id, name: "Related work" },
    ]);
  } finally {
    await db.end();
  }
});

test("public rollups retain decimal, finite, null, empty and label-count semantics", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db);
    await f.write(f.a, { [f.estimate.id]: 1e308, [f.category.id]: "" });
    await f.write(f.b, { [f.estimate.id]: 1e308, [f.category.id]: null });
    let values = f
      .projection(await f.preview())
      .records.find((r) => r.pageId === f.root.pageId).values;
    assert.equal(values[f.rollups.sum.id], null);
    assert.equal(values[f.rollups.average.id], 1e308);
    assert.equal(values[f.rollups.countValues.id], 0);
    assert.equal(values[f.rollups.unique.id], 0);
    const empty = structuredClone(f.input);
    empty.scope.databases[0].recordIds = [f.root.pageId];
    values = f.projection(await f.preview(empty)).records[0].values;
    for (const aggregation of ["sum", "count", "countValues", "unique"])
      assert.equal(values[f.rollups[aggregation].id], 0, aggregation);
    for (const aggregation of ["average", "min", "max"])
      assert.equal(values[f.rollups[aggregation].id], null, aggregation);
  } finally {
    await db.end();
  }
});

test("public rollups support two explicit relation steps and reject cycles and a third step", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      nested = await f.property("Nested shared total", "Rollup", {
        rollup: {
          relationId: f.relation.id,
          aggregation: "sum",
          targetPropertyId: f.rollups.sum.id,
        },
      });
    // The root links A and B. A links B and an unselected private item.
    await f.write(f.a, { [f.relation.id]: [f.b.pageId, f.hidden.pageId] });
    f.input.scope.databases[0].propertyIds.push(nested.id);
    let projection = f.projection(await f.preview());
    assert.equal(
      projection.records.find((r) => r.pageId === f.root.pageId).values[
        nested.id
      ],
      0.2,
    );
    // Reconfigure the existing field directly to model legacy invalid configs.
    await db.query(
      "UPDATE database_properties SET config=jsonb_set(config,'{rollup,targetPropertyId}',$2::jsonb) WHERE id=$1",
      [nested.id, JSON.stringify(nested.id)],
    );
    assert.equal((await f.preview()).response.status, 400);
    await db.query(
      "UPDATE database_properties SET config=jsonb_set(config,'{rollup,targetPropertyId}',$2::jsonb) WHERE id=$1",
      [nested.id, JSON.stringify(f.rollups.sum.id)],
    );
    await db.query(
      "UPDATE database_properties SET config=jsonb_set(config,'{rollup,targetPropertyId}',$2::jsonb) WHERE id=$1",
      [f.rollups.sum.id, JSON.stringify(f.formulaTarget.id)],
    );
    assert.equal((await f.preview()).response.status, 400);
  } finally {
    await db.end();
  }
});

test("public rollup browser selection removes dependent fields, reviews real results and stays isolated on mobile", async () => {
  const { chromium, expect } = await import("@playwright/test"),
    db = new Pool({ connectionString: process.env.DATABASE_URL });
  let browser;
  try {
    const f = await fixture(db);
    browser = await chromium.launch({
      executablePath: "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1365, height: 1000 },
    });
    await context.addCookies([
      { name: "orvyn_session", value: f.cookie.split("=")[1], url: base },
    ]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/?page=" + f.id);
    await expect(
      page.getByRole("heading", { name: "The launch plan", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const share = page.getByRole("dialog", { name: "Share page", exact: true });
    await share.getByRole("tab", { name: "Publish", exact: true }).click();
    const scope = share.locator(".database-public-scope"),
      relation = scope.getByRole("checkbox", {
        name: "Related work",
        exact: true,
      }),
      sum = scope.getByRole("checkbox", { name: /^Total/ }),
      formula = scope.getByRole("checkbox", { name: /^Twice total/ });
    await expect(sum).toBeDisabled();
    await relation.check();
    await sum.check();
    await formula.check();
    await relation.uncheck();
    await expect(sum).not.toBeChecked();
    await expect(formula).not.toBeChecked();
    await expect(sum).toBeDisabled();
    await relation.check();
    await scope
      .getByRole("checkbox", { name: "Estimate", exact: true })
      .check();
    await sum.check();
    await scope.getByRole("checkbox", { name: /^Shared tasks/ }).check();
    for (const row of [f.root, f.a, f.b])
      await scope
        .getByRole("checkbox", { name: row.title, exact: true })
        .check();
    await share
      .getByRole("button", { name: "Review publication", exact: true })
      .click();
    const review = page.getByRole("dialog", {
      name: "Review publication",
      exact: true,
    });
    await expect(review).toBeVisible();
    await expect(review.getByText("0.3", { exact: true })).toBeVisible();
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/public-rollup-review.png",
      fullPage: true,
    });
    const created = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/v1/" + f.path &&
        r.request().method() === "POST",
    );
    await review
      .getByRole("button", { name: "Publish snapshot", exact: true })
      .click();
    const response = await created;
    assert.equal(response.status(), 201, await response.text());
    const publication = await response.json(),
      anonymous = await browser.newContext({
        viewport: { width: 1365, height: 900 },
      }),
      forbidden = [];
    await anonymous.route("**/api/v1/**", (route) => {
      if (
        !new URL(route.request().url()).pathname.startsWith(
          "/api/v1/publications/",
        )
      ) {
        forbidden.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    const reader = await anonymous.newPage();
    reader.on("pageerror", (e) => errors.push(e.message));
    await reader.goto(publication.url);
    const row = reader
      .getByRole("row")
      .filter({
        has: reader.getByRole("button", { name: f.root.title, exact: true }),
      });
    await expect(row.getByText("0.3", { exact: true })).toBeVisible();
    await expect(
      reader.getByText(/Calculated from shared values/),
    ).toBeVisible();
    await reader.screenshot({
      path: ".local/ui-review/public-rollup-reader.png",
      fullPage: true,
    });
    await reader.setViewportSize({ width: 390, height: 844 });
    await row.getByRole("button", { name: f.root.title, exact: true }).click();
    await expect(
      reader.getByRole("dialog").getByText("0.3", { exact: true }),
    ).toBeVisible();
    assert.equal(
      await reader.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await reader.screenshot({
      path: ".local/ui-review/public-rollup-mobile.png",
      fullPage: true,
    });
    assert.deepEqual(forbidden, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await db.end();
  }
});

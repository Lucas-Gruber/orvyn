import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  parseFormula,
  formulaType,
  formatFormula,
  relationWatchProperties,
} from "../packages/shared/dist/index.js";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { peer, waitFor } from "./collaboration-peer.mjs";

async function account() {
  const r = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(r.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
async function fixture(db) {
  const owner = await account(),
    viewer = await account(),
    space = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Product studio" },
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
      body: { name: "Project estimates" },
    })
  ).data;
  const f = { owner, viewer, space, database };
  f.hours = await property(f, "Hours", "Number");
  f.rate = await property(f, "Rate", "Number");
  return f;
}
async function property(f, name, type, extra = {}) {
  const result = await request(`databases/${f.database.id}/properties`, {
    method: "POST",
    cookie: f.owner.cookie,
    body: { name, type, ...extra },
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  return result.data;
}
async function formula(f, name, source) {
  return property(f, name, "Formula", { formula: source });
}
async function record(f, title, values = {}, visibility = "space") {
  const r = await request(`databases/${f.database.id}/records`, {
    method: "POST",
    cookie: f.owner.cookie,
    body: { title, values, visibility },
  });
  assert.equal(r.response.status, 201, JSON.stringify(r.data));
  return r.data;
}
const query = (f, body = {}, user = f.owner) =>
  request(`databases/${f.database.id}/query`, {
    method: "POST",
    cookie: user.cookie,
    body,
  });

test("formula grammar resolves stable IDs, rejects code/type/cycle/complexity errors and follows relation dependencies", () => {
  const hours = {
      id: randomUUID(),
      name: "Hours",
      type: "Number",
      config: {},
      position: 0,
    },
    relation = {
      id: randomUUID(),
      name: "Work",
      type: "Relation",
      config: { databaseId: randomUUID() },
      position: 1,
    },
    props = [hours, relation],
    expression = parseFormula(
      'round(prop("Hours") * 1.5) + length(prop("Work"))',
      props,
    );
  assert.equal(formulaType(expression, props), "number");
  const computed = {
    id: randomUUID(),
    name: "Estimate",
    type: "Formula",
    config: { expression, resultType: "number" },
    position: 2,
  };
  assert.deepEqual(relationWatchProperties([computed], [...props, computed]), [
    relation.id,
  ]);
  const renamed = [{ ...hours, name: "Effort" }, relation];
  assert.match(formatFormula(expression, renamed), /prop\("Effort"\)/);
  assert.equal(formulaType(expression, renamed), "number");
  for (const invalid of [
    'fetch("https://example.com")',
    "globalThis.process.exit()",
    'prop("Missing")',
    'prop("Hours") + "text"',
    "if(1, 2, 3)",
    "length(5)",
    "1; DROP TABLE pages",
    "round(1,2)",
    "1e309",
    '"unterminated',
    'concat("a",)',
    "(".repeat(25) + "1" + ")".repeat(25),
    Array(150).fill("1").join("+"),
  ])
    assert.throws(() => parseFormula(invalid, props), undefined, invalid);
  assert.throws(
    () =>
      parseFormula('prop("Hours")', [...props, { ...hours, id: randomUUID() }]),
    /ambiguous/,
  );
  const cyclic = {
    ...computed,
    config: {
      resultType: "number",
      expression: { kind: "property", id: computed.id, valueType: "number" },
    },
  };
  assert.throws(() => formulaType(cyclic.config.expression, [cyclic]), /cycle/);
});

test("formulas compute typed query/filter/sort/export results, reject writes, preserve renamed references and protect schema edits", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      category = await property(f, "Category", "Select", {
        options: ["Client", "Internal"],
      }),
      categories = await property(f, "Categories", "MultiSelect", {
        options: ["Build", "Review"],
      }),
      total = await formula(f, "Estimate", 'prop("Hours") * prop("Rate")'),
      withTax = await formula(f, "With tax", 'round(prop("Estimate") * 1.2)'),
      label = await formula(
        f,
        "Summary",
        'concat(upper(prop("Name")), ": ", format(coalesce(prop("Estimate"), 0)))',
      ),
      high = await formula(f, "High budget", 'prop("Estimate") >= 100'),
      zero = await formula(f, "Safe division", "1 / 0"),
      overflow = await formula(f, "Safe overflow", "1e308 * 1e308"),
      arithmetic = await formula(
        f,
        "Arithmetic",
        "min(max(abs(-5), ceil(2.1)), floor(9.9)) + round(2.4) + (7 % 4)",
      ),
      textFunctions = await formula(
        f,
        "Text tools",
        'if(contains(trim(lower(" A B ")), "a") && !false, "yes", "no")',
      ),
      categoryName = await formula(
        f,
        "Category name",
        'coalesce(prop("Category"), "Unassigned")',
      ),
      categoryCount = await formula(
        f,
        "Category count",
        'length(prop("Categories"))',
      ),
      literal = await formula(
        f,
        "Literal text",
        JSON.stringify("x'); select pg_sleep(5); --"),
      ),
      a = await record(f, "Alpha", {
        [f.hours.id]: 4,
        [f.rate.id]: 30,
        [category.id]: category.config.options[0].id,
        [categories.id]: categories.config.options.map((o) => o.id),
      }),
      b = await record(f, "Beta", { [f.hours.id]: 2, [f.rate.id]: 20 }),
      c = await record(f, "Gamma"),
      hidden = await record(
        f,
        "Private bid",
        { [f.hours.id]: 10, [f.rate.id]: 100 },
        "restricted",
      );
    assert.equal(a.values[total.id], 120);
    assert.equal(a.values[withTax.id], 144);
    assert.equal(a.values[label.id], "ALPHA: 120");
    assert.equal(a.values[high.id], true);
    assert.equal(a.values[zero.id], null);
    assert.equal(a.values[overflow.id], null);
    assert.equal(a.values[arithmetic.id], 10);
    assert.equal(a.values[textFunctions.id], "yes");
    assert.equal(a.values[categoryName.id], "Client");
    assert.equal(a.values[categoryCount.id], 2);
    assert.equal(a.values[literal.id], "x'); select pg_sleep(5); --");
    assert.equal(c.values[label.id], "GAMMA: 0");
    let r = await query(
      f,
      { sorts: [{ propertyId: total.id, direction: "desc" }], limit: 1 },
      f.viewer,
    );
    assert.equal(r.response.status, 200, JSON.stringify(r.data));
    assert.deepEqual(
      r.data.records.map((r) => r.pageId),
      [a.pageId],
    );
    assert.equal(r.data.nextOffset, 1);
    r = await query(
      f,
      {
        filters: [{ propertyId: total.id, operator: "gt", value: 50 }],
        limit: 1,
      },
      f.viewer,
    );
    assert.deepEqual(
      r.data.records.map((r) => r.pageId),
      [a.pageId],
    );
    r = await query(
      f,
      { filters: [{ propertyId: high.id, operator: "eq", value: false }] },
      f.viewer,
    );
    assert.deepEqual(
      r.data.records.map((r) => r.pageId),
      [b.pageId],
    );
    r = await query(
      f,
      { filters: [{ propertyId: total.id, operator: "empty" }] },
      f.viewer,
    );
    assert.deepEqual(
      r.data.records.map((r) => r.pageId),
      [c.pageId],
    );
    r = await query(
      f,
      {
        filters: [
          { propertyId: label.id, operator: "contains", value: "alpha" },
        ],
      },
      f.viewer,
    );
    assert.deepEqual(
      r.data.records.map((r) => r.pageId),
      [a.pageId],
    );
    for (const values of [{ [total.id]: 999 }, { [total.id]: null }]) {
      r = await request(`databases/${f.database.id}/records/${a.pageId}`, {
        method: "PATCH",
        cookie: f.owner.cookie,
        body: { version: a.version, values },
      });
      assert.equal(r.response.status, 400);
    }
    r = await request(`databases/${f.database.id}/records/${a.pageId}`, {
      method: "PATCH",
      cookie: f.owner.cookie,
      body: { version: a.version, values: { [f.hours.id]: 5 } },
    });
    assert.equal(r.response.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.values[total.id], 150);
    const metadata = async () =>
      (await request(`databases/${f.database.id}`, { cookie: f.owner.cookie }))
        .data;
    let meta = await metadata();
    r = await request(`databases/${f.database.id}/properties/${f.hours.id}`, {
      method: "PATCH",
      cookie: f.owner.cookie,
      body: { name: "Effort", schemaVersion: meta.schemaVersion },
    });
    assert.equal(r.response.status, 200);
    r = await query(f);
    assert.equal(
      r.data.records.find((r) => r.pageId === a.pageId).values[total.id],
      150,
    );
    meta = await metadata();
    const edit = (source, version = meta.schemaVersion, user = f.owner) =>
      request(`databases/${f.database.id}/properties/${total.id}`, {
        method: "PATCH",
        cookie: user.cookie,
        body: { name: "Estimate", schemaVersion: version, formula: source },
      });
    assert.equal((await edit('prop("Estimate") + 1')).response.status, 400);
    assert.equal((await edit('prop("With tax") + 1')).response.status, 400);
    assert.equal((await edit('"different type"')).response.status, 400);
    assert.equal(
      (await edit('prop("Effort") * prop("Rate")', meta.schemaVersion - 1))
        .response.status,
      409,
    );
    assert.equal(
      (
        await edit(
          'prop("Effort") * prop("Rate")',
          meta.schemaVersion,
          f.viewer,
        )
      ).response.status,
      404,
    );
    assert.equal(
      (await edit('prop("Effort") * prop("Rate") + 10')).response.status,
      200,
    );
    r = await query(f, {}, f.viewer);
    assert.equal(
      r.data.records.find((r) => r.pageId === a.pageId).values[total.id],
      160,
    );
    const exported = await request(`databases/${f.database.id}/export.json`, {
      cookie: f.viewer.cookie,
    });
    assert.equal(exported.response.status, 200, JSON.stringify(exported.data));
    assert.equal(
      exported.data.records.find((r) => r.pageId === a.pageId).values[total.id],
      160,
    );
    assert.equal(JSON.stringify(exported.data).includes(hidden.pageId), false);
    const csv = await fetch(
      `${base}/api/v1/databases/${f.database.id}/export.csv?spreadsheetSafe=false`,
      { headers: { cookie: f.viewer.cookie } },
    );
    assert.equal(csv.status, 200);
    const text = await csv.text();
    assert.match(text, /Estimate/);
    assert.match(text, /160/);
    assert.equal(text.includes("Private bid"), false);
    for (const source of [
      "process.exit()",
      'prop("Effort") + "bad"',
      'prop("Absent")',
      'if(true, 1, "bad")',
    ]) {
      r = await request(`databases/${f.database.id}/properties`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: { name: "Invalid", type: "Formula", formula: source },
      });
      assert.equal(r.response.status, 400, JSON.stringify(r.data));
    }
    const before = await metadata();
    assert.equal(
      before.properties.filter((p) => p.name === "Invalid").length,
      0,
    );
    const csvSource =
        "Name,Effort,Rate,Estimate\nImported estimate,3,20,999999\n",
      upload = async (action, settings = {}) => {
        const body = new FormData();
        body.append(
          "file",
          new Blob([csvSource], { type: "text/csv" }),
          "estimates.csv",
        );
        body.append("settings", JSON.stringify(settings));
        const response = await fetch(
          `${base}/api/v1/databases/${f.database.id}/import/csv/${action}`,
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
    assert.equal(preview.data.canImport, true, JSON.stringify(preview.data));
    assert.equal(
      preview.data.mapping.find((m) => m.column === 3).skip,
      true,
      "computed columns are skipped during import",
    );
    assert.equal(
      (await upload("confirm", { token: preview.data.token })).status,
      201,
    );
    r = await query(f, { search: "Imported estimate" });
    assert.equal(
      r.data.records[0].values[total.id],
      70,
      "CSV values cannot override the formula",
    );
  } finally {
    await db.end();
  }
});

test("formulas count only readable relations in queries/exports and subscribe through hidden dependency columns", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let remote;
  try {
    const f = await fixture(db),
      relation = await property(f, "Related work", "Relation", {
        relationDatabaseId: f.database.id,
      }),
      count = await formula(f, "Linked count", 'length(prop("Related work"))'),
      visible = await record(f, "Visible work"),
      secret = await record(f, "Secret work", {}, "restricted"),
      parent = await record(f, "Plan", {
        [relation.id]: [visible.pageId, secret.pageId],
      });
    assert.equal(parent.values[count.id], 2);
    const title = f.database.properties.find((p) => p.type === "Title"),
      view = (
        await request(`databases/${f.database.id}/views`, {
          method: "POST",
          cookie: f.owner.cookie,
          body: {
            name: "Totals only",
            type: "Table",
            config: {
              visibleProperties: [title.id, count.id],
              filters: [
                { propertyId: title.id, operator: "eq", value: "Plan" },
              ],
            },
          },
        })
      ).data;
    let r = await query(f, { viewId: view.id }, f.viewer);
    assert.equal(r.response.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.records[0].values[count.id], 1);
    assert.equal(r.data.records[0].values[relation.id], undefined);
    assert.equal(r.data.records[0].relations, undefined);
    assert.deepEqual(r.data.relationProperties, [relation.id]);
    assert.equal(JSON.stringify(r.data).includes(secret.pageId), false);
    const exportData = (
      await request(
        `databases/${f.database.id}/export.json?viewId=${view.id}`,
        { cookie: f.viewer.cookie },
      )
    ).data;
    assert.equal(exportData.records[0].values[count.id], 1);
    assert.equal(JSON.stringify(exportData).includes(secret.pageId), false);
    remote = peer(
      JSON.parse(process.env.COLLABORATION_TEST_URLS)[1],
      f.database.id,
      f.viewer.cookie,
    );
    const messages = [];
    remote.provider.on("stateless", ({ payload }) =>
      messages.push(JSON.parse(payload)),
    );
    await waitFor(() => remote.provider.isSynced, "Formula observer connected");
    remote.provider.sendStateless(
      JSON.stringify({
        type: "watch-records",
        recordIds: [parent.pageId],
        relationProperties: r.data.relationProperties,
        fingerprint: r.data.fingerprint,
      }),
    );
    await waitFor(() => messages.some((m) => m.type === "records-watched"));
    assert.equal(
      messages.some((m) => m.type === "database-changed"),
      false,
      "HTTP and collaboration fingerprints must match for hidden formula dependencies",
    );
    const current = (
      await request(`pages/${visible.pageId}`, { cookie: f.owner.cookie })
    ).data;
    const revoke = await request(`pages/${visible.pageId}/permissions`, {
      method: "PUT",
      cookie: f.owner.cookie,
      body: {
        version: current.version,
        confirm: true,
        visibility: "restricted",
        grants: [],
      },
    });
    assert.equal(revoke.response.status, 200, JSON.stringify(revoke.data));
    await waitFor(() => messages.some((m) => m.type === "database-changed"));
    r = await query(f, { viewId: view.id }, f.viewer);
    assert.equal(r.data.records[0].values[count.id], 0);
    r = await query(
      f,
      { filters: [{ propertyId: count.id, operator: "gt", value: 0 }] },
      f.viewer,
    );
    assert.equal(r.data.records.length, 0);
  } finally {
    remote?.destroy();
    await db.end();
  }
});

test("Chromium: create and edit a formula, recalculate inputs, save numeric filters, reload and preserve read-only access", async () => {
  const { chromium, expect } = await import("@playwright/test"),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    }),
    db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db);
    await record(f, "Website launch", { [f.hours.id]: 6, [f.rate.id]: 80 });
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
    await page.goto(`${base}/?page=${f.database.id}`);
    await page.getByText("Add a property", { exact: true }).click();
    await page.getByLabel("Property name", { exact: true }).fill("Estimate");
    await page
      .getByLabel("Property type", { exact: true })
      .selectOption("Formula");
    await page
      .getByLabel("Formula expression", { exact: true })
      .fill('prop("Hours") * prop("Rate")');
    await expect(
      page.getByText("Result: number", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Add property", exact: true })
      .click();
    const row = page.getByRole("row").filter({
      has: page.getByRole("button", { name: "Website launch", exact: true }),
    });
    await expect(row.locator(".property-formula")).toHaveText("480");
    await row.getByLabel("Hours", { exact: true }).fill("8");
    await row.getByLabel("Hours", { exact: true }).press("Tab");
    await expect(row.locator(".property-formula")).toHaveText("640");
    await page
      .getByRole("button", { name: "Edit Estimate formula", exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Edit formula",
      exact: true,
    });
    await editor
      .getByLabel("Formula expression")
      .fill('round(prop("Hours") * prop("Rate") * 1.2)');
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/database-formula-editor.png",
      fullPage: true,
    });
    await editor
      .getByRole("button", { name: "Save formula", exact: true })
      .click();
    await expect(editor).not.toBeVisible();
    await expect(row.locator(".property-formula")).toHaveText("768");
    await page
      .getByRole("button", { name: "View settings", exact: true })
      .click();
    const settings = page.getByRole("dialog", {
      name: "View settings",
      exact: true,
    });
    await settings
      .getByRole("button", { name: "Add filter", exact: true })
      .click();
    await settings
      .getByLabel("Filter property", { exact: true })
      .selectOption({ label: "Estimate" });
    await settings
      .getByLabel("Filter comparison", { exact: true })
      .selectOption("gte");
    await settings.getByRole("spinbutton", { name: "Estimate", exact: true }).fill("700");
    await settings
      .getByRole("button", { name: "Save view", exact: true })
      .click();
    await expect(row).toBeVisible();
    await page.reload();
    await expect(row.locator(".property-formula")).toHaveText("768");
    const reader = await browser.newContext();
    await reader.addCookies([
      {
        name: "orvyn_session",
        value: f.viewer.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const readPage = await reader.newPage();
    await readPage.goto(`${base}/?page=${f.database.id}`);
    await expect(readPage.locator(".property-formula")).toHaveText("768");
    await expect(
      readPage.getByRole("button", { name: "Edit Estimate formula" }),
    ).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await db.end();
  }
});

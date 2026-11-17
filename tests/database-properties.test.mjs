import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool } from "./helpers.mjs";
import { base } from "./helpers.mjs";
import { chromium, expect } from "./browser-tools.mjs";
import { pageLink } from "../packages/editor/dist/links.js";
import { mkdir } from "node:fs/promises";

async function account() {
  const result = await request("auth/register", {
    method: "POST",
    body: { email: randomUUID() + "@example.test", password: randomUUID() },
  });
  const cookie = sessionCookie(result.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
async function setup() {
  const owner = await account();
  const space = (
    await request("spaces", {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Schema work" },
    })
  ).data;
  const database = (
    await request(`spaces/${space.id}/databases`, {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Decisions" },
    })
  ).data;
  const path = `databases/${database.id}`;
  const get = async () => (await request(path, { cookie: owner.cookie })).data;
  const add = async (name, type, extra = {}) =>
    (
      await request(path + "/properties", {
        method: "POST",
        cookie: owner.cookie,
        body: { name, type, ...extra },
      })
    ).data;
  const patch = async (property, body) =>
    request(path + "/properties/" + property.id, {
      method: "PATCH",
      cookie: owner.cookie,
      body: {
        name: property.name,
        schemaVersion: (await get()).schemaVersion,
        ...body,
      },
    });
  const remove = async (property) =>
    request(path + "/properties/" + property.id, {
      method: "DELETE",
      cookie: owner.cookie,
      body: { schemaVersion: (await get()).schemaVersion },
    });
  const restore = async (property) =>
    request(path + "/properties/" + property.id + "/restore", {
      method: "POST",
      cookie: owner.cookie,
      body: { schemaVersion: (await get()).schemaVersion },
    });
  return { owner, space, database, path, get, add, patch, remove, restore };
}

test("property options retain stable IDs, archive/restore values, sanitize filters/exports and enforce schema revisions and current roles", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await setup(),
      viewer = await account(),
      stranger = await account();
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [f.space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      f.space.id,
      viewer.id,
    ]);
    const category = await f.add("Category", "Select", {
      options: ["Research", "Ready"],
    });
    const tags = await f.add("Tags", "MultiSelect", {
      options: ["One", "Two"],
    });
    const formula = await f.add("Category label", "Formula", {
      formula: 'prop("Category")',
    });
    const record = (
      await request(f.path + "/records", {
        method: "POST",
        cookie: f.owner.cookie,
        body: {
          title: "Keep the originals",
          values: {
            [category.id]: category.config.options[0].id,
            [tags.id]: tags.config.options.map((item) => item.id),
          },
        },
      })
    ).data;
    const renamed = category.config.options.map((item, index) => ({
      ...item,
      label: index ? item.label : "Discovery",
    }));
    assert.equal(
      (await f.patch(category, { name: "Stage", options: renamed })).response
        .status,
      200,
    );
    const snapshot = async () =>
      (
        await request(f.path + "/records/" + record.pageId, {
          cookie: f.owner.cookie,
        })
      ).data.record;
    assert.equal(
      (await snapshot()).values[category.id],
      category.config.options[0].id,
    );
    assert.equal((await snapshot()).values[formula.id], "Discovery");
    const meta = await f.get(),
      view = meta.views.find((item) => item.type === "Table");
    assert.equal(
      (
        await request(f.path + "/views/" + view.id, {
          method: "PATCH",
          cookie: f.owner.cookie,
          body: {
            ...view,
            id: undefined,
            position: undefined,
            config: {
              ...view.config,
              filters: [
                {
                  propertyId: category.id,
                  operator: "eq",
                  value: category.config.options[0].id,
                },
              ],
            },
          },
        })
      ).response.status,
      200,
    );
    const before = await f.get();
    assert.equal(
      (await f.patch(category, { options: renamed.slice(1) })).response.status,
      400,
    );
    assert.equal((await f.get()).schemaVersion, before.schemaVersion);
    assert.equal(
      (await f.patch(category, { options: [renamed[0], renamed[0]] })).response
        .status,
      400,
    );
    assert.equal(
      (
        await f.patch(category, {
          options: [{ ...renamed[0], id: tags.config.options[0].id }],
        })
      ).response.status,
      400,
    );
    const archived = await f.patch(category, {
      name: "Stage",
      options: renamed.slice(1),
      confirmOptionRemoval: true,
    });
    assert.equal(archived.response.status, 200, JSON.stringify(archived.data));
    assert.equal((await snapshot()).values[category.id], null);
    assert.equal((await snapshot()).values[formula.id], null);
    assert.equal(
      (await f.get()).views.find((item) => item.id === view.id).config.filters
        .length,
      0,
    );
    const empty = await request(f.path + "/query", {
      method: "POST",
      cookie: f.owner.cookie,
      body: { filters: [{ propertyId: category.id, operator: "empty" }] },
    });
    assert.equal(empty.data.records.length, 1);
    const exported = (
      await request(f.path + "/export.json", { cookie: f.owner.cookie })
    ).data;
    assert.equal(exported.records[0].values[category.id], null);
    assert.equal(
      (
        await db.query(
          "SELECT values->$1 AS value FROM database_records WHERE page_id=$2",
          [category.id, record.pageId],
        )
      ).rows[0].value,
      category.config.options[0].id,
    );
    const deleted = await request(
      f.path + "/properties/" + category.id + "/deleted-options",
      { cookie: f.owner.cookie },
    );
    assert.equal(deleted.data[0].id, category.config.options[0].id);
    assert.equal(deleted.data[0].label, "Discovery");
    assert.equal(
      (
        await request(
          f.path + "/properties/" + category.id + "/deleted-options",
          { cookie: viewer.cookie },
        )
      ).response.status,
      404,
    );
    assert.equal(
      (
        await request(f.path + "/deleted-properties", {
          cookie: stranger.cookie,
        })
      ).response.status,
      404,
    );
    assert.equal(
      (
        await request(f.path + "/properties/" + category.id, {
          method: "PATCH",
          cookie: f.owner.cookie,
          body: { name: "Stale rename", schemaVersion: before.schemaVersion },
        })
      ).response.status,
      409,
    );
    assert.equal(
      (await f.patch(category, { name: "Stage", options: renamed })).response
        .status,
      200,
    );
    assert.equal(
      (await snapshot()).values[category.id],
      category.config.options[0].id,
    );
    assert.equal((await snapshot()).values[formula.id], "Discovery");
    assert.equal(
      (
        await request(
          f.path + "/properties/" + category.id + "/deleted-options",
          { cookie: f.owner.cookie },
        )
      ).data.length,
      0,
    );
    assert.equal(
      (
        await f.patch(tags, {
          options: tags.config.options.slice(1),
          confirmOptionRemoval: true,
        })
      ).response.status,
      200,
    );
    assert.deepEqual((await snapshot()).values[tags.id], [
      tags.config.options[1].id,
    ]);
    assert.equal(
      (
        await request(f.path + "/query", {
          method: "POST",
          cookie: f.owner.cookie,
          body: {
            filters: [
              {
                propertyId: tags.id,
                operator: "eq",
                value: [tags.config.options[1].id],
              },
            ],
          },
        })
      ).data.records.length,
      1,
    );
    assert.equal(
      (await f.patch(tags, { options: [], confirmOptionRemoval: true }))
        .response.status,
      200,
    );
    assert.deepEqual((await snapshot()).values[tags.id], []);
    assert.equal(
      (
        await request(f.path + "/query", {
          method: "POST",
          cookie: f.owner.cookie,
          body: { filters: [{ propertyId: tags.id, operator: "empty" }] },
        })
      ).data.records.length,
      1,
    );
    assert.equal(
      (await f.patch(tags, { options: tags.config.options })).response.status,
      200,
    );
    assert.deepEqual(
      (await snapshot()).values[tags.id],
      tags.config.options.map((item) => item.id).sort(),
    );
  } finally {
    await db.end();
  }
});

test("property deletion is reversible, preserves values, repairs saved views and blocks dependent formulas and relation rollups", async () => {
  const f = await setup();
  const number = await f.add("Estimate", "Number"),
    formula = await f.add("Doubled", "Formula", {
      formula: 'prop("Estimate") * 2',
    });
  const record = (
    await request(f.path + "/records", {
      method: "POST",
      cookie: f.owner.cookie,
      body: { title: "Persistent values", values: { [number.id]: 7 } },
    })
  ).data;
  const before = await f.get();
  assert.equal((await f.remove(number)).response.status, 409);
  assert.equal((await f.get()).schemaVersion, before.schemaVersion);
  assert.equal(
    (await f.remove(before.properties.find((item) => item.type === "Title")))
      .response.status,
    400,
  );
  assert.equal((await f.remove(formula)).response.status, 200);
  assert.equal((await f.remove(number)).response.status, 200);
  const hidden = (
    await request(f.path + "/records/" + record.pageId, {
      cookie: f.owner.cookie,
    })
  ).data;
  assert.equal(Object.hasOwn(hidden.record.values, number.id), false);
  assert.equal((await f.restore(formula)).response.status, 409);
  assert.equal((await f.restore(number)).response.status, 200);
  assert.equal((await f.restore(formula)).response.status, 200);
  const saved = (
    await request(f.path + "/records/" + record.pageId, {
      cookie: f.owner.cookie,
    })
  ).data.record;
  assert.equal(saved.values[number.id], 7);
  assert.equal(saved.values[formula.id], 14);
  const status = (await f.get()).properties.find(
    (item) => item.type === "Status",
  );
  assert.equal((await f.remove(status)).response.status, 200);
  const afterStatus = await f.get();
  assert.equal(
    afterStatus.views.find((item) => item.name === "Board").type,
    "Table",
  );
  assert.equal(
    afterStatus.views.find((item) => item.name === "Board").config.groupBy,
    null,
  );
  assert.equal(
    (
      await request(f.path + "/query", {
        method: "POST",
        cookie: f.owner.cookie,
        body: {
          viewId: afterStatus.views.find((item) => item.name === "Board").id,
        },
      })
    ).response.status,
    200,
  );
  const date = afterStatus.properties.find((item) => item.type === "Date");
  assert.equal((await f.remove(date)).response.status, 200);
  assert.equal(
    (await f.get()).views.find((item) => item.name === "Calendar").type,
    "Table",
  );
  assert.equal((await f.restore(status)).response.status, 200);
  assert.equal((await f.restore(date)).response.status, 200);
  const relation = await f.add("Related", "Relation", {
    relationDatabaseId: f.database.id,
  });
  const rollup = await f.add("Count", "Rollup", {
    rollup: { relationId: relation.id, aggregation: "count" },
  });
  const current = (
    await request(f.path + "/records/" + record.pageId, {
      cookie: f.owner.cookie,
    })
  ).data.record;
  assert.equal(
    (
      await request(f.path + "/records/" + record.pageId, {
        method: "PATCH",
        cookie: f.owner.cookie,
        body: {
          version: current.version,
          values: { [relation.id]: [record.pageId] },
        },
      })
    ).response.status,
    200,
  );
  assert.equal((await f.remove(relation)).response.status, 409);
  assert.equal((await f.remove(rollup)).response.status, 200);
  assert.equal((await f.remove(relation)).response.status, 200);
  assert.equal((await f.restore(relation)).response.status, 200);
  assert.equal((await f.restore(rollup)).response.status, 200);
  const restored = (
    await request(f.path + "/records/" + record.pageId, {
      cookie: f.owner.cookie,
    })
  ).data.record;
  assert.deepEqual(restored.values[relation.id], [record.pageId]);
  assert.equal(restored.values[rollup.id], 1);
  assert.equal(
    (await f.get()).views.find((item) => item.name === "Board").type,
    "Table",
    "Restore does not overwrite later view settings",
  );
});

test("Chromium: manage property names/options, confirm deletion, restore saved values, recover schema conflicts and fit mobile", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  let page;
  try {
    const f = await setup(),
      estimate = await f.add("Estimate", "Number");
    const status = (await f.get()).properties.find(
      (item) => item.type === "Status",
    );
    const record = (
      await request(f.path + "/records", {
        method: "POST",
        cookie: f.owner.cookie,
        body: {
          title: "A considered decision",
          values: {
            [estimate.id]: 7,
            [status.id]: status.config.options[0].id,
          },
        },
      })
    ).data;
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
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
    await context.addInitScript(() =>
      localStorage.setItem("orvyn.theme", "light"),
    );
    page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base + pageLink(f.database.id));
    await page
      .getByRole("button", { name: "Edit Status property", exact: true })
      .click();
    const manager = page.getByRole("dialog", {
      name: "Database properties",
      exact: true,
    });
    const propertyName = manager.getByRole("textbox", {
      name: "Property name",
      exact: true,
    });
    await expect(propertyName).toHaveValue("Status");
    await propertyName.fill("Workflow");
    const firstOption = manager.getByRole("group", {
      name: "Option 1",
      exact: true,
    });
    await firstOption
      .getByRole("textbox", { name: "Option name", exact: true })
      .fill("Planned");
    await firstOption
      .getByRole("combobox", { name: "Option color", exact: true })
      .selectOption("blue");
    await manager
      .getByRole("button", { name: "Add option", exact: true })
      .click();
    const newOption = manager.getByRole("group", {
      name: "Option 4",
      exact: true,
    });
    await newOption
      .getByRole("textbox", { name: "Option name", exact: true })
      .fill("Blocked");
    await newOption
      .getByRole("combobox", { name: "Option color", exact: true })
      .selectOption("amber");
    await manager
      .getByRole("button", { name: "Save property", exact: true })
      .click();
    await expect(
      manager.getByRole("button", { name: "Discard changes", exact: true }),
    ).toHaveCount(0);
    await expect(
      manager.getByRole("button", { name: "Save property", exact: true }),
    ).toBeDisabled();
    const savedStatus = (await f.get()).properties.find(
      (item) => item.id === status.id,
    );
    assert.equal(savedStatus.name, "Workflow");
    assert.equal(savedStatus.config.options[0].id, status.config.options[0].id);
    assert.equal(savedStatus.config.options[0].label, "Planned");
    assert.equal(savedStatus.config.options[3].label, "Blocked");
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/database-property-options.png",
      fullPage: true,
    });
    await propertyName.fill("Unfinished rename");
    await page.keyboard.press("Escape");
    await expect(manager).toBeVisible();
    await expect(manager.getByRole("alert")).toContainText("Save or discard");
    await manager
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await expect(propertyName).toHaveValue("Workflow");
    await firstOption
      .getByRole("button", { name: "Remove option", exact: true })
      .click();
    await manager
      .getByRole("checkbox", { name: /Remove these options/ })
      .check();
    await manager
      .getByRole("button", { name: "Save property", exact: true })
      .click();
    await expect(
      manager.getByRole("button", { name: "Discard changes", exact: true }),
    ).toHaveCount(0);
    await expect(
      manager.getByRole("button", { name: "Save property", exact: true }),
    ).toBeDisabled();
    const snapshot = async () =>
      (
        await request(f.path + "/records/" + record.pageId, {
          cookie: f.owner.cookie,
        })
      ).data.record;
    assert.equal((await snapshot()).values[status.id], null);
    await manager
      .locator("summary")
      .filter({ hasText: "Deleted options" })
      .click();
    await manager
      .getByRole("button", { name: "Restore option Planned", exact: true })
      .click();
    await manager
      .getByRole("button", { name: "Save property", exact: true })
      .click();
    await expect(
      manager.getByRole("button", { name: "Discard changes", exact: true }),
    ).toHaveCount(0);
    await expect(
      manager.getByRole("button", { name: "Save property", exact: true }),
    ).toBeDisabled();
    assert.equal(
      (await snapshot()).values[status.id],
      status.config.options[0].id,
    );
    await manager
      .getByRole("navigation", { name: "Properties", exact: true })
      .getByRole("button", { name: "Estimate", exact: true })
      .click();
    await manager
      .getByRole("button", { name: "Delete property", exact: true })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: "Delete property",
      exact: true,
    });
    await expect(confirmation).toContainText("Saved record values are kept");
    await confirmation
      .getByRole("button", { name: "Delete property", exact: true })
      .click();
    await expect(confirmation).not.toBeVisible();
    assert.equal(Object.hasOwn((await snapshot()).values, estimate.id), false);
    await manager
      .getByRole("navigation", { name: "Properties", exact: true })
      .getByRole("button", { name: "Estimate", exact: true })
      .click();
    await f.add("Concurrent restoration", "Text");
    await manager
      .getByRole("button", { name: "Restore property", exact: true })
      .click();
    await expect(manager.getByRole("alert")).toContainText("schema changed");
    await manager
      .getByRole("button", { name: "Reload properties", exact: true })
      .click();
    await expect(
      manager.getByRole("button", { name: "Restore property", exact: true }),
    ).toBeEnabled();
    await manager
      .getByRole("button", { name: "Restore property", exact: true })
      .click();
    await expect(propertyName).toHaveValue("Estimate");
    assert.equal((await snapshot()).values[estimate.id], 7);
    await f.add("Concurrent property", "Text");
    await propertyName.fill("Budget");
    await manager
      .getByRole("button", { name: "Save property", exact: true })
      .click();
    await expect(manager.getByRole("alert")).toContainText("schema changed");
    await expect(propertyName).toHaveValue("Budget");
    await manager
      .getByRole("button", { name: "Use saved property", exact: true })
      .click();
    await expect(propertyName).toHaveValue("Estimate");
    await manager
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    const url = `${base}/api/v1/${f.path}/records/${record.pageId}`;
    await page.route(url, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ message: "Connection interrupted" }),
          })
        : route.continue(),
    );
    const row = page.locator(".database-table tbody tr").filter({
      has: page.getByRole("button", { name: record.title, exact: true }),
    });
    await row
      .getByRole("spinbutton", { name: "Estimate", exact: true })
      .fill("14");
    await row
      .getByRole("spinbutton", { name: "Estimate", exact: true })
      .press("Tab");
    const recovery = page.getByRole("region", {
      name: "Unsaved changes for " + record.title,
      exact: true,
    });
    await expect(recovery.getByRole("alert")).toBeVisible();
    assert.equal((await f.remove(estimate)).response.status, 200);
    await expect(
      recovery.getByText(
        "A property in this draft was deleted. Restore it in Properties to save its changes.",
        { exact: true },
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Database options", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Properties", exact: true })
      .click();
    await manager
      .getByRole("navigation", { name: "Properties", exact: true })
      .getByRole("button", { name: "Estimate", exact: true })
      .click();
    await manager
      .getByRole("button", { name: "Restore property", exact: true })
      .click();
    await expect(propertyName).toHaveValue("Estimate");
    await manager
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(
      recovery.getByRole("spinbutton", { name: "Estimate", exact: true }),
    ).toHaveValue("14");
    await page.unroute(url);
    await recovery
      .getByRole("button", { name: "Retry saving", exact: true })
      .click();
    await expect(recovery).toHaveCount(0);
    assert.equal((await snapshot()).values[estimate.id], 14);
    await page
      .getByRole("button", { name: "Edit Workflow property", exact: true })
      .click();
    await manager
      .getByRole("navigation", { name: "Properties", exact: true })
      .getByRole("button", { name: "Workflow", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await manager.evaluate(
        (node) => node.scrollWidth <= node.clientWidth + 1,
      ),
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: ".local/ui-review/database-property-options-mobile.png",
      fullPage: true,
    });
    await manager
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(manager).not.toBeVisible();
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page)
      await page.screenshot({
        path: "/tmp/orvyn-property-manager-failure.png",
        fullPage: true,
      });
    throw error;
  } finally {
    await browser.close();
  }
});

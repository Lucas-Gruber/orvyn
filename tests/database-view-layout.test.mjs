import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  orderedViewProperties,
  reorderPropertyIds,
} from "../packages/shared/dist/index.js";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { chromium, expect } from "./browser-tools.mjs";
import { pageLink } from "../packages/editor/dist/links.js";

async function account() {
  const result = await request("auth/register", {
    method: "POST",
    body: { email: randomUUID() + "@example.test", password: randomUUID() },
  });
  const cookie = sessionCookie(result.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
async function fixture() {
  const owner = await account();
  const space = (
    await request("spaces", {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Product studio" },
    })
  ).data;
  const database = (
    await request(`spaces/${space.id}/databases`, {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "A thoughtful roadmap" },
    })
  ).data;
  const path = `databases/${database.id}`;
  const get = async () => (await request(path, { cookie: owner.cookie })).data;
  const add = async (name, type) =>
    (
      await request(path + "/properties", {
        method: "POST",
        cookie: owner.cookie,
        body: { name, type },
      })
    ).data;
  const notes = await add("Notes", "Text"),
    effort = await add("Effort", "Number");
  const meta = await get();
  const query = async (viewId, cookie = owner.cookie) =>
    (
      await request(path + "/query", {
        method: "POST",
        cookie,
        body: { viewId },
      })
    ).data;
  const update = async (view, config, cookie = owner.cookie) =>
    request(path + "/views/" + view.id, {
      method: "PATCH",
      cookie,
      body: { name: view.name, type: view.type, version: view.version, config },
    });
  return {
    owner,
    space,
    database,
    path,
    get,
    add,
    notes,
    effort,
    meta,
    query,
    update,
  };
}

test("view layout keeps the title and required fields visible, orders partial layouts stably and never mutates metadata", () => {
  const properties = ["Name", "Status", "Date", "Notes", "Effort"].map(
    (name, index) => ({
      id: String(index),
      name,
      type: ["Title", "Status", "Date", "Text", "Number"][index],
      position: index,
      config: {},
    }),
  );
  const original = structuredClone(properties);
  const config = {
    filters: [],
    sorts: [],
    visibleProperties: ["3"],
    propertyOrder: ["4", "3", "0"],
    groupBy: "1",
    dateProperty: "2",
  };
  assert.deepEqual(
    orderedViewProperties(properties, config).map((item) => item.name),
    ["Name", "Notes", "Status", "Date"],
  );
  assert.deepEqual(
    orderedViewProperties(properties, { ...config, visibleProperties: [] }).map(
      (item) => item.name,
    ),
    ["Name", "Effort", "Notes", "Status", "Date"],
  );
  assert.deepEqual(properties, original);
  assert.deepEqual(reorderPropertyIds(["0", "1", "2", "3"], "3", "1"), [
    "0",
    "3",
    "1",
    "2",
  ]);
  assert.deepEqual(reorderPropertyIds(["0", "1", "2", "3"], "1", "3", true), [
    "0",
    "2",
    "3",
    "1",
  ]);
});

test("saved column order is scoped per view, validates IDs and versions, follows exports, templates and reversible property deletion", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(),
      viewer = await account();
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [f.space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      f.space.id,
      viewer.id,
    ]);
    const title = f.meta.properties.find(
        (property) => property.type === "Title",
      ),
      status = f.meta.properties.find((property) => property.type === "Status"),
      date = f.meta.properties.find((property) => property.type === "Date");
    let view = f.meta.views.find((view) => view.type === "Table");
    const ids = [f.effort.id, f.notes.id, date.id, status.id, title.id];
    let config = { ...view.config, propertyOrder: ids };
    const saved = await f.update(view, config);
    assert.equal(saved.response.status, 200);
    const expected = [title.id, f.effort.id, f.notes.id, date.id, status.id];
    assert.deepEqual(
      (await f.query(view.id)).properties.map((property) => property.id),
      expected,
    );
    assert.deepEqual(
      (
        await f.query(f.meta.views.find((view) => view.type === "List").id)
      ).properties.map((property) => property.id),
      f.meta.properties.map((property) => property.id),
    );
    assert.equal((await f.update(view, config)).response.status, 409);
    view = saved.data;
    assert.ok(
      [403, 404].includes(
        (await f.update(view, config, viewer.cookie)).response.status,
      ),
    );
    for (const propertyOrder of [
      [f.notes.id, f.notes.id],
      [randomUUID()],
      "Notes",
      Array.from({ length: 51 }, () => randomUUID()),
    ])
      assert.equal(
        (await f.update(view, { ...config, propertyOrder })).response.status,
        400,
      );
    const exported = await request(f.path + "/export.csv?viewId=" + view.id, {
      cookie: viewer.cookie,
    });
    assert.equal(exported.response.status, 200);
    assert.equal(
      exported.data.split("\r\n")[0],
      [title.name, "Effort", "Notes", "Date", "Status"].join(","),
    );
    const json = (
      await request(f.path + "/export.json?viewId=" + view.id, {
        cookie: viewer.cookie,
      })
    ).data;
    assert.deepEqual(
      json.database.properties.map((property) => property.id),
      expected,
    );
    const template = (
      await request(f.path + "/templates", {
        method: "POST",
        cookie: f.owner.cookie,
        body: { name: "A clean layout", kind: "database" },
      })
    ).data;
    const applied = await request(`templates/${template.id}/apply`, {
      method: "POST",
      cookie: f.owner.cookie,
      body: {
        requestId: randomUUID(),
        version: template.version,
        title: "A fresh roadmap",
      },
    });
    assert.equal(applied.response.status, 201, JSON.stringify(applied.data));
    const clone = (
      await request(`databases/${applied.data.pageId}`, {
        cookie: f.owner.cookie,
      })
    ).data;
    const cloneView = clone.views.find((item) => item.type === "Table");
    assert.ok(
      cloneView.config.propertyOrder.every((id) =>
        clone.properties.some((property) => property.id === id),
      ),
    );
    assert.ok(cloneView.config.propertyOrder.every((id) => !ids.includes(id)));
    const cloneQuery = (
      await request(`databases/${clone.id || applied.data.pageId}/query`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: { viewId: cloneView.id },
      })
    ).data;
    assert.deepEqual(
      cloneQuery.properties.map((property) => property.name),
      [title.name, "Effort", "Notes", "Date", "Status"],
    );
    // Hide every optional column while retaining the title; no empty-means-all ambiguity.
    const onlyTitle = await f.update(view, {
      ...config,
      visibleProperties: [title.id],
    });
    assert.equal(onlyTitle.response.status, 200);
    assert.deepEqual(
      (await f.query(view.id)).properties.map((property) => property.id),
      [title.id],
    );
    view = onlyTitle.data;
    const beforeDelete = await f.get();
    assert.equal(
      (
        await request(f.path + "/properties/" + f.notes.id, {
          method: "DELETE",
          cookie: f.owner.cookie,
          body: { schemaVersion: beforeDelete.schemaVersion },
        })
      ).response.status,
      200,
    );
    const repaired = (await f.get()).views.find((item) => item.id === view.id);
    assert.ok(!repaired.config.propertyOrder.includes(f.notes.id));
    assert.equal(repaired.version, view.version + 1);
    const beforeRestore = await f.get();
    assert.equal(
      (
        await request(f.path + "/properties/" + f.notes.id + "/restore", {
          method: "POST",
          cookie: f.owner.cookie,
          body: { schemaVersion: beforeRestore.schemaVersion },
        })
      ).response.status,
      200,
    );
    // A restored property rejoins the canonical tail without replacing the saved layout.
    const allAgain = await f.update(repaired, {
      ...repaired.config,
      visibleProperties: [],
    });
    assert.equal(allAgain.response.status, 200);
    const after = await f.query(view.id);
    assert.deepEqual(
      after.properties.map((property) => property.id),
      [title.id, f.effort.id, date.id, status.id, f.notes.id],
    );
    // Board and calendar dependencies remain visible even when not explicitly selected.
    for (const kind of ["Board", "Calendar"]) {
      const special = (await f.get()).views.find((item) => item.type === kind);
      assert.equal(
        (
          await f.update(special, {
            ...special.config,
            propertyOrder: [f.notes.id],
            visibleProperties: [title.id],
          })
        ).response.status,
        200,
      );
      assert.ok(
        (await f.query(special.id)).properties.some(
          (property) =>
            property.id === (kind === "Board" ? status.id : date.id),
        ),
      );
    }
  } finally {
    await db.end();
  }
});

test("Chromium: arrange/hide view properties, drag headers, preserve failed cell drafts, review view conflicts and fit mobile", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const contexts = [],
    errors = [];
  let page;
  try {
    await mkdir(".local/ui-review", { recursive: true });
    const f = await fixture();
    const status = f.meta.properties.find(
      (property) => property.type === "Status",
    );
    const record = (
      await request(f.path + "/records", {
        method: "POST",
        cookie: f.owner.cookie,
        body: {
          title: "Make the first impression count",
          values: {
            [f.notes.id]: "A clear path from idea to outcome",
            [f.effort.id]: 5,
            [status.id]: status.config.options[0].id,
          },
        },
      })
    ).data;
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
      reducedMotion: "reduce",
    });
    contexts.push(context);
    await context.addInitScript(() =>
      localStorage.setItem("orvyn.theme", "light"),
    );
    await context.addCookies([
      {
        name: "orvyn_session",
        value: f.owner.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base + pageLink(f.database.id));
    const table = page.locator(".database-table");
    const names = () =>
      table
        .locator("thead .property-header-button")
        .allTextContents()
        .then((names) => names.map((name) => name.trim()));
    await expect
      .poll(names)
      .toEqual(["Name", "Status", "Date", "Notes", "Effort"]);
    await page
      .getByRole("button", { name: "View properties", exact: true })
      .click();
    const layout = page.getByRole("dialog", {
      name: "View properties",
      exact: true,
    });
    await expect(
      layout.getByLabel("Show Name in view", { exact: true }),
    ).toBeDisabled();
    await layout
      .getByRole("button", { name: "Move Effort up", exact: true })
      .click();
    await layout
      .getByRole("button", { name: "Reorder Effort", exact: true })
      .focus();
    await page.keyboard.press("Alt+Shift+ArrowUp");
    await page.keyboard.press("Alt+Shift+ArrowUp");
    await layout.getByLabel("Show Date in view", { exact: true }).uncheck();
    const rowNames = () =>
      layout
        .locator(".view-layout-name")
        .allTextContents()
        .then((names) =>
          names.map((name) => name.replace("Always shown first", "").trim()),
        );
    await expect
      .poll(rowNames)
      .toEqual(["Name", "Effort", "Status", "Date", "Notes"]);
    await page.screenshot({
      path: ".local/ui-review/database-view-properties.png",
      fullPage: true,
    });
    await layout
      .getByRole("button", { name: "Save layout", exact: true })
      .click();
    await expect(layout).not.toBeVisible();
    await expect.poll(names).toEqual(["Name", "Effort", "Status", "Notes"]);
    const statusHeader = table.locator("thead th").filter({
      has: page.getByRole("button", {
        name: "Edit Status property",
        exact: true,
      }),
    });
    await table
      .getByRole("button", { name: "Move Notes column", exact: true })
      .dragTo(statusHeader, { targetPosition: { x: 2, y: 12 } });
    await expect.poll(names).toEqual(["Name", "Effort", "Notes", "Status"]);
    await table
      .getByRole("button", { name: "Move Effort column", exact: true })
      .focus();
    await page.keyboard.press("Alt+Shift+ArrowRight");
    await expect.poll(names).toEqual(["Name", "Notes", "Effort", "Status"]);
    await expect(
      table.getByRole("button", { name: "Move Effort column", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Alt+Shift+ArrowRight");
    await expect.poll(names).toEqual(["Name", "Notes", "Status", "Effort"]);
    await expect(
      table.getByRole("button", { name: "Move Effort column", exact: true }),
    ).toBeFocused();
    // Failed cell values remain available while the view layout changes around them.
    const patchUrl = `**/api/v1/${f.path}/records/${record.pageId}`;
    await page.route(patchUrl, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ message: "Test write unavailable" }),
          })
        : route.continue(),
    );
    await table
      .getByRole("textbox", { name: "Notes", exact: true })
      .fill("Keep this local thought");
    await table
      .getByRole("textbox", { name: "Notes", exact: true })
      .press("Tab");
    const recovery = page.getByRole("region", {
      name: "Unsaved changes for " + record.title,
      exact: true,
    });
    await expect(recovery.getByRole("alert")).toBeVisible();
    await page
      .getByRole("button", { name: "View properties", exact: true })
      .click();
    await layout.getByLabel("Show Notes in view", { exact: true }).uncheck();
    await layout
      .getByRole("button", { name: "Save layout", exact: true })
      .click();
    await expect(layout).not.toBeVisible();
    await expect.poll(names).toEqual(["Name", "Status", "Effort"]);
    await expect(
      recovery.getByRole("textbox", { name: "Notes", exact: true }),
    ).toHaveValue("Keep this local thought");
    await page.unroute(patchUrl);
    await recovery
      .getByRole("button", { name: "Retry saving", exact: true })
      .click();
    await expect(recovery).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (
            await request(f.path + "/records/" + record.pageId, {
              cookie: f.owner.cookie,
            })
          ).data.record.values[f.notes.id],
      )
      .toBe("Keep this local thought");
    // A concurrent edit requires an explicit reload rather than replacing newer filters.
    await page
      .getByRole("button", { name: "View properties", exact: true })
      .click();
    await layout.getByLabel("Show Date in view", { exact: true }).check();
    const latest = (await f.get()).views.find((item) => item.type === "Table");
    assert.equal(
      (
        await f.update(latest, {
          ...latest.config,
          sorts: [{ propertyId: f.effort.id, direction: "desc" }],
        })
      ).response.status,
      200,
    );
    await layout
      .getByRole("button", { name: "Save layout", exact: true })
      .click();
    await expect(layout.getByRole("alert")).toContainText(
      "changed in another window",
    );
    await expect(
      layout.getByLabel("Show Date in view", { exact: true }),
    ).toBeChecked();
    await layout
      .getByRole("button", { name: "Reload saved layout", exact: true })
      .click();
    await expect(
      layout.getByLabel("Show Date in view", { exact: true }),
    ).not.toBeChecked();
    await layout
      .getByRole("button", { name: "Reset layout", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await layout.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: ".local/ui-review/database-view-properties-mobile.png",
      fullPage: true,
    });
    await layout
      .getByRole("button", { name: "Save layout", exact: true })
      .click();
    await expect(layout).not.toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1050 });
    await expect
      .poll(names)
      .toEqual(["Name", "Status", "Date", "Notes", "Effort"]);
    const savedView = (await f.get()).views.find(
      (item) => item.type === "Table",
    );
    assert.deepEqual(savedView.config.sorts, [
      { propertyId: f.effort.id, direction: "desc" },
    ]);
    await page.reload();
    await expect
      .poll(names)
      .toEqual(["Name", "Status", "Date", "Notes", "Effort"]);
    await expect(
      table.getByRole("textbox", { name: "Notes", exact: true }),
    ).toHaveValue("Keep this local thought");
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page)
      await page.screenshot({
        path: ".local/ui-review/database-view-layout-failure.png",
        fullPage: true,
      });
    console.error("View layout browser errors", errors);
    throw error;
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { chromium, expect } from "./browser-tools.mjs";
import { waitFor } from "./collaboration-peer.mjs";

async function account() {
  const r = await request("auth/register", {
    method: "POST",
    body: { email: randomUUID() + "@example.test", password: randomUUID() },
  });
  const cookie = sessionCookie(r.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
async function fixture(db) {
  const owner = await account(),
    viewer = await account();
  const space = (
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
      body: { name: "Release roadmap" },
    })
  ).data;
  const path = `databases/${database.id}`;
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
  const get = async () => (await request(path, { cookie: owner.cookie })).data;
  const update = (view, config, user = owner) =>
    request(path + "/views/" + view.id, {
      method: "PATCH",
      cookie: user.cookie,
      body: { name: view.name, type: view.type, version: view.version, config },
    });
  let meta = await get();
  const title = meta.properties.find((p) => p.type === "Title"),
    table = meta.views.find((v) => v.type === "Table");
  assert.equal(
    (
      await update(table, {
        ...table.config,
        visibleProperties: [title.id, notes.id, effort.id],
      })
    ).response.status,
    200,
  );
  const focus = (
    await request(path + "/views", {
      method: "POST",
      cookie: owner.cookie,
      body: {
        name: "Focus",
        type: "Table",
        config: {
          ...table.config,
          visibleProperties: [title.id, notes.id, effort.id],
        },
      },
    })
  ).data;
  const row = (
    await request(path + "/records", {
      method: "POST",
      cookie: owner.cookie,
      body: {
        title: "Launch the new workspace",
        values: {
          [notes.id]:
            "Give the team a clear path from research to a confident release.",
          [effort.id]: 8,
        },
      },
    })
  ).data;
  meta = await get();
  return {
    owner,
    viewer,
    space,
    database,
    path,
    notes,
    effort,
    title,
    focus,
    row,
    meta,
    get,
    update,
    view: () => get().then((m) => m.views.find((v) => v.id === table.id)),
  };
}
const launch = () =>
  chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
async function open(browser, f, user = f.owner) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  await context.addInitScript(() =>
    localStorage.setItem("orvyn.theme", "light"),
  );
  await context.addCookies([
    {
      name: "orvyn_session",
      value: user.cookie.split("=")[1],
      url: base,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  await page.goto(`${base}/?page=${f.database.id}`);
  await expect(page.locator(".database-table tbody tr")).toHaveCount(1);
  return page;
}
const savedWidth = async (f, value) =>
  waitFor(
    async () => (await f.view()).config.propertyWidths?.[f.notes.id] === value,
    "Saved column width " + value,
  );
const handle = (page) =>
  page.getByRole("separator", { name: "Resize Notes column", exact: true });
async function dragStart(page, delta) {
  const box = await handle(page).boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, {
    steps: 8,
  });
}

test("saved view widths validate active fields, type-specific limits and versions, remap through templates and repair deleted properties", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db);
    let view = await f.view();
    const propertyWidths = {
      [f.title.id]: 320,
      [f.notes.id]: 380,
      [f.effort.id]: 110,
    };
    const saved = await f.update(view, { ...view.config, propertyWidths });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.data));
    assert.equal(
      (await f.update(view, { ...view.config, propertyWidths })).response
        .status,
      409,
    );
    view = saved.data;
    assert.deepEqual(view.config.propertyWidths, propertyWidths);
    assert.equal(
      (await f.get()).views.find((v) => v.id === f.focus.id).config
        .propertyWidths,
      undefined,
    );
    assert.ok(
      [403, 404].includes(
        (await f.update(view, view.config, f.viewer)).response.status,
      ),
    );
    for (const widths of [
      { [randomUUID()]: 300 },
      { [f.title.id]: 199 },
      { [f.notes.id]: 139 },
      { [f.effort.id]: 99 },
      { [f.notes.id]: 961 },
      { [f.notes.id]: 300.5 },
      { [f.notes.id]: "300" },
      { bad: 300 },
      null,
      Object.fromEntries(Array.from({ length: 51 }, () => [randomUUID(), 300])),
    ])
      assert.equal(
        (await f.update(view, { ...view.config, propertyWidths: widths }))
          .response.status,
        400,
        JSON.stringify(widths),
      );
    const queried = (
      await request(f.path + "/query", {
        method: "POST",
        cookie: f.viewer.cookie,
        body: { viewId: view.id },
      })
    ).data;
    assert.deepEqual(queried.view.config.propertyWidths, propertyWidths);
    const template = (
      await request(f.path + "/templates", {
        method: "POST",
        cookie: f.owner.cookie,
        body: { name: "Wide notes", kind: "database" },
      })
    ).data;
    const clone = await request(`templates/${template.id}/apply`, {
      method: "POST",
      cookie: f.owner.cookie,
      body: {
        requestId: randomUUID(),
        version: template.version,
        title: "A fresh roadmap",
      },
    });
    assert.equal(clone.response.status, 201, JSON.stringify(clone.data));
    const cloned = (
      await request(`databases/${clone.data.pageId}`, {
        cookie: f.owner.cookie,
      })
    ).data;
    const cloneView = cloned.views.find((v) => v.name === view.name);
    for (const [name, width] of [
      [f.title.name, 320],
      ["Notes", 380],
      ["Effort", 110],
    ]) {
      const field = cloned.properties.find((p) => p.name === name);
      assert.equal(cloneView.config.propertyWidths[field.id], width);
      assert.equal(Object.hasOwn(propertyWidths, field.id), false);
    }
    const removed = await request(f.path + "/properties/" + f.notes.id, {
      method: "DELETE",
      cookie: f.owner.cookie,
      body: { schemaVersion: (await f.get()).schemaVersion },
    });
    assert.equal(removed.response.status, 200);
    assert.equal((await f.view()).config.propertyWidths[f.notes.id], undefined);
    assert.equal((await f.view()).config.propertyWidths[f.effort.id], 110);
    const restored = await request(
      f.path + "/properties/" + f.notes.id + "/restore",
      {
        method: "POST",
        cookie: f.owner.cookie,
        body: { schemaVersion: (await f.get()).schemaVersion },
      },
    );
    assert.equal(restored.response.status, 200);
    assert.equal((await f.view()).config.propertyWidths[f.notes.id], undefined);
    const row = (
      await request(f.path + "/records/" + f.row.pageId, {
        cookie: f.owner.cookie,
      })
    ).data.record;
    assert.equal(row.version, f.row.version);
    assert.equal(row.values[f.notes.id], f.row.values[f.notes.id]);
  } finally {
    await db.end();
  }
});

test("Chromium: resize once on release, cancel gestures, use keyboard bounds/reset, retain per-view widths and update live readers", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await launch();
  try {
    const f = await fixture(db),
      page = await open(browser, f),
      reader = await open(browser, f, f.viewer),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const resize = handle(page);
    await expect(resize).toHaveAttribute("aria-valuenow", "240");
    await expect(
      reader.getByRole("separator", { name: /Resize .* column/ }),
    ).toHaveCount(0);
    let writes = 0;
    page.on("request", (req) => {
      if (req.method() === "PATCH" && req.url().includes(f.path + "/views/"))
        writes++;
    });
    const initial = await f.view();
    await dragStart(page, 120);
    await expect(resize).toHaveAttribute("aria-valuenow", "360");
    assert.equal(
      (await f.view()).version,
      initial.version,
      "pointer previews do not write the view",
    );
    await page.mouse.up();
    await savedWidth(f, 360);
    await expect(resize).toHaveAttribute("aria-disabled", "false");
    assert.equal(writes, 1);
    assert.equal((await f.view()).version, initial.version + 1);
    await expect
      .poll(() =>
        reader
          .getByRole("columnheader")
          .nth(1)
          .evaluate((el) => Math.round(el.getBoundingClientRect().width)),
      )
      .toBe(360);
    await dragStart(page, 70);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(resize).toHaveAttribute("aria-valuenow", "360");
    assert.equal(writes, 1);
    assert.equal(
      await page.evaluate(() => document.documentElement.style.cursor),
      "",
    );
    await dragStart(page, 40);
    await resize.dispatchEvent("pointercancel", { pointerId: 1 });
    await page.mouse.up();
    await expect(resize).toHaveAttribute("aria-valuenow", "360");
    assert.equal(writes, 1);
    await resize.focus();
    for (const [key, width] of [
      ["ArrowRight", 370],
      ["Shift+ArrowRight", 420],
      ["Home", 140],
      ["End", 960],
      ["Enter", undefined],
    ]) {
      await resize.press(key);
      await savedWidth(f, width);
      await expect(resize).toHaveAttribute("aria-disabled", "false");
      await expect(resize).toBeFocused();
    }
    await resize.press("Shift+ArrowRight");
    await savedWidth(f, 290);
    await expect(resize).toHaveAttribute("aria-disabled", "false");
    await page.reload();
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "290");
    await page.getByRole("tab", { name: "Focus", exact: true }).click();
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "240");
    await page.getByRole("tab", { name: "Table", exact: true }).click();
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "290");
    await dragStart(page, 200);
    await page.mouse.up();
    await savedWidth(f, 490);
    await expect(handle(page)).toHaveAttribute("aria-disabled", "false");
    await handle(page).focus();
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/database-column-widths.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: ".local/ui-review/database-column-widths-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await handle(page).dblclick();
    await savedWidth(f, undefined);
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "240");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await db.end();
  }
});

test("Chromium: column width conflicts reload the saved view while failed cell drafts survive view writes", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await launch();
  let release = () => {};
  try {
    const f = await fixture(db),
      page = await open(browser, f);
    let widthWrites = 0;
    page.on("request", (req) => {
      if (req.method() === "PATCH" && req.url().includes(f.path + "/views/"))
        widthWrites++;
    });
    const recordUrl = `${base}/api/v1/${f.path}/records/${f.row.pageId}`;
    await page.route(recordUrl, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ message: "Temporary write unavailable" }),
          })
        : route.continue(),
    );
    const input = page
      .locator(".database-table")
      .getByRole("textbox", { name: "Notes", exact: true });
    await input.fill("Keep this local thought");
    await input.press("Tab");
    const recovery = page.getByRole("region", {
      name: "Unsaved changes for " + f.row.title,
      exact: true,
    });
    await expect(recovery.getByRole("alert")).toBeVisible();
    await handle(page).focus();
    await handle(page).press("ArrowRight");
    await savedWidth(f, 250);
    await expect(input).toHaveValue("Keep this local thought");
    await expect(handle(page)).toHaveAttribute("aria-disabled", "false");
    await dragStart(page, 40);
    const gestureView = await f.view();
    assert.equal(
      (
        await f.update(gestureView, {
          ...gestureView.config,
          propertyWidths: {
            ...gestureView.config.propertyWidths,
            [f.notes.id]: 300,
          },
        })
      ).response.status,
      200,
    );
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "300");
    await page.mouse.up();
    assert.equal(
      widthWrites,
      1,
      "a remote view revision cancels the active gesture",
    );
    let intercepted = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const viewUrl = `${base}/api/v1/${f.path}/views/${(await f.view()).id}`;
    await page.route(
      viewUrl,
      async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        intercepted = true;
        await gate;
        await route.continue();
      },
      { times: 1 },
    );
    await handle(page).press("ArrowRight");
    await waitFor(
      () => intercepted,
      "Column width write held before a concurrent update",
    );
    const current = await f.view();
    assert.equal(
      (
        await f.update(current, {
          ...current.config,
          propertyWidths: {
            ...current.config.propertyWidths,
            [f.notes.id]: 500,
          },
        })
      ).response.status,
      200,
    );
    release();
    await expect(
      page.getByRole("alert").filter({ hasText: /view changed/i }),
    ).toBeVisible();
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "500");
    await expect(input).toHaveValue("Keep this local thought");
    assert.equal(
      (
        await request(f.path + "/records/" + f.row.pageId, {
          cookie: f.owner.cookie,
        })
      ).data.record.version,
      f.row.version,
    );
    await recovery
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await expect(input).toHaveValue(f.row.values[f.notes.id]);
  } finally {
    release();
    await browser.close();
    await db.end();
  }
});

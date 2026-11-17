import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, base, Pool } from "./helpers.mjs";
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
      body: { name: "Project decisions" },
    })
  ).data;
  const add = async (name, type, extra = {}) => {
    const result = await request(`databases/${database.id}/properties`, {
      method: "POST",
      cookie: owner.cookie,
      body: { name, type, ...extra },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data;
  };
  const estimate = await add("Estimate", "Number"),
    notes = await add("Notes", "Text"),
    approved = await add("Approved", "Checkbox");
  const record = (
    await request(`databases/${database.id}/records`, {
      method: "POST",
      cookie: owner.cookie,
      body: {
        title: "A decision worth keeping",
        values: { [estimate.id]: 8, [notes.id]: "Saved notes" },
      },
    })
  ).data;
  return { owner, space, database, estimate, notes, approved, record, add };
}
async function session(browser, owner) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1050 },
    reducedMotion: "reduce",
  });
  await context.addCookies([
    {
      name: "orvyn_session",
      value: owner.cookie.split("=")[1],
      url: base,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  await context.addInitScript(() =>
    localStorage.setItem("orvyn.theme", "light"),
  );
  return context.newPage();
}
const rowFor = (page, title) =>
  page
    .locator(".database-table tbody tr")
    .filter({ has: page.getByRole("button", { name: title, exact: true }) });
const launch = () =>
  chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
const recordPath = (f) =>
  `databases/${f.database.id}/records/${f.record.pageId}`;
const snapshot = async (f) =>
  (await request(recordPath(f), { cookie: f.owner.cookie })).data.record;

test("Chromium: failed drafts retain every writable cell type through refresh, block navigation and retry together", async () => {
  const browser = await launch();
  try {
    const f = await fixture();
    const labels = await f.add("Labels", "MultiSelect", {
      options: ["Design", "Review"],
    });
    const assignees = await f.add("Assignees", "Person"),
      files = await f.add("Documents", "Files");
    const target = (
      await request(`databases/${f.database.id}/records`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: { title: "Related decision", values: {} },
      })
    ).data;
    const relation = await f.add("Related", "Relation", {
      relationDatabaseId: f.database.id,
    });
    const form = new FormData();
    form.append("file", new Blob(["A real test attachment"]), "brief.txt");
    const upload = await fetch(
      `${base}/api/v1/pages/${f.record.pageId}/files`,
      {
        method: "POST",
        headers: { Cookie: f.owner.cookie, Origin: process.env.TEST_ORIGIN },
        body: form,
      },
    );
    assert.equal(upload.status, 201);
    const file = await upload.json();
    const otherPage = (
      await request(`spaces/${f.space.id}/pages`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: { title: "Another document" },
      })
    ).data;
    const metadata = (
      await request(`databases/${f.database.id}`, { cookie: f.owner.cookie })
    ).data;
    const status = metadata.properties.find((p) => p.type === "Status"),
      date = metadata.properties.find((p) => p.type === "Date");
    const page = await session(browser, f.owner),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base + pageLink(f.database.id));
    const row = rowFor(page, f.record.title),
      url = `${base}/api/v1/${recordPath(f)}`;
    let attempts = 0;
    await page.route(url, (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      attempts++;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          message:
            "The connection was interrupted. Your changes could not be saved.",
        }),
      });
    });
    await row
      .getByRole("textbox", { name: "Notes", exact: true })
      .fill("Keep this draft");
    await row.getByRole("textbox", { name: "Notes", exact: true }).press("Tab");
    const recovery = page.getByRole("region", {
      name: "Unsaved changes for " + f.record.title,
      exact: true,
    });
    await expect(recovery.getByRole("alert")).toContainText(
      "connection was interrupted",
    );
    let unloadType = "";
    page.once("dialog", async (dialog) => {
      unloadType = dialog.type();
      await dialog.dismiss();
    });
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => unloadType).toBe("beforeunload");
    assert.equal(
      page.isClosed(),
      false,
      "Dismissing the unsaved-changes warning keeps the draft open",
    );
    await row
      .getByRole("spinbutton", { name: "Estimate", exact: true })
      .fill("13");
    await row
      .getByRole("spinbutton", { name: "Estimate", exact: true })
      .press("Tab");
    await row.getByRole("checkbox", { name: "Approved", exact: true }).check();
    await row
      .getByRole("combobox", { name: "Status", exact: true })
      .selectOption(status.config.options[1].id);
    await row
      .getByRole("textbox", { name: "Date", exact: true })
      .fill("2026-12-04");
    await row.getByRole("textbox", { name: "Date", exact: true }).press("Tab");
    for (const [name, option] of [
      ["Labels", "Design"],
      ["Assignees", f.owner.email],
      ["Documents", "brief.txt"],
    ]) {
      await row.getByRole("button", { name, exact: true }).click();
      const picker = page.getByRole("dialog", {
        name: name + " options",
        exact: true,
      });
      await picker.getByRole("option", { name: option, exact: true }).click();
      await picker.getByRole("button", { name: "Done", exact: true }).click();
    }
    await row.getByRole("button", { name: "Related", exact: true }).click();
    const relations = page.getByRole("dialog", {
      name: "Related links",
      exact: true,
    });
    await relations
      .getByRole("option", { name: "Related decision", exact: true })
      .click();
    await relations
      .getByRole("button", { name: "Apply links", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh records", exact: true })
      .click();
    await expect(
      row.getByRole("textbox", { name: "Notes", exact: true }),
    ).toHaveValue("Keep this draft");
    await expect(
      row.getByRole("spinbutton", { name: "Estimate", exact: true }),
    ).toHaveValue("13");
    await expect(
      row.getByRole("checkbox", { name: "Approved", exact: true }),
    ).toBeChecked();
    await expect(
      row.getByRole("button", { name: "Documents", exact: true }),
    ).toContainText("brief.txt");
    assert.equal(attempts, 1, "failed records wait for an explicit retry");
    await page
      .getByRole("navigation", { name: "Pages", exact: true })
      .getByRole("button", { name: otherPage.title, exact: true })
      .click();
    await expect(
      page.getByText(
        "Some database changes have not been saved. Retry or discard your drafts before leaving.",
        { exact: true },
      ),
    ).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.get("page"), f.database.id);
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/database-draft-recovery.png",
      fullPage: true,
    });
    await page.unroute(url);
    await recovery
      .getByRole("button", { name: "Retry saving", exact: true })
      .click();
    await expect(recovery).toHaveCount(0);
    const saved = await snapshot(f);
    assert.equal(saved.values[f.notes.id], "Keep this draft");
    assert.equal(saved.values[f.estimate.id], 13);
    assert.equal(saved.values[f.approved.id], true);
    assert.equal(saved.values[status.id], status.config.options[1].id);
    assert.equal(saved.values[date.id], "2026-12-04");
    assert.deepEqual(saved.values[labels.id], [labels.config.options[0].id]);
    assert.deepEqual(saved.values[assignees.id], [f.owner.id]);
    assert.deepEqual(saved.values[files.id], [file.id]);
    assert.deepEqual(saved.values[relation.id], [target.pageId]);
    assert.deepEqual(errors, []);
    await row
      .getByRole("textbox", { name: "Notes", exact: true })
      .fill("Saved before keyboard navigation");
    await page.keyboard.press("Control+p");
    const search = page.getByRole("dialog", {
      name: "Search your workspace",
      exact: true,
    });
    await expect(search).toBeVisible();
    await page.keyboard.press("Escape");
    await page
      .getByRole("navigation", { name: "Pages", exact: true })
      .getByRole("button", { name: otherPage.title, exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue(otherPage.title);
    assert.equal(
      (await snapshot(f)).values[f.notes.id],
      "Saved before keyboard navigation",
    );
  } finally {
    await browser.close();
  }
});

test("Chromium: queued cells rebase unrelated writes and same-field conflicts require current-value review", async () => {
  const browser = await launch();
  try {
    const f = await fixture(),
      page = await session(browser, f.owner);
    await page.goto(base + pageLink(f.database.id));
    const row = rowFor(page, f.record.title),
      estimate = row.getByRole("spinbutton", { name: "Estimate", exact: true });
    const url = `${base}/api/v1/${recordPath(f)}`;
    let release, started;
    let hold = new Promise((resolve) => {
        release = resolve;
      }),
      pending = new Promise((resolve) => {
        started = resolve;
      });
    let held = false;
    await page.route(url, async (route) => {
      if (route.request().method() === "PATCH" && !held) {
        held = true;
        started();
        await hold;
      }
      await route.continue();
    });
    await estimate.fill("9");
    await estimate.press("Tab");
    await pending;
    await row
      .getByRole("textbox", { name: "Notes", exact: true })
      .fill("A second queued cell");
    await row.getByRole("textbox", { name: "Notes", exact: true }).press("Tab");
    const current = await snapshot(f);
    assert.equal(
      (
        await request(recordPath(f), {
          method: "PATCH",
          cookie: f.owner.cookie,
          body: { version: current.version, values: { [f.approved.id]: true } },
        })
      ).response.status,
      200,
    );
    release();
    await expect
      .poll(async () => (await snapshot(f)).values[f.notes.id])
      .toBe("A second queued cell");
    assert.equal((await snapshot(f)).values[f.estimate.id], 9);
    assert.equal((await snapshot(f)).values[f.approved.id], true);
    await expect(page.locator(".database-drafts")).toHaveCount(0);
    held = false;
    hold = new Promise((resolve) => {
      release = resolve;
    });
    pending = new Promise((resolve) => {
      started = resolve;
    });
    await estimate.fill("14");
    await estimate.press("Tab");
    await pending;
    const beforeConflict = await snapshot(f);
    await request(recordPath(f), {
      method: "PATCH",
      cookie: f.owner.cookie,
      body: {
        version: beforeConflict.version,
        values: { [f.estimate.id]: 99 },
      },
    });
    release();
    const recovery = page.getByRole("region", {
      name: "Unsaved changes for " + f.record.title,
      exact: true,
    });
    await expect(
      recovery.getByText("Saved value: 99", { exact: true }),
    ).toBeVisible();
    await expect(estimate).toHaveValue("14");
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/database-conflict-recovery.png",
      fullPage: true,
    });
    const later = await snapshot(f);
    await request(recordPath(f), {
      method: "PATCH",
      cookie: f.owner.cookie,
      body: { version: later.version, values: { [f.estimate.id]: 100 } },
    });
    await recovery
      .getByRole("button", { name: "Keep my changes", exact: true })
      .click();
    await expect(
      recovery.getByText("Saved value: 100", { exact: true }),
    ).toBeVisible();
    assert.equal((await snapshot(f)).values[f.estimate.id], 100);
    await recovery
      .getByRole("button", { name: "Keep my changes", exact: true })
      .click();
    await expect(recovery).toHaveCount(0);
    assert.equal((await snapshot(f)).values[f.estimate.id], 14);
    assert.equal(
      (await snapshot(f)).values[f.notes.id],
      "A second queued cell",
    );
  } finally {
    await browser.close();
  }
});

test("Chromium: off-view drafts survive filters, discard uses saved values and revoked records clear local drafts", async () => {
  const browser = await launch(),
    db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(),
      editor = await account();
    const labels = await f.add("Labels", "MultiSelect", {
      options: ["Design"],
    });
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [f.space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Editor')", [
      f.space.id,
      editor.id,
    ]);
    const table = f.database.views.find((v) => v.type === "Table");
    await request(`databases/${f.database.id}/views/${table.id}`, {
      method: "PATCH",
      cookie: f.owner.cookie,
      body: {
        name: table.name,
        type: table.type,
        version: table.version,
        config: {
          ...table.config,
          filters: [{ propertyId: f.estimate.id, operator: "gt", value: 5 }],
        },
      },
    });
    const page = await session(browser, editor);
    await page.goto(base + pageLink(f.database.id));
    const row = rowFor(page, f.record.title),
      url = `${base}/api/v1/${recordPath(f)}`;
    await page.route(url, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ message: "Connection interrupted" }),
          })
        : route.continue(),
    );
    await row
      .getByRole("spinbutton", { name: "Estimate", exact: true })
      .fill("20");
    await row
      .getByRole("spinbutton", { name: "Estimate", exact: true })
      .press("Tab");
    const recovery = page.getByRole("region", {
      name: "Unsaved changes for " + f.record.title,
      exact: true,
    });
    await expect(recovery.getByRole("alert")).toBeVisible();
    const current = await snapshot(f);
    await request(recordPath(f), {
      method: "PATCH",
      cookie: f.owner.cookie,
      body: { version: current.version, values: { [f.estimate.id]: 0 } },
    });
    await expect(row).toHaveCount(0);
    await expect(
      recovery.getByRole("spinbutton", { name: "Estimate", exact: true }),
    ).toHaveValue("20");
    await recovery
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await expect(recovery).toHaveCount(0);
    const reset = await snapshot(f);
    await request(recordPath(f), {
      method: "PATCH",
      cookie: f.owner.cookie,
      body: { version: reset.version, values: { [f.estimate.id]: 8 } },
    });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Labels", exact: true }).click();
    const picker = page.getByRole("dialog", {
      name: "Labels options",
      exact: true,
    });
    await picker.getByRole("option", { name: "Design", exact: true }).click();
    const beforeFilter = await snapshot(f);
    await request(recordPath(f), {
      method: "PATCH",
      cookie: f.owner.cookie,
      body: { version: beforeFilter.version, values: { [f.estimate.id]: 0 } },
    });
    await expect(row).toHaveCount(0);
    await page.locator(".database-drafts > summary").click();
    await expect(
      recovery.getByRole("button", { name: "Labels", exact: true }),
    ).toContainText("Design");
    assert.deepEqual((await snapshot(f)).values[labels.id] || [], []);
    await recovery
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    const beforeReset = await snapshot(f);
    await request(recordPath(f), {
      method: "PATCH",
      cookie: f.owner.cookie,
      body: { version: beforeReset.version, values: { [f.estimate.id]: 8 } },
    });
    await expect(row).toBeVisible();
    await row
      .getByRole("textbox", { name: "Notes", exact: true })
      .fill("Private local draft");
    await row.getByRole("textbox", { name: "Notes", exact: true }).press("Tab");
    await expect(recovery.getByRole("alert")).toBeVisible();
    const pageRecord = (
      await request(`pages/${f.record.pageId}`, { cookie: f.owner.cookie })
    ).data;
    await request(`pages/${f.record.pageId}/permissions`, {
      method: "PUT",
      cookie: f.owner.cookie,
      body: {
        version: pageRecord.version,
        confirm: true,
        visibility: "restricted",
        grants: [],
      },
    });
    await expect(row).toHaveCount(0);
    await expect(recovery).toHaveCount(0);
    await expect(
      page.getByText("Private local draft", { exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".database-drafts")).toHaveCount(0);
  } finally {
    await browser.close();
    await db.end();
  }
});

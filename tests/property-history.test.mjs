import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { request, Pool, base } from "./helpers.mjs";
import { chromium, expect } from "./browser-tools.mjs";
import { conversionFixture } from "./property-conversion-fixture.mjs";
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
async function fixture(db) {
  const f = await conversionFixture(db),
    preview = await f.preview({ toType: "Number" });
  assert.equal(preview.response.status, 200);
  const applied = await f.apply(preview.data);
  assert.equal(applied.response.status, 200, JSON.stringify(applied.data));
  const original = (await f.history()).data[0];
  // Imported historical fixtures deliberately share a PostgreSQL microsecond:
  // cursor order must use the stable ID tie-breaker, never a rounded JS Date.
  await db.query(
    `INSERT INTO database_property_changes(property_id,request_id,preview_digest,actor_id,from_type,to_type,from_config,to_config,total_records,changed_values,cleared_values,created_at)
    SELECT $1,gen_random_uuid(),'history fixture',$2,'Text','Number','{}','{}',0,0,0,now()+interval '0.000123 seconds' FROM generate_series(1,44)`,
    [f.notes.id, f.owner.id],
  );
  const page = (after, actor = f.owner) =>
    request(
      f.endpoint +
        "/type-history/page" +
        (after ? "?after=" + encodeURIComponent(after) : ""),
      { cookie: actor.cookie },
    );
  return { ...f, original, page };
}
test("property history paginates tied timestamps without gaps or duplicates and does not shift when newer changes arrive", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      expected = (
        await db.query(
          "SELECT id FROM database_property_changes WHERE property_id=$1 ORDER BY created_at DESC,id",
          [f.notes.id],
        )
      ).rows.map((row) => row.id),
      first = await f.page();
    assert.equal(first.response.status, 200);
    assert.equal(first.data.changes.length, 20);
    assert.equal(first.data.propertyType, "Number");
    const newer = (
      await db.query(
        "INSERT INTO database_property_changes(property_id,request_id,preview_digest,from_type,to_type,from_config,to_config,total_records,changed_values,cleared_values,created_at) VALUES($1,gen_random_uuid(),'new fixture','Text','Number','{}','{}',0,0,0,now()+interval '1 day') RETURNING id",
        [f.notes.id],
      )
    ).rows[0].id;
    const second = await f.page(first.data.nextCursor),
      third = await f.page(second.data.nextCursor);
    assert.equal(second.data.changes.length, 20);
    assert.equal(third.data.changes.length, 5);
    assert.equal(third.data.nextCursor, null);
    const ids = [
      ...first.data.changes,
      ...second.data.changes,
      ...third.data.changes,
    ].map((change) => change.id);
    assert.deepEqual(ids, expected);
    assert.equal(new Set(ids).size, 45);
    assert.ok(!ids.includes(newer));
    assert.equal((await f.page()).data.changes[0].id, newer);
    const older = third.data.changes.find(
      (change) => change.id === f.original.id,
    );
    assert.equal(older.canReviewRestore, true);
    const restore = await f.preview({ historyId: older.id });
    assert.equal(restore.response.status, 200);
    assert.equal(restore.data.toType, "Text");
    const saved = await f.apply(restore.data);
    assert.equal(saved.response.status, 200, JSON.stringify(saved.data));
    assert.equal(
      (await f.stored()).find((row) => row.page_id === f.rows[0].pageId).values[
        f.notes.id
      ],
      "0012",
    );
    const current = await f.page();
    assert.equal(current.data.propertyType, "Text");
    assert.equal(
      current.data.changes.find((change) => change.id === newer)
        .canReviewRestore,
      false,
    );
    const legacy = await f.history();
    assert.ok(Array.isArray(legacy.data));
    assert.equal(legacy.data.length, 20);
  } finally {
    await db.end();
  }
});
test("history cursors are scoped to the current owner/database/field and reject malformed, foreign or removed positions", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      first = await f.page();
    assert.equal(
      (await request(f.endpoint + "/type-history/page")).response.status,
      401,
    );
    for (const actor of [f.viewer, f.editor])
      assert.equal(
        (await f.page(first.data.nextCursor, actor)).response.status,
        404,
      );
    assert.equal((await f.page("not-a-cursor")).response.status, 400);
    assert.equal((await f.page(randomUUID())).response.status, 400);
    const foreign = (
      await db.query(
        "INSERT INTO database_property_changes(property_id,request_id,preview_digest,from_type,to_type,from_config,to_config,total_records,changed_values,cleared_values) VALUES($1,gen_random_uuid(),'foreign fixture','Number','Text','{}','{}',0,0,0) RETURNING id",
        [f.other.id],
      )
    ).rows[0].id;
    assert.equal((await f.page(foreign)).response.status, 400);
    assert.equal(
      (
        await request(
          f.endpoint +
            "/type-history/page?after=" +
            first.data.nextCursor +
            "&extra=true",
          { cookie: f.owner.cookie },
        )
      ).response.status,
      400,
    );
    await db.query("DELETE FROM database_property_changes WHERE id=$1", [
      first.data.nextCursor,
    ]);
    assert.equal((await f.page(first.data.nextCursor)).response.status, 400);
    await db.query(
      "UPDATE database_properties SET deleted_at=now() WHERE id=$1",
      [f.notes.id],
    );
    assert.equal((await f.page()).response.status, 404);
  } finally {
    await db.end();
  }
});
async function browserFixture(browser, f) {
  const context = await browser.newContext({
    viewport: { width: 1365, height: 1000 },
  });
  await context.addCookies([
    { name: "orvyn_session", value: f.owner.cookie.split("=")[1], url: base },
  ]);
  const page = await context.newPage();
  await page.goto(`${base}/?page=${f.database.id}`);
  await page
    .getByRole("button", { name: "Edit Estimate property", exact: true })
    .click();
  const manager = page.getByRole("dialog", {
      name: "Database properties",
      exact: true,
    }),
    dialog = page.getByRole("dialog", {
      name: "Change field type",
      exact: true,
    });
  const open = async () => {
    await manager
      .getByRole("button", { name: "Change type…", exact: true })
      .click();
    await expect(
      dialog.getByRole("combobox", { name: "New field type", exact: true }),
    ).toBeEnabled();
    await dialog.getByText("Recent type changes", { exact: true }).click();
  };
  await open();
  return { page, dialog, open };
}
const launch = () =>
  chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
test("Chromium: load older field changes, retain position after a failed request, review an older restore and fit mobile", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await launch();
  try {
    const f = await fixture(db),
      { page, dialog } = await browserFixture(browser, f);
    await expect(
      dialog.getByText("Showing 20 changes", { exact: true }),
    ).toBeVisible();
    await page.route("**/type-history/page?after=*", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Temporary history failure" }),
      }),
    );
    await dialog
      .getByRole("button", { name: "Load older changes", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Temporary history failure",
    );
    await expect(
      dialog.getByText("Showing 20 changes", { exact: true }),
    ).toBeVisible();
    await page.unroute("**/type-history/page?after=*");
    await dialog
      .getByRole("button", { name: "Retry older changes", exact: true })
      .click();
    await expect(
      dialog.getByText("Showing 40 changes", { exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Load older changes", exact: true })
      .click();
    await expect(
      dialog.getByText("All changes loaded", { exact: true }),
    ).toBeVisible();
    await expect(dialog.locator(".conversion-history li")).toHaveCount(45);
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/property-history-desktop.png",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: ".local/ui-review/property-history-mobile.png",
    });
    assert.ok(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    );
    await dialog
      .locator(".conversion-history li")
      .last()
      .getByRole("button", { name: "Review restore", exact: true })
      .click();
    await expect(
      dialog.getByText("Restore previous type: Text", { exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Apply type change", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await f.get()).properties.find(
            (property) => property.id === f.notes.id,
          ).type,
      )
      .toBe("Text");
    assert.equal(
      (await f.stored()).find((row) => row.page_id === f.rows[0].pageId).values[
        f.notes.id
      ],
      "0012",
    );
  } finally {
    await browser.close();
    await db.end();
  }
});
test("Chromium: a closed dialog ignores an older history response, and changed field types require a fresh history before restore", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await launch(),
    gate = deferred(),
    reached = deferred();
  try {
    const f = await fixture(db),
      { page, dialog, open } = await browserFixture(browser, f);
    await page.route(
      "**/type-history/page?after=*",
      async (route) => {
        const response = await route.fetch();
        reached.resolve();
        await gate.promise;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    await dialog
      .getByRole("button", { name: "Load older changes", exact: true })
      .click();
    await reached.promise;
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await open();
    const pending = page.waitForResponse((response) =>
      response.url().includes("/type-history/page?after="),
    );
    gate.resolve();
    await (await pending).finished();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(
      dialog.getByText("Showing 20 changes", { exact: true }),
    ).toBeVisible();
    const preview = await f.preview({ toType: "Text" });
    assert.equal((await f.apply(preview.data)).response.status, 200);
    await dialog
      .getByRole("button", { name: "Load older changes", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText("field type changed");
    for (const button of await dialog
      .getByRole("button", { name: "Review restore", exact: true })
      .all())
      await expect(button).toBeDisabled();
    await dialog
      .getByRole("button", { name: "Reload field", exact: true })
      .click();
    await expect(dialog.locator(".conversion-field")).toContainText("Text");
  } finally {
    gate.resolve();
    await browser.close();
    await db.end();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { request, Pool, base } from "./helpers.mjs";
import { chromium, expect } from "./browser-tools.mjs";
import { waitFor } from "./collaboration-peer.mjs";
import { conversionFixture as fixture } from "./property-conversion-fixture.mjs";
const launch = () =>
  chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
async function open(browser, f, actor = f.owner) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    reducedMotion: "reduce",
  });
  await context.addInitScript(() =>
    localStorage.setItem("orvyn.theme", "light"),
  );
  await context.addCookies([
    {
      name: "orvyn_session",
      value: actor.cookie.split("=")[1],
      url: base,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  await page.goto(`${base}/?page=${f.database.id}`);
  await expect(
    page.getByRole("heading", { name: "Planning decisions", exact: true }),
  ).toBeVisible();
  return page;
}
const manager = (page) =>
  page.getByRole("dialog", { name: "Database properties", exact: true });
const dialog = (page) =>
  page.getByRole("dialog", { name: "Change field type", exact: true });
async function start(page) {
  if (!(await manager(page).isVisible()))
    await page
      .getByRole("button", { name: "Edit Estimate property", exact: true })
      .click();
  await manager(page)
    .getByRole("button", { name: "Change type…", exact: true })
    .click();
  await expect(dialog(page)).toBeVisible();
  await expect(
    dialog(page).getByRole("combobox", { name: "New field type", exact: true }),
  ).toBeEnabled();
}
async function review(page, type) {
  await dialog(page)
    .getByRole("combobox", { name: "New field type", exact: true })
    .selectOption(type);
  await dialog(page)
    .getByRole("button", { name: "Review conversion", exact: true })
    .click();
  await expect(
    dialog(page).getByRole("button", {
      name: "Apply type change",
      exact: true,
    }),
  ).toBeVisible();
}

test("Chromium: review scalar type changes, acknowledge cleared values, inspect history, restore originals and fit mobile", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await launch();
  try {
    const f = await fixture(db),
      page = await open(browser, f),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await start(page);
    await review(page, "Number");
    const apply = dialog(page).getByRole("button", {
      name: "Apply type change",
      exact: true,
    });
    await expect(apply).toBeDisabled();
    await expect(
      dialog(page).getByText("Includes 1 archived record.", { exact: true }),
    ).toBeVisible();
    const research = dialog(page)
      .getByRole("row")
      .filter({
        has: page.getByRole("link", { name: "Research", exact: true }),
      });
    await expect(research.getByRole("cell").last()).toHaveText("Empty");
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/property-conversion-preview.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: ".local/ui-review/property-conversion-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const box = await dialog(page).boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390);
    await dialog(page)
      .getByRole("checkbox", {
        name: /I understand that 2 incompatible values will become empty/,
      })
      .check();
    await apply.click();
    await expect(
      dialog(page).getByText("Field type changed. Original values were kept.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await f.get()).properties.find((p) => p.id === f.notes.id).type,
      )
      .toBe("Number");
    await page.setViewportSize({ width: 1440, height: 1050 });
    await dialog(page)
      .getByText("Recent type changes", { exact: true })
      .click();
    await dialog(page)
      .getByRole("button", { name: "Review restore", exact: true })
      .click();
    await expect(
      dialog(page).getByText("Restore previous type: Text", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog(page).getByRole("button", {
        name: "Apply type change",
        exact: true,
      }),
    ).toBeEnabled();
    await dialog(page)
      .getByRole("button", { name: "Apply type change", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await f.get()).properties.find((p) => p.id === f.notes.id).type,
      )
      .toBe("Text");
    await expect(
      dialog(page).getByRole("combobox", {
        name: "New field type",
        exact: true,
      }),
    ).toHaveValue("");
    const restored = (await f.stored()).find(
      (row) => row.page_id === f.rows[0].pageId,
    );
    assert.equal(restored.values[f.notes.id], "0012");
    await dialog(page)
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(manager(page)).toBeVisible();
    await expect(
      manager(page).locator(".property-details .property-type"),
    ).toHaveText("Text");
    const editor = await open(browser, f, f.editor);
    await editor
      .getByRole("button", { name: "Edit Estimate property", exact: true })
      .click();
    await expect(manager(editor)).toBeVisible();
    await expect(
      manager(editor).getByRole("button", {
        name: "Change type…",
        exact: true,
      }),
    ).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await db.end();
  }
});

test("Chromium: stale review never overwrites newer values, lost responses retry once and closing an in-flight review leaves no stale state", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await launch();
  let release = () => {};
  try {
    const f = await fixture(db),
      page = await open(browser, f),
      ids = [];
    await start(page);
    await review(page, "Number");
    await dialog(page)
      .getByRole("checkbox", { name: /I understand/ })
      .check();
    await f.patch(f.rows[0], "15");
    await dialog(page)
      .getByRole("button", { name: "Apply type change", exact: true })
      .click();
    await expect(dialog(page).getByRole("alert")).toContainText(
      "database changed",
    );
    assert.equal(
      (await f.get()).properties.find((p) => p.id === f.notes.id).type,
      "Text",
    );
    await dialog(page)
      .getByRole("button", { name: "Review conversion", exact: true })
      .click();
    await dialog(page)
      .getByRole("checkbox", { name: /I understand/ })
      .check();
    const convertUrl = `${base}/api/v1/${f.endpoint}/convert`;
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url() === convertUrl)
        ids.push(req.postDataJSON().requestId);
    });
    await page.route(
      convertUrl,
      async (route) => {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "Connection lost after saving" }),
        });
      },
      { times: 1 },
    );
    await dialog(page)
      .getByRole("button", { name: "Apply type change", exact: true })
      .click();
    await expect(dialog(page).getByRole("alert")).toHaveText(
      "Connection lost after saving",
    );
    assert.equal(
      (await f.get()).properties.find((p) => p.id === f.notes.id).type,
      "Number",
    );
    const version = (await f.stored()).find(
      (row) => row.page_id === f.rows[0].pageId,
    ).version;
    await dialog(page)
      .getByRole("button", { name: "Apply type change", exact: true })
      .click();
    await expect(
      dialog(page).getByText("Field type changed. Original values were kept.", {
        exact: true,
      }),
    ).toBeVisible();
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
    assert.equal((await f.history()).data.length, 1);
    assert.equal(
      (await f.stored()).find((row) => row.page_id === f.rows[0].pageId)
        .version,
      version,
    );
    let intercepted = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const previewUrl = `${base}/api/v1/${f.endpoint}/conversion-preview`;
    await page.route(
      previewUrl,
      async (route) => {
        intercepted = true;
        await gate;
        await route.continue();
      },
      { times: 1 },
    );
    await dialog(page)
      .getByRole("combobox", { name: "New field type", exact: true })
      .selectOption("Date");
    await dialog(page)
      .getByRole("button", { name: "Review conversion", exact: true })
      .click();
    await waitFor(() => intercepted, "Preview request held");
    await dialog(page)
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(manager(page)).toBeVisible();
    await start(page);
    await review(page, "Text");
    release();
    await expect(
      dialog(page).getByRole("table").locator("caption"),
    ).toContainText(/Number\s*→\s*Text/);
    await expect(
      dialog(page).getByRole("button", {
        name: "Apply type change",
        exact: true,
      }),
    ).toBeEnabled();
    assert.equal(
      (await f.get()).properties.find((p) => p.id === f.notes.id).type,
      "Number",
    );
  } finally {
    release();
    await browser.close();
    await db.end();
  }
});

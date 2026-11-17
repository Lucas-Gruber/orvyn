import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, base } from "./helpers.mjs";
import { pageLink } from "../packages/editor/dist/links.js";
import { databaseAction } from "./ui-helpers.mjs";

test("Chromium: database side/modal/full-page editing, templates, context menus and discoverable keyboard navigation", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
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
          body: { name: "Product roadmap" },
        })
      ).data,
      hours = (
        await request(`databases/${database.id}/properties`, {
          method: "POST",
          cookie,
          body: { name: "Estimate", type: "Number" },
        })
      ).data,
      metadata = (await request(`databases/${database.id}`, { cookie })).data,
      status = metadata.properties.find((p) => p.type === "Status"),
      record = (
        await request(`databases/${database.id}/records`, {
          method: "POST",
          cookie,
          body: {
            title: "Design the writing experience",
            values: { [hours.id]: 4, [status.id]: status.config.options[1].id },
          },
        })
      ).data;
    for (const [title, estimate, state] of [
      ["Connect ideas across documents", 3, 0],
      ["Make database views feel effortless", 5, 1],
      ["Review keyboard navigation", 2, 2],
    ]) {
      const result = await request(`databases/${database.id}/records`, {
        method: "POST",
        cookie,
        body: {
          title,
          values: {
            [hours.id]: estimate,
            [status.id]: status.config.options[state].id,
          },
        },
      });
      assert.equal(result.response.status, 201);
    }
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1050 },
      reducedMotion: "reduce",
    });
    await context.addInitScript(() =>
      localStorage.setItem("orvyn.theme", "graphite"),
    );
    await context.addCookies([
      {
        name: "orvyn_session",
        value: cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + pageLink(database.id));
    const row = () =>
      page.locator(".database-table").getByRole("button", {
        name: "Design the writing experience",
        exact: true,
      });
    await expect(row()).toBeVisible();
    await row().click();
    const peek = page.locator("dialog.page-peek[open]");
    await expect(peek).toHaveClass(/drawer/);
    assert.equal(await peek.evaluate((el) => el.matches(":modal")), false);
    await expect(
      peek.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue(record.title);
    await expect(peek.locator(".peek-header-context")).toHaveText(
      "Product roadmap",
    );
    await expect(
      peek.getByRole("button", { name: "Back to database", exact: true }),
    ).toHaveCount(1);
    await expect(
      peek.getByRole("region", { name: "Record properties", exact: true }),
    ).toBeVisible();
    await expect(
      peek.getByRole("toolbar", { name: "Text formatting", exact: true }),
    ).not.toBeVisible();
    const formatting = peek.getByRole("button", {
      name: "Text formatting",
      exact: true,
    });
    await expect(
      peek
        .locator(".dialog-header")
        .getByRole("button", { name: "Text formatting", exact: true }),
    ).toBeVisible();
    await expect(formatting).toHaveAttribute("aria-expanded", "false");
    await formatting.click();
    await expect(
      peek.getByRole("toolbar", { name: "Text formatting", exact: true }),
    ).toBeVisible();
    await formatting.click();
    await expect(formatting).toHaveAttribute("aria-expanded", "false");
    await peek
      .getByRole("button", { name: "Date (empty)", exact: true })
      .click();
    await peek
      .getByRole("textbox", { name: "Date", exact: true })
      .fill("2026-11-18");
    await peek.getByRole("textbox", { name: "Date", exact: true }).press("Tab");
    await expect
      .poll(async () => {
        const snapshot = (
            await request(`databases/${database.id}/records/${record.pageId}`, {
              cookie,
            })
          ).data,
          date = snapshot.properties.find((p) => p.type === "Date");
        return snapshot.record.values[date.id];
      })
      .toBe("2026-11-18");
    const field = peek.getByRole("spinbutton");
    await expect(field).toHaveValue("4");
    let releaseSave, saving;
    const heldSave = new Promise((resolve) => {
        releaseSave = resolve;
      }),
      saveStarted = new Promise((resolve) => {
        saving = resolve;
      });
    const recordUrl = `${base}/api/v1/databases/${database.id}/records/${record.pageId}`;
    await page.route(recordUrl, async (route) => {
      if (route.request().method() === "PATCH") {
        saving();
        await heldSave;
      }
      await route.continue();
    });
    await field.fill("8");
    await field.press("Tab");
    await saveStarted;
    await peek
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(peek).toHaveAttribute("aria-busy", "true");
    releaseSave();
    await expect(peek).not.toBeVisible();
    await page.unroute(recordUrl);
    await expect(row()).toBeFocused();
    await row().click();
    await expect(field).toHaveValue("8");
    const editor = peek.getByRole("textbox", { name: "Document", exact: true });
    await expect(editor).toBeEditable();
    await editor.fill("A calm space to write, plan and connect ideas.");
    await editor.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("## The writing experience");
    await page.keyboard.press("Enter");
    await page.keyboard.type(
      "Start with the page. Keep properties close, and let the document breathe.",
    );
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("## What good looks like");
    await page.keyboard.press("Enter");
    await page.keyboard.type("- Clear typography and consistent spacing");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Keyboard shortcuts that stay out of the way");
    await peek
      .getByRole("button", { name: "Open as modal", exact: true })
      .click();
    await expect(peek).not.toHaveClass(/drawer/);
    assert.equal(await peek.evaluate((el) => el.matches(":modal")), true);
    await expect(editor).toContainText("A calm space");
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/database-center-peek.png",
      fullPage: true,
    });
    await peek
      .getByRole("button", { name: "Open to side", exact: true })
      .click();
    await expect(peek).toHaveClass(/drawer/);
    await page.screenshot({
      path: ".local/ui-review/database-side-peek.png",
      fullPage: true,
    });
    await page.screenshot({
      path: ".local/ui-review/database-side-peek-dark.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Account menu", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Appearance", exact: true })
      .click();
    const appearance = page.getByRole("dialog", {
      name: "Appearance",
      exact: true,
    });
    await appearance
      .getByRole("button", { name: "Light", exact: true })
      .click();
    await appearance
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.screenshot({
      path: ".local/ui-review/database-side-peek-light.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => peek.evaluate((node) => node.matches(":modal")))
      .toBe(true);
    assert.ok(
      await peek.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: ".local/ui-review/database-peek-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1600, height: 1050 });
    await expect
      .poll(() => peek.evaluate((node) => node.matches(":modal")))
      .toBe(false);
    await peek
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(peek).not.toBeVisible();
    await expect(row()).toBeFocused();
    await expect(
      page
        .locator(".database-table tbody tr")
        .filter({ hasText: record.title })
        .getByRole("spinbutton", { name: "Estimate", exact: true }),
    ).toHaveValue("8");
    await row().click({ button: "right" });
    const menu = page.getByRole("menu", {
      name: "Record actions",
      exact: true,
    });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(peek).toBeVisible();
    assert.equal(await peek.evaluate((el) => el.matches(":modal")), true);
    await peek
      .getByRole("button", { name: "Record actions", exact: true })
      .click();
    await peek
      .getByRole("menuitem", { name: "Save as template", exact: true })
      .click();
    const save = page.getByRole("dialog", {
      name: "Save as template",
      exact: true,
    });
    await expect(save).toBeVisible();
    await save.getByRole("textbox").fill("Product brief");
    await save.getByRole("textbox").press("Control+Enter");
    await expect(save).not.toBeVisible();
    await peek
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(peek).not.toBeVisible();
    await page.getByRole("button", { name: "New record", exact: true }).focus();
    await page.keyboard.press("/");
    await expect(
      page.getByRole("searchbox", { name: "Search records", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Control+Alt+r");
    const create = page.getByRole("dialog", {
      name: "New record",
      exact: true,
    });
    await expect(create).toBeVisible();
    await expect(
      create
        .getByRole("combobox", { name: "Start with a template", exact: true })
        .locator("option")
        .filter({ hasText: "Product brief" }),
    ).toHaveCount(1);
    await create
      .getByRole("combobox", { name: "Start with a template", exact: true })
      .selectOption({ label: "Product brief" });
    await expect(
      create.getByRole("textbox", { name: "Record name", exact: true }),
    ).toHaveValue(record.title);
    await create
      .getByRole("textbox", { name: "Record name", exact: true })
      .fill("Ship a better editor");
    await create
      .getByRole("button", { name: "Create record", exact: true })
      .click();
    await expect(peek).toBeVisible();
    await expect(
      peek.getByRole("textbox", { name: "Document", exact: true }),
    ).toContainText("A calm space");
    await expect(peek.getByRole("spinbutton")).toHaveValue("8");
    const title = peek.getByRole("textbox", {
      name: "Page title",
      exact: true,
    });
    await title.fill(
      "A long record title that should wrap naturally across several lines instead of disappearing beyond the edge of a single-line field",
    );
    await expect
      .poll(() => title.evaluate((node) => node.clientHeight))
      .toBeGreaterThan(60);
    assert.ok(
      await title.evaluate(
        (node) => node.scrollHeight <= node.clientHeight + 2,
      ),
    );
    await title.fill("Ship a better editor");
    await title.press("Enter");
    await expect(
      peek.getByRole("textbox", { name: "Document", exact: true }),
    ).toBeFocused();
    await peek
      .getByRole("button", { name: "Open as full page", exact: true })
      .click();
    await expect(peek).not.toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue("Ship a better editor");
    await page
      .getByRole("button", { name: "Back to database", exact: true })
      .click();
    await expect(row()).toBeVisible();
    await page.keyboard.press("Control+Alt+f");
    const settings = page.getByRole("dialog", {
      name: "View settings",
      exact: true,
    });
    await expect(settings).toBeVisible();
    await settings
      .getByRole("combobox", { name: "Open records in", exact: true })
      .selectOption("modal");
    await settings
      .getByRole("button", { name: "Save view", exact: true })
      .click();
    await expect(settings).not.toBeVisible();
    await row().click();
    await expect(peek).toBeVisible();
    assert.equal(await peek.evaluate((el) => el.matches(":modal")), true);
    await page.reload();
    await expect(peek).toBeVisible();
    assert.equal(await peek.evaluate((el) => el.matches(":modal")), true);
    await expect(
      page
        .locator(".database-table .record-title")
        .filter({ hasText: record.title }),
    ).toHaveCount(1);
    // Focus a row as the dialog disappears. Returning focus must not later
    // override that new choice when the URL update finishes.
    await page.evaluate((title) => {
      const dialog = document.querySelector("dialog.page-peek[open]"),
        target = [
          ...document.querySelectorAll(".database-table .record-title"),
        ].find((node) => node.textContent.trim() === title);
      const observer = new MutationObserver(() => {
        if (!dialog.isConnected) {
          target.focus();
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }, record.title);
    await peek
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(peek).not.toBeVisible();
    await expect
      .poll(() => new URL(page.url()).searchParams.has("peek"))
      .toBe(false);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(row()).toBeFocused();
    await page.keyboard.press("Shift+F10");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(row()).toBeFocused();
    await row().press("Shift+Enter");
    await expect(peek).toBeVisible();
    assert.equal(await peek.evaluate((el) => el.matches(":modal")), true);
    await peek
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(peek).not.toBeVisible();
    await row().press("Control+Enter");
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue(record.title);
    await page
      .getByRole("button", { name: "Back to database", exact: true })
      .click();
    await expect(row()).toBeVisible();
    const tree = page.getByRole("navigation", { name: "Pages", exact: true });
    await tree
      .getByRole("button", {
        name: database.title || "Product roadmap",
        exact: true,
      })
      .click({ button: "right" });
    const pageMenu = page.getByRole("menu", {
      name: "Page actions",
      exact: true,
    });
    await expect(pageMenu).toBeVisible();
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Keyboard shortcuts", exact: true })
      .click();
    const help = page.getByRole("dialog", {
      name: "Keyboard shortcuts",
      exact: true,
    });
    await expect(help).toBeVisible();
    await expect(
      help.getByText("Open record as modal", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(help).not.toBeVisible();
    await page.keyboard.press("Control+/");
    await expect(help).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+p");
    const searchDialog = page.getByRole("dialog", {
      name: "Search your workspace",
      exact: true,
    });
    await expect(searchDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(searchDialog).not.toBeVisible();
    await page.keyboard.press("Control+Alt+d");
    const newDatabase = page.getByRole("dialog", {
      name: "Create a database",
      exact: true,
    });
    await expect(newDatabase).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(newDatabase).not.toBeVisible();
    await page.keyboard.press("Control+Backslash");
    await expect(page.locator(".app-sidebar")).toHaveClass(/collapsed/);
    await page.keyboard.press("Control+Backslash");
    await expect(page.locator(".app-sidebar")).not.toHaveClass(/collapsed/);
    await databaseAction(page, "Save as template");
    const schema = page.getByRole("dialog", {
      name: "Save as template",
      exact: true,
    });
    await expect(schema).toBeVisible();
    await schema.getByRole("textbox").fill("Team projects");
    await schema
      .getByRole("button", { name: "Save template", exact: true })
      .click();
    await expect(schema).not.toBeVisible();
    await page.getByRole("button", { name: "Templates", exact: true }).click();
    const library = page.getByRole("dialog", {
      name: "Database templates",
      exact: true,
    });
    await library.getByRole("button", { name: /Team projects/ }).click();
    await library
      .getByRole("textbox", { name: "Database name", exact: true })
      .fill("New team projects");
    await library
      .getByRole("button", { name: "Create database", exact: true })
      .click();
    await expect(library).not.toBeVisible();
    await expect(
      page.getByRole("heading", { name: "New team projects", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator(".database-table tbody .record-title"),
    ).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

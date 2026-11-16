import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { pageLink } from "../packages/editor/dist/links.js";
test("Chromium: columns, selection formatting/linking, exit shortcuts, live readers, mobile stacking and reload", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    }),
    contexts = [],
    errors = [];
  let page;
  async function account() {
    const r = await request("auth/register", {
        method: "POST",
        body: { email: randomUUID() + "@example.test", password: randomUUID() },
      }),
      cookie = sessionCookie(r.response);
    return { ...(await request("auth/me", { cookie })).data, cookie };
  }
  async function session(user) {
    const c = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      reducedMotion: "reduce",
    });
    contexts.push(c);
    await c.addCookies([
      {
        name: "orvyn_session",
        value: user.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    return p;
  }
  try {
    await mkdir(".local/ui-review", { recursive: true });
    const owner = await account(),
      viewer = await account(),
      space = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Layout workspace" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const create = async (title) =>
        (
          await request(`spaces/${space.id}/pages`, {
            method: "POST",
            cookie: owner.cookie,
            body: { title },
          })
        ).data,
      source = await create("Planning canvas"),
      target = await create("Reference document");
    page = await session(owner);
    await page.goto(base + pageLink(source.id));
    const doc = page.getByRole("textbox", { name: "Document", exact: true });
    await expect(doc).toBeEditable();
    await doc.click();
    await page.keyboard.type("/2 columns");
    await page.getByRole("option", { name: "2 columns", exact: true }).click();
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await page.keyboard.insertText("Left notes");
    const columns = doc.locator("[data-orvyn-column]");
    await expect(columns).toHaveCount(2);
    await expect(columns.nth(0)).toHaveText("Left notes");
    await columns.nth(1).locator("p").click();
    await page.keyboard.insertText("Right notes");
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    const menu = page.getByRole("toolbar", {
      name: "Selected text formatting",
      exact: true,
    });
    await expect(menu).toBeVisible();
    await menu.getByRole("button", { name: "Bold", exact: true }).click();
    await expect(
      menu.getByRole("button", { name: "Bold", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(columns.nth(1).locator("strong")).toHaveText("Right notes");
    await menu.getByRole("button", { name: "Italic", exact: true }).click();
    await expect(columns.nth(1).locator("em")).toHaveText("Right notes");
    await menu
      .getByRole("button", { name: "Link selection", exact: true })
      .click();
    const picker = page.getByRole("dialog", {
      name: "Link to document",
      exact: true,
    });
    await picker
      .getByLabel("Find a document", { exact: true })
      .fill("Reference document");
    await picker
      .getByRole("button", { name: /Reference document Layout workspace/ })
      .click();
    await expect(
      picker.getByLabel("Link text (optional)", { exact: true }),
    ).toHaveValue("Right notes");
    await picker
      .getByRole("button", { name: "Link entire document", exact: true })
      .click();
    await expect(
      columns.nth(1).getByRole("link", { name: "Right notes", exact: true }),
    ).toHaveAttribute("href", pageLink(target.id));
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await page.keyboard.press("Control+Enter");
    await page.keyboard.insertText("After the layout");
    await expect(doc.locator(":scope > p").last()).toHaveText(
      "After the layout",
    );
    await page.keyboard.press("Enter");
    await page.keyboard.type("/3 columns");
    await page.getByRole("option", { name: "3 columns", exact: true }).click();
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await page.keyboard.insertText("Draft");
    await expect(doc.locator(".columns-block")).toHaveCount(2);
    await expect(columns).toHaveCount(5);
    await columns.nth(3).locator("p").click();
    await page.keyboard.insertText("Review");
    await columns.nth(4).locator("p").click();
    await page.keyboard.insertText("Publish");
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible({ timeout: 12000 });
    await page.screenshot({
      path: ".local/ui-review/editor-columns.png",
      fullPage: true,
    });
    const reader = await session(viewer);
    await reader.goto(base + pageLink(source.id));
    const readerDoc = reader.getByRole("textbox", {
      name: "Document",
      exact: true,
    });
    await expect(readerDoc).toHaveAttribute("contenteditable", "false");
    await expect(readerDoc.locator("[data-orvyn-column]")).toHaveCount(5);
    await expect(
      reader.getByRole("toolbar", {
        name: "Selected text formatting",
        exact: true,
      }),
    ).toHaveCount(0);
    await reader.setViewportSize({ width: 390, height: 844 });
    const first = await readerDoc
        .locator("[data-orvyn-column]")
        .nth(0)
        .boundingBox(),
      second = await readerDoc
        .locator("[data-orvyn-column]")
        .nth(1)
        .boundingBox();
    assert.ok(second.y > first.y);
    assert.ok(Math.abs(second.x - first.x) < 2);
    assert.ok(
      await reader.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.reload();
    await expect(doc.locator("[data-orvyn-column]")).toHaveCount(5);
    await expect(doc.locator("strong")).toHaveText("Right notes");
    await expect(doc.locator("em")).toHaveText("Right notes");
    await expect(
      doc.getByRole("link", { name: "Right notes", exact: true }),
    ).toHaveAttribute("href", pageLink(target.id));
    assert.deepEqual(errors, []);
  } catch (e) {
    if (page)
      await page.screenshot({
        path: ".local/ui-review/editor-columns-failure.png",
        fullPage: true,
      });
    console.error("Layout browser errors", errors);
    throw e;
  } finally {
    for (const c of contexts) await c.close();
    await browser.close();
    await db.end();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, base } from "./helpers.mjs";
import { pageLink } from "../packages/editor/dist/links.js";

test("Chromium: Markdown headings keep the caret, reveal their level, slash commands have icons and dialogs keep horizontal spacing", async () => {
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
          body: { name: "Studio" },
        })
      ).data,
      source = (
        await request(`spaces/${space.id}/pages`, {
          method: "POST",
          cookie,
          body: { title: "A clearer writing experience" },
        })
      ).data,
      context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        reducedMotion: "reduce",
      });
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
    await page.goto(base + pageLink(source.id));
    const editor = page.getByRole("textbox", { name: "Document", exact: true });
    await expect(editor).toBeEditable();
    await editor.click();
    await mkdir(".local/ui-review", { recursive: true });
    for (const level of [1, 2, 3]) {
      await page.keyboard.type("#".repeat(level) + " ");
      const heading = editor.locator("h" + level).last();
      await expect(heading).toHaveAttribute("data-heading-empty", "true");
      await expect(heading).toHaveAttribute("data-heading-active", "true");
      await expect(heading.locator(".heading-permalink")).toHaveCount(0);
      await expect(heading).toHaveAttribute(
        "data-heading-marker",
        "#".repeat(level),
      );
      await expect(
        page.getByRole("combobox", { name: "Text style", exact: true }),
      ).toHaveValue("heading-" + level);
      assert.ok(
        await heading.evaluate((node) => {
          const selection = window.getSelection(),
            style = getComputedStyle(node);
          return (
            !!selection?.isCollapsed &&
            node.contains(selection.focusNode) &&
            parseFloat(style.minHeight) > 0 &&
            style.caretColor !== "transparent"
          );
        }),
        "The empty heading retains an editable text caret position and a visible line",
      );
      if (level === 1)
        await page.screenshot({
          path: ".local/ui-review/editor-empty-heading-ux.png",
          fullPage: true,
          caret: "initial",
        });
      await page.keyboard.type(
        ["Release notes", "The next milestone", "A small detail"][level - 1],
      );
      await expect(heading).toContainText(
        ["Release notes", "The next milestone", "A small detail"][level - 1],
      );
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Control+Alt+0");
    }
    await page.keyboard.type("/");
    const menu = page.getByRole("listbox", {
        name: "Insert block",
        exact: true,
      }),
      options = menu.getByRole("option");
    await expect(menu).toBeVisible();
    assert.ok((await options.count()) >= 20);
    assert.equal(
      await options.locator("svg").count(),
      await options.count(),
      "Every slash command has an icon",
    );
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/editor-heading-slash-ux.png",
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");
    await page.getByTitle("Link a database", { exact: true }).click();
    const native = page.locator("dialog.link-database-dialog[open]");
    await expect(native).toBeVisible();
    assert.ok(
      await native.evaluate(
        (node) =>
          parseFloat(getComputedStyle(node).paddingLeft) >= 20 &&
          parseFloat(getComputedStyle(node).paddingRight) >= 20,
      ),
    );
    await native.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("button", { name: "Link to document", exact: true })
      .click();
    const content = page.locator(".ui-dialog[open] .dialog-content");
    await expect(content).toBeVisible();
    assert.ok(
      await content.evaluate(
        (node) =>
          parseFloat(getComputedStyle(node).paddingLeft) >= 20 &&
          parseFloat(getComputedStyle(node).paddingRight) >= 20,
      ),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

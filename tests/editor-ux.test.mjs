import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, base } from "./helpers.mjs";
import { pageLink } from "../packages/editor/dist/links.js";
import { documentSchemaVersion } from "../packages/editor/dist/index.js";

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
    const labels = [
      "Release notes",
      "The next milestone",
      "A small detail",
      "An in-depth note",
    ];
    for (const level of [1, 2, 3, 4]) {
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
      await page.keyboard.type(labels[level - 1]);
      await expect(heading).toContainText(labels[level - 1]);
      if (level === 4) {
        const id = await heading.getAttribute("id"),
          style = page.getByRole("combobox", {
            name: "Text style",
            exact: true,
          });
        await style.selectOption("heading-3");
        await expect(editor.locator("h3").last()).toHaveAttribute("id", id);
        await style.selectOption("heading-4");
        await expect(heading).toHaveAttribute("id", id);
        await page.keyboard.press("Control+Alt+3");
        await expect(editor.locator("h3").last()).toHaveAttribute("id", id);
        await page.keyboard.press("Control+Alt+4");
        await expect(heading).toHaveAttribute("id", id);
        await expect(style).toHaveValue("heading-4");
      }
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
    await page.keyboard.type("heading 4");
    await menu.getByRole("option", { name: "Heading 4", exact: true }).click();
    await expect(editor.locator("h4").last()).toHaveAttribute(
      "data-heading-empty",
      "true",
    );
    await page.keyboard.type("A linked H4 section");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Control+Alt+0");
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
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
    await page
      .getByRole("dialog", { name: "Link to document", exact: true })
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await expect(editor.locator("h4")).toHaveCount(2);
    await expect(editor.locator("h4").last()).toContainText(
      "A linked H4 section",
    );
    await expect(editor.locator("h4").last()).toHaveAttribute(
      "data-heading-marker",
      "####",
    );
    const saved = (await request("pages/" + source.id, { cookie })).data;
    assert.equal(saved.document_schema_version, documentSchemaVersion);
    const headings = (await request(`pages/${source.id}/headings`, { cookie }))
      .data;
    assert.deepEqual(
      headings.filter((h) => h.level === 4).map((h) => h.text),
      [labels[3], "A linked H4 section"],
    );
    await page.screenshot({
      path: ".local/ui-review/editor-h1-h4.png",
      fullPage: true,
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { pageLink } from "../packages/editor/dist/links.js";
test("Chromium: callout, toggle, table of contents and code highlighting persist and collaborate with read-only viewers", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    }),
    contexts = [],
    errors = [];
  async function account() {
    const r = await request("auth/register", {
        method: "POST",
        body: { email: randomUUID() + "@example.test", password: randomUUID() },
      }),
      cookie = sessionCookie(r.response);
    return { ...(await request("auth/me", { cookie })).data, cookie };
  }
  async function session(account) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 980 },
      reducedMotion: "reduce",
    });
    contexts.push(context);
    await context.addCookies([
      {
        name: "orvyn_session",
        value: account.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    return page;
  }
  let page;
  try {
    await mkdir(".local/ui-review", { recursive: true });
    const owner = await account(),
      viewer = await account(),
      space = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Editor blocks" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const source = (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie: owner.cookie,
        body: { title: "Working document" },
      })
    ).data;
    page = await session(owner);
    await page.goto(base + pageLink(source.id));
    const doc = page.getByRole("textbox", { name: "Document", exact: true });
    await expect(doc).toBeEditable();
    async function slash(command) {
      await page.keyboard.type("/" + command);
      await expect(
        page.getByRole("listbox", { name: "Insert block", exact: true }),
      ).toBeVisible();
      await page.getByRole("option", { name: command, exact: true }).click();
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
    }
    await doc.click();
    await slash("Callout");
    await page.keyboard.insertText("Remember to review the release.");
    await expect(doc.locator(".callout-content")).toContainText(
      "Remember to review the release.",
    );
    await page
      .getByLabel("Callout style", { exact: true })
      .selectOption("warning");
    await doc.locator(".callout-content p").click();
    await page.keyboard.press("Control+Enter");
    await slash("Toggle");
    await page.keyboard.type("Implementation details");
    await expect(doc.locator("[data-orvyn-toggle-summary]")).toHaveText(
      "Implementation details",
    );
    await page.keyboard.press("Enter");
    await page.keyboard.insertText(
      "This content can be collapsed without changing the document.",
    );
    const body = doc.locator("[data-orvyn-toggle-content]");
    await expect(body).toContainText("This content can be collapsed");
    await page
      .getByRole("button", {
        name: "Collapse Implementation details",
        exact: true,
      })
      .click();
    await expect(body).toBeHidden();
    await page
      .getByRole("button", {
        name: "Expand Implementation details",
        exact: true,
      })
      .click();
    await expect(body).toBeVisible();
    await page.keyboard.press("Control+Enter");
    await slash("Code block");
    await page.keyboard.insertText(
      "const answer = 42;\n// <script> is code, not HTML",
    );
    await page
      .getByLabel("Code language", { exact: true })
      .selectOption("javascript");
    await expect(doc.locator(".hljs-keyword")).toContainText("const");
    await expect(
      page.locator("script").filter({ hasText: "is code, not HTML" }),
    ).toHaveCount(0);
    await doc.locator(".code-block code").click();
    await page.keyboard.press("Control+End");
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await slash("Heading 2");
    await page.keyboard.type("Release checklist");
    await page.keyboard.press("Enter");
    await slash("Table of contents");
    const toc = page.getByRole("navigation", {
      name: "Table of contents",
      exact: true,
    });
    await expect(
      toc.getByRole("button", { name: "Release checklist", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible({ timeout: 12000 });
    const reader = await session(viewer);
    await reader.goto(base + pageLink(source.id));
    const readerDoc = reader.getByRole("textbox", {
      name: "Document",
      exact: true,
    });
    await expect(readerDoc).toHaveAttribute("contenteditable", "false");
    await expect(
      reader.getByLabel("Code language", { exact: true }),
    ).toBeDisabled();
    await expect(
      reader.getByLabel("Callout style", { exact: true }),
    ).toHaveCount(0);
    await reader
      .getByRole("button", {
        name: "Collapse Implementation details",
        exact: true,
      })
      .click();
    await expect(readerDoc.locator("[data-orvyn-toggle-content]")).toBeHidden();
    const before = (
      await request("pages/" + source.id, { cookie: owner.cookie })
    ).data.version;
    await reader
      .getByRole("button", {
        name: "Expand Implementation details",
        exact: true,
      })
      .click();
    assert.equal(
      (await request("pages/" + source.id, { cookie: owner.cookie })).data
        .version,
      before,
    );
    await page
      .getByLabel("Callout style", { exact: true })
      .selectOption("success");
    await expect(readerDoc.locator(".callout-block")).toHaveAttribute(
      "data-tone",
      "success",
    );
    await reader
      .getByRole("navigation", { name: "Table of contents", exact: true })
      .getByRole("button", { name: "Release checklist", exact: true })
      .click();
    await expect(
      reader.getByRole("heading", { name: "Release checklist", exact: true }),
    ).toHaveAttribute("data-link-target", "true");
    await page.reload();
    await expect(doc.locator(".callout-block")).toHaveAttribute(
      "data-tone",
      "success",
    );
    await expect(doc.locator("[data-orvyn-toggle-summary]")).toHaveText(
      "Implementation details",
    );
    await expect(page.getByLabel("Code language", { exact: true })).toHaveValue(
      "javascript",
    );
    await expect(doc.locator(".hljs-keyword")).toContainText("const");
    await page.screenshot({
      path: ".local/ui-review/editor-blocks.png",
      fullPage: true,
    });
    assert.deepEqual(errors, []);
  } catch (e) {
    if (page)
      await page.screenshot({
        path: ".local/ui-review/editor-blocks-failure.png",
        fullPage: true,
      });
    console.error("Editor block errors", errors);
    throw e;
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
    await db.end();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { pageLink } from "../packages/editor/dist/links.js";

const paragraph = (text) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const heading = (text) => ({
  type: "heading",
  attrs: { level: 2, id: randomUUID() },
  content: [{ type: "text", text }],
});
const layout = (...contents) => ({
  type: "orvynColumns",
  content: contents.map((content) => ({ type: "orvynColumn", content })),
});
test("Chromium: column pointer/keyboard resizing, cancellation, independent undo, live collaboration and responsive persisted widths", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const contexts = [],
    errors = [];
  let page;
  async function account() {
    const registered = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    });
    const cookie = sessionCookie(registered.response);
    return { ...(await request("auth/me", { cookie })).data, cookie };
  }
  async function session(user) {
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
        value: user.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const p = await context.newPage();
    p.on("pageerror", (error) => errors.push(error.message));
    return p;
  }
  try {
    await mkdir(".local/ui-review", { recursive: true });
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
    const source = (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie: owner.cookie,
        body: { title: "A little space to think" },
      })
    ).data;
    assert.equal(
      (
        await request(`pages/${source.id}`, {
          method: "PUT",
          cookie: owner.cookie,
          body: {
            title: source.title,
            version: source.version,
            document: {
              type: "doc",
              content: [
                paragraph(
                  "Bring your ideas, decisions and next steps together. Shape the page around the way you work.",
                ),
                layout(
                  [
                    heading("The bigger picture"),
                    paragraph(
                      "Make room for the work that matters. Collect context, explore possibilities and keep the team moving in the same direction.",
                    ),
                    paragraph(
                      "A simple, thoughtful workspace starts with a clear plan.",
                    ),
                  ],
                  [
                    heading("At a glance"),
                    paragraph("Discovery · In progress"),
                    paragraph("Next review · Thursday"),
                    paragraph("Owner · Product team"),
                  ],
                ),
                heading("From idea to action"),
                layout(
                  [
                    heading("Explore"),
                    paragraph(
                      "Understand the problem and gather the right questions.",
                    ),
                  ],
                  [
                    heading("Build"),
                    paragraph(
                      "Turn the most promising direction into something tangible.",
                    ),
                  ],
                  [
                    heading("Learn"),
                    paragraph(
                      "Share early, listen carefully and improve the next iteration.",
                    ),
                  ],
                ),
                paragraph(
                  "Drag the quiet dividers to give each thought the space it needs.",
                ),
              ],
            },
          },
        })
      ).response.status,
      200,
    );
    page = await session(owner);
    await page.goto(base + pageLink(source.id));
    const doc = page.getByRole("textbox", { name: "Document", exact: true });
    const separator = doc
      .getByRole("separator", { name: "Resize columns 1 and 2", exact: true })
      .first();
    await expect(doc).toBeEditable();
    await expect(separator).toHaveAttribute("aria-valuenow", "50");
    const replica = await session(owner);
    await replica.goto(base + pageLink(source.id));
    const replicaSeparator = replica
      .getByRole("separator", { name: "Resize columns 1 and 2", exact: true })
      .first();
    await expect(replicaSeparator).toHaveAttribute("aria-valuenow", "50");
    const box = await separator.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + 30, {
      steps: 8,
    });
    assert.ok(Number(await separator.getAttribute("aria-valuenow")) > 60);
    // A pointer gesture is local until release; cancel leaves every replica untouched.
    await expect(replicaSeparator).toHaveAttribute("aria-valuenow", "50");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(separator).toHaveAttribute("aria-valuenow", "50");
    await separator.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", "60");
    await expect(replicaSeparator).toHaveAttribute("aria-valuenow", "60");
    await doc.locator("p").first().click();
    await page.keyboard.press("Control+z");
    await expect(separator).toHaveAttribute("aria-valuenow", "50");
    await page.keyboard.press("Control+Shift+z");
    await expect(separator).toHaveAttribute("aria-valuenow", "60");
    await separator.focus();
    await page.keyboard.press("Home");
    await expect(separator).toHaveAttribute("aria-valuenow", "15");
    await page.keyboard.press("End");
    await expect(separator).toHaveAttribute("aria-valuenow", "85");
    await separator.dblclick();
    await expect(separator).toHaveAttribute("aria-valuenow", "50");
    const secondBox = await separator.boundingBox();
    await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + 40);
    await page.mouse.down();
    await page.mouse.move(
      secondBox.x + secondBox.width / 2 + 110,
      secondBox.y + 40,
      { steps: 8 },
    );
    await page.mouse.up();
    const persisted = await separator.getAttribute("aria-valuenow");
    assert.ok(Number(persisted) > 60 && Number(persisted) < 80);
    await expect(replicaSeparator).toHaveAttribute("aria-valuenow", persisted);
    const three = doc.locator(".columns-block").nth(1);
    const thirdDivider = three.getByRole("separator").nth(1);
    await thirdDivider.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect(thirdDivider).toHaveAttribute("aria-valuenow", "43.34");
    await expect(three.getByRole("separator").first()).toHaveAttribute(
      "aria-valuenow",
      "33.33",
    );
    // A concurrent resize wins over an uncommitted local gesture.
    const concurrentBox = await separator.boundingBox();
    await page.mouse.move(concurrentBox.x + 10, concurrentBox.y + 50);
    await page.mouse.down();
    await page.mouse.move(concurrentBox.x + 30, concurrentBox.y + 50);
    await replicaSeparator.focus();
    await replica.keyboard.press("ArrowLeft");
    const concurrentWidth = Number(persisted) - 2;
    await expect(separator).toHaveAttribute(
      "aria-valuenow",
      String(concurrentWidth),
    );
    await page.mouse.up();
    await expect(replicaSeparator).toHaveAttribute(
      "aria-valuenow",
      String(concurrentWidth),
    );
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await separator.focus();
    await page.screenshot({
      path: ".local/ui-review/resizable-columns.png",
      fullPage: true,
    });
    const reader = await session(viewer);
    await reader.goto(base + pageLink(source.id));
    const readerDoc = reader.getByRole("textbox", {
      name: "Document",
      exact: true,
    });
    await expect(readerDoc).toHaveAttribute("contenteditable", "false");
    await expect(readerDoc.getByRole("separator")).toHaveCount(0);
    const widthRatio = await readerDoc
      .locator(".columns-block")
      .first()
      .locator("[data-orvyn-column]")
      .evaluateAll(
        (columns) =>
          columns[0].getBoundingClientRect().width /
          columns[1].getBoundingClientRect().width,
      );
    assert.ok(widthRatio > 1.4);
    await reader.setViewportSize({ width: 390, height: 844 });
    const cells = readerDoc.locator("[data-orvyn-column]");
    const first = await cells.nth(0).boundingBox(),
      second = await cells.nth(1).boundingBox();
    assert.ok(second.y > first.y && Math.abs(first.x - second.x) < 2);
    assert.ok(
      await reader.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await reader.screenshot({
      path: ".local/ui-review/resizable-columns-mobile.png",
      fullPage: true,
    });
    await page.reload();
    await expect(separator).toHaveAttribute(
      "aria-valuenow",
      String(concurrentWidth),
    );
    const saved = (
      await request(`pages/${source.id}`, { cookie: owner.cookie })
    ).data.document.content.find((node) => node.type === "orvynColumns");
    assert.equal(saved.attrs.widths[0] / 100, concurrentWidth);
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page)
      await page.screenshot({
        path: ".local/ui-review/column-resizing-failure.png",
        fullPage: true,
      });
    console.error("Column resize browser errors", errors);
    throw error;
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
    await db.end();
  }
});

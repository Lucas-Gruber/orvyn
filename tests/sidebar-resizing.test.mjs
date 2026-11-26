import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, base } from "./helpers.mjs";

test("Chromium: sidebar resizing persists per account, cancels safely, supports keyboard/reset and fits smaller viewports", async () => {
  const registration = await request("auth/register", {
    method: "POST",
    body: {
      email: randomUUID() + "@example.test",
      password: randomUUID(),
      displayName: "Mara Keller",
    },
  });
  const cookie = sessionCookie(registration.response);
  const owner = (await request("auth/me", { cookie })).data;
  const space = (
    await request("spaces", {
      method: "POST",
      cookie,
      body: { name: "Product studio" },
    })
  ).data;
  const source = (
    await request(`spaces/${space.id}/pages`, {
      method: "POST",
      cookie,
      body: { title: "A little more room for your ideas" },
    })
  ).data;
  await request(`pages/${source.id}`, {
    method: "PUT",
    cookie,
    body: {
      version: source.version,
      title: source.title,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Keep the navigation as wide as you need. Your pages, decisions and next steps stay within reach.",
              },
            ],
          },
          {
            type: "heading",
            attrs: { level: 2, id: randomUUID() },
            content: [
              { type: "text", text: "Make space for the work that matters" },
            ],
          },
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Drag the sidebar edge, or use the keyboard. Your preferred width stays with this account on this device.",
              },
            ],
          },
        ],
      },
    },
  });
  for (const title of [
    "Research and customer conversations",
    "Decisions, context and next steps",
    "The weekly product review",
  ])
    await request(`spaces/${space.id}/pages`, {
      method: "POST",
      cookie,
      body: { title },
    });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const errors = [];
  try {
    await context.addInitScript(() =>
      localStorage.setItem("orvyn.theme", "graphite"),
    );
    await context.addCookies([
      { name: "orvyn_session", value: cookie.split("=")[1], url: base },
    ]);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base + "/?page=" + source.id);
    const sidebar = page.getByRole("complementary", {
      name: "Workspace navigation",
    });
    const handle = page.getByRole("separator", {
      name: "Resize sidebar",
      exact: true,
    });
    const width = () =>
      sidebar.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    const stored = () =>
      page.evaluate(
        (id) => JSON.parse(localStorage.getItem("orvyn.ui." + id)).sidebarWidth,
        owner.id,
      );
    await expect(handle).toBeVisible();
    assert.equal(await width(), 252);
    async function drag(target, finish = true) {
      const rect = await handle.boundingBox();
      const initial = await width();
      await page.mouse.move(rect.x + rect.width / 2, rect.y + 180);
      await page.mouse.down();
      await page.mouse.move(
        rect.x + rect.width / 2 + target - initial,
        rect.y + 180,
        { steps: 5 },
      );
      if (finish) await page.mouse.up();
    }
    await drag(420);
    await expect.poll(width).toBe(420);
    assert.equal(await stored(), 420);
    await page.reload();
    await expect(handle).toHaveAttribute("aria-valuenow", "420");
    assert.equal(await width(), 420);
    await page
      .getByRole("button", { name: "Collapse sidebar", exact: true })
      .click();
    await expect(handle).toHaveCount(0);
    await expect
      .poll(() =>
        page
          .locator(".workspace-main")
          .evaluate((el) => Math.round(el.getBoundingClientRect().left)),
      )
      .toBe(0);
    await page
      .getByRole("button", { name: "Toggle sidebar", exact: true })
      .click();
    await expect(handle).toBeVisible();
    await expect.poll(width).toBe(420);
    await drag(480, false);
    await expect(handle).toHaveAttribute("aria-valuenow", "480");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.equal(await width(), 420);
    assert.equal(await stored(), 420);
    await drag(470, false);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.mouse.up();
    assert.equal(await width(), 420);
    assert.equal(
      await page.evaluate(() => document.documentElement.style.cursor),
      "",
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.style.userSelect),
      "",
    );
    await drag(460, false);
    await handle.dispatchEvent("pointercancel", { pointerId: 1 });
    await page.mouse.up();
    assert.equal(await width(), 420);
    await handle.focus();
    await handle.press("ArrowLeft");
    assert.equal(await width(), 410);
    await handle.press("Shift+ArrowRight");
    assert.equal(await width(), 460);
    await handle.press("Home");
    assert.equal(await width(), 220);
    await handle.press("End");
    assert.equal(await width(), 480);
    await handle.press("Enter");
    assert.equal(await width(), 252);
    assert.equal(await stored(), null);
    await drag(1);
    assert.equal(await width(), 220);
    await drag(1000);
    assert.equal(await width(), 480);
    await page.setViewportSize({ width: 780, height: 1000 });
    await expect.poll(width).toBe(420);
    assert.equal(await stored(), 480);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(handle).toHaveCount(0);
    await page
      .getByRole("button", { name: "Toggle sidebar", exact: true })
      .click();
    await expect(sidebar).toBeVisible();
    assert.equal(await width(), 252);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page
      .getByRole("button", { name: "Collapse sidebar", exact: true })
      .click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect.poll(width).toBe(480);
    await handle.dblclick();
    await expect.poll(width).toBe(252);
    await drag(400);
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/sidebar-resized-dark.png",
    });
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "light"),
    );
    await page.screenshot({
      path: ".local/ui-review/sidebar-resized-light.png",
    });
    // Invalid legacy/local settings fall back without discarding other prefs.
    await page.evaluate(
      ({ id, spaceId, pageId }) =>
        localStorage.setItem(
          "orvyn.ui." + id,
          JSON.stringify({
            spaceId,
            favorites: [pageId],
            sidebarWidth: "invalid",
          }),
        ),
      { id: owner.id, spaceId: space.id, pageId: source.id },
    );
    await page.reload();
    await expect(handle).toHaveAttribute("aria-valuenow", "252");
    await expect(
      page.getByRole("button", { name: "Remove from favorites", exact: true }),
    ).toBeVisible();
    const other = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    });
    await context.clearCookies();
    await context.addCookies([
      {
        name: "orvyn_session",
        value: sessionCookie(other.response).split("=")[1],
        url: base,
      },
    ]);
    await page.goto(base);
    await expect(handle).toHaveAttribute("aria-valuenow", "252");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
  }
});

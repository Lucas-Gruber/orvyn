import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";

test("Chromium: sidebar creation menus choose page types, preserve parent context, dismiss without writes and fit small screens", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  let page;
  const errors = [];
  async function account(displayName) {
    const registered = await request("auth/register", {
      method: "POST",
      body: {
        email: randomUUID() + "@example.test",
        password: randomUUID(),
        displayName,
      },
    });
    const cookie = sessionCookie(registered.response);
    return { ...(await request("auth/me", { cookie })).data, cookie };
  }
  async function session(account) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    await context.addCookies([
      {
        name: "orvyn_session",
        value: account.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const result = await context.newPage();
    result.on("pageerror", (error) => errors.push(error.message));
    return result;
  }
  try {
    const owner = await account("Mara Keller");
    const viewer = await account("Jonas Weber");
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
    const initial = (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie: owner.cookie,
        body: { title: "Product brief" },
      })
    ).data;
    const count = async () =>
      Number(
        (
          await db.query("SELECT count(*) FROM pages WHERE space_id=$1", [
            space.id,
          ])
        ).rows[0].count,
      );
    const current = async () =>
      (
        await request("pages/" + new URL(page.url()).searchParams.get("page"), {
          cookie: owner.cookie,
        })
      ).data;
    page = await session(owner);
    await page.goto(base + "/?page=" + initial.id);
    await expect(
      page.getByRole("textbox", { name: "Document", exact: true }),
    ).toBeEditable();
    await page
      .getByRole("textbox", { name: "Document", exact: true })
      .fill(
        "A place for the plan, the sketches and the decisions we make together.",
      );
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    const trigger = page.getByRole("button", {
      name: "Create in this space",
      exact: true,
    });
    const before = await count();
    await trigger.focus();
    await trigger.press("ArrowDown");
    const menu = page.getByRole("menu", {
      name: "Create in this space",
      exact: true,
    });
    await expect(menu).toBeVisible();
    assert.ok((await menu.boundingBox()).width <= 320);
    await expect(
      menu.getByRole("menuitem", { name: "New page", exact: true }),
    ).toBeFocused();
    for (const label of [
      "New page",
      "New whiteboard",
      "New database",
      "New folder",
      "Import Markdown",
    ]) {
      await expect(
        menu.getByRole("menuitem", { name: label, exact: true }),
      ).toBeVisible();
    }
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/sidebar-create-menu.png",
      fullPage: true,
    });
    await page.keyboard.press("End");
    await expect(
      menu.getByRole("menuitem", { name: "Import Markdown", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    assert.equal(await count(), before);
    await trigger.click();
    await page.setViewportSize({ width: 1420, height: 980 });
    await expect(menu).toHaveCount(0);
    await trigger.click();
    await page.getByLabel("Page title", { exact: true }).click();
    await expect(menu).toHaveCount(0);
    assert.equal(await count(), before);

    const title = page.getByLabel("Page title", { exact: true });
    async function nameCurrent(name, kind, parentId = null) {
      await expect(title).toBeVisible();
      await title.fill(name);
      await title.press("Tab");
      await expect(
        page.getByText("Title saved", { exact: true }),
      ).toBeVisible();
      const result = await current();
      assert.equal(result.kind, kind);
      assert.equal(result.parent_id, parentId);
      return result;
    }
    await trigger.click();
    await menu
      .getByRole("menuitem", { name: "New folder", exact: true })
      .click();
    const folder = await nameCurrent("Projects", "folder");
    const add = page.getByRole("button", {
      name: "Add subpage to Projects",
      exact: true,
    });
    async function nested(label) {
      await add.click();
      const nestedMenu = page.getByRole("menu", {
        name: "Add subpage to Projects",
        exact: true,
      });
      await expect(nestedMenu).toContainText("Add to Projects");
      await nestedMenu
        .getByRole("menuitem", { name: label, exact: true })
        .click();
    }
    await nested("New whiteboard");
    await expect(title).toHaveValue("Untitled whiteboard");
    await nameCurrent("Release sketch", "whiteboard", folder.id);
    await nested("New page");
    await expect(title).toHaveValue("Untitled");
    await nameCurrent("Release notes", "page", folder.id);
    await nested("New folder");
    await nameCurrent("References", "folder", folder.id);
    await nested("New database");
    const dialog = page.getByRole("dialog", {
      name: "Create a database",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await dialog
      .getByLabel("Database name", { exact: true })
      .fill("Release tracker");
    await dialog
      .getByRole("button", { name: "Create database", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("heading", {
        name: "Release tracker",
        level: 1,
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(async () => (await current()).title)
      .toBe("Release tracker");
    const database = await current();
    assert.equal(database.kind, "database");
    assert.equal(database.parent_id, folder.id);
    await expect(
      page.getByRole("button", {
        name: "Add subpage to Release tracker",
        exact: true,
      }),
    ).toHaveCount(0);

    // Cancelling a nested database must not leak its destination into a later
    // top-level menu/shortcut creation.
    await nested("New database");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    const root = page.getByRole("button", {
      name: "Create new item",
      exact: true,
    });
    await root.click();
    await page
      .getByRole("menu", { name: "Create new item", exact: true })
      .getByRole("menuitem", { name: "New database", exact: true })
      .click();
    await dialog
      .getByLabel("Database name", { exact: true })
      .fill("Company directory");
    await dialog
      .getByRole("button", { name: "Create database", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Company directory",
        level: 1,
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(async () => (await current()).title)
      .toBe("Company directory");
    assert.equal((await current()).parent_id, null);

    const savedTemplate = await request(`databases/${database.id}/templates`, {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Release blueprint", kind: "database" },
    });
    assert.equal(savedTemplate.response.status, 201);
    await nested("New database");
    await dialog
      .getByRole("button", { name: "Start with a saved template", exact: true })
      .click();
    const library = page.getByRole("dialog", {
      name: "Database templates",
      exact: true,
    });
    await library.getByRole("button", { name: /Release blueprint/ }).click();
    await library
      .getByLabel("Database name", { exact: true })
      .fill("Project tracker");
    await library
      .getByRole("button", { name: "Create database", exact: true })
      .click();
    await expect(library).toHaveCount(0);
    await expect
      .poll(async () => (await current()).title)
      .toBe("Project tracker");
    assert.equal((await current()).parent_id, folder.id);

    await nested("Import Markdown");
    const importer = page.getByRole("dialog", {
      name: "Import Markdown",
      exact: true,
    });
    await expect(importer).toBeVisible();
    await expect(
      importer.getByLabel("Import into", { exact: true }),
    ).toHaveValue(folder.id);
    await page.keyboard.press("Escape");
    await expect(importer).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 420 });
    const sidebar = page.locator(".app-sidebar");
    await expect(sidebar).toHaveAttribute("inert", "");
    await page
      .getByRole("button", { name: "Toggle sidebar", exact: true })
      .click();
    await expect(sidebar).not.toHaveAttribute("inert", "");
    await root.scrollIntoViewIfNeeded();
    await root.click();
    const smallMenu = page.getByRole("menu", {
      name: "Create new item",
      exact: true,
    });
    await expect(smallMenu).toBeVisible();
    const bounds = await smallMenu.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0);
    assert.ok(
      bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 420,
    );
    assert.equal(
      await smallMenu.evaluate((element) => element.matches(":popover-open")),
      true,
    );
    await page.screenshot({
      path: ".local/ui-review/sidebar-create-menu-mobile.png",
    });
    await page.keyboard.press("Escape");
    await expect(smallMenu).toHaveCount(0);
    await expect(root).toBeFocused();
    await expect(sidebar).toBeVisible();

    const reader = await session(viewer);
    await reader.goto(base + "/?page=" + initial.id);
    await expect(
      reader.getByRole("textbox", { name: "Document", exact: true }),
    ).toHaveAttribute("contenteditable", "false");
    await expect(
      reader.getByRole("button", { name: "Create new item", exact: true }),
    ).toHaveCount(0);
    await expect(
      reader.getByRole("button", { name: "Create in this space", exact: true }),
    ).toHaveCount(0);
    await expect(reader.locator(".tree-add")).toHaveCount(0);
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page && !page.isClosed())
      await page
        .screenshot({
          path: ".local/ui-review/sidebar-create-menu-failure.png",
        })
        .catch(() => {});
    throw error;
  } finally {
    await browser.close();
    await db.end();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { base } from "./helpers.mjs";
test("workspace UX: immediate pages, autosave, persistent deep links, search, favorites, themes and mobile navigation", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
      viewport: { width: 1440, height: 980 },
      reducedMotion: "reduce",
    }),
    page = await context.newPage(),
    errors = [],
    fontRequests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (/woff2?/.test(r.url())) fontRequests.push(r.url());
  });
  try {
    await mkdir(".local/ui-review", { recursive: true });
    await page.goto(base);
    await page
      .getByLabel("Email", { exact: true })
      .fill(randomUUID() + "@example.test");
    await page
      .getByLabel("Password · at least 12 characters", { exact: true })
      .fill(randomUUID());
    await page.screenshot({ path: ".local/ui-review/after-login.png" });
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await page
      .getByLabel("New private space", { exact: true })
      .fill("Product workspace");
    await page
      .getByRole("button", { name: "Create space", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Make this space yours", exact: true }),
    ).toBeVisible();
    const create = async (name) => {
      await page
        .getByRole("button", { name: "Create new item", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "New page", exact: true })
        .click();
      await page.getByLabel("Page title", { exact: true }).fill(name);
      await page.getByLabel("Page title", { exact: true }).press("Tab");
      await expect(
        page.getByText("Title saved", { exact: true }),
      ).toBeVisible();
    };
    await create("  Product brief  ");
    await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(
      "Product brief",
    );
    const externalRename = async (title) => {
      assert.equal(
        await page.evaluate(async (title) => {
          const id = new URL(location.href).searchParams.get("page"),
            current = await (await fetch("/api/v1/pages/" + id)).json();
          const result = await fetch("/api/v1/pages/" + id + "/title", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title,
              titleVersion: current.title_version,
            }),
          });
          return result.status;
        }, title),
        200,
      );
    };
    await externalRename("A title from another session");
    await page
      .getByLabel("Page title", { exact: true })
      .fill("Product brief, edited here");
    await page.getByLabel("Page title", { exact: true }).press("Tab");
    await expect(page.locator(".title-conflict")).toContainText(
      "A title from another session",
    );
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(
      "Product brief, edited here",
    );
    await page
      .getByRole("button", { name: "Keep my title", exact: true })
      .click();
    await expect(page.getByText("Title saved", { exact: true })).toBeVisible();
    await externalRename("Product brief");
    await page
      .getByLabel("Page title", { exact: true })
      .fill("Another local draft");
    await page.getByLabel("Page title", { exact: true }).press("Tab");
    await expect(page.locator(".title-conflict")).toBeVisible();
    await page
      .getByRole("button", { name: "Use saved title", exact: true })
      .click();
    await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(
      "Product brief",
    );
    await expect(page.locator(".title-conflict")).toHaveCount(0);
    await page
      .getByRole("textbox", { name: "Document", exact: true })
      .fill("A clear space to turn ideas into decisions.");
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Add to favorites", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Remove from favorites", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await create("Planning notes");
    const tree = page.getByRole("navigation", { name: "Pages", exact: true });
    await tree
      .getByRole("button", {
        name: "Add subpage to Product brief",
        exact: true,
      })
      .click();
    await page.getByRole("menuitem", { name: "New page", exact: true }).click();
    await page.getByLabel("Page title", { exact: true }).fill("Research");
    await page.getByLabel("Page title", { exact: true }).press("Tab");
    await expect(page.getByText("Title saved", { exact: true })).toBeVisible();
    await expect(
      page
        .locator(".breadcrumbs")
        .getByRole("button", { name: "Product brief", exact: true }),
    ).toBeVisible();
    const parent = tree.getByRole("button", {
      name: "Product brief",
      exact: true,
    });
    await parent.focus();
    await parent.press("ArrowLeft");
    await expect(
      tree.getByRole("button", { name: "Research", exact: true }),
    ).toHaveCount(0);
    await parent.press("ArrowRight");
    await expect(
      tree.getByRole("button", { name: "Research", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Page actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Move page", exact: true })
      .click();
    const move = page.getByRole("dialog", { name: "Move page", exact: true });
    await move
      .getByLabel("New parent", { exact: true })
      .selectOption({ label: "Space root" });
    await move.getByRole("button", { name: "Move page", exact: true }).click();
    await expect(move).not.toBeVisible();
    await expect(
      page
        .locator(".breadcrumbs")
        .getByRole("button", { name: "Product brief", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Page actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Move to trash", exact: true })
      .click();
    const deletion = page.getByRole("dialog", {
      name: "Move to trash?",
      exact: true,
    });
    await deletion
      .getByRole("button", { name: "Move to trash", exact: true })
      .click();
    await expect(deletion).not.toBeVisible();
    await expect(
      tree.getByRole("button", { name: "Research", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await page
      .locator(".trash-list li")
      .filter({ hasText: "Research" })
      .getByRole("button", { name: "Restore page", exact: true })
      .click();
    await expect(
      tree.getByRole("button", { name: "Research", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Control+k");
    const search = page.getByRole("dialog", {
      name: "Search your workspace",
      exact: true,
    });
    await expect(search).toBeVisible();
    await search
      .getByLabel("Search pages", { exact: true })
      .fill("Product brief");
    await search.getByRole("button", { name: /Product brief/ }).click();
    await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(
      "Product brief",
    );
    await expect(
      page.getByRole("textbox", { name: "Document", exact: true }),
    ).toHaveText("A clear space to turn ideas into decisions.");
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
    for (const name of ["Graphite", "Midnight", "Nord", "Carbon", "Matrix"]) {
      const choice = appearance.getByRole("button", { name, exact: true });
      await choice.click();
      await expect(choice).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        name.toLowerCase(),
      );
    }
    await appearance
      .getByRole("button", { name: "Light", exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await appearance
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await page.screenshot({
      path: ".local/ui-review/after-document-light.png",
    });
    await page.reload();
    await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(
      "Product brief",
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(
      page.getByRole("textbox", { name: "Document", exact: true }),
    ).toHaveText("A clear space to turn ideas into decisions.");
    await expect(
      page.getByRole("button", { name: "Remove from favorites", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page
      .getByRole("button", { name: "Account menu", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Appearance", exact: true })
      .click();
    await appearance
      .getByRole("button", { name: "Cybercade", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expect(appearance).not.toBeVisible();
    await page.screenshot({ path: ".local/ui-review/after-document.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".app-sidebar")).toHaveAttribute("inert", "");
    await expect(page.getByLabel("Page title", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Toggle sidebar", exact: true })
      .click();
    await expect(page.locator(".workspace-main")).toHaveAttribute("inert", "");
    await page
      .getByRole("navigation", { name: "Pages", exact: true })
      .getByRole("button", { name: "Planning notes", exact: true })
      .click();
    await expect(page.getByLabel("Page title", { exact: true })).toHaveValue(
      "Planning notes",
    );
    await expect(page.locator(".app-sidebar")).toHaveAttribute("inert", "");
    await expect(
      page.getByRole("textbox", { name: "Document", exact: true }),
    ).toBeEditable();
    await page.screenshot({ path: ".local/ui-review/after-mobile.png" });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      "mobile layout must not horizontally overflow",
    );
    assert.ok(fontRequests.length);
    assert.ok(
      fontRequests.every((url) => new URL(url).origin === new URL(base).origin),
      "fonts are served locally",
    );
    assert.deepEqual(errors, []);
  } catch (e) {
    console.error("UX browser errors", errors);
    await page.screenshot({
      path: ".local/ui-review/ux-failure.png",
      fullPage: true,
    });
    throw e;
  } finally {
    await context.close();
    await browser.close();
  }
});

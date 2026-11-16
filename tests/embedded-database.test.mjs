import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { chooseSpace, openPageFromSidebar } from "./ui-helpers.mjs";
import { documentSchemaVersion } from "../packages/editor/dist/index.js";
test("linked database blocks persist independent views and never grant access to their source", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    }),
    contexts = [];
  const account = async () => {
    const r = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    });
    assert.equal(r.response.status, 201);
    const cookie = sessionCookie(r.response),
      me = (await request("auth/me", { cookie })).data;
    return { ...me, cookie };
  };
  async function session(account) {
    const context = await browser.newContext();
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
    return context.newPage();
  }
  try {
    const owner = await account(),
      viewer = await account(),
      space = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Linked spaces" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const source = (
      await request(`spaces/${space.id}/databases`, {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Private linked source" },
      })
    ).data;
    const record = (
      await request("databases/" + source.id + "/records", {
        method: "POST",
        cookie: owner.cookie,
        body: { title: "Actual linked record", values: {} },
      })
    ).data;
    const sourcePage = (
      await request("pages/" + source.id, { cookie: owner.cookie })
    ).data;
    await request("pages/" + source.id + "/permissions", {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        version: sourcePage.version,
        confirm: true,
        visibility: "restricted",
        grants: [],
      },
    });
    const document = (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie: owner.cookie,
        body: { title: "Document with linked data" },
      })
    ).data;
    const page = await session(owner),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base);
    await chooseSpace(page, "Linked spaces");
    await openPageFromSidebar(page, "Document with linked data");
    await page
      .getByRole("button", { name: "Link database", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Link a database",
      exact: true,
    });
    await dialog
      .getByLabel("Source database", { exact: true })
      .selectOption(source.id);
    await dialog
      .getByLabel("Create a separate view with independent filters", {
        exact: true,
      })
      .check();
    await dialog
      .getByLabel("New view name", { exact: true })
      .fill("Document-specific table");
    await dialog
      .getByRole("button", { name: "Insert linked view", exact: true })
      .click();
    const embedded = page.locator(".embedded-database");
    await expect(
      embedded.getByRole("heading", {
        name: "Private linked source",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      embedded.getByRole("tab", {
        name: "Document-specific table",
        exact: true,
      }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      embedded.getByRole("button", {
        name: "Actual linked record",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    const persisted = (
      await request("pages/" + document.id, { cookie: owner.cookie })
    ).data;
    assert.equal(persisted.document_schema_version, documentSchemaVersion);
    assert.ok(
      persisted.document.content.some(
        (n) => n.type === "orvynDatabase" && n.attrs.databaseId === source.id,
      ),
    );
    await embedded
      .getByRole("button", { name: "Actual linked record", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Back to database", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "Document", exact: true })
      .fill("Record notes stay on the original record page.");
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await openPageFromSidebar(page, "Document with linked data");
    await expect(
      page
        .locator(".embedded-database")
        .getByRole("button", { name: "Actual linked record", exact: true }),
    ).toBeVisible();
    const observer = await session(viewer);
    observer.on("pageerror", (e) => errors.push(e.message));
    await observer.goto(base);
    await chooseSpace(observer, "Linked spaces");
    await openPageFromSidebar(observer, "Document with linked data");
    await expect(
      observer.locator(".embedded-database").getByRole("alert"),
    ).toHaveText("This database is unavailable or you do not have access.");
    assert.equal(
      (await observer.locator("body").innerText()).includes(
        "Actual linked record",
      ),
      false,
    );
    assert.equal(
      (await observer.locator("body").innerText()).includes(
        "Private linked source",
      ),
      false,
    );
    const fresh = (
      await request("pages/" + source.id, { cookie: owner.cookie })
    ).data;
    await request("pages/" + source.id + "/permissions", {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        version: fresh.version,
        confirm: true,
        visibility: "restricted",
        grants: [{ userId: viewer.id, role: "Viewer" }],
      },
    });
    await expect(
      observer
        .locator(".embedded-database")
        .getByRole("button", { name: "Actual linked record", exact: true }),
    ).toBeVisible({ timeout: 12000 });
    assert.equal(
      (
        await request("databases/" + source.id + "/query", {
          method: "POST",
          cookie: owner.cookie,
          body: { viewId: source.views[0].id },
        })
      ).data.records[0].pageId,
      record.pageId,
    );
    assert.deepEqual(errors, []);
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
    await db.end();
  }
});

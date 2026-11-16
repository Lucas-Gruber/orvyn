import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { pageLink } from "../packages/editor/dist/links.js";
const account = async () => {
  const r = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(r.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
};
const create = async (owner, space, title, kind = "page", parentId = null) => {
  const r = await request(`spaces/${space}/pages`, {
    method: "POST",
    cookie: owner.cookie,
    body: { title, kind, parentId },
  });
  assert.equal(r.response.status, 201, JSON.stringify(r.data));
  return r.data;
};
const current = async (owner, id) =>
  (await request(`pages/${id}`, { cookie: owner.cookie })).data;
const place = async (owner, pageId, placement, targetId, extra = {}) =>
  request(`pages/${pageId}/move`, {
    method: "POST",
    cookie: owner.cookie,
    body: {
      structureVersion: (await current(owner, pageId)).structure_version,
      placement,
      targetId,
      ...extra,
    },
  });
const restrict = async (owner, id, grants = []) =>
  request(`pages/${id}/permissions`, {
    method: "PUT",
    cookie: owner.cookie,
    body: {
      visibility: "restricted",
      grants,
      confirm: true,
      version: (await current(owner, id)).version,
    },
  });
test("folders and hierarchy placement preserve identity/audience, reject cycles, serialize structure and compact ranks privately", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const owner = await account(),
      editor = await account(),
      viewer = await account(),
      space = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Ordered knowledge" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query(
      "INSERT INTO space_members VALUES($1,$2,'Editor'),($1,$3,'Viewer')",
      [space.id, editor.id, viewer.id],
    );
    const alpha = await create(owner, space.id, "Alpha"),
      bravo = await create(owner, space.id, "Bravo"),
      charlie = await create(owner, space.id, "Charlie"),
      folder = await create(owner, space.id, "Projects", "folder"),
      nested = await create(
        owner,
        space.id,
        "Nested folder",
        "folder",
        folder.id,
      ),
      headingId = randomUUID();
    assert.equal(folder.kind, "folder");
    await request(`pages/${charlie.id}`, {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        title: charlie.title,
        version: charlie.version,
        document: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2, id: headingId },
              content: [{ type: "text", text: "Permanent destination" }],
            },
          ],
        },
      },
    });
    const before = await current(owner, charlie.id);
    await request(`pages/${charlie.id}/title`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: { title: "Charlie renamed", titleVersion: before.title_version },
    });
    assert.equal(
      (
        await place(editor, charlie.id, "before", alpha.id, {
          structureVersion: before.structure_version,
          targetParentId: null,
        })
      ).response.status,
      201,
    );
    let moved = await current(owner, charlie.id);
    assert.equal(
      moved.visibility,
      "space",
      "Sibling reordering must not turn inherited sharing into explicit grants",
    );
    assert.deepEqual(moved.document, before.document);
    assert.equal(moved.title, "Charlie renamed");
    assert.equal(
      (
        await db.query("SELECT 1 FROM page_permissions WHERE page_id=$1", [
          charlie.id,
        ])
      ).rowCount,
      0,
    );
    const ordering = async () =>
      (
        await request(`spaces/${space.id}/pages?limit=200`, {
          cookie: owner.cookie,
        })
      ).data
        .sort((a, b) => a.sort_rank - b.sort_rank)
        .filter((p) => [alpha.id, bravo.id, charlie.id].includes(p.id))
        .map((p) => p.id);
    assert.deepEqual(await ordering(), [charlie.id, alpha.id, bravo.id]);
    assert.equal(
      (
        await place(editor, charlie.id, "after", bravo.id, {
          structureVersion: before.structure_version,
        })
      ).response.status,
      409,
    );
    assert.equal(
      (await place(viewer, charlie.id, "inside", folder.id)).response.status,
      404,
    );
    assert.equal(
      (await place(owner, folder.id, "inside", nested.id)).response.status,
      400,
    );
    assert.equal(
      (await place(owner, folder.id, "before", folder.id)).response.status,
      400,
    );
    assert.equal(
      (await place(editor, charlie.id, "inside", folder.id)).response.status,
      201,
    );
    moved = await current(owner, charlie.id);
    assert.equal(moved.parent_id, folder.id);
    assert.deepEqual(moved.document, before.document);
    assert.equal(
      (await request(`pages/${charlie.id}`, { cookie: viewer.cookie })).response
        .status,
      200,
    );
    assert.equal(
      (await place(editor, charlie.id, "root", null)).response.status,
      201,
    );
    assert.equal((await current(owner, charlie.id)).parent_id, null);
    const privateFolder = await create(
      owner,
      space.id,
      "Private projects",
      "folder",
    );
    await restrict(owner, privateFolder.id, [
      { userId: editor.id, role: "Editor" },
    ]);
    assert.equal(
      (await place(editor, privateFolder.id, "inside", folder.id)).response
        .status,
      201,
    );
    assert.equal(
      (await request(`pages/${privateFolder.id}`, { cookie: viewer.cookie }))
        .response.status,
      404,
    );
    const restrictedChild = await create(
      owner,
      space.id,
      "Restricted child",
      "page",
      nested.id,
    );
    await restrict(owner, restrictedChild.id, [
      { userId: editor.id, role: "Viewer" },
    ]);
    assert.equal(
      (await place(editor, nested.id, "root", null)).response.status,
      403,
    );
    const otherSpace = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Other space" },
        })
      ).data,
      otherFolder = await create(owner, otherSpace.id, "Elsewhere", "folder");
    assert.equal(
      (await place(owner, alpha.id, "inside", otherFolder.id)).response.status,
      400,
    );
    const database = (
      await request(`spaces/${space.id}/databases`, {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Records" },
      })
    ).data;
    assert.equal(
      (await place(owner, alpha.id, "inside", database.id)).response.status,
      400,
    );
    assert.equal(
      (
        await request(`spaces/${space.id}/pages`, {
          method: "POST",
          cookie: owner.cookie,
          body: { title: "Wrong child", kind: "folder", parentId: database.id },
        })
      ).response.status,
      400,
    );
    const record = await request(`databases/${database.id}/records`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "Valid database record" },
    });
    assert.equal(record.response.status, 201, JSON.stringify(record.data));
    assert.equal((await current(owner, record.data.pageId)).kind, "record");
    assert.equal(
      (await place(owner, record.data.pageId, "root", null)).response.status,
      400,
    );
    const closeBefore = await create(owner, space.id, "Near before"),
      closeAfter = await create(owner, space.id, "Near after"),
      hidden = await create(owner, space.id, "Hidden sibling");
    await restrict(owner, hidden.id);
    await db.query(
      "UPDATE pages SET sort_rank=CASE id WHEN $1::uuid THEN 50000 WHEN $2::uuid THEN 50000.000000001 ELSE 50000.0000000005 END WHERE id=ANY($3::uuid[])",
      [
        closeBefore.id,
        closeAfter.id,
        [closeBefore.id, closeAfter.id, hidden.id],
      ],
    );
    const hiddenBefore = (
        await db.query(
          "SELECT version,updated_at::text AS stamp FROM pages WHERE id=$1",
          [hidden.id],
        )
      ).rows[0],
      spaceBefore = (
        await db.query("SELECT version FROM spaces WHERE id=$1", [space.id])
      ).rows[0].version;
    assert.equal(
      (await place(editor, alpha.id, "before", closeAfter.id)).response.status,
      201,
    );
    assert.deepEqual(
      (
        await db.query(
          "SELECT version,updated_at::text AS stamp FROM pages WHERE id=$1",
          [hidden.id],
        )
      ).rows[0],
      hiddenBefore,
    );
    assert.equal(
      (await db.query("SELECT version FROM spaces WHERE id=$1", [space.id]))
        .rows[0].version,
      spaceBefore + 1,
    );
    const visible = (
      await request(`spaces/${space.id}/pages?limit=200`, {
        cookie: editor.cookie,
      })
    ).data;
    assert.ok(!JSON.stringify(visible).includes(hidden.id));
    assert.ok(
      (await current(owner, alpha.id)).sort_rank <
        (await current(owner, closeAfter.id)).sort_rank,
    );
    // An anchor moved since the UI rendered must not redirect a relative drop into another parent.
    assert.equal(
      (await place(owner, bravo.id, "inside", folder.id)).response.status,
      201,
    );
    assert.equal(
      (
        await place(owner, alpha.id, "before", bravo.id, {
          targetParentId: null,
        })
      ).response.status,
      409,
    );
  } finally {
    await db.end();
  }
});

test("Chromium: create/nest folders, native sidebar drops, keyboard reorder/outdent, permanent heading links, reader and reload", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    }),
    contexts = [],
    errors = [];
  let page;
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
          body: { name: "Product workspace" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const overview = await create(owner, space.id, "Overview"),
      release = await create(owner, space.id, "Release plan"),
      archive = await create(owner, space.id, "Archive", "folder"),
      headingId = randomUUID();
    await request(`pages/${release.id}`, {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        title: release.title,
        version: release.version,
        document: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2, id: headingId },
              content: [{ type: "text", text: "Launch checklist" }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "The release plan stays linked when its place in the workspace changes.",
                },
              ],
            },
          ],
        },
      },
    });
    page = await session(owner);
    await page.goto(base + pageLink(overview.id));
    await expect(
      page.getByRole("textbox", { name: "Document", exact: true }),
    ).toBeEditable();
    await page
      .getByRole("button", { name: "Create in this space", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "New folder", exact: true })
      .click();
    const title = page.getByLabel("Page title", { exact: true });
    await expect(title).toHaveValue("Untitled folder");
    await title.fill("Projects");
    await title.press("Tab");
    await expect(page.getByText("Title saved", { exact: true })).toBeVisible();
    const folderId = new URL(page.url()).searchParams.get("page");
    assert.equal((await current(owner, folderId)).kind, "folder");
    await page
      .getByRole("button", { name: "Page actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "New subfolder", exact: true })
      .click();
    await expect(title).toHaveValue("Untitled folder");
    await title.fill("Design notes");
    await title.press("Tab");
    await expect(page.getByText("Title saved", { exact: true })).toBeVisible();
    const nestedId = new URL(page.url()).searchParams.get("page");
    assert.equal((await current(owner, nestedId)).parent_id, folderId);
    const tree = page.getByRole("navigation", { name: "Pages", exact: true }),
      row = (name) =>
        tree.getByRole("button", { name, exact: true }).locator(".."),
      selectedOrder = () =>
        tree
          .locator(".tree-page")
          .allTextContents()
          .then((titles) =>
            titles
              .map((t) => t.trim())
              .filter((t) =>
                ["Projects", "Design notes", "Release plan"].includes(t),
              ),
          );
    await expect(row("Release plan")).toHaveAttribute("draggable", "true");
    await row("Release plan").dragTo(row("Projects"));
    await expect
      .poll(async () => (await current(owner, release.id)).parent_id)
      .toBe(folderId);
    await expect
      .poll(selectedOrder)
      .toEqual(["Projects", "Design notes", "Release plan"]);
    await expect(row("Release plan")).toHaveCSS("--depth", "1");
    await tree
      .getByRole("button", { name: "Release plan", exact: true })
      .focus();
    await page.keyboard.press("Alt+Shift+ArrowUp");
    await expect
      .poll(selectedOrder)
      .toEqual(["Projects", "Release plan", "Design notes"]);
    await tree
      .getByRole("button", { name: "Release plan", exact: true })
      .focus();
    await page.keyboard.press("Alt+Shift+ArrowLeft");
    await expect
      .poll(async () => (await current(owner, release.id)).parent_id)
      .toBe(null);
    await expect
      .poll(selectedOrder)
      .toEqual(["Projects", "Design notes", "Release plan"]);
    await expect(row("Release plan")).toHaveCSS("--depth", "0");
    await row("Release plan").dragTo(row("Overview"), {
      targetPosition: { x: 110, y: 2 },
    });
    await expect
      .poll(() => tree.locator(".tree-page").first().textContent())
      .toBe("Release plan");
    await tree
      .getByRole("button", { name: "Release plan", exact: true })
      .click();
    await expect(title).toHaveValue("Release plan");
    await expect(
      page
        .getByRole("textbox", { name: "Document", exact: true })
        .locator("h2"),
    ).toHaveAttribute("id", "h-" + headingId);
    await page.screenshot({
      path: ".local/ui-review/folders-hierarchy.png",
      fullPage: true,
    });
    const reader = await session(viewer);
    await reader.goto(base + pageLink(release.id, headingId));
    await expect(
      reader.getByRole("textbox", { name: "Document", exact: true }),
    ).toHaveAttribute("contenteditable", "false", { timeout: 12000 });
    await expect(reader.locator("h2#h-" + headingId)).toHaveText(
      /Launch checklist/,
    );
    await expect(
      reader
        .getByRole("navigation", { name: "Pages", exact: true })
        .locator('[draggable="true"]'),
    ).toHaveCount(0);
    await expect(
      reader.getByRole("button", { name: "Create in this space", exact: true }),
    ).toHaveCount(0);
    await reader.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await reader.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.reload();
    await expect
      .poll(() => tree.locator(".tree-page").first().textContent())
      .toBe("Release plan");
    await expect(
      page
        .getByRole("textbox", { name: "Document", exact: true })
        .locator("h2"),
    ).toHaveAttribute("id", "h-" + headingId);
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page)
      await page.screenshot({
        path: ".local/ui-review/hierarchy-failure.png",
        fullPage: true,
      });
    console.error("Hierarchy browser errors", errors);
    throw error;
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
    await db.end();
  }
});

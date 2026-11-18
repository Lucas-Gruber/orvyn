import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import {
  EditorState,
  Selection,
  TextSelection,
} from "../packages/editor/node_modules/@tiptap/pm/dist/state/index.js";
import {
  schema,
  BlockSelection,
  blockRange,
  blockAction,
  moveBlocks,
} from "../packages/editor/dist/index.js";
import { pageLink } from "../packages/editor/dist/links.js";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";

const paragraph = (text) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
test("whole-block selections preserve closed structure, map edits and support reorder, deletion and bookmarks", () => {
  const id = randomUUID(),
    doc = schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2, id },
          content: [{ type: "text", text: "Plan" }],
        },
        { type: "orvynCallout", content: [paragraph("Nested note")] },
        paragraph("After"),
      ],
    }),
    first = doc.child(0).nodeSize,
    second = first + doc.child(1).nodeSize;
  let state = EditorState.create({
    doc,
    selection: BlockSelection.create(doc, { from: 0, to: second }),
  });
  const copied = state.selection.content();
  assert.equal(copied.openStart, 0);
  assert.equal(copied.openEnd, 0);
  assert.equal(copied.content.child(1).firstChild.textContent, "Nested note");
  assert.ok(
    Selection.fromJSON(doc, state.selection.toJSON()).eq(state.selection),
  );
  assert.ok(state.selection.getBookmark().resolve(doc).eq(state.selection));
  assert.equal(blockAction(state, "up"), null);
  assert.equal(moveBlocks(state, { from: 0, to: second }, first), null);
  assert.equal(
    moveBlocks(state, { from: 1, to: second }, doc.content.size),
    null,
  );
  state = state.apply(blockAction(state, "down"));
  assert.equal(state.doc.firstChild.textContent, "After");
  assert.equal(state.doc.child(1).attrs.id, id);
  assert.equal(state.doc.lastChild.type.name, "orvynCallout");
  assert.ok(state.selection instanceof BlockSelection);
  state.doc.check();
  state = state.apply(blockAction(state, "up"));
  assert.ok(state.doc.eq(doc));
  const edited = state.tr.insertText("!", 2),
    mapped = state.selection.map(edited.doc, edited.mapping);
  assert.ok(mapped instanceof BlockSelection);
  assert.equal(mapped.to, second + 1);
  const removed = state.tr.delete(0, second);
  assert.ok(
    !(
      state.selection.map(removed.doc, removed.mapping) instanceof
      BlockSelection
    ),
  );
  assert.deepEqual(blockRange(doc, second), {
    from: second,
    to: doc.content.size,
  });
  state = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, 2, second + 2)),
  );
  state = state.apply(blockAction(state, "delete"));
  assert.equal(state.doc.childCount, 1);
  assert.equal(state.doc.firstChild.type.name, "paragraph");
  assert.equal(state.doc.firstChild.textContent, "");
  state.doc.check();
});

test("Chromium: handles select/reorder multiple blocks, native drag, duplicate heading identities, undo, reader and reload", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    }),
    contexts = [],
    errors = [];
  let page;
  const account = async () => {
    const r = await request("auth/register", {
        method: "POST",
        body: { email: randomUUID() + "@example.test", password: randomUUID() },
      }),
      cookie = sessionCookie(r.response);
    return { ...(await request("auth/me", { cookie })).data, cookie };
  };
  async function session(user) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      reducedMotion: "reduce",
    });
    contexts.push(context);
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
          body: { name: "Editorial workspace" },
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
          body: { title: "Launch notes" },
        })
      ).data,
      headingId = randomUUID(),
      content = [
        {
          type: "heading",
          attrs: { level: 2, id: headingId },
          content: [{ type: "text", text: "Launch checklist" }],
        },
        paragraph("Confirm the release date"),
        paragraph("Review the announcement"),
        {
          type: "orvynCallout",
          attrs: { tone: "info" },
          content: [paragraph("Keep everyone informed before publishing.")],
        },
        paragraph("Publish the update"),
      ];
    assert.equal(
      (
        await request(`pages/${source.id}`, {
          method: "PUT",
          cookie: owner.cookie,
          body: {
            title: source.title,
            version: source.version,
            document: { type: "doc", content },
          },
        })
      ).response.status,
      200,
    );
    page = await session(owner);
    await page.goto(base + pageLink(source.id));
    const doc = page.getByRole("textbox", { name: "Document", exact: true }),
      handles = doc.locator(":scope > .block-handle-anchor > .block-handle"),
      menu = page.getByRole("menu", { name: "Block actions", exact: true }),
      selected = doc.locator(":scope > .orvyn-block-selected");
    await expect(doc).toBeEditable();
    await expect(handles).toHaveCount(5);
    const nodes = () =>
      doc
        .locator(":scope > h2, :scope > p, :scope > .callout-block")
        .evaluateAll((elements) =>
          elements.map((element) => {
            if (element.matches(".callout-block"))
              return element.querySelector(".callout-content").textContent;
            const clone = element.cloneNode(true);
            clone
              .querySelectorAll(
                ".heading-permalink, .collaboration-carets__caret",
              )
              .forEach((e) => e.remove());
            return clone.textContent;
          }),
        );
    await handles.nth(1).click({ modifiers: ["Shift"] });
    await expect(selected).toHaveCount(1);
    await handles.nth(2).click({ modifiers: ["Shift"] });
    await expect(selected).toHaveCount(2);
    await page.keyboard.press("Alt+Shift+ArrowDown");
    await expect
      .poll(nodes)
      .toEqual([
        "Launch checklist",
        "Keep everyone informed before publishing.",
        "Confirm the release date",
        "Review the announcement",
        "Publish the update",
      ]);
    await expect(selected).toHaveCount(2);
    await handles.nth(2).click();
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("2 blocks selected");
    await menu.getByRole("menuitem", { name: "Move up", exact: false }).click();
    await expect
      .poll(nodes)
      .toEqual([
        "Launch checklist",
        "Confirm the release date",
        "Review the announcement",
        "Keep everyone informed before publishing.",
        "Publish the update",
      ]);
    await handles.nth(0).click();
    await menu
      .getByRole("menuitem", { name: "Duplicate", exact: true })
      .click();
    const headings = doc.locator("h2");
    await expect(headings).toHaveCount(2);
    const ids = await headings.evaluateAll((elements) =>
      elements.map((e) => e.id),
    );
    assert.equal(ids[0], "h-" + headingId);
    assert.notEqual(ids[1], ids[0]);
    await expect(selected).toHaveCount(1);
    await page.keyboard.press("Delete");
    await expect(headings).toHaveCount(1);
    await expect(headings).toHaveAttribute("id", "h-" + headingId);
    // Native Chromium drag-and-drop through the actual grip, preserving nested content.
    await handles.nth(3).hover();
    await handles
      .nth(3)
      .dragTo(doc.locator(":scope > h2"), { targetPosition: { x: 50, y: 2 } });
    await expect
      .poll(nodes)
      .toEqual([
        "Keep everyone informed before publishing.",
        "Launch checklist",
        "Confirm the release date",
        "Review the announcement",
        "Publish the update",
      ]);
    await expect(headings).toHaveAttribute("id", "h-" + headingId);
    await expect(selected).toHaveCount(1);
    await page.screenshot({
      path: ".local/ui-review/editor-block-handles.png",
      fullPage: true,
    });
    // Start a separate undo item, then undo a menu move while the document remains focused.
    await handles.nth(0).click();
    await menu
      .getByRole("menuitem", { name: "Move down", exact: false })
      .click();
    await expect
      .poll(nodes)
      .toEqual([
        "Launch checklist",
        "Keep everyone informed before publishing.",
        "Confirm the release date",
        "Review the announcement",
        "Publish the update",
      ]);
    await page.keyboard.press("Control+z");
    await expect
      .poll(nodes)
      .toEqual([
        "Keep everyone informed before publishing.",
        "Launch checklist",
        "Confirm the release date",
        "Review the announcement",
        "Publish the update",
      ]);
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
      readerDoc.getByRole("button", { name: "Block actions", exact: true }),
    ).toHaveCount(0);
    await expect(readerDoc.locator("h2")).toHaveAttribute(
      "id",
      "h-" + headingId,
    );
    await handles.nth(2).click({ modifiers: ["Shift"] });
    await handles.nth(3).click({ modifiers: ["Shift"] });
    await expect(selected).toHaveCount(2);
    const finalParagraph = doc.locator(":scope > p").last(),
      bounds = await finalParagraph.boundingBox();
    await handles.nth(2).dragTo(finalParagraph, {
      targetPosition: { x: 50, y: bounds.height - 2 },
    });
    await expect
      .poll(nodes)
      .toEqual([
        "Keep everyone informed before publishing.",
        "Launch checklist",
        "Publish the update",
        "Confirm the release date",
        "Review the announcement",
      ]);
    await expect(selected).toHaveCount(2);
    await expect(readerDoc.locator(":scope > p").last()).toContainText(
      "Review the announcement",
    );
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible({ timeout: 12000 });
    await page.reload();
    await expect(doc).toBeEditable();
    await expect
      .poll(nodes)
      .toEqual([
        "Keep everyone informed before publishing.",
        "Launch checklist",
        "Publish the update",
        "Confirm the release date",
        "Review the announcement",
      ]);
    await expect(headings).toHaveAttribute("id", "h-" + headingId);
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: base,
      });
    await handles.nth(0).click({ modifiers: ["Shift"] });
    await expect(selected).toHaveCount(1);
    await page.keyboard.press("Control+c");
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain("Keep everyone informed before publishing.");
    const destination = (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie: owner.cookie,
        body: { title: "Copied blocks" },
      })
    ).data;
    await page.goto(base + pageLink(destination.id));
    await expect(doc).toBeEditable();
    await doc.locator(":scope > p").click();
    await page.keyboard.press("Control+v");
    await expect(doc.locator(".callout-content")).toHaveText(
      "Keep everyone informed before publishing.",
    );
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible({ timeout: 12000 });
    await page.reload();
    await expect(doc.locator(".callout-content")).toHaveText(
      "Keep everyone informed before publishing.",
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page)
      await page.screenshot({
        path: ".local/ui-review/editor-block-handles-failure.png",
        fullPage: true,
      });
    console.error("Block control errors", errors);
    throw error;
  } finally {
    for (const c of contexts) await c.close();
    await browser.close();
    await db.end();
  }
});

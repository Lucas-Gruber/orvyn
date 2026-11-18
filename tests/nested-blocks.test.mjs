import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  schema,
  blockRange,
  BlockSelection,
  blockAction,
  moveBlocks,
  blockMoveTargets,
  validateDocument,
} from "../packages/editor/dist/index.js";
import {
  EditorState,
  Selection,
} from "../packages/editor/node_modules/@tiptap/pm/dist/state/index.js";

const paragraph = (text) => ({
  type: "paragraph",
  ...(text ? { content: [{ type: "text", text }] } : {}),
});
const nodeAtText = (doc, text) => {
  let found;
  doc.descendants((node, position) => {
    if (node.isTextblock && node.textContent === text)
      found = { node, position };
  });
  assert.ok(found, `Text block ${text} exists`);
  return found;
};
const rangeAt = (doc, text) => {
  const { node, position } = nodeAtText(doc, text);
  return { from: position, to: position + node.nodeSize };
};
const fixture = () =>
  schema.nodeFromJSON({
    type: "doc",
    content: [
      paragraph("Before"),
      {
        type: "orvynColumns",
        attrs: { widths: [6000, 4000] },
        content: [
          {
            type: "orvynColumn",
            content: [
              paragraph("Alpha"),
              {
                type: "heading",
                attrs: { level: 3, id: randomUUID() },
                content: [{ type: "text", text: "Beta" }],
              },
            ],
          },
          { type: "orvynColumn", content: [paragraph("Gamma")] },
        ],
      },
      {
        type: "orvynCallout",
        content: [paragraph("Delta"), paragraph("Epsilon")],
      },
      {
        type: "orvynToggle",
        content: [
          {
            type: "orvynToggleSummary",
            content: [{ type: "text", text: "Details" }],
          },
          { type: "orvynToggleContent", content: [paragraph("Zeta")] },
        ],
      },
      paragraph("After"),
    ],
  });

test("nested block ranges use their nearest editable container and preserve exact selections through mapping", () => {
  const doc = fixture(),
    alpha = rangeAt(doc, "Alpha"),
    beta = rangeAt(doc, "Beta");
  assert.deepEqual(blockRange(doc, alpha.from + 1), alpha);
  assert.deepEqual(blockRange(doc, alpha.from + 2, beta.to - 1), {
    from: alpha.from,
    to: beta.to,
  });
  const selection = BlockSelection.create(doc, {
    from: alpha.from,
    to: beta.to,
  });
  assert.ok(Selection.fromJSON(doc, selection.toJSON()).eq(selection));
  assert.ok(selection.getBookmark().resolve(doc).eq(selection));
  assert.equal(selection.content().openStart, 0);
  assert.equal(selection.content().content.childCount, 2);
  const state = EditorState.create({ doc, selection });
  const inserted = state.tr.insertText("!", alpha.from + 2);
  const mapped = selection.map(inserted.doc, inserted.mapping);
  assert.ok(mapped instanceof BlockSelection);
  assert.equal(mapped.to, beta.to + 1);
  const removed = state.tr.delete(
    doc.firstChild.nodeSize,
    doc.firstChild.nodeSize + doc.child(1).nodeSize,
  );
  assert.ok(
    !(selection.map(removed.doc, removed.mapping) instanceof BlockSelection),
  );
  assert.throws(() =>
    BlockSelection.create(doc, { from: alpha.from + 1, to: beta.to }),
  );
});

test("moving nested blocks across containers preserves wrappers, headings, widths and valid empty source containers", () => {
  const doc = fixture(),
    alpha = rangeAt(doc, "Alpha"),
    beta = rangeAt(doc, "Beta"),
    gamma = rangeAt(doc, "Gamma");
  let state = EditorState.create({
    doc,
    selection: BlockSelection.create(doc, { from: alpha.from, to: beta.to }),
  });
  state = state.apply(
    moveBlocks(state, { from: alpha.from, to: beta.to }, gamma.from),
  );
  assert.equal(state.doc.child(1).child(0).childCount, 1);
  assert.equal(state.doc.child(1).child(0).firstChild.type.name, "paragraph");
  assert.equal(state.doc.child(1).child(0).textContent, "");
  assert.equal(state.doc.child(1).child(1).textContent, "AlphaBetaGamma");
  assert.equal(
    nodeAtText(state.doc, "Beta").node.attrs.id,
    nodeAtText(doc, "Beta").node.attrs.id,
  );
  assert.deepEqual(state.doc.child(1).attrs.widths, [6000, 4000]);
  assert.ok(state.selection instanceof BlockSelection);
  validateDocument(state.doc.toJSON());
  // Move both selected blocks out of the columns, ahead of the callout.
  const calloutPosition =
    state.doc.child(0).nodeSize + state.doc.child(1).nodeSize;
  state = state.apply(moveBlocks(state, state.selection, calloutPosition));
  assert.equal(state.doc.child(2).textContent, "Alpha");
  assert.equal(state.doc.child(3).textContent, "Beta");
  assert.equal(state.doc.child(1).child(1).textContent, "Gamma");
  validateDocument(state.doc.toJSON());
  // Moving the only toggle child leaves an editable paragraph in the toggle.
  const zeta = rangeAt(state.doc, "Zeta");
  state = state.apply(
    moveBlocks(state, zeta, rangeAt(state.doc, "Delta").from),
  );
  const toggle = state.doc.content.content.find(
    (node) => node.type.name === "orvynToggle",
  );
  assert.equal(toggle.lastChild.childCount, 1);
  assert.equal(toggle.lastChild.firstChild.type.name, "paragraph");
  assert.equal(toggle.firstChild.textContent, "Details");
  assert.equal(
    state.doc.content.content.find((node) => node.type.name === "orvynCallout")
      .textContent,
    "ZetaDeltaEpsilon",
  );
  validateDocument(state.doc.toJSON());
});

test("nested movement/deletion respects sibling boundaries and refuses structural or self-containing drops", () => {
  const doc = fixture(),
    alpha = rangeAt(doc, "Alpha"),
    beta = rangeAt(doc, "Beta");
  let state = EditorState.create({
    doc,
    selection: BlockSelection.create(doc, alpha),
  });
  assert.equal(blockAction(state, "up"), null);
  state = state.apply(blockAction(state, "down"));
  assert.equal(state.doc.child(1).child(0).textContent, "BetaAlpha");
  assert.equal(blockAction(state, "down"), null);
  state = state.apply(blockAction(state, "delete"));
  assert.equal(state.doc.child(1).child(0).textContent, "Beta");
  state = state.apply(
    state.tr.setSelection(
      BlockSelection.create(state.doc, rangeAt(state.doc, "Beta")),
    ),
  );
  state = state.apply(blockAction(state, "delete"));
  assert.equal(state.doc.child(1).child(0).childCount, 1);
  assert.equal(state.doc.child(1).child(0).firstChild.type.name, "paragraph");
  validateDocument(state.doc.toJSON());
  const original = EditorState.create({ doc });
  const columns = {
    from: doc.firstChild.nodeSize,
    to: doc.firstChild.nodeSize + doc.child(1).nodeSize,
  };
  assert.equal(moveBlocks(original, columns, alpha.from), null);
  assert.equal(moveBlocks(original, alpha, beta.from + 1), null);
  assert.equal(moveBlocks(original, alpha, columns.from + 1), null);
  assert.equal(moveBlocks(original, alpha, alpha.to), null);
});

test("nested targets exclude the source subtree and outdent moves only the selected blocks", () => {
  const doc = fixture(),
    state = EditorState.create({
      doc,
      selection: BlockSelection.create(doc, rangeAt(doc, "Alpha")),
    });
  const targets = blockMoveTargets(state);
  assert.ok(targets.some((target) => target.label === "Column 2 · Gamma"));
  assert.ok(targets.some((target) => target.label === "Toggle · Details"));
  assert.ok(targets.some((target) => target.label === "Callout · Delta"));
  const moved = state.apply(blockAction(state, "out"));
  assert.equal(moved.doc.child(2).textContent, "Alpha");
  assert.equal(moved.doc.child(1).child(0).textContent, "Beta");
  validateDocument(moved.doc.toJSON());
  const columnsRange = {
    from: doc.firstChild.nodeSize,
    to: doc.firstChild.nodeSize + doc.child(1).nodeSize,
  };
  const selectedColumns = EditorState.create({
    doc,
    selection: BlockSelection.create(doc, columnsRange),
  });
  assert.ok(
    !blockMoveTargets(selectedColumns).some((target) =>
      target.label.startsWith("Column"),
    ),
  );
});

import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { pageLink } from "../packages/editor/dist/links.js";

test("Chromium: nested grips, cross-column native drag, destination search, undo, outdent, duplication, readers and reload", async () => {
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
        body: { title: "Make room for your ideas" },
      })
    ).data;
    const headingId = randomUUID();
    const document = {
      type: "doc",
      content: [
        paragraph(
          "A flexible page for shaping the next release. Move a thought wherever it belongs.",
        ),
        {
          type: "orvynColumns",
          attrs: { widths: [5500, 4500] },
          content: [
            {
              type: "orvynColumn",
              content: [
                {
                  type: "heading",
                  attrs: { level: 3, id: headingId },
                  content: [{ type: "text", text: "In motion" }],
                },
                paragraph("Gather customer feedback"),
                paragraph("Sketch the first direction"),
              ],
            },
            {
              type: "orvynColumn",
              content: [
                {
                  type: "heading",
                  attrs: { level: 3, id: randomUUID() },
                  content: [{ type: "text", text: "Coming next" }],
                },
                paragraph("Share an early prototype"),
              ],
            },
          ],
        },
        {
          type: "orvynCallout",
          attrs: { tone: "neutral" },
          content: [
            paragraph("Keep the conversation open."),
            paragraph("Small steps make room for better ideas."),
          ],
        },
        {
          type: "orvynToggle",
          content: [
            {
              type: "orvynToggleSummary",
              content: [{ type: "text", text: "Decisions and context" }],
            },
            {
              type: "orvynToggleContent",
              content: [paragraph("Review the original research")],
            },
          ],
        },
        paragraph("Next team review · Thursday"),
      ],
    };
    assert.equal(
      (
        await request(`pages/${source.id}`, {
          method: "PUT",
          cookie: owner.cookie,
          body: { title: source.title, version: source.version, document },
        })
      ).response.status,
      200,
    );
    page = await session(owner);
    await page.goto(base + pageLink(source.id));
    const doc = page.getByRole("textbox", { name: "Document", exact: true });
    const columns = doc.locator("[data-orvyn-column]");
    const grips = (index) =>
      columns
        .nth(index)
        .getByRole("button", { name: "Block actions", exact: true });
    const menu = page.getByRole("menu", { name: "Block actions", exact: true });
    await expect(doc).toBeEditable();
    await expect(grips(0)).toHaveCount(3);
    await expect(grips(1)).toHaveCount(2);
    await grips(0).nth(1).hover();
    await grips(0)
      .nth(1)
      .dragTo(
        columns.nth(1).getByText("Share an early prototype", { exact: true }),
        { targetPosition: { x: 60, y: 2 } },
      );
    await expect(columns.nth(0)).not.toContainText("Gather customer feedback");
    await expect(columns.nth(1)).toContainText("Gather customer feedback");
    await expect(columns.nth(1).locator(".orvyn-block-selected")).toHaveCount(
      1,
    );
    await page.keyboard.press("Control+z");
    await expect(columns.nth(0)).toContainText("Gather customer feedback");
    await expect(columns.nth(1)).not.toContainText("Gather customer feedback");
    // Select the heading and both paragraphs as siblings within the first column.
    await grips(0)
      .nth(0)
      .click({ modifiers: ["Shift"] });
    await grips(0)
      .nth(2)
      .click({ modifiers: ["Shift"] });
    await grips(0).nth(1).click();
    await expect(menu).toContainText("3 blocks selected");
    await menu.getByRole("menuitem", { name: "Move to…", exact: true }).click();
    const destinations = page.getByRole("menu", {
      name: "Move blocks to",
      exact: true,
    });
    await destinations.getByLabel("Find a block destination").fill("Callout");
    await expect(destinations.getByRole("menuitem")).toHaveCount(1);
    await page.screenshot({
      path: ".local/ui-review/nested-block-destinations.png",
      fullPage: true,
    });
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(columns.nth(0).locator("p")).toHaveCount(1);
    await expect(columns.nth(0).locator("p")).toHaveText("");
    const callout = doc.locator(".callout-block");
    await expect(callout).toContainText("In motion");
    await expect(callout.locator("h3")).toHaveAttribute("id", "h-" + headingId);
    await page.keyboard.press("Control+z");
    await expect(columns.nth(0).locator("h3")).toHaveAttribute(
      "id",
      "h-" + headingId,
    );
    await expect(callout).not.toContainText("In motion");
    // A nested block can leave its containing callout without moving the callout.
    const calloutGrips = callout.getByRole("button", {
      name: "Block actions",
      exact: true,
    });
    await calloutGrips.nth(0).click({ modifiers: ["Shift"] });
    await page.keyboard.press("Alt+Shift+ArrowLeft");
    await expect(
      doc.locator(":scope > p", { hasText: "Keep the conversation open." }),
    ).toBeVisible();
    await expect(callout).not.toContainText("Keep the conversation open.");
    await expect(callout).toContainText(
      "Small steps make room for better ideas.",
    );
    // Duplicate a nested heading while preserving the existing permanent link.
    await grips(0).nth(0).click();
    await menu
      .getByRole("menuitem", { name: "Duplicate", exact: true })
      .click();
    await expect(columns.nth(0).locator("h3")).toHaveCount(2);
    const headingIds = await columns
      .nth(0)
      .locator("h3")
      .evaluateAll((elements) => elements.map((element) => element.id));
    assert.equal(headingIds[0], "h-" + headingId);
    assert.notEqual(headingIds[1], headingIds[0]);
    await page.keyboard.press("Control+z");
    await expect(columns.nth(0).locator("h3")).toHaveCount(1);
    // Move the only toggle child to another column, keeping its source editable.
    const toggleBody = doc.locator("[data-orvyn-toggle-content]");
    await toggleBody
      .getByRole("button", { name: "Block actions", exact: true })
      .click();
    await menu.getByRole("menuitem", { name: "Move to…", exact: true }).click();
    await destinations.getByLabel("Find a block destination").fill("Column 2");
    await destinations.getByRole("menuitem").click();
    await expect(toggleBody.locator("p")).toHaveText("");
    await expect(columns.nth(1)).toContainText("Review the original research");
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
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
    await expect(readerDoc.locator("[data-orvyn-column]").nth(1)).toContainText(
      "Review the original research",
    );
    await reader.screenshot({
      path: ".local/ui-review/nested-block-layout.png",
      fullPage: true,
    });
    await page.reload();
    await expect(columns.nth(1)).toContainText("Review the original research");
    await expect(toggleBody.locator("p")).toHaveText("");
    await expect(columns.nth(0).locator("h3")).toHaveAttribute(
      "id",
      "h-" + headingId,
    );
    const live = await session(owner);
    await live.goto(base + pageLink(source.id));
    const liveDoc = live.getByRole("textbox", {
      name: "Document",
      exact: true,
    });
    await expect(liveDoc).toBeEditable();
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await grips(0)
      .nth(2)
      .dispatchEvent("dragstart", { dataTransfer: transfer });
    await liveDoc.locator(":scope > p").first().click();
    await live.keyboard.press("Home");
    await live.keyboard.insertText("Updated together: ");
    await expect(doc.locator(":scope > p").first()).toContainText(
      "Updated together:",
    );
    const drop = await columns
      .nth(1)
      .getByText("Share an early prototype", { exact: true })
      .boundingBox();
    await doc.dispatchEvent("drop", {
      dataTransfer: transfer,
      clientX: drop.x + 50,
      clientY: drop.y + 1,
    });
    await transfer.dispose();
    await expect(columns.nth(0)).not.toContainText(
      "Sketch the first direction",
    );
    await expect(columns.nth(1)).toContainText("Sketch the first direction");
    await expect(liveDoc.locator("[data-orvyn-column]").nth(1)).toContainText(
      "Sketch the first direction",
    );
    await expect(readerDoc.locator("[data-orvyn-column]").nth(1)).toContainText(
      "Sketch the first direction",
    );
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await reader.screenshot({
      path: ".local/ui-review/nested-block-layout.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await grips(0).nth(1).click();
    await menu.getByRole("menuitem", { name: "Move to…", exact: true }).click();
    await expect(destinations).toBeVisible();
    const bounds = await destinations.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: ".local/ui-review/nested-block-mobile.png",
      fullPage: true,
    });
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page)
      await page.screenshot({
        path: ".local/ui-review/nested-block-failure.png",
        fullPage: true,
      });
    console.error("Nested block browser errors", errors);
    throw error;
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
    await db.end();
  }
});

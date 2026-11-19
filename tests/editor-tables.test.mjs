import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { waitFor } from "./collaboration-peer.mjs";
import {
  validateDocument,
  documentToYDoc,
  yDocToDocument,
} from "../packages/editor/dist/index.js";

const paragraph = (text, marks) => ({
  type: "paragraph",
  ...(text
    ? { content: [{ type: "text", text, ...(marks ? { marks } : {}) }] }
    : {}),
});
const cell = (type = "tableCell", attrs = {}, text = "") => ({
  type,
  attrs,
  content: [paragraph(text)],
});
const merged = () => ({
  type: "table",
  content: [
    {
      type: "tableRow",
      content: [
        cell(
          "tableHeader",
          { colspan: 2, colwidth: [0, 220] },
          "Project overview",
        ),
        cell("tableHeader", {}, "Owner"),
      ],
    },
    { type: "tableRow", content: [cell(), cell(), cell()] },
  ],
});
const tableOf = (page) =>
  page.document.content.find((node) => node.type === "table");
async function account() {
  const registered = await request("auth/register", {
    method: "POST",
    body: { email: randomUUID() + "@example.test", password: randomUUID() },
  });
  const cookie = sessionCookie(registered.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
async function fixture(db, content) {
  const owner = await account(),
    viewer = await account(),
    editor = await account();
  const space = (
    await request("spaces", {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Product studio" },
    })
  ).data;
  await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
  for (const [person, role] of [
    [viewer, "Viewer"],
    [editor, "Editor"],
  ])
    await db.query("INSERT INTO space_members VALUES($1,$2,$3)", [
      space.id,
      person.id,
      role,
    ]);
  const page = (
    await request(`spaces/${space.id}/pages`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "Release plan" },
    })
  ).data;
  if (content)
    assert.equal(
      (
        await request("pages/" + page.id, {
          method: "PUT",
          cookie: owner.cookie,
          body: {
            title: page.title,
            version: page.version,
            document: { type: "doc", content },
          },
        })
      ).response.status,
      200,
    );
  const get = async () =>
    (await request("pages/" + page.id, { cookie: owner.cookie })).data;
  return { owner, viewer, editor, space, page, get };
}
const launch = () =>
  chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
async function open(browser, f, actor = f.owner) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    reducedMotion: "reduce",
  });
  await context.addInitScript(() =>
    localStorage.setItem("orvyn.theme", "light"),
  );
  await context.addCookies([
    {
      name: "orvyn_session",
      value: actor.cookie.split("=")[1],
      url: base,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  await page.goto(`${base}/?page=${f.page.id}`);
  const doc = page.getByRole("textbox", { name: "Document", exact: true });
  await expect(doc).toHaveAttribute(
    "contenteditable",
    actor === f.viewer ? "false" : "true",
  );
  return { page, doc };
}
const flow = (page) =>
  page.getByRole("toolbar", { name: "Table controls", exact: true });
async function action(page, menu, label, role = "menuitem") {
  await flow(page).getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole(role, { name: label, exact: true }).click();
}
async function drag(page, target, delta, finish = true) {
  const box = await target.boundingBox();
  assert.ok(box);
  await page.mouse.move(
    box.x + box.width - 2,
    box.y + Math.min(12, box.height / 2),
  );
  await expect(page.locator(".tiptap.resize-cursor")).toHaveCount(1);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width - 2 + delta,
    box.y + Math.min(12, box.height / 2),
    { steps: 8 },
  );
  if (finish) await page.mouse.up();
}

test("editor tables retain native unspecified widths through Yjs and reject negative, fractional and oversized columns", () => {
  const doc = { type: "doc", content: [merged()] };
  const ydoc = documentToYDoc(doc);
  try {
    assert.deepEqual(yDocToDocument(ydoc), validateDocument(doc));
  } finally {
    ydoc.destroy();
  }
  for (const value of [-1, 1.5, 2001]) {
    const bad = structuredClone(doc);
    bad.content[0].content[0].content[0].attrs.colwidth = [0, value];
    assert.throws(() => validateDocument(bad), /column width/);
  }
});

test("Chromium: inserted tables have clear cells, contextual row/column/header controls, width settings, continuation, live readers and persisted mobile layouts", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await launch();
  try {
    const f = await fixture(db),
      { page, doc } = await open(browser, f),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await doc.click();
    await page.keyboard.type("/Table");
    await page.getByRole("option", { name: "Table", exact: true }).click();
    const table = doc.locator("table");
    await expect(table.locator("tr")).toHaveCount(3);
    assert.equal(
      await table
        .locator("p")
        .evaluateAll((nodes) =>
          nodes.some((node) =>
            getComputedStyle(node, "::before").content.includes(
              "Start writing",
            ),
          ),
        ),
      false,
    );
    await table.locator("th,td").first().locator("p").click();
    await expect(flow(page)).toBeVisible();
    await action(page, "Table actions", "Header row", "menuitemcheckbox");
    await expect(table.locator("tr").first().locator("th")).toHaveCount(0);
    await action(page, "Table actions", "Header row", "menuitemcheckbox");
    await expect(table.locator("tr").first().locator("th")).toHaveCount(3);
    await action(page, "Row actions", "Insert row below");
    await expect(table.locator("tr")).toHaveCount(4);
    await action(page, "Column actions", "Insert column right");
    await expect(table.locator("tr").first().locator("th,td")).toHaveCount(4);
    await action(page, "Row actions", "Delete row");
    await action(page, "Column actions", "Delete column");
    await expect(table.locator("tr")).toHaveCount(3);
    await expect(table.locator("tr").first().locator("th,td")).toHaveCount(3);
    await action(page, "Table actions", "Header row", "menuitemcheckbox");
    const labels = [
      "Milestone",
      "Owner",
      "Due",
      "Research",
      "Mara",
      "Friday",
      "Prototype",
      "Lucas",
      "Next week",
    ];
    for (let index = 0; index < labels.length; index++) {
      await table.locator("th,td").nth(index).locator("p").click();
      await page.keyboard.insertText(labels[index]);
    }
    const reader = await open(browser, f, f.viewer);
    await expect(reader.doc.locator("table")).toContainText("Prototype");
    await expect(flow(reader.page)).toHaveCount(0);
    await table.locator("th,td").first().locator("p").click();
    await action(page, "Column actions", "Set column width…");
    const width = page.getByRole("dialog", {
      name: "Column width",
      exact: true,
    });
    await width
      .getByRole("spinbutton", { name: "Width in pixels", exact: true })
      .fill("260");
    await width
      .getByRole("button", { name: "Apply width", exact: true })
      .click();
    await expect(width).not.toBeVisible();
    await waitFor(
      async () =>
        tableOf(await f.get())?.content[0].content[0].attrs.colwidth?.[0] ===
        260,
      "Column width persisted",
    );
    await expect
      .poll(() =>
        reader.doc
          .locator("table col")
          .first()
          .evaluate((el) => Math.round(el.getBoundingClientRect().width)),
      )
      .toBe(260);
    await table.locator("th,td").first().locator("p").click();
    await flow(page)
      .getByRole("button", { name: "Row actions", exact: true })
      .click();
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/editor-table-menu.png",
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await table.locator("th,td").first().locator("p").click();
    await page.screenshot({
      path: ".local/ui-review/editor-table-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.setViewportSize({ width: 1440, height: 1050 });
    await table.locator("th,td").first().locator("p").click();
    await page.keyboard.press("Control+Enter");
    await page.keyboard.insertText("Next steps");
    await expect(doc.locator(":scope > p").last()).toHaveText("Next steps");
    await waitFor(
      async () =>
        (await f.get()).document.content.some(
          (node) =>
            node.type === "paragraph" &&
            node.content?.some((part) => part.text === "Next steps"),
        ),
      "Continuation saved",
    );
    await page.reload();
    await expect(
      page
        .getByRole("textbox", { name: "Document", exact: true })
        .locator("table"),
    ).toContainText("Prototype");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await db.end();
  }
});

test("Chromium: native merged-column resizing persists, Escape and permission revocation cancel previews, and text links retain pointer cursors for readers", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await launch();
  try {
    const table = merged();
    table.content[0].content[0].attrs.colwidth = null;
    const f = await fixture(db, [
      table,
      paragraph("Reference", [
        { type: "link", attrs: { href: "https://example.test/docs" } },
      ]),
    ]);
    const owner = await open(browser, f),
      reader = await open(browser, f, f.viewer),
      editor = await open(browser, f, f.editor),
      errors = [];
    for (const page of [owner.page, reader.page, editor.page])
      page.on("pageerror", (error) => errors.push(error.message));
    for (const client of [owner, reader])
      await expect(
        client.doc.getByRole("link", { name: "Reference", exact: true }),
      ).toHaveCSS("cursor", "pointer");
    const header = owner.doc.locator("tr").first().locator("th").first();
    await drag(owner.page, header, 80);
    await waitFor(
      async () =>
        tableOf(await f.get()).content[0].content[0].attrs.colwidth?.[1] > 200,
      "Merged column resize durably saved",
    );
    const saved = await f.get(),
      widths = tableOf(saved).content[0].content[0].attrs.colwidth;
    assert.equal(widths[0], 0);
    assert.ok(Number.isInteger(widths[1]));
    await expect
      .poll(() =>
        reader.doc
          .locator("col")
          .nth(1)
          .evaluate((el) => Math.round(el.getBoundingClientRect().width)),
      )
      .toBe(widths[1]);
    await drag(owner.page, header, 60, false);
    await owner.page.keyboard.press("Escape");
    await owner.page.mouse.up();
    assert.deepEqual(tableOf(await f.get()), tableOf(saved));
    await drag(
      editor.page,
      editor.doc.locator("tr").first().locator("th").first(),
      70,
      false,
    );
    const beforeRevoke = await f.get();
    const changed = await request("pages/" + f.page.id + "/permissions", {
      method: "PUT",
      cookie: f.owner.cookie,
      body: {
        version: beforeRevoke.version,
        confirm: true,
        visibility: "restricted",
        grants: [
          { userId: f.editor.id, role: "Viewer" },
          { userId: f.viewer.id, role: "Viewer" },
        ],
      },
    });
    assert.equal(changed.response.status, 200, JSON.stringify(changed.data));
    await expect(editor.doc).toHaveAttribute("contenteditable", "false");
    await editor.page.mouse.up();
    assert.deepEqual(tableOf(await f.get()), tableOf(saved));
    await expect(flow(editor.page)).toHaveCount(0);
    await owner.page.reload();
    await expect
      .poll(() =>
        owner.page
          .locator(".tiptap table col")
          .nth(1)
          .evaluate((el) => Math.round(el.getBoundingClientRect().width)),
      )
      .toBe(widths[1]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await db.end();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { documentToYDoc, schema } from "../packages/editor/dist/index.js";
import {
  anchorForRange,
  resolveCommentAnchor,
  resolveStoredCommentAnchor,
  validCommentAnchor,
} from "../packages/editor/dist/comment-anchors.js";
import { request, sessionCookie, Pool } from "./helpers.mjs";
import { peer, waitFor } from "./collaboration-peer.mjs";
const text = "A stable quotation stays with its discussion.";
const document = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
};
test("relative comment anchors survive preceding edits and persistence, flag changes, and reject deleted/foreign/malformed ranges", () => {
  const doc = documentToYDoc(document),
    other = documentToYDoc(document);
  try {
    const a = anchorForRange(doc, 3, 9);
    assert.ok(validCommentAnchor(a));
    assert.equal(a.quote, "stable");
    assert.equal(resolveCommentAnchor(other, a), null);
    let updates = 0;
    doc.on("update", () => updates++);
    assert.deepEqual(
      resolveStoredCommentAnchor(Y.encodeStateAsUpdate(doc), a),
      { from: 3, to: 9, quote: "stable", changed: false },
    );
    assert.equal(updates, 0);
    const body = doc.getXmlFragment("default").get(0).get(0);
    body.insert(0, "New ");
    assert.deepEqual(resolveCommentAnchor(doc, a), {
      from: 7,
      to: 13,
      quote: "stable",
      changed: false,
    });
    body.insert(8, "X");
    assert.ok(resolveCommentAnchor(doc, a).changed);
    const selection = resolveCommentAnchor(doc, a);
    body.delete(selection.from - 1, selection.to - selection.from);
    assert.equal(resolveCommentAnchor(doc, a), null);
    for (const bad of [
      null,
      { ...a, quote: "x".repeat(2001) },
      { ...a, from: { tname: "secret" } },
      { ...a, unknown: true },
      { ...a, to: { type: { client: -1, clock: 1 } } },
    ])
      assert.equal(validCommentAnchor(bad), false);
    assert.equal(anchorForRange(doc, 1, 1), null);
    assert.equal(anchorForRange(doc, -1, 2), null);
    const nestedJSON = {
        type: "doc",
        content: [
          {
            type: "orvynCallout",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Nested quotation 🚀" }],
              },
            ],
          },
        ],
      },
      nested = documentToYDoc(nestedJSON),
      model = schema.nodeFromJSON(nestedJSON);
    try {
      let position;
      model.descendants((node, pos) => {
        if (node.isText) position = pos + 7;
      });
      const anchor = anchorForRange(nested, position, position + 9);
      assert.equal(anchor.quote, "quotation");
      assert.equal(resolveCommentAnchor(nested, anchor).changed, false);
    } finally {
      nested.destroy();
    }
  } finally {
    doc.destroy();
    other.destroy();
  }
});
test("text threads validate current page CRDT ranges, preserve idempotency after edits, hide resolved anchors and enforce current rights", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    peers = [];
  async function account() {
    const r = await request("auth/register", {
        method: "POST",
        body: { email: randomUUID() + "@example.test", password: randomUUID() },
      }),
      cookie = sessionCookie(r.response);
    return { ...(await request("auth/me", { cookie })).data, cookie };
  }
  try {
    const owner = await account(),
      commenter = await account(),
      viewer = await account(),
      space = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Text discussions" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query(
      "INSERT INTO space_members VALUES($1,$2,'Commenter'),($1,$3,'Viewer')",
      [space.id, commenter.id, viewer.id],
    );
    const p = (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie: owner.cookie,
        body: { title: "Quoted text" },
      })
    ).data;
    await request(`pages/${p.id}`, {
      method: "PUT",
      cookie: owner.cookie,
      body: { version: p.version, title: p.title, document },
    });
    const writer = peer(
      JSON.parse(process.env.COLLABORATION_TEST_URLS)[0],
      p.id,
      owner.cookie,
    );
    peers.push(writer);
    await waitFor(
      () => writer.provider.isSynced && !writer.provider.hasUnsyncedChanges,
      "Text writer initialized",
    );
    const anchor = anchorForRange(writer.doc, 3, 9),
      input = {
        body: "Discuss this particular word.",
        requestId: randomUUID(),
        anchor,
      },
      create = (body) =>
        request(`pages/${p.id}/threads`, {
          method: "POST",
          cookie: commenter.cookie,
          body,
        }),
      created = await create(input);
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    assert.deepEqual(
      created.data.thread.anchor,
      JSON.parse(JSON.stringify(anchor)),
    );
    const anchors = async () =>
      request(`pages/${p.id}/thread-anchors`, { cookie: viewer.cookie });
    assert.equal((await anchors()).data.anchors[0].id, created.data.thread.id);
    const body = writer.doc.getXmlFragment("default").get(0).get(0);
    body.insert(0, "New ");
    await waitFor(
      () => !writer.provider.hasUnsyncedChanges,
      "Preceding edit durable",
    );
    assert.equal(
      (await create({ ...input, requestId: randomUUID() })).response.status,
      201,
    );
    body.insert(8, "X");
    await waitFor(
      () => !writer.provider.hasUnsyncedChanges,
      "Quoted edit durable",
    );
    assert.equal(
      (await create({ ...input, requestId: randomUUID() })).response.status,
      409,
    );
    assert.equal(
      (await create(input)).data.thread.id,
      created.data.thread.id,
      "A confirmed retry must not fail because the quoted text later changed",
    );
    const old = documentToYDoc(document);
    try {
      assert.equal(
        (
          await create({
            ...input,
            requestId: randomUUID(),
            anchor: anchorForRange(old, 3, 9),
          })
        ).response.status,
        409,
      );
    } finally {
      old.destroy();
    }
    assert.equal(
      (
        await create({
          ...input,
          requestId: randomUUID(),
          anchor: { ...anchor, from: { tname: "wrong" } },
        })
      ).response.status,
      400,
    );
    const t = (
      await request(`threads/${created.data.thread.id}`, {
        cookie: owner.cookie,
      })
    ).data.thread;
    await request(`threads/${t.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: { version: t.version, resolved: true },
    });
    assert.ok(!(await anchors()).data.anchors.some((a) => a.id === t.id));
    await db.query(
      "UPDATE space_members SET role='Viewer' WHERE space_id=$1 AND user_id=$2",
      [space.id, commenter.id],
    );
    assert.equal(
      (await create({ ...input, requestId: randomUUID() })).response.status,
      404,
    );
    const page = (await request(`pages/${p.id}`, { cookie: owner.cookie }))
      .data;
    await request(`pages/${p.id}/permissions`, {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        version: page.version,
        visibility: "restricted",
        grants: [],
        confirm: true,
      },
    });
    assert.equal((await anchors()).response.status, 404);
  } finally {
    for (const p of peers) p.destroy();
    await db.end();
  }
});

test("readonly commenters create selected-text discussions, follow live changes, revisit markers and retain threads after text deletion", async () => {
  const { chromium, expect } = await import("@playwright/test"),
    { mkdir } = await import("node:fs/promises"),
    { pageLink } = await import("../packages/editor/dist/links.js"),
    { base } = await import("./helpers.mjs"),
    db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    }),
    contexts = [],
    errors = [];
  let writer;
  async function account() {
    const result = await request("auth/register", {
        method: "POST",
        body: { email: randomUUID() + "@example.test", password: randomUUID() },
      }),
      cookie = sessionCookie(result.response);
    return { ...(await request("auth/me", { cookie })).data, cookie };
  }
  async function session(user) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
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
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    return page;
  }
  async function selectText(page, text) {
    await page
      .getByRole("textbox", { name: "Document", exact: true })
      .evaluate((dom, text) => {
        dom.focus();
        const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const at = node.textContent.indexOf(text);
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + text.length);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          document.dispatchEvent(new Event("selectionchange"));
          return;
        }
        throw Error("Selection text not found: " + text);
      }, text);
  }
  try {
    await mkdir(".local/ui-review", { recursive: true });
    const owner = await account(),
      commenter = await account(),
      space = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Product handbook" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Commenter')", [
      space.id,
      commenter.id,
    ]);
    const p = (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie: owner.cookie,
        body: { title: "Release planning" },
      })
    ).data;
    await request(`pages/${p.id}`, {
      method: "PUT",
      cookie: owner.cookie,
      body: { title: p.title, version: p.version, document },
    });
    writer = peer(
      JSON.parse(process.env.COLLABORATION_TEST_URLS)[0],
      p.id,
      owner.cookie,
    );
    await waitFor(() => writer.provider.isSynced, "Writer synced");
    const page = await session(commenter),
      editor = page.getByRole("textbox", { name: "Document", exact: true });
    await page.goto(base + pageLink(p.id));
    await expect(editor).toHaveAttribute("contenteditable", "false");
    await selectText(page, "stable quotation");
    const toolbar = page.getByRole("toolbar", {
      name: "Selected text comments",
      exact: true,
    });
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: "Comment", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Comments", exact: true });
    await expect(panel.locator(".draft-reference blockquote")).toHaveText(
      "stable quotation",
    );
    await panel
      .getByLabel("New comment", { exact: true })
      .fill("Could we make this passage more specific before the next review?");
    await panel
      .getByRole("button", { name: "Post comment", exact: true })
      .click();
    await expect(panel.locator(".comment-body")).toHaveText(
      "Could we make this passage more specific before the next review?",
    );
    await expect(editor.locator(".comment-highlight")).toHaveText(
      "stable quotation",
    );
    const body = writer.doc.getXmlFragment("default").get(0).get(0);
    body.insert(0, "Updated introduction. ");
    await expect(editor).toContainText("Updated introduction.");
    await expect(editor.locator(".comment-highlight")).toHaveText(
      "stable quotation",
    );
    await expect(
      panel.getByText("This text has changed since the discussion started."),
    ).toHaveCount(0);
    await page.screenshot({
      path: ".local/ui-review/comment-anchors.png",
      fullPage: true,
    });
    await panel
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await editor
      .getByRole("button", { name: "Open comment thread", exact: true })
      .click();
    await expect(panel.locator(".comment-body")).toHaveCount(1);
    await panel
      .getByRole("button", { name: "Show in document", exact: true })
      .click();
    await expect(
      editor.getByRole("button", { name: "Open comment thread", exact: true }),
    ).toBeFocused();
    body.insert(body.toString().indexOf("stable") + 2, "X");
    await expect(
      panel.getByText("This text has changed since the discussion started."),
    ).toBeVisible();
    await page.reload();
    await editor
      .getByRole("button", { name: "Open comment thread", exact: true })
      .click();
    await expect(panel.locator(".comment-body")).toHaveCount(1);
    await expect(
      panel.getByText("This text has changed since the discussion started."),
    ).toBeVisible();
    const at = body.toString().indexOf("stXable quotation");
    assert.ok(at >= 0);
    body.delete(at, "stXable quotation".length);
    await expect(
      panel.getByText(
        "The original text is no longer in this document. The discussion is still available.",
      ),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Show in document", exact: true }),
    ).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "Open comment thread", exact: true }),
    ).toHaveCount(0);
    await db.query(
      "UPDATE space_members SET role='Viewer' WHERE space_id=$1 AND user_id=$2",
      [space.id, commenter.id],
    );
    await expect(page.locator(".topbar-actions > .badge")).toContainText(
      "Read-only",
      {
        timeout: 10000,
      },
    );
    await panel
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await selectText(page, "discussion");
    await expect(toolbar).toBeHidden();
    await page.keyboard.press("Control+Shift+m");
    await expect(panel).toBeHidden();
    assert.deepEqual(errors, []);
  } finally {
    writer?.destroy();
    await Promise.all(contexts.map((c) => c.close()));
    await browser.close();
    await db.end();
  }
});

test("collaboration reports every role change even when incoming frames already changed readonly state", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let client;
  try {
    const register = async () => {
        const response = await request("auth/register", {
            method: "POST",
            body: {
              email: randomUUID() + "@example.test",
              password: randomUUID(),
            },
          }),
          cookie = sessionCookie(response.response);
        return { ...(await request("auth/me", { cookie })).data, cookie };
      },
      owner = await register(),
      member = await register(),
      space = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Role changes" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Editor')", [
      space.id,
      member.id,
    ]);
    const page = (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie: owner.cookie,
        body: { title: "Live roles" },
      })
    ).data;
    client = peer(
      JSON.parse(process.env.COLLABORATION_TEST_URLS)[0],
      page.id,
      member.cookie,
    );
    const ranks = [];
    client.provider.on("stateless", ({ payload }) => {
      const message = JSON.parse(payload);
      if (message.type === "permissions") ranks.push(message.accessRank);
    });
    await waitFor(() => client.provider.isSynced, "Role client synced");
    for (const [role, rank] of [
      ["Commenter", 20],
      ["Viewer", 10],
      ["Editor", 30],
    ]) {
      await db.query(
        "UPDATE space_members SET role=$3 WHERE space_id=$1 AND user_id=$2",
        [space.id, member.id, role],
      );
      client.provider.sendStateless("role-check");
      await waitFor(
        () => ranks.includes(rank),
        "Updated role must reach the connected client: " + role,
      );
    }
    assert.deepEqual(ranks, [20, 10, 30]);
  } finally {
    client?.destroy();
    await db.end();
  }
});

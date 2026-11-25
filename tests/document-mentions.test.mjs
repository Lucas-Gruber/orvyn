import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { peer, waitFor } from "./collaboration-peer.mjs";
import {
  documentToYDoc,
  yDocToDocument,
  validateDocument,
} from "../packages/editor/dist/index.js";
import { documentPeople } from "../packages/editor/dist/mention-model.js";
const account = async () => {
  const response = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(response.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
};
async function fixture(db) {
  const owner = await account(),
    reader = await account(),
    other = await account(),
    outsider = await account(),
    space = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Team handbook" },
      })
    ).data;
  await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
  await db.query(
    "INSERT INTO space_members VALUES($1,$2,'Viewer'),($1,$3,'Editor')",
    [space.id, reader.id, other.id],
  );
  const page = (
    await request(`spaces/${space.id}/pages`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "Planning review" },
    })
  ).data;
  return { owner, reader, other, outsider, space, page };
}
const person = (id) => ({ type: "orvynPerson", attrs: { userId: id } });
const doc = (ids, text = "Please review these decisions.") => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text }, ...ids.map(person)],
    },
  ],
});
const notifications = async (user) =>
  (await request("notifications", { cookie: user.cookie })).data;

test("inline people preserve only identity references through Yjs and enforce identifiers and unique-person bounds", () => {
  const id = randomUUID(),
    json = validateDocument(doc([id, id]));
  assert.deepEqual(documentPeople(json), [id]);
  const state = documentToYDoc(json);
  try {
    assert.deepEqual(yDocToDocument(state), json);
    assert.deepEqual(documentPeople(yDocToDocument(state)), [id]);
  } finally {
    state.destroy();
  }
  for (const id of [
    null,
    "javascript:alert(1)",
    "other-user",
    "https://example.test/person",
  ])
    assert.throws(() => validateDocument(doc([id])));
  assert.throws(() =>
    validateDocument(doc(Array.from({ length: 101 }, () => randomUUID()))),
  );
  const bounded = validateDocument(
    doc(Array.from({ length: 100 }, () => randomUUID())),
  );
  assert.equal(documentPeople(bounded).length, 100);
  const attributes = validateDocument({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "orvynPerson",
            attrs: {
              userId: id,
              email: "private@example.test",
              label: "Copied name",
              url: "https://tracking.invalid",
            },
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    { ...attributes.content[0].content[0].attrs },
    { userId: id },
  );
});

test("document mention projections validate additions, preserve historical references, resolve current readers and deduplicate notifications on ordinary edits", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      path = `pages/${f.page.id}`,
      save = async (document) => {
        const current = (await request(path, { cookie: f.owner.cookie })).data;
        return request(path, {
          method: "PUT",
          cookie: f.owner.cookie,
          body: { title: current.title, version: current.version, document },
        });
      };
    const initial = await save(doc([f.reader.id, f.reader.id, f.owner.id]));
    assert.equal(initial.response.status, 200, JSON.stringify(initial.data));
    let feed = await notifications(f.reader);
    assert.equal(feed.unread, 1);
    assert.equal(feed.notifications[0].kind, "document_mention");
    assert.equal(feed.notifications[0].threadId, null);
    assert.equal(feed.notifications[0].commentId, null);
    assert.equal(
      feed.notifications[0].excerpt,
      "Please review these decisions.",
    );
    assert.equal((await notifications(f.owner)).unread, 0);
    const labels = await request(
      path +
        "/people-references?ids=" +
        [f.reader.id, f.outsider.id, f.other.id].join(","),
      { cookie: f.reader.cookie },
    );
    assert.equal(labels.response.status, 200);
    assert.deepEqual(labels.data, [
      { id: f.reader.id, displayName: f.reader.displayName },
    ]);
    assert.equal(
      (
        await request(path + "/people-references?ids=wrong", {
          cookie: f.reader.cookie,
        })
      ).response.status,
      400,
    );
    assert.equal(
      (
        await request(path + "/people-references?ids=" + f.reader.id, {
          cookie: f.outsider.cookie,
        })
      ).response.status,
      404,
    );
    assert.equal((await save(doc([f.outsider.id]))).response.status, 400);
    assert.deepEqual(
      documentPeople(
        (await request(path, { cookie: f.owner.cookie })).data.document,
      ),
      [f.reader.id, f.owner.id],
    );
    const n = feed.notifications[0];
    assert.equal(
      (
        await request("notifications/" + n.id, {
          method: "PATCH",
          cookie: f.reader.cookie,
          body: { read: true },
        })
      ).response.status,
      200,
    );
    assert.equal(
      (
        await save(
          doc([f.reader.id, f.owner.id], "A current, updated excerpt."),
        )
      ).response.status,
      200,
    );
    feed = await notifications(f.reader);
    assert.equal(feed.unread, 0);
    assert.equal(feed.notifications[0].id, n.id);
    assert.equal(feed.notifications[0].excerpt, "A current, updated excerpt.");
    const renamed = "Renamed " + randomUUID().slice(0, 8);
    await db.query("UPDATE users SET display_name=$2 WHERE id=$1", [
      f.reader.id,
      renamed,
    ]);
    assert.equal(
      (
        await request(path + "/people-references?ids=" + f.reader.id, {
          cookie: f.owner.cookie,
        })
      ).data[0].displayName,
      renamed,
    );
    assert.ok(
      !JSON.stringify(
        (await request(path, { cookie: f.owner.cookie })).data.document,
      ).includes(renamed),
    );
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.space.id, f.reader.id],
    );
    assert.equal((await notifications(f.reader)).notifications.length, 0);
    assert.deepEqual(
      (
        await request(path + "/people-references?ids=" + f.reader.id, {
          cookie: f.owner.cookie,
        })
      ).data,
      [],
    );
    assert.equal(
      (
        await save(
          doc(
            [f.reader.id, f.owner.id],
            "Keep editing with a historical reference.",
          ),
        )
      ).response.status,
      200,
    );
    assert.equal((await save(doc([]))).response.status, 200);
    assert.equal(
      (
        await db.query("SELECT 1 FROM document_people WHERE page_id=$1", [
          f.page.id,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (await save(doc([f.reader.id]))).response.status,
      400,
      "removed reader cannot be reintroduced as a new reference",
    );
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      f.space.id,
      f.reader.id,
    ]);
    assert.equal((await save(doc([f.reader.id]))).response.status, 200);
    feed = await notifications(f.reader);
    assert.equal(feed.unread, 1);
    assert.notEqual(feed.notifications[0].id, n.id);
  } finally {
    await db.end();
  }
});

test("collaboration projects inline mentions atomically across replicas and refuses new inaccessible identities without persisting or broadcasting them", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    clients = [];
  try {
    const f = await fixture(db),
      urls = JSON.parse(process.env.COLLABORATION_TEST_URLS),
      writer = peer(urls[0], f.page.id, f.owner.cookie),
      reader = peer(urls[1], f.page.id, f.reader.cookie);
    clients.push(writer, reader);
    await waitFor(
      () => writer.provider.isSynced && reader.provider.isSynced,
      "Both replicas initialized",
    );
    const paragraph = writer.doc.getXmlFragment("default").get(0),
      text = new Y.XmlText("Review with "),
      mention = new Y.XmlElement("orvynPerson");
    mention.setAttribute("userId", f.reader.id);
    writer.doc.transact(() => paragraph.insert(0, [text, mention]));
    await waitFor(
      () =>
        !writer.provider.hasUnsyncedChanges &&
        documentPeople(yDocToDocument(reader.doc)).includes(f.reader.id),
      "Mention durably saved and replicated",
    );
    let feed = await notifications(f.reader);
    assert.equal(feed.unread, 1);
    const id = feed.notifications[0].id;
    const duplicate = new Y.XmlElement("orvynPerson");
    duplicate.setAttribute("userId", f.reader.id);
    paragraph.insert(paragraph.length, [duplicate]);
    await waitFor(
      () => !writer.provider.hasUnsyncedChanges,
      "Duplicate reference saved",
    );
    assert.equal((await notifications(f.reader)).notifications.length, 1);
    assert.equal((await notifications(f.reader)).notifications[0].id, id);
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      f.page.id,
    ]);
    await waitFor(
      () => reader.closed || reader.rejected,
      "Reader actively revoked",
    );
    text.insert(text.length, "Still editable ");
    await waitFor(
      () => !writer.provider.hasUnsyncedChanges,
      "Unchanged historical reference remains editable",
    );
    assert.equal((await notifications(f.reader)).unread, 0);
    const rejected = new Y.XmlElement("orvynPerson");
    rejected.setAttribute("userId", f.other.id);
    paragraph.insert(paragraph.length, [rejected]);
    await waitFor(
      () => writer.closed || writer.rejected,
      "New inaccessible recipient rejected",
    );
    const stored = (
      await request("pages/" + f.page.id, { cookie: f.owner.cookie })
    ).data.document;
    assert.deepEqual(documentPeople(stored), [f.reader.id]);
    assert.ok(JSON.stringify(stored).includes("Still editable"));
    assert.equal((await notifications(f.other)).notifications.length, 0);
  } finally {
    clients.forEach((client) => client.destroy());
    await db.end();
  }
});

test("Chromium: type @ and choose an inline person, reload/live readers resolve names, inbox focuses the mention and revoked recipients become unavailable", async () => {
  const { chromium, expect } = await import("./browser-tools.mjs"),
    { mkdir } = await import("node:fs/promises"),
    { pageLink } = await import("../packages/editor/dist/links.js"),
    db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    }),
    contexts = [],
    errors = [];
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
    page.on("pageerror", (e) => errors.push(e.message));
    return page;
  }
  try {
    await mkdir(".local/ui-review", { recursive: true });
    const f = await fixture(db);
    await request("pages/" + f.page.id, {
      method: "PUT",
      cookie: f.owner.cookie,
      body: {
        title: f.page.title,
        version: f.page.version,
        document: doc([], "Invite a reviewer: "),
      },
    });
    const owner = await session(f.owner),
      reader = await session(f.reader),
      editor = owner.getByRole("textbox", { name: "Document", exact: true });
    await owner.goto(base + pageLink(f.page.id));
    await expect(editor).toHaveAttribute("contenteditable", "true", {
      timeout: 12000,
    });
    await editor.locator("p").last().click();
    await owner.keyboard.press("End");
    await owner.keyboard.type(" @" + f.reader.displayName);
    const picker = owner.getByRole("listbox", {
      name: "Mention a page reader",
      exact: true,
    });
    await expect(
      picker.getByRole("option", { name: f.reader.displayName, exact: false }),
    ).toBeVisible();
    await owner.keyboard.press("ArrowDown");
    await owner.keyboard.press("Enter");
    await expect(editor.locator(".editor-person")).toContainText(
      f.reader.displayName,
    );
    await expect(
      owner.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    const stored = (
      await request("pages/" + f.page.id, { cookie: f.owner.cookie })
    ).data.document;
    assert.deepEqual(documentPeople(stored), [f.reader.id]);
    assert.ok(!JSON.stringify(stored).includes(f.reader.email));
    await reader.goto(base + pageLink(f.page.id));
    const readEditor = reader.getByRole("textbox", {
      name: "Document",
      exact: true,
    });
    await expect(readEditor).toHaveAttribute("contenteditable", "false", {
      timeout: 12000,
    });
    await expect(readEditor.locator(".editor-person")).toContainText(
      f.reader.displayName,
    );
    await reader
      .getByRole("button", { name: "Notifications", exact: true })
      .click();
    const inbox = reader.getByRole("dialog", { name: "Inbox", exact: true });
    await expect(inbox.locator(".inbox-item")).toContainText(
      "mentioned you in a document",
    );
    await inbox.locator(".inbox-item").click();
    await expect(readEditor.locator(".editor-person")).toHaveAttribute(
      "data-mention-target",
      "",
    );
    await expect(readEditor.locator(".editor-person")).toBeFocused();
    await owner.screenshot({
      path: ".local/ui-review/document-mentions.png",
      fullPage: true,
    });
    await owner.reload();
    await expect(editor.locator(".editor-person")).toContainText(
      f.reader.displayName,
    );
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      f.page.id,
    ]);
    await expect(editor.locator(".editor-person")).toContainText(
      "Person unavailable",
      { timeout: 10000 },
    );
    await editor.locator("p").last().click();
    await owner.keyboard.press("End");
    await owner.keyboard.type(" Still editable.");
    await expect(
      owner.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    assert.ok(
      JSON.stringify(
        (await request("pages/" + f.page.id, { cookie: f.owner.cookie })).data
          .document,
      ).includes("Still editable."),
    );
    await owner.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await owner.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    assert.deepEqual(errors, []);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
    await browser.close();
    await db.end();
  }
});

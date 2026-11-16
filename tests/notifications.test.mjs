import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
const account = async () => {
  const result = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(result.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
};
async function fixture(db) {
  const owner = await account(),
    author = await account(),
    reader = await account(),
    outsider = await account(),
    space = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Project reviews" },
      })
    ).data;
  await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
  await db.query(
    "INSERT INTO space_members VALUES($1,$2,'Commenter'),($1,$3,'Viewer')",
    [space.id, author.id, reader.id],
  );
  const page = (
    await request(`spaces/${space.id}/pages`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "Review decisions" },
    })
  ).data;
  return { owner, author, reader, outsider, space, page };
}
const feed = async (user, query = "") =>
  request("notifications" + query, { cookie: user.cookie });
const create = async (f, body, mentions = [], requestId = randomUUID()) =>
  request(`pages/${f.page.id}/threads`, {
    method: "POST",
    cookie: f.author.cookie,
    body: { body, mentions, requestId },
  });

test("comment mentions validate current readers, persist chosen identities and notify exactly once across retries, edits and replies", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      body = `Please check this, @${f.reader.email}.`,
      key = randomUUID(),
      created = await create(f, body, [f.reader.id, f.reader.id], key);
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    const message = created.data.messages[0],
      id = created.data.thread.id;
    assert.deepEqual(message.mentions, [
      { id: f.reader.id, email: f.reader.email },
    ]);
    const initial = (await feed(f.reader)).data;
    assert.equal(initial.unread, 1);
    assert.equal(initial.notifications.length, 1);
    assert.equal(initial.notifications[0].kind, "comment_mention");
    assert.equal(
      (await create(f, body, [f.reader.id], key)).response.status,
      201,
    );
    assert.equal((await feed(f.reader)).data.unread, 1);
    assert.equal((await create(f, body, [], key)).response.status, 409);
    assert.equal((await feed(f.author)).data.unread, 0);
    for (const [text, ids] of [
      [body, [f.outsider.id]],
      ["No mention label", [f.reader.id]],
      [body, [randomUUID()]],
    ])
      assert.equal((await create(f, text, ids)).response.status, 400);
    assert.equal(
      (
        await create(
          f,
          "Too many",
          Array.from({ length: 21 }, () => randomUUID()),
        )
      ).response.status,
      400,
    );
    const people = await request(`pages/${f.page.id}/mention-people`, {
      cookie: f.author.cookie,
    });
    assert.equal(people.response.status, 200);
    assert.ok(people.data.some((p) => p.id === f.reader.id));
    assert.ok(!people.data.some((p) => p.id === f.outsider.id));
    assert.equal(
      (
        await request(`pages/${f.page.id}/mention-people`, {
          cookie: f.reader.cookie,
        })
      ).response.status,
      404,
    );
    const notification = initial.notifications[0],
      marked = await request("notifications/" + notification.id, {
        method: "PATCH",
        cookie: f.reader.cookie,
        body: { read: true },
      });
    assert.equal(marked.response.status, 200);
    assert.ok(marked.data.readAt);
    assert.equal((await feed(f.reader)).data.unread, 0);
    const edit = async (text, ids, version) =>
      request("comments/" + message.id, {
        method: "PATCH",
        cookie: f.author.cookie,
        body: { body: text, mentions: ids, version },
      });
    const edited = await edit(
      body + " Updated.",
      [f.reader.id],
      message.version,
    );
    assert.equal(edited.response.status, 200);
    assert.equal(
      (await feed(f.reader)).data.unread,
      0,
      "unchanged mention does not notify again",
    );
    assert.match(
      (await feed(f.reader)).data.notifications[0].excerpt,
      /Updated/,
    );
    const removed = await edit(
      "No longer addressed to anyone.",
      [],
      edited.data.messages[0].version,
    );
    assert.equal(removed.response.status, 200);
    assert.equal((await feed(f.reader)).data.notifications.length, 0);
    const readded = await edit(
      body,
      [f.reader.id],
      removed.data.messages[0].version,
    );
    assert.equal(readded.response.status, 200);
    assert.equal((await feed(f.reader)).data.unread, 1);
    const self = await create(f, `A note to @${f.author.email}`, [f.author.id]);
    assert.equal(self.response.status, 201);
    assert.equal((await feed(f.author)).data.unread, 0);
    const response = await request(`threads/${id}/comments`, {
      method: "POST",
      cookie: f.owner.cookie,
      body: {
        body: `Thanks, @${f.author.email}.`,
        mentions: [f.author.id],
        requestId: randomUUID(),
      },
    });
    assert.equal(response.response.status, 201, JSON.stringify(response.data));
    const authorFeed = (await feed(f.author)).data;
    assert.equal(authorFeed.unread, 1);
    assert.equal(
      authorFeed.notifications[0].kind,
      "comment_mention",
      "mention supersedes participant reply",
    );
    const reply = await request(`threads/${id}/comments`, {
      method: "POST",
      cookie: f.author.cookie,
      body: { body: "Confirmed.", requestId: randomUUID() },
    });
    assert.equal(reply.response.status, 201);
    assert.equal(
      (await feed(f.owner)).data.notifications[0].kind,
      "thread_reply",
    );
    assert.equal(
      (await feed(f.reader)).data.unread,
      1,
      "being mentioned does not subscribe a reader to every future reply",
    );
    const deleted = await request("comments/" + message.id, {
      method: "DELETE",
      cookie: f.author.cookie,
      body: { version: readded.data.messages[0].version },
    });
    assert.equal(deleted.response.status, 200);
    assert.equal((await feed(f.reader)).data.notifications.length, 0);
  } finally {
    await db.end();
  }
});

test("notification counts, pagination and read actions use current permissions and live sources across restriction, trash, membership and deletion", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      path = `pages/${f.page.id}`,
      first = await create(f, `First @${f.reader.email}`, [f.reader.id]),
      second = await create(f, `Second @${f.reader.email}`, [f.reader.id]);
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);
    const a = (await feed(f.reader, "?limit=1")).data;
    assert.equal(a.unread, 2);
    assert.ok(a.nextBefore);
    const b = (await feed(f.reader, "?limit=1&before=" + a.nextBefore)).data;
    assert.equal(b.notifications.length, 1);
    assert.notEqual(a.notifications[0].id, b.notifications[0].id);
    assert.equal(b.nextBefore, "");
    const hidden = a.notifications[0].id;
    assert.equal(
      (
        await request("notifications/" + hidden, {
          method: "PATCH",
          cookie: f.outsider.cookie,
          body: { read: true },
        })
      ).response.status,
      404,
    );
    assert.equal(
      (await feed(f.outsider, "?before=" + hidden)).data.notifications.length,
      0,
    );
    assert.equal(
      (
        await request("notifications/" + hidden, {
          method: "PATCH",
          cookie: f.reader.cookie,
          origin: "https://elsewhere.invalid",
          body: { read: true },
        })
      ).response.status,
      403,
    );
    const p = (await request(path, { cookie: f.owner.cookie })).data;
    assert.equal(
      (
        await request(path + "/title", {
          method: "PATCH",
          cookie: f.owner.cookie,
          body: {
            title: "Current title, never a cached copy",
            titleVersion: p.title_version,
          },
        })
      ).response.status,
      200,
    );
    assert.equal(
      (await feed(f.reader)).data.notifications[0].title,
      "Current title, never a cached copy",
    );
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      f.page.id,
    ]);
    assert.deepEqual((await feed(f.reader)).data, {
      notifications: [],
      nextBefore: "",
      unread: 0,
    });
    assert.equal(
      (
        await request("notifications/" + hidden, {
          method: "PATCH",
          cookie: f.reader.cookie,
          body: { read: true },
        })
      ).response.status,
      404,
    );
    assert.equal(
      (
        await request("notifications/read-all", {
          method: "POST",
          cookie: f.reader.cookie,
          body: {},
        })
      ).response.status,
      201,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM notifications WHERE recipient_id=$1 AND read_at IS NULL",
          [f.reader.id],
        )
      ).rows[0].n,
      2,
      "mark all does not touch inaccessible notifications",
    );
    await db.query("UPDATE pages SET visibility='space' WHERE id=$1", [
      f.page.id,
    ]);
    await db.query("UPDATE pages SET deleted_at=now() WHERE id=$1", [
      f.page.id,
    ]);
    assert.equal((await feed(f.reader)).data.unread, 0);
    await db.query("UPDATE pages SET deleted_at=NULL WHERE id=$1", [f.page.id]);
    assert.equal((await feed(f.reader)).data.unread, 2);
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.space.id, f.reader.id],
    );
    assert.equal((await feed(f.reader)).data.unread, 0);
    assert.equal(
      (await create(f, `Cannot notify @${f.reader.email}`, [f.reader.id]))
        .response.status,
      400,
    );
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      f.space.id,
      f.reader.id,
    ]);
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.space.id, f.author.id],
    );
    assert.equal(
      (await feed(f.reader)).data.notifications[0].actor.email,
      null,
    );
    assert.equal(
      (
        await request("notifications/read-all", {
          method: "POST",
          cookie: f.reader.cookie,
          body: {},
        })
      ).response.status,
      201,
    );
    assert.equal(
      (await feed(f.reader, "?state=unread")).data.notifications.length,
      0,
    );
    assert.equal((await feed(f.reader, "?limit=0")).response.status, 400);
    assert.equal(
      (await feed(f.reader, "?before=invalid")).response.status,
      400,
    );
    assert.equal((await feed(f.reader, "?state=hidden")).response.status, 400);
    await db.query(
      "UPDATE comments SET body=NULL,deleted_at=now() WHERE thread_id=ANY($1::uuid[])",
      [[first.data.thread.id, second.data.thread.id]],
    );
    assert.equal((await feed(f.reader)).data.notifications.length, 0);
  } finally {
    await db.end();
  }
});

test("Chromium: @ chooser sends a mention, inbox opens the current discussion, read controls persist and replies notify participants", async () => {
  const { chromium, expect } = await import("@playwright/test"),
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
    const f = await fixture(db),
      owner = await session(f.owner),
      reviewer = await session(f.author);
    await owner.goto(base + pageLink(f.page.id));
    await owner.getByRole("button", { name: "Comments", exact: true }).click();
    const panel = owner.getByRole("dialog", { name: "Comments", exact: true });
    await panel
      .getByLabel("New comment", { exact: true })
      .fill("Please review @" + f.author.email.split("@")[0]);
    await expect(
      panel.getByRole("option", { name: f.author.email, exact: false }),
    ).toBeVisible();
    await panel.getByLabel("New comment", { exact: true }).press("ArrowDown");
    await panel.getByLabel("New comment", { exact: true }).press("Enter");
    await expect(panel.getByLabel("New comment", { exact: true })).toHaveValue(
      "Please review @" + f.author.email + " ",
    );
    await panel
      .getByRole("button", { name: "Post comment", exact: true })
      .click();
    await expect(panel.locator(".comment-body")).toHaveText(
      "Please review @" + f.author.email,
    );
    await reviewer.goto(base + pageLink(f.page.id));
    await expect(
      reviewer.getByLabel("Unread notifications", { exact: true }),
    ).toHaveText("1");
    await reviewer
      .getByRole("button", { name: "Notifications", exact: true })
      .click();
    const inbox = reviewer.getByRole("dialog", { name: "Inbox", exact: true });
    await expect(inbox.locator(".inbox-item")).toHaveCount(1);
    await expect(inbox.locator(".inbox-item")).toContainText(
      "mentioned you in a comment",
    );
    await reviewer.screenshot({
      path: ".local/ui-review/notifications-inbox.png",
      fullPage: true,
    });
    await inbox.getByRole("button", { name: "Mark read", exact: true }).click();
    await expect(
      inbox.getByRole("button", { name: "Mark unread", exact: true }),
    ).toBeVisible();
    await inbox
      .getByRole("button", { name: "Mark unread", exact: true })
      .click();
    await inbox.locator(".inbox-item").click();
    const reviewPanel = reviewer.getByRole("dialog", {
      name: "Comments",
      exact: true,
    });
    await expect(reviewPanel.locator(".comment-body")).toHaveCount(1);
    await reviewPanel
      .getByLabel("Reply", { exact: true })
      .fill("Reviewed. The decisions are ready for the team.");
    await reviewPanel
      .getByRole("button", { name: "Send reply", exact: true })
      .click();
    await expect(reviewPanel.locator(".comment-body")).toHaveCount(2);
    await owner
      .getByRole("button", { name: "Notifications", exact: true })
      .click();
    const ownInbox = owner.getByRole("dialog", { name: "Inbox", exact: true });
    await expect(ownInbox.locator(".inbox-item")).toContainText(
      "replied to your discussion",
    );
    await ownInbox
      .getByRole("button", { name: "Mark all read", exact: true })
      .click();
    await expect(
      ownInbox.getByRole("button", { name: "Mark all read", exact: true }),
    ).toBeDisabled();
    await owner.reload();
    await owner
      .getByRole("button", { name: "Notifications", exact: true })
      .click();
    await expect(
      ownInbox.getByRole("button", { name: "Mark unread", exact: true }),
    ).toBeVisible();
    await reviewer.setViewportSize({ width: 390, height: 844 });
    await reviewPanel
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await reviewer
      .getByRole("button", { name: "Toggle sidebar", exact: true })
      .click();
    await reviewer
      .getByRole("button", { name: "Notifications", exact: true })
      .click();
    await expect(inbox).toBeVisible();
    assert.ok(
      await reviewer.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      f.page.id,
    ]);
    await inbox.locator(".inbox-item").click();
    await expect(inbox.locator(".inbox-item")).toHaveCount(0);
    await expect(inbox.getByRole("alert")).toHaveText("Notification not found");
    await expect(
      reviewer.getByLabel("Unread notifications", { exact: true }),
    ).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await browser.close();
    await db.end();
  }
});

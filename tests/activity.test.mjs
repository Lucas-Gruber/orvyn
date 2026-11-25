import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { peer, waitFor } from "./collaboration-peer.mjs";
import * as Y from "yjs";
const account = async (name = "member") => {
  const result = await request("auth/register", {
      method: "POST",
      body: {
        email: name + "-" + randomUUID().slice(0, 12) + "@example.test",
        password: randomUUID(),
      },
    }),
    cookie = sessionCookie(result.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
};
async function fixture(db) {
  const owner = await account("alex"),
    editor = await account("sam"),
    viewer = await account("jules"),
    admin = await account("morgan"),
    outsider = await account("outside"),
    space = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Product team" },
      })
    ).data;
  await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
  await db.query(
    "INSERT INTO space_members VALUES($1,$2,'Editor'),($1,$3,'Viewer'),($1,$4,'Admin')",
    [space.id, editor.id, viewer.id, admin.id],
  );
  const page = (
    await request(`spaces/${space.id}/pages`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "Release decisions" },
    })
  ).data;
  return { owner, editor, viewer, admin, outsider, space, page };
}
const feed = async (f, user, query = "") =>
  request(`spaces/${f.space.id}/activity` + query, { cookie: user.cookie });
const doc = (text) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

test("activity records committed page/discussion actions without bodies, coalesces document edits, paginates scoped events and resolves current titles", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      path = "pages/" + f.page.id;
    assert.equal((await feed(f, f.outsider)).response.status, 404);
    assert.equal(
      (await request(`spaces/${f.space.id}/activity`)).response.status,
      401,
    );
    let items = (await feed(f, f.viewer)).data.events;
    assert.ok(items.some((e) => e.kind === "space.created"));
    assert.ok(
      items.some((e) => e.kind === "page.created" && e.pageId === f.page.id),
    );
    for (let i = 0; i < 5; i++) {
      const page = (await request(path, { cookie: f.owner.cookie })).data;
      const result = await request(path, {
        method: "PUT",
        cookie: f.owner.cookie,
        body: {
          title: page.title,
          version: page.version,
          document: doc("Source-only document body " + i),
        },
      });
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
    }
    const edits = (
      await db.query(
        "SELECT * FROM activity_events WHERE page_id=$1 AND kind='page.updated'",
        [f.page.id],
      )
    ).rows;
    assert.ok(
      edits.length >= 1 && edits.length <= 2,
      "same actor's edits share five-minute windows",
    );
    assert.ok(edits.some((e) => e.updated_at > e.created_at));
    const current = (await request(path, { cookie: f.owner.cookie })).data;
    assert.equal(
      (
        await request(path + "/title", {
          method: "PATCH",
          cookie: f.owner.cookie,
          body: {
            title: "Final release decisions",
            titleVersion: current.title_version,
          },
        })
      ).response.status,
      200,
    );
    const before = (
      await db.query(
        "SELECT count(*)::int AS n FROM activity_events WHERE page_id=$1",
        [f.page.id],
      )
    ).rows[0].n;
    assert.equal(
      (
        await request(path + "/title", {
          method: "PATCH",
          cookie: f.owner.cookie,
          body: {
            title: "A stale rename",
            titleVersion: current.title_version,
          },
        })
      ).response.status,
      409,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM activity_events WHERE page_id=$1",
          [f.page.id],
        )
      ).rows[0].n,
      before,
    );
    const thread = await request(path + "/threads", {
      method: "POST",
      cookie: f.editor.cookie,
      body: { body: "A source-only comment body.", requestId: randomUUID() },
    });
    assert.equal(thread.response.status, 201);
    assert.equal(
      (
        await request("threads/" + thread.data.thread.id, {
          method: "PATCH",
          cookie: f.editor.cookie,
          body: { version: thread.data.thread.version, resolved: true },
        })
      ).response.status,
      200,
    );
    items = (await feed(f, f.viewer)).data.events;
    assert.ok(items.some((e) => e.kind === "comment.thread_created"));
    assert.ok(items.some((e) => e.kind === "comment.resolved"));
    assert.ok(
      items
        .filter((e) => e.pageId === f.page.id)
        .every((e) => e.title === "Final release decisions"),
    );
    assert.ok(!JSON.stringify(items).includes("Source-only document body"));
    assert.ok(!JSON.stringify(items).includes("source-only comment body"));
    const seen = [],
      query = "?page=" + f.page.id + "&limit=2";
    let cursor = "";
    do {
      const response = await feed(
        f,
        f.viewer,
        query + (cursor ? "&before=" + cursor : ""),
      );
      assert.equal(response.response.status, 200);
      assert.ok(response.data.events.every((e) => e.pageId === f.page.id));
      seen.push(...response.data.events.map((e) => e.id));
      cursor = response.data.nextBefore;
    } while (cursor);
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(
      seen.length,
      items.filter((e) => e.pageId === f.page.id).length,
    );
    assert.equal((await feed(f, f.viewer, "?before=bad")).response.status, 400);
    assert.equal((await feed(f, f.viewer, "?limit=0")).response.status, 400);
    assert.equal((await feed(f, f.viewer, "?page=bad")).response.status, 400);
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.space.id, f.editor.id],
    );
    const prior = (await feed(f, f.owner)).data.events.find(
      (e) => e.kind === "comment.thread_created",
    );
    assert.equal(prior.actor.displayName, null);
  } finally {
    await db.end();
  }
});

test("activity hides private records, administrative changes and lost/trash sources without leaking cursor positions", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      secret = (
        await request(`spaces/${f.space.id}/pages`, {
          method: "POST",
          cookie: f.owner.cookie,
          body: { title: "Private acquisition plan", visibility: "restricted" },
        })
      ).data;
    assert.equal(
      (
        await request(`pages/${secret.id}/permissions`, {
          method: "PUT",
          cookie: f.owner.cookie,
          body: {
            version: secret.version,
            visibility: "restricted",
            grants: [],
            confirm: true,
          },
        })
      ).response.status,
      200,
    );
    const privateEvent = (await feed(f, f.owner)).data.events.find(
      (e) => e.pageId === secret.id,
    );
    assert.ok(privateEvent);
    assert.ok(
      !(await feed(f, f.viewer)).data.events.some(
        (e) => e.pageId === secret.id,
      ),
    );
    assert.equal(
      (await feed(f, f.viewer, "?page=" + secret.id)).response.status,
      404,
    );
    assert.deepEqual(
      (await feed(f, f.viewer, "?before=" + privateEvent.id)).data.events,
      [],
    );
    assert.equal(
      (
        await request(`spaces/${f.space.id}/members/${f.editor.id}`, {
          method: "PUT",
          cookie: f.owner.cookie,
          body: { role: "Commenter" },
        })
      ).response.status,
      200,
    );
    assert.ok(
      (await feed(f, f.admin)).data.events.some(
        (e) => e.kind === "space.member_role_changed",
      ),
    );
    assert.ok(
      !(await feed(f, f.viewer)).data.events.some(
        (e) => e.kind === "space.member_role_changed",
      ),
    );
    const database = (
      await request(`spaces/${f.space.id}/databases`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: { name: "Deliveries" },
      })
    ).data;
    assert.ok(database.id);
    const visibleBefore = (await feed(f, f.viewer)).data.events.map(
      (e) => e.id,
    );
    const record = (
      await request(`databases/${database.id}/records`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: {
          title: "Private supplier agreement",
          visibility: "restricted",
          values: {},
        },
      })
    ).data;
    assert.ok(record.pageId, JSON.stringify(record));
    const change = await request(
      `databases/${database.id}/records/${record.pageId}`,
      {
        method: "PATCH",
        cookie: f.owner.cookie,
        body: {
          version: record.version,
          values: {
            [database.properties.find((p) => p.type === "Status").id]:
              database.properties.find((p) => p.type === "Status").config
                .options[0].id,
          },
        },
      },
    );
    assert.equal(change.response.status, 200, JSON.stringify(change.data));
    assert.deepEqual(
      (await feed(f, f.viewer)).data.events.map((e) => e.id),
      visibleBefore,
      "private record actions do not announce activity on the parent database",
    );
    assert.ok(
      (await feed(f, f.owner)).data.events.some(
        (e) =>
          e.pageId === record.pageId && e.kind === "database.record_updated",
      ),
    );
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      f.page.id,
    ]);
    assert.ok(
      !(await feed(f, f.viewer)).data.events.some(
        (e) => e.pageId === f.page.id,
      ),
    );
    await db.query(
      "UPDATE pages SET visibility='space',deleted_at=now() WHERE id=$1",
      [f.page.id],
    );
    assert.ok(
      !(await feed(f, f.viewer)).data.events.some(
        (e) => e.pageId === f.page.id,
      ),
    );
    await db.query("UPDATE pages SET deleted_at=NULL WHERE id=$1", [f.page.id]);
    assert.ok(
      (await feed(f, f.viewer)).data.events.some((e) => e.pageId === f.page.id),
    );
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.space.id, f.viewer.id],
    );
    assert.equal((await feed(f, f.viewer)).response.status, 404);
  } finally {
    await db.end();
  }
});

test("collaboration records each actor's durable edits across replicas and rejected updates leave no activity", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    clients = [];
  try {
    const f = await fixture(db),
      urls = JSON.parse(process.env.COLLABORATION_TEST_URLS),
      editor = peer(urls[0], f.page.id, f.editor.cookie),
      owner = peer(urls[1], f.page.id, f.owner.cookie);
    clients.push(editor, owner);
    await waitFor(
      () => editor.provider.isSynced && owner.provider.isSynced,
      "Both collaborators synced",
    );
    const paragraph = editor.doc.getXmlFragment("default").get(0),
      text = new Y.XmlText("Reviewed decisions");
    paragraph.insert(0, [text]);
    await waitFor(
      () => !editor.provider.hasUnsyncedChanges,
      "First edit durable",
    );
    for (let i = 0; i < 4; i++) {
      text.insert(text.length, ".");
      await waitFor(
        () => !editor.provider.hasUnsyncedChanges,
        "Edit durably acknowledged",
      );
    }
    const other = owner.doc.getXmlFragment("default").get(0).get(0);
    other.insert(other.length, " Accepted.");
    await waitFor(
      () => !owner.provider.hasUnsyncedChanges,
      "Other actor saved",
    );
    const rows = (
      await db.query(
        "SELECT actor_id,count(*)::int AS n FROM activity_events WHERE page_id=$1 AND kind='page.updated' GROUP BY actor_id",
        [f.page.id],
      )
    ).rows;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.n >= 1 && row.n <= 2));
    const before = (
      await db.query(
        "SELECT count(*)::int AS n FROM activity_events WHERE page_id=$1",
        [f.page.id],
      )
    ).rows[0].n;
    const invalid = new Y.XmlElement("orvynPerson");
    invalid.setAttribute("userId", f.outsider.id);
    paragraph.insert(paragraph.length, [invalid]);
    await waitFor(
      () => editor.closed || editor.rejected,
      "Invalid addition rejected",
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM activity_events WHERE page_id=$1",
          [f.page.id],
        )
      ).rows[0].n,
      before,
    );
    const events = (await feed(f, f.viewer, "?page=" + f.page.id)).data.events;
    assert.ok(
      events.some(
        (e) => e.kind === "page.updated" && e.actor.id === f.editor.id,
      ),
    );
    assert.ok(
      events.some(
        (e) => e.kind === "page.updated" && e.actor.id === f.owner.id,
      ),
    );
  } finally {
    clients.forEach((client) => client.destroy());
    await db.end();
  }
});

test("Chromium: activity shows real edits/discussions, scopes to a page, opens pages, fits mobile and clears revoked content", async () => {
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
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    return page;
  }
  try {
    await mkdir(".local/ui-review", { recursive: true });
    const f = await fixture(db),
      owner = await session(f.owner),
      reader = await session(f.viewer),
      editor = owner.getByRole("textbox", { name: "Document", exact: true });
    await owner.goto(base + pageLink(f.page.id));
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await editor.click();
    await owner.keyboard.type(
      "We keep release decisions and review notes together.",
    );
    await expect(
      owner.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await owner.getByRole("button", { name: "Comments", exact: true }).click();
    const comments = owner.getByRole("dialog", {
      name: "Comments",
      exact: true,
    });
    await comments
      .getByLabel("New comment", { exact: true })
      .fill("The release checklist is ready for review.");
    await comments
      .getByRole("button", { name: "Post comment", exact: true })
      .click();
    await expect(comments.locator(".comment-body")).toHaveCount(1);
    await owner.getByRole("button", { name: "Activity", exact: true }).click();
    const activity = owner.getByRole("dialog", {
      name: "Space activity",
      exact: true,
    });
    await expect(
      activity.getByText("Started a discussion", { exact: true }),
    ).toBeVisible();
    await expect(
      activity.getByText("Edited the document", { exact: true }),
    ).toBeVisible();
    await expect(
      activity.getByText("Created a page", { exact: true }),
    ).toBeVisible();
    await owner.screenshot({
      path: ".local/ui-review/activity-history.png",
      fullPage: true,
    });
    await activity
      .getByRole("button", { name: f.page.title, exact: true })
      .first()
      .click();
    await expect(activity).toBeHidden();
    await expect(
      owner.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue(f.page.title);
    await reader.goto(base + pageLink(f.page.id));
    await reader
      .getByRole("button", { name: "Page actions", exact: true })
      .click();
    await reader
      .getByRole("menuitem", { name: "Page activity", exact: true })
      .click();
    const pageActivity = reader.getByRole("dialog", {
      name: "Page activity",
      exact: true,
    });
    await expect(
      pageActivity.getByText("Started a discussion", { exact: true }),
    ).toBeVisible();
    await expect(
      pageActivity.getByText("Created this space", { exact: true }),
    ).toHaveCount(0);
    await reader.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await reader.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      f.page.id,
    ]);
    await pageActivity
      .getByRole("button", { name: "Refresh activity", exact: true })
      .click();
    await expect(pageActivity.locator(".activity-events li")).toHaveCount(0);
    await expect(pageActivity.getByRole("alert")).toHaveText("Page not found");
    assert.deepEqual(errors, []);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
    await browser.close();
    await db.end();
  }
});

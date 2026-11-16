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
async function fixture(db) {
  const owner = await account(),
    editor = await account(),
    commenter = await account(),
    viewer = await account(),
    outsider = await account(),
    space = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Discussion workspace" },
      })
    ).data;
  await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
  await db.query(
    "INSERT INTO space_members VALUES($1,$2,'Commenter'),($1,$3,'Viewer'),($1,$4,'Editor')",
    [space.id, commenter.id, viewer.id, editor.id],
  );
  const page = (
    await request(`spaces/${space.id}/pages`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "Team discussion" },
    })
  ).data;
  return { owner, editor, commenter, viewer, outsider, space, page };
}
const comment = (body) => ({ body, requestId: randomUUID() });
const detail = async (id, user) =>
  request("threads/" + id, { cookie: user.cookie });
test("page threads enforce commenter/author/moderator roles, idempotency, edit conflicts, resolution and inherited privacy", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      path = `pages/${f.page.id}/threads`,
      input = comment("A <script> stays literal, with a real discussion."),
      created = await request(path, {
        method: "POST",
        cookie: f.commenter.cookie,
        body: input,
      });
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    const id = created.data.thread.id,
      first = created.data.messages[0];
    assert.equal(created.data.accessRank, 20);
    assert.ok(first.canEdit && first.canDelete);
    assert.ok(created.data.thread.canResolve);
    assert.equal(
      (
        await request(path, {
          method: "POST",
          cookie: f.commenter.cookie,
          body: input,
        })
      ).data.thread.id,
      id,
    );
    assert.equal(
      (await db.query("SELECT id FROM comments WHERE thread_id=$1", [id]))
        .rowCount,
      1,
    );
    assert.equal(
      (
        await request(path, {
          method: "POST",
          cookie: f.commenter.cookie,
          body: { ...input, body: "Changed retry" },
        })
      ).response.status,
      409,
    );
    for (const user of [f.viewer, f.outsider])
      assert.equal(
        (
          await request(path, {
            method: "POST",
            cookie: user.cookie,
            body: comment("Forbidden"),
          })
        ).response.status,
        404,
      );
    assert.equal(
      (await request(path, { method: "POST", body: comment("Anonymous") }))
        .response.status,
      401,
    );
    const reader = await detail(id, f.viewer);
    assert.equal(reader.response.status, 200);
    assert.equal(reader.data.accessRank, 10);
    assert.ok(!reader.data.thread.canResolve);
    assert.ok(
      !reader.data.messages[0].canEdit && !reader.data.messages[0].canDelete,
    );
    const reply = await request(`threads/${id}/comments`, {
      method: "POST",
      cookie: f.owner.cookie,
      body: comment("A reply from the page owner."),
    });
    assert.equal(reply.response.status, 201);
    assert.equal(reply.data.thread.replyCount, 1);
    const other = reply.data.messages.find((m) => m.author.id === f.owner.id);
    assert.equal(
      (
        await request(`comments/${other.id}`, {
          method: "DELETE",
          cookie: f.commenter.cookie,
          body: { version: other.version },
        })
      ).response.status,
      403,
    );
    assert.equal(
      (
        await request(`comments/${first.id}`, {
          method: "PATCH",
          cookie: f.owner.cookie,
          body: {
            version: first.version,
            body: "Cannot impersonate the author",
          },
        })
      ).response.status,
      403,
    );
    const changes = await Promise.all(
      ["First revision", "Other revision"].map((body) =>
        request(`comments/${first.id}`, {
          method: "PATCH",
          cookie: f.commenter.cookie,
          body: { version: first.version, body },
        }),
      ),
    );
    assert.deepEqual(changes.map((r) => r.response.status).sort(), [200, 409]);
    let current = (await detail(id, f.commenter)).data;
    assert.equal(
      (
        await request(`threads/${id}`, {
          method: "PATCH",
          cookie: f.commenter.cookie,
          body: { version: created.data.thread.version, resolved: true },
        })
      ).response.status,
      409,
    );
    const resolved = await request(`threads/${id}`, {
      method: "PATCH",
      cookie: f.commenter.cookie,
      body: { version: current.thread.version, resolved: true },
    });
    assert.equal(resolved.response.status, 200);
    assert.ok(resolved.data.thread.resolvedAt);
    assert.equal(
      (
        await request(`threads/${id}/comments`, {
          method: "POST",
          cookie: f.owner.cookie,
          body: comment("Cannot reply into a closed thread"),
        })
      ).response.status,
      409,
    );
    assert.equal(
      (await request(path, { cookie: f.viewer.cookie })).data.threads.length,
      0,
    );
    assert.equal(
      (await request(path + "?state=resolved", { cookie: f.viewer.cookie }))
        .data.threads[0].id,
      id,
    );
    assert.equal(
      (
        await request(`threads/${id}`, {
          method: "PATCH",
          cookie: f.editor.cookie,
          body: { version: resolved.data.thread.version, resolved: false },
        })
      ).response.status,
      200,
    );
    current = (await detail(id, f.owner)).data;
    const edited = current.messages.find((m) => m.id === first.id);
    assert.equal(
      (
        await request(`comments/${first.id}`, {
          method: "DELETE",
          cookie: f.editor.cookie,
          body: { version: edited.version },
        })
      ).response.status,
      200,
    );
    assert.equal(
      (await detail(id, f.viewer)).data.messages.find((m) => m.id === first.id)
        .body,
      null,
    );
    assert.equal(
      (await db.query("SELECT body FROM comments WHERE id=$1", [first.id]))
        .rows[0].body,
      null,
    );
    assert.equal(
      (
        await request(`comments/${first.id}`, {
          method: "PATCH",
          cookie: f.commenter.cookie,
          body: {
            version: edited.version + 1,
            body: "Cannot restore purged text",
          },
        })
      ).response.status,
      409,
    );
    const known = await detail(id, f.outsider),
      missing = await detail(randomUUID(), f.outsider);
    assert.equal(known.response.status, 404);
    assert.deepEqual(known.data, missing.data);
    const privatePage = (
      await request(`spaces/${f.space.id}/pages`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: { title: "Restricted parent" },
      })
    ).data;
    await request(`pages/${privatePage.id}/permissions`, {
      method: "PUT",
      cookie: f.owner.cookie,
      body: {
        version: privatePage.version,
        visibility: "restricted",
        grants: [],
        confirm: true,
      },
    });
    const p = (await request(`pages/${f.page.id}`, { cookie: f.owner.cookie }))
      .data;
    assert.deepEqual(p.document, f.page.document);
    assert.equal(
      p.version,
      f.page.version,
      "Comments do not change rich-document revisions",
    );
    await request(`pages/${f.page.id}/move`, {
      method: "POST",
      cookie: f.owner.cookie,
      body: { version: p.version, parentId: privatePage.id, sortOrder: 0 },
    });
    assert.equal((await detail(id, f.viewer)).response.status, 404);
    assert.equal(
      (await request(path, { cookie: f.commenter.cookie })).response.status,
      404,
    );
    assert.equal(
      (
        await request(`comments/${other.id}`, {
          method: "DELETE",
          cookie: f.commenter.cookie,
          body: { version: other.version },
        })
      ).response.status,
      404,
    );
    assert.equal((await detail(id, f.owner)).response.status, 200);
  } finally {
    await db.end();
  }
});
test("thread/reply pagination stays scoped, authors become former members, and closed/trash boundaries retain no hidden counts", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      ids = [];
    for (let i = 0; i < 7; i++)
      ids.push(
        (
          await request(`pages/${f.page.id}/threads`, {
            method: "POST",
            cookie: f.commenter.cookie,
            body: comment("Discussion " + i),
          })
        ).data.thread.id,
      );
    let cursor = "",
      seen = [];
    do {
      const r = (
        await request(`pages/${f.page.id}/threads?limit=3&before=${cursor}`, {
          cookie: f.viewer.cookie,
        })
      ).data;
      seen.push(...r.threads.map((t) => t.id));
      cursor = r.nextBefore;
    } while (cursor);
    assert.deepEqual(seen, ids.toReversed());
    for (let i = 0; i < 6; i++)
      await request(`threads/${ids[0]}/comments`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: comment("Reply " + i),
      });
    cursor = "";
    seen = [];
    do {
      const r = (
        await request(`threads/${ids[0]}?limit=2&before=${cursor}`, {
          cookie: f.viewer.cookie,
        })
      ).data;
      seen.unshift(...r.messages.map((m) => m.body));
      cursor = r.nextBefore;
    } while (cursor);
    assert.deepEqual(seen, [
      "Discussion 0",
      ...Array.from({ length: 6 }, (_, i) => "Reply " + i),
    ]);
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.space.id, f.commenter.id],
    );
    assert.equal(
      (await detail(ids[0], f.owner)).data.messages[0].author.email,
      null,
    );
    assert.equal((await detail(ids[0], f.commenter)).response.status, 404);
    await request(`pages/${f.page.id}`, {
      method: "DELETE",
      cookie: f.owner.cookie,
      body: {},
    });
    assert.equal((await detail(ids[0], f.owner)).response.status, 404);
    await request(`pages/${f.page.id}/restore`, {
      method: "POST",
      cookie: f.owner.cookie,
      body: {},
    });
    assert.equal((await detail(ids[0], f.owner)).data.messages.length, 7);
  } finally {
    await db.end();
  }
});

test("Chromium: commenter opens a thread, owner replies, edits resolve/reopen and deletion persist, readers cannot post", async () => {
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
    const f = await fixture(db);
    await request(`pages/${f.page.id}`, {
      method: "PUT",
      cookie: f.owner.cookie,
      body: {
        title: f.page.title,
        version: f.page.version,
        document: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "Review schedule" }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "We collect decisions and open questions here. Please keep feedback with the discussion.",
                },
              ],
            },
          ],
        },
      },
    });
    const otherPage = (
      await request(`spaces/${f.space.id}/pages`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: { title: "Another discussion" },
      })
    ).data;
    page = await session(f.commenter);
    await page.goto(base + pageLink(f.page.id));
    await expect(
      page.getByRole("textbox", { name: "Document", exact: true }),
    ).toHaveAttribute("contenteditable", "false");
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Comments", exact: true });
    await expect(panel).toBeVisible();
    assert.equal(
      await panel.evaluate((element) => element.matches(":modal")),
      false,
    );
    const firstText =
      "Can we review this before Friday? <script>window.orvynCommentAttack=true</script>";
    await panel.getByLabel("New comment", { exact: true }).fill(firstText);
    const tree = page.getByRole("navigation", { name: "Pages", exact: true });
    await tree
      .getByRole("button", { name: "Another discussion", exact: true })
      .click();
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    await expect(panel.getByLabel("New comment", { exact: true })).toHaveValue(
      "",
    );
    await tree
      .getByRole("button", { name: "Team discussion", exact: true })
      .click();
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    await expect(panel.getByLabel("New comment", { exact: true })).toHaveValue(
      firstText,
    );
    await panel
      .getByRole("button", { name: "Post comment", exact: true })
      .click();
    await expect(panel.locator(".comment-body")).toHaveText(firstText);
    assert.equal(
      await page.evaluate(() => window.orvynCommentAttack),
      undefined,
    );
    await expect(
      panel.getByRole("button", { name: "Resolve thread", exact: true }),
    ).toBeVisible();
    const owner = await session(f.owner);
    await owner.goto(base + pageLink(f.page.id));
    await owner.getByRole("button", { name: "Comments", exact: true }).click();
    const ownerPanel = owner.getByRole("dialog", {
      name: "Comments",
      exact: true,
    });
    await ownerPanel
      .getByRole("button", { name: /Can we review this before Friday/ })
      .click();
    await ownerPanel
      .getByLabel("Reply", { exact: true })
      .fill("Yes. I will add the final figures tomorrow.");
    await ownerPanel
      .getByRole("button", { name: "Send reply", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "Refresh comments", exact: true })
      .click();
    await expect(panel.locator(".comment-body")).toHaveCount(2);
    await panel
      .locator(".comment-message")
      .first()
      .getByRole("button", { name: "Comment actions", exact: true })
      .click();
    await panel
      .getByRole("menuitem", { name: "Edit comment", exact: true })
      .click();
    await panel
      .getByLabel("Edit comment", { exact: true })
      .fill("Review the updated figures before Friday.");
    await panel
      .getByRole("button", { name: "Save comment", exact: true })
      .click();
    await expect(panel.locator(".comment-body").first()).toHaveText(
      "Review the updated figures before Friday.",
    );
    await page.screenshot({
      path: ".local/ui-review/page-comments.png",
      fullPage: true,
    });
    await panel
      .getByRole("button", { name: "Resolve thread", exact: true })
      .click();
    await expect(
      panel.getByRole("button", { name: "Reopen thread", exact: true }),
    ).toBeVisible();
    await expect(panel.getByLabel("Reply", { exact: true })).toHaveCount(0);
    await panel
      .getByRole("button", { name: "Reopen thread", exact: true })
      .click();
    await expect(panel.getByLabel("Reply", { exact: true })).toBeVisible();
    await panel
      .locator(".comment-message")
      .first()
      .getByRole("button", { name: "Comment actions", exact: true })
      .click();
    await panel
      .getByRole("menuitem", { name: "Delete comment", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Delete comment?", exact: true })
      .getByRole("button", { name: "Delete comment", exact: true })
      .click();
    await expect(panel.locator(".comment-body").first()).toHaveText(
      "Comment deleted",
    );
    const viewer = await session(f.viewer);
    await viewer.goto(base + pageLink(f.page.id));
    await viewer.getByRole("button", { name: "Comments", exact: true }).click();
    const readerPanel = viewer.getByRole("dialog", {
      name: "Comments",
      exact: true,
    });
    await readerPanel.getByRole("button", { name: /Comment deleted/ }).click();
    await expect(readerPanel.locator(".comment-body")).toHaveCount(2);
    await expect(readerPanel.getByLabel("Reply", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      readerPanel.getByRole("button", { name: "Comment actions", exact: true }),
    ).toHaveCount(0);
    await expect(
      readerPanel.getByRole("button", { name: "Resolve thread", exact: true }),
    ).toHaveCount(0);
    await viewer.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => readerPanel.evaluate((element) => element.matches(":modal")))
      .toBe(true);
    assert.ok(
      await viewer.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.reload();
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    await panel.getByRole("button", { name: /Comment deleted/ }).click();
    await expect(panel.locator(".comment-body").first()).toHaveText(
      "Comment deleted",
    );
    await expect(panel.locator(".comment-body").last()).toHaveText(
      "Yes. I will add the final figures tomorrow.",
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page)
      await page.screenshot({
        path: ".local/ui-review/comments-failure.png",
        fullPage: true,
      });
    console.error("Comments browser errors", errors);
    throw error;
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
    await db.end();
  }
});

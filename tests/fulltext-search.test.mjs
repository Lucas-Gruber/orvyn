import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { chromium, expect } from "./browser-tools.mjs";
import { pageLink } from "../packages/editor/dist/links.js";
import { searchExcerpt } from "../apps/api/dist/search.js";

async function account() {
  const result = await request("auth/register", {
    method: "POST",
    body: { email: randomUUID() + "@example.test", password: randomUUID() },
  });
  const cookie = sessionCookie(result.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
async function space(owner, name) {
  return (
    await request("spaces", {
      method: "POST",
      cookie: owner.cookie,
      body: { name },
    })
  ).data;
}
const document = (text) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
async function create(owner, source, title, body = "", extra = {}) {
  const page = (
    await request(`spaces/${source.id}/pages`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title, ...extra },
    })
  ).data;
  if (body) {
    const saved = await request(`pages/${page.id}`, {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        title,
        version: page.version,
        document: typeof body === "string" ? document(body) : body,
      },
    });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.data));
    return saved.data;
  }
  return page;
}
const search = (actor, q = "", filters = {}) =>
  request("search?" + new URLSearchParams({ q, ...filters }), {
    cookie: actor?.cookie,
  });
async function restrict(owner, id) {
  const current = (await request("pages/" + id, { cookie: owner.cookie })).data;
  const changed = await request("pages/" + id + "/permissions", {
    method: "PUT",
    cookie: owner.cookie,
    body: {
      version: current.version,
      confirm: true,
      visibility: "restricted",
      grants: [],
    },
  });
  assert.equal(changed.response.status, 200);
}

test("full-text search indexes authored blocks and rich-text words, prioritizes titles, filters scopes and never follows private previews or attributes", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const owner = await account(),
      viewer = await account(),
      outsider = await account();
    const team = await space(owner, "Product studio"),
      personal = await space(owner, "Private research");
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [team.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      team.id,
      viewer.id,
    ]);
    const rich = await create(owner, team, "Planning handbook", {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 4 },
          content: [{ type: "text", text: "A zephyr milestone" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "A know" },
            { type: "text", text: "ledgeable", marks: [{ type: "bold" }] },
            { type: "text", text: " team uses Überprüfung and zephyr notes." },
          ],
        },
        {
          type: "codeBlock",
          content: [
            {
              type: "text",
              text: '<img src=x onerror="globalThis.searchAttack=1"> zephyr example',
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "A public link",
              marks: [
                {
                  type: "link",
                  attrs: { href: "https://example.test/attributequasar" },
                },
              ],
            },
          ],
        },
      ],
    });
    const exact = await create(owner, team, "zephyr", "An ordinary overview.");
    const title = await create(
      owner,
      team,
      "Zephyr delivery",
      "A delivery overview.",
    );
    const hidden = await create(
      owner,
      team,
      "Private plan",
      "zephyr confidentialquasar",
    );
    await restrict(owner, hidden.id);
    const signpost = await create(owner, team, "Public signpost", {
      type: "doc",
      content: [{ type: "orvynPagePreview", attrs: { pageId: hidden.id } }],
    });
    const folder = await create(owner, team, "Restricted folder", "", {
      kind: "folder",
    });
    const child = await create(
      owner,
      team,
      "Nested notes",
      "zephyr hidden child",
      { parentId: folder.id },
    );
    await restrict(owner, folder.id);
    const other = await create(
      owner,
      personal,
      "Personal observations",
      "zephyr private space",
    );
    const database = (
      await request(`spaces/${team.id}/databases`, {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Delivery roadmap" },
      })
    ).data;
    const record = (
      await request(`databases/${database.id}/records`, {
        method: "POST",
        cookie: owner.cookie,
        body: { title: "Editor QA", values: {} },
      })
    ).data;
    await request("pages/" + record.pageId, {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        title: record.title,
        version: (
          await request("pages/" + record.pageId, { cookie: owner.cookie })
        ).data.version,
        document: document("zephyr record content"),
      },
    });
    const results = await search(viewer, "ZEPH");
    assert.equal(results.response.status, 200, JSON.stringify(results.data));
    assert.deepEqual(
      results.data
        .slice(0, 2)
        .map((item) => item.id)
        .sort(),
      [exact.id, title.id].sort(),
    );
    assert.equal(
      (await search(viewer, "zephyr")).data[0].id,
      exact.id,
      "exact title precedes body matches",
    );
    assert.deepEqual(
      new Set(results.data.map((item) => item.id)),
      new Set([rich.id, exact.id, title.id, record.pageId]),
    );
    const found = results.data.find((item) => item.id === rich.id);
    assert.equal(found.match_source, "content");
    assert.ok(found.excerpt.includes("zephyr"));
    assert.ok(found.highlights.length);
    for (const range of found.highlights)
      assert.match(found.excerpt.slice(range.start, range.end), /^zeph/i);
    assert.equal(
      results.response.headers.get("Cache-Control"),
      "private, no-store",
    );
    assert.deepEqual(
      (await search(viewer, "knowledg")).data.map((item) => item.id),
      [rich.id],
    );
    assert.deepEqual(
      (await search(viewer, "überprüf")).data.map((item) => item.id),
      [rich.id],
    );
    assert.deepEqual(
      (await search(viewer, "zephyr milestone")).data.map((item) => item.id),
      [rich.id],
    );
    assert.deepEqual((await search(viewer, "confidentialquasar")).data, []);
    assert.deepEqual(
      (await search(owner, "confidentialquasar")).data.map((item) => item.id),
      [hidden.id],
    );
    assert.deepEqual((await search(owner, "attributequasar")).data, []);
    assert.equal(
      (await search(owner, "zephyr")).data.some(
        (item) => item.id === signpost.id,
      ),
      false,
    );
    assert.deepEqual((await search(outsider, "zephyr")).data, []);
    assert.equal((await search(undefined, "zephyr")).response.status, 401);
    assert.deepEqual(
      (await search(viewer, "zephyr", { kind: "record" })).data.map(
        (item) => item.id,
      ),
      [record.pageId],
    );
    assert.equal(
      (await search(viewer, "zephyr", { scope: "title" })).data.length,
      2,
    );
    assert.deepEqual(
      (await search(viewer, "delivery zephyr", { scope: "title" })).data.map(
        (item) => item.id,
      ),
      [title.id],
    );
    assert.deepEqual(
      (await search(owner, "zephyr", { spaceId: personal.id })).data.map(
        (item) => item.id,
      ),
      [other.id],
    );
    assert.deepEqual(
      (await search(viewer, "zephyr", { spaceId: personal.id })).data,
      [],
    );
    assert.equal(
      (await search(owner, "zephyr")).data.some((item) => item.id === child.id),
      true,
    );
    const current = (
      await request("pages/" + rich.id, { cookie: owner.cookie })
    ).data;
    assert.equal(
      (
        await request("pages/" + rich.id, {
          method: "PUT",
          cookie: owner.cookie,
          body: {
            title: current.title,
            version: current.version,
            document: document("An aster update replaces the old content."),
          },
        })
      ).response.status,
      200,
    );
    assert.equal(
      (await search(viewer, "zephyr")).data.some((item) => item.id === rich.id),
      false,
    );
    assert.deepEqual(
      (await search(viewer, "aster")).data.map((item) => item.id),
      [rich.id],
    );
    const rename = (await request("pages/" + rich.id, { cookie: owner.cookie }))
      .data;
    await request("pages/" + rich.id + "/title", {
      method: "PATCH",
      cookie: owner.cookie,
      body: { title: "Updated playbook", titleVersion: rename.title_version },
    });
    assert.deepEqual(
      (await search(viewer, "Planning handbook", { scope: "title" })).data,
      [],
    );
    assert.deepEqual(
      (await search(viewer, "Updated playbook", { scope: "title" })).data.map(
        (item) => item.id,
      ),
      [rich.id],
    );
    await request("pages/" + rich.id, {
      method: "DELETE",
      cookie: owner.cookie,
      body: { confirm: true },
    });
    assert.deepEqual((await search(viewer, "aster")).data, []);
    await request("pages/" + rich.id + "/restore", {
      method: "POST",
      cookie: owner.cookie,
      body: {},
    });
    assert.deepEqual(
      (await search(viewer, "aster")).data.map((item) => item.id),
      [rich.id],
    );
    const longGuide = await create(
      owner,
      team,
      "Long guide",
      Array.from({ length: 10000 }, (_, index) => "word" + index).join(" ") +
        " farendmarker",
    );
    const farEnd = (await search(viewer, "farendmarker")).data;
    assert.deepEqual(
      farEnd.map((item) => item.id),
      [longGuide.id],
    );
    assert.ok(farEnd[0].excerpt.includes("farendmarker"));
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [team.id, viewer.id],
    );
    assert.deepEqual((await search(viewer, "aster")).data, []);
  } finally {
    await db.end();
  }
});

test("search pagination preserves equal microsecond timestamps, filters before limiting, binds cursors and uses GIN word/title indexes", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const owner = await account(),
      viewer = await account(),
      team = await space(owner, "Pagination");
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [team.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      team.id,
      viewer.id,
    ]);
    const ids = Array.from({ length: 75 }, () => randomUUID()).sort();
    await db.query(
      `INSERT INTO pages(id,space_id,title,document,created_by,last_edited_by,updated_at,visibility)
      SELECT item.id,$1,'Entry '||item.position,$2::jsonb,$3,$3,'2026-01-01 12:00:00.123456+00'::timestamptz,
      CASE WHEN item.position<=20 THEN 'restricted' ELSE 'space' END
      FROM unnest($4::uuid[]) WITH ORDINALITY AS item(id,position)`,
      [team.id, document("paginationquasar shared content"), owner.id, ids],
    );
    let after = "",
      firstCursor = "",
      seen = [];
    do {
      const result = await search(viewer, "paginationquasar", {
        limit: "7",
        after,
      });
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      assert.ok(result.data.length > 0);
      seen.push(...result.data.map((item) => item.id));
      after = result.response.headers.get("X-Next-Cursor") || "";
      firstCursor ||= after;
    } while (after);
    assert.deepEqual(seen, ids.slice(20));
    assert.equal(new Set(seen).size, 55);
    const cursor = JSON.parse(Buffer.from(firstCursor, "base64url").toString());
    assert.match(cursor.updated, /\.123456Z$/);
    assert.equal(
      (await search(viewer, "different", { after: firstCursor })).response
        .status,
      400,
    );
    assert.equal(
      (
        await search(viewer, "paginationquasar", {
          after: firstCursor,
          kind: "record",
        })
      ).response.status,
      400,
    );
    for (const filters of [
      { after: "invalid" },
      { limit: "0" },
      { limit: "101" },
      { spaceId: "not-a-uuid" },
      { kind: "secret" },
      { scope: "hidden" },
    ])
      assert.equal(
        (await search(viewer, "paginationquasar", filters)).response.status,
        400,
      );
    assert.equal((await search(viewer, "\0")).response.status, 400);
    await create(owner, team, "100%_choice", "A literal title.");
    assert.equal(
      (await search(viewer, "%", { scope: "title" })).data.length,
      1,
    );
    assert.equal(
      (await search(viewer, "_choice", { scope: "title" })).data.length,
      1,
    );
    for (const query of [
      "%' OR true --",
      "[{()}]",
      "\\",
      "don't",
      "foo:* | bar",
      '"',
    ])
      assert.equal((await search(viewer, query)).response.status, 200);
    const planner = await db.connect();
    try {
      await planner.query("BEGIN");
      await planner.query("SET LOCAL enable_seqscan=off");
      const words = await planner.query(
        "EXPLAIN (FORMAT JSON) SELECT page_id FROM page_search WHERE search_vector@@orvyn_search_query($1)",
        ["paginationqua"],
      );
      assert.match(JSON.stringify(words.rows), /page_search_words/);
      const titles = await planner.query(
        "EXPLAIN (FORMAT JSON) SELECT page_id FROM page_search WHERE title_text ILIKE $1",
        ["%choice%"],
      );
      assert.match(JSON.stringify(titles.rows), /page_search_titles/);
      await planner.query("ROLLBACK");
    } finally {
      planner.release();
    }
  } finally {
    await db.end();
  }
});

test("search excerpts preserve literal markup and Unicode, escape regex terms and return only bounded text ranges", () => {
  for (const [body, term] of [
    ["A literal [term] is not an expression.", "[term]"],
    ["<img src=x onerror=alert(1)> zephyr", "zeph"],
    ["😀".repeat(100) + "Überprüfung" + "😀".repeat(200), "überprüf"],
  ]) {
    const excerpt = searchExcerpt(body, [term]);
    assert.ok(excerpt.excerpt.length <= 260);
    assert.ok(excerpt.excerpt.isWellFormed());
    assert.equal(excerpt.highlights.length, 1);
    const match = excerpt.highlights[0];
    assert.equal(
      excerpt.excerpt.slice(match.start, match.end).toLowerCase(),
      term.toLowerCase(),
    );
  }
  assert.deepEqual(searchExcerpt("Nothing matches here", ["other"]), {
    excerpt: "",
    highlights: [],
  });
});

test("Chromium: content search highlights safe excerpts, filters spaces/types, pages results, ignores late responses and refreshes revoked access", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let page;
  try {
    const owner = await account(),
      editor = await account();
    const product = await space(owner, "Product studio"),
      engineering = await space(owner, "Engineering");
    for (const source of [product, engineering]) {
      await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [source.id]);
      await db.query("INSERT INTO space_members VALUES($1,$2,'Editor')", [
        source.id,
        editor.id,
      ]);
    }
    const handbook = await create(
      owner,
      product,
      "Product handbook",
      "Our rollout starts with a small group of teams. We collect feedback and improve the writing experience before opening it to everyone.",
    );
    const checklist = await create(
      owner,
      product,
      "Release checklist",
      "Before the rollout, confirm permissions, editor saves and database views.",
    );
    const planning = await create(
      owner,
      product,
      "Planning notes",
      "A staged rollout gives the team time to learn, review feedback and decide what comes next.",
    );
    await create(
      owner,
      product,
      "Rollout schedule",
      "Dates and owners for the next release.",
    );
    await create(
      owner,
      engineering,
      "Deployment guide",
      "The rollout uses a separate test instance before the production deployment.",
    );
    const hidden = await create(
      owner,
      product,
      "Private finance",
      "rollout PRIVATESEARCHTOKEN",
    );
    await restrict(owner, hidden.id);
    await create(owner, product, "Markup examples", {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [
            {
              type: "text",
              text: '<img src="x" onerror="globalThis.searchAttack=1"> safehtml example',
            },
          ],
        },
      ],
    });
    const database = (
      await request(`spaces/${product.id}/databases`, {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Product roadmap" },
      })
    ).data;
    const record = (
      await request(`databases/${database.id}/records`, {
        method: "POST",
        cookie: owner.cookie,
        body: { title: "Editor QA", values: {} },
      })
    ).data;
    const recordPage = (
      await request("pages/" + record.pageId, { cookie: owner.cookie })
    ).data;
    await request("pages/" + record.pageId, {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        title: record.title,
        version: recordPage.version,
        document: document(
          "Review the rollout with keyboard navigation and shared editing.",
        ),
      },
    });
    await db.query(
      `INSERT INTO pages(space_id,title,document,created_by,last_edited_by)
      SELECT $1,'Catalog entry '||value,$2::jsonb,$3,$3 FROM generate_series(1,32) value`,
      [product.id, document("catalogmarker reference content"), owner.id],
    );
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    await context.addCookies([
      {
        name: "orvyn_session",
        value: editor.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    await context.addInitScript(() =>
      localStorage.setItem("orvyn.theme", "light"),
    );
    page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base + pageLink(handbook.id));
    await expect(
      page.getByRole("textbox", { name: "Document", exact: true }),
    ).toBeEditable();
    await page.keyboard.press("Control+p");
    const dialog = page.getByRole("dialog", {
      name: "Search your workspace",
      exact: true,
    });
    const input = dialog.getByLabel("Search pages", { exact: true });
    const rows = dialog.locator(".search-results > li");
    await expect(input).toBeFocused();
    const originalY = (await input.boundingBox()).y;
    await input.fill("rollou");
    await expect(rows).toHaveCount(6);
    await expect(dialog.locator(".search-result-title").first()).toHaveText(
      "Rollout schedule",
    );
    await expect(dialog.locator("mark").first()).toContainText(/rollou/i);
    await expect(
      dialog.getByText("PRIVATESEARCHTOKEN", { exact: false }),
    ).toHaveCount(0);
    await dialog
      .getByRole("combobox", { name: "Search in", exact: true })
      .selectOption("title");
    await expect(rows).toHaveCount(1);
    await dialog
      .getByRole("combobox", { name: "Search in", exact: true })
      .selectOption("all");
    await dialog
      .getByRole("combobox", { name: "Content type", exact: true })
      .selectOption("record");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Editor QA");
    await dialog
      .getByRole("combobox", { name: "Search space", exact: true })
      .selectOption(engineering.id);
    await expect(rows).toHaveCount(0);
    await expect(
      dialog.getByText(
        "No results found. Try fewer words or different filters.",
        { exact: true },
      ),
    ).toBeVisible();
    assert.ok(
      Math.abs((await input.boundingBox()).y - originalY) <= 1,
      "The search field stays in place as results change",
    );
    await dialog
      .getByRole("combobox", { name: "Content type", exact: true })
      .selectOption("all");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Deployment guide");
    await dialog
      .getByRole("combobox", { name: "Search space", exact: true })
      .selectOption(product.id);
    await dialog
      .getByRole("combobox", { name: "Content type", exact: true })
      .selectOption("page");
    await input.fill("rollout");
    await expect(rows).toHaveCount(4);
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/fulltext-search.png",
      fullPage: true,
    });
    await dialog
      .getByRole("combobox", { name: "Search space", exact: true })
      .selectOption("");
    await dialog
      .getByRole("combobox", { name: "Content type", exact: true })
      .selectOption("all");
    await expect(rows).toHaveCount(6);
    let release, started, finished;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const pending = new Promise((resolve) => {
      started = resolve;
    });
    const handled = new Promise((resolve) => {
      finished = resolve;
    });
    await page.route("**/api/v1/search?**", async (route) => {
      if (new URL(route.request().url()).searchParams.get("q") !== "earlier")
        return route.continue();
      started();
      await held;
      try {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              id: handbook.id,
              title: "OUTDATED RESPONSE",
              kind: "page",
              space_name: product.name,
              excerpt: "",
              highlights: [],
            },
          ]),
        });
      } catch (error) {
        if (!/cancel|abort|closed|disposed/i.test(error.message)) throw error;
      } finally {
        finished();
      }
    });
    await input.fill("earlier");
    await pending;
    await input.fill("rollout");
    await expect(rows).toHaveCount(6);
    release();
    await handled;
    await expect(
      dialog.getByText("OUTDATED RESPONSE", { exact: true }),
    ).toHaveCount(0);
    await page.unroute("**/api/v1/search?**");
    await input.fill("safehtml");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("<img");
    assert.equal(await dialog.locator("img,script").count(), 0);
    assert.equal(await page.evaluate(() => globalThis.searchAttack), undefined);
    await input.fill("catalogmarker");
    await expect(rows).toHaveCount(30);
    await dialog
      .getByRole("button", { name: "Next results", exact: true })
      .click();
    await expect(rows).toHaveCount(2);
    await expect(dialog.getByText("Page 2", { exact: true })).toBeVisible();
    await dialog
      .getByRole("button", { name: "Previous results", exact: true })
      .click();
    await expect(rows).toHaveCount(30);
    await dialog
      .getByRole("combobox", { name: "Search space", exact: true })
      .selectOption(engineering.id);
    await expect(rows).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Previous results", exact: true }),
    ).toBeDisabled();
    await dialog
      .getByRole("combobox", { name: "Search space", exact: true })
      .selectOption("");
    await input.fill("rollout");
    await expect(rows).toHaveCount(6);
    await restrict(owner, planning.id);
    await expect(
      dialog
        .locator(".search-result-title")
        .filter({ hasText: /^Planning notes$/ }),
    ).toHaveCount(0);
    await expect(rows).toHaveCount(5);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: ".local/ui-review/fulltext-search-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route("**/api/v1/search?**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Unavailable" }),
      }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(dialog.getByRole("alert")).toContainText(
      "Search is unavailable",
    );
    await expect(rows).toHaveCount(0);
    await page.unroute("**/api/v1/search?**");
    await dialog
      .getByRole("button", { name: "Try again", exact: true })
      .click();
    await expect(rows).toHaveCount(5);
    await input.fill("permissions");
    await expect(rows).toHaveCount(1);
    await input.press("Enter");
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue(checklist.title);
    const editorInput = page.getByRole("textbox", {
      name: "Document",
      exact: true,
    });
    await expect(editorInput).toBeEditable();
    await editorInput.fill(
      "An observatory marker is now part of the rollout notes.",
    );
    await expect
      .poll(async () =>
        (await search(editor, "observatory")).data.map((item) => item.id),
      )
      .toEqual([checklist.id]);
    await page.keyboard.press("Control+p");
    await input.fill("observatory");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("observatory");
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page)
      await page.screenshot({
        path: "/tmp/orvyn-fulltext-search-failure.png",
        fullPage: true,
      });
    throw error;
  } finally {
    await browser.close();
    await db.end();
  }
});

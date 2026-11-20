import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  importMarkdown,
  bindMarkdownDocument,
} from "../packages/editor/dist/markdown.js";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";

const markdown = `# A calmer handover

A note with **clear context**, _small details_ and [the next step](#next-step).

## Next step

- [x] Add a plan
- [ ] Review together

| Area | Owner | Next |
| --- | --- | --- |
| Experience | The studio | Review the flow |
| Delivery | The team | Share a small update |

> Make the next person's work easier.

#### A useful reference

\`\`\`ts
const nextStep = "Keep it clear";
\`\`\`
`;
const flatten = (node) => [node, ...(node.content || []).flatMap(flatten)];
async function account() {
  const registered = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(registered.response),
    me = await request("auth/me", { cookie });
  return { ...me.data, cookie };
}
async function fixture() {
  const owner = await account(),
    cookie = owner.cookie,
    space = (
      await request("spaces", {
        method: "POST",
        cookie,
        body: { name: "Product studio" },
      })
    ).data,
    parent = (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie,
        body: { title: "Knowledge base", kind: "folder" },
      })
    ).data,
    input = {
      filename: "Handover.md",
      markdown,
      titleFromHeading: true,
      parentId: parent.id,
    },
    path = `spaces/${space.id}/imports/markdown`,
    preview = (body = input, actor = cookie) =>
      request(path + "/preview", { method: "POST", cookie: actor, body });
  async function commit(
    review,
    value = input,
    requestId = randomUUID(),
    actor = cookie,
  ) {
    return request(path, {
      method: "POST",
      cookie: actor,
      body: { previewToken: review.data.previewToken, requestId, input: value },
    });
  }
  return { owner, cookie, space, parent, input, path, preview, commit };
}

test("Markdown import preserves GFM structure, stable heading links, inline marks, entities and mixed list types", () => {
  const result = importMarkdown(markdown, {
      filename: "Handover.md",
      titleFromHeading: true,
    }),
    nodes = flatten(result.document);
  assert.equal(result.title, "A calmer handover");
  assert.deepEqual(result.warnings, []);
  for (const item of nodes.filter((node) => node.type === "taskItem")) {
    assert.equal(item.content.length, 1);
    assert.ok(!JSON.stringify(item.content).includes("[x]"));
    assert.ok(!JSON.stringify(item.content).includes("[ ]"));
  }
  assert.equal(
    nodes.filter((n) => n.type === "heading" && n.attrs.level === 1).length,
    0,
  );
  assert.ok(nodes.some((n) => n.type === "taskItem" && n.attrs.checked));
  assert.ok(nodes.some((n) => n.type === "taskItem" && !n.attrs.checked));
  assert.equal(nodes.filter((n) => n.type === "tableHeader").length, 3);
  assert.equal(nodes.filter((n) => n.type === "tableCell").length, 6);
  assert.ok(
    nodes.some((n) => n.type === "codeBlock" && n.attrs.language === "ts"),
  );
  assert.ok(nodes.some((n) => n.marks?.some((m) => m.type === "bold")));
  assert.ok(nodes.some((n) => n.marks?.some((m) => m.type === "italic")));
  const heading = nodes.find(
    (n) => n.type === "heading" && n.attrs.level === 2,
  );
  assert.ok(
    nodes.some((n) =>
      n.marks?.some(
        (m) =>
          m.type === "link" && m.attrs.href.endsWith("#h-" + heading.attrs.id),
      ),
    ),
  );
  assert.deepEqual(
    result,
    importMarkdown(markdown, {
      filename: "Handover.md",
      titleFromHeading: true,
    }),
  );
  const mixed = importMarkdown(
    "- plain\n- [x] done\n- plain again\n\n7. numbered\n8. next\n\n###### &eacute; &amp; details\n",
    { filename: "mixed.md", titleFromHeading: false },
  );
  assert.deepEqual(
    mixed.document.content.slice(0, 4).map((n) => n.type),
    ["bulletList", "taskList", "bulletList", "orderedList"],
  );
  assert.equal(mixed.document.content[3].attrs.start, 7);
  assert.equal(mixed.document.content[4].attrs.level, 4);
  assert.equal(mixed.document.content[4].content[0].text, "é & details");
  assert.ok(mixed.warnings.some((warning) => /levels 5 and 6/.test(warning)));
  assert.equal(
    importMarkdown("plain text", {
      filename: "folder\\Useful note.md",
      titleFromHeading: true,
    }).title,
    "Useful note",
  );
  assert.throws(() =>
    importMarkdown("x".repeat(98305), {
      filename: "too-big.md",
      titleFromHeading: true,
    }),
  );
  assert.throws(() =>
    importMarkdown("\0binary", {
      filename: "binary.md",
      titleFromHeading: true,
    }),
  );
  assert.throws(() =>
    importMarkdown("> ".repeat(65) + "too deep", {
      filename: "deep.md",
      titleFromHeading: false,
    }),
  );
});

test("Markdown review writes nothing; confirmation atomically creates the editable page, history, references and searchable content", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(),
      review = await f.preview();
    assert.equal(review.response.status, 201, JSON.stringify(review.data));
    assert.equal(review.data.title, "A calmer handover");
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM pages WHERE space_id=$1",
          [f.space.id],
        )
      ).rows[0].count,
      1,
    );
    const created = await f.commit(review);
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.parent_id, f.parent.id);
    assert.equal(created.data.kind, "page");
    assert.equal(created.data.replayed, false);
    assert.deepEqual(
      created.data.document,
      JSON.parse(
        JSON.stringify(
          bindMarkdownDocument(review.data.document, created.data.id),
        ),
      ),
    );
    const revision = (
      await db.query("SELECT * FROM page_revisions WHERE page_id=$1", [
        created.data.id,
      ])
    ).rows;
    assert.equal(revision.length, 1);
    assert.deepEqual(revision[0].document, created.data.document);
    const found = await request("search?q=" + encodeURIComponent("easier"), {
      cookie: f.cookie,
    });
    assert.equal(found.response.status, 200);
    assert.ok(found.data.some((page) => page.id === created.data.id));
  } finally {
    await db.end();
  }
});

test("Markdown imports recheck destination permissions and reject stale access, altered content, foreign parents and viewers", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(),
      viewer = await account();
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [f.space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      f.space.id,
      viewer.id,
    ]);
    assert.equal(
      (await f.preview(f.input, viewer.cookie)).response.status,
      404,
    );
    const review = await f.preview();
    assert.equal(review.response.status, 201);
    assert.equal(
      (await f.commit(review, f.input, randomUUID(), viewer.cookie)).response
        .status,
      404,
    );
    assert.equal(
      (await f.commit(review, { ...f.input, markdown: markdown + "Changed" }))
        .response.status,
      409,
    );
    assert.equal(
      (
        await request(f.path + "/preview", {
          method: "POST",
          cookie: f.cookie,
          origin: "https://elsewhere.test",
          body: f.input,
        })
      ).response.status,
      403,
    );
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      f.parent.id,
    ]);
    assert.equal((await f.commit(review)).response.status, 409);
    const elsewhere = (
        await request("spaces", {
          method: "POST",
          cookie: f.cookie,
          body: { name: "Elsewhere" },
        })
      ).data,
      foreign = (
        await request(`spaces/${elsewhere.id}/pages`, {
          method: "POST",
          cookie: f.cookie,
          body: { title: "Other folder", kind: "folder" },
        })
      ).data;
    assert.equal(
      (await f.preview({ ...f.input, parentId: foreign.id })).response.status,
      400,
    );
    const database = (
      await request(`spaces/${f.space.id}/databases`, {
        method: "POST",
        cookie: f.cookie,
        body: { name: "Records" },
      })
    ).data;
    assert.equal(
      (await f.preview({ ...f.input, parentId: database.id })).response.status,
      400,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM page_import_requests WHERE space_id=$1",
          [f.space.id],
        )
      ).rows[0].count,
      0,
    );
  } finally {
    await db.end();
  }
});

test("Markdown confirmation retries serialize to one page, remain recoverable after preview expiry and reject reused content", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(),
      review = await f.preview(),
      requestId = randomUUID();
    assert.equal(review.response.status, 201);
    const results = await Promise.all([
      f.commit(review, f.input, requestId),
      f.commit(review, f.input, requestId),
    ]);
    assert.ok(
      results.every((r) => r.response.status === 201),
      JSON.stringify(results.map((r) => r.data)),
    );
    assert.equal(results[0].data.id, results[1].data.id);
    assert.deepEqual(results.map((r) => r.data.replayed).sort(), [false, true]);
    const { encryptionKey } = await import("../apps/api/dist/auth/security.js"),
      claims = JSON.parse(
        Buffer.from(
          review.data.previewToken.split(".")[0],
          "base64url",
        ).toString(),
      ),
      encoded = Buffer.from(
        JSON.stringify({ ...claims, expires: Date.now() - 1000 }),
      ).toString("base64url"),
      expired = {
        data: {
          previewToken:
            encoded +
            "." +
            createHmac("sha256", encryptionKey())
              .update("orvyn:markdown-import:v1:" + encoded)
              .digest("base64url"),
        },
      };
    assert.equal(
      (await f.commit(expired, f.input, randomUUID())).response.status,
      409,
    );
    const replay = await f.commit(expired, f.input, requestId);
    assert.equal(replay.response.status, 201);
    assert.equal(replay.data.id, results[0].data.id);
    assert.equal(
      (await f.commit(review, { ...f.input, title: "Another" }, requestId))
        .response.status,
      409,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM page_import_requests WHERE space_id=$1",
          [f.space.id],
        )
      ).rows[0].count,
      1,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM pages WHERE space_id=$1 AND kind='page'",
          [f.space.id],
        )
      ).rows[0].count,
      1,
    );
  } finally {
    await db.end();
  }
});

test("Markdown import failures roll back the page, history and receipt, allowing an exact retry", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    tag = "markdown_" + randomUUID().replaceAll("-", "");
  try {
    const f = await fixture();
    f.input.title = tag;
    const review = await f.preview(),
      requestId = randomUUID();
    assert.equal(review.response.status, 201);
    await db.query(
      `CREATE FUNCTION ${tag}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected import history failure'; END $$`,
    );
    await db.query(
      `CREATE TRIGGER ${tag} BEFORE INSERT ON page_revisions FOR EACH ROW WHEN (NEW.title='${tag}') EXECUTE FUNCTION ${tag}()`,
    );
    try {
      assert.equal(
        (await f.commit(review, f.input, requestId)).response.status,
        500,
      );
    } finally {
      await db.query(`DROP TRIGGER ${tag} ON page_revisions`);
      await db.query(`DROP FUNCTION ${tag}()`);
    }
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM pages WHERE title=$1",
          [tag],
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM page_import_requests WHERE actor_id=$1",
          [f.owner.id],
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (await f.commit(review, f.input, requestId)).response.status,
      201,
    );
  } finally {
    await db.end();
  }
});

test("Markdown images, raw HTML, scripts and relative file links never trigger server fetches or create attachment grants", async () => {
  let fetched = 0;
  const server = createServer((req, res) => {
    fetched++;
    res.end("private resource");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const f = await fixture(),
      address = `http://127.0.0.1:${server.address().port}/never-load`,
      input = {
        ...f.input,
        markdown: `# Readable text\n\n![picture](${address})\n\n<script>fetch('${address}')</script>\n\n[unsafe](jav&#x61;script:alert(1)) [local](file:///etc/passwd) [relative](../secret.md)\n`,
      },
      review = await f.preview(input);
    assert.equal(review.response.status, 201, JSON.stringify(review.data));
    const nodes = flatten(review.data.document),
      links = nodes.flatMap((n) =>
        (n.marks || []).filter((m) => m.type === "link"),
      );
    assert.equal(links.length, 1);
    assert.equal(links[0].attrs.href, address);
    assert.ok(!nodes.some((n) => ["orvynImage", "orvynFile"].includes(n.type)));
    assert.ok(nodes.some((n) => n.type === "codeBlock"));
    assert.ok(review.data.warnings.some((warning) => /Images/.test(warning)));
    assert.ok(review.data.warnings.some((warning) => /HTML/.test(warning)));
    assert.equal((await f.commit(review, input)).response.status, 201);
    assert.equal(fetched, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Chromium: import a Markdown file through review, recover a lost response, edit tables and retain the result on mobile", async () => {
  const { chromium, expect } = await import("@playwright/test");
  let browser;
  try {
    const f = await fixture();
    browser = await chromium.launch({
      executablePath: "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1365, height: 1000 },
    });
    await context.addCookies([
      { name: "orvyn_session", value: f.cookie.split("=")[1], url: base },
    ]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/?page=" + f.parent.id);
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue(f.parent.title);
    await page
      .getByRole("button", { name: "Page actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", {
        name: "Import Markdown as subpage",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Import Markdown",
      exact: true,
    });
    await dialog
      .getByLabel("Choose a Markdown file", { exact: true })
      .setInputFiles({
        name: "Handover.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(markdown),
      });
    await expect(
      dialog.getByRole("textbox", { name: "Markdown source", exact: true }),
    ).toHaveValue(markdown);
    await expect(
      dialog.getByRole("combobox", { name: "Import into", exact: true }),
    ).toHaveValue(f.parent.id);
    await dialog
      .getByRole("button", { name: "Preview import", exact: true })
      .click();
    const review = page.getByRole("dialog", {
      name: "Review Markdown import",
      exact: true,
    });
    await expect(
      review.getByRole("heading", { name: "A calmer handover", exact: true }),
    ).toBeVisible();
    await expect(
      review.getByRole("columnheader", { name: "Area", exact: true }),
    ).toBeVisible();
    await expect(review.getByText("[x]", { exact: true })).toHaveCount(0);
    await expect(review.locator('input[type="checkbox"]')).toHaveCount(2);
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/markdown-import-review.png",
      fullPage: true,
    });
    let lost = false,
      original;
    const routePath = "**/api/v1/" + f.path;
    await page.route(routePath, async (route) => {
      if (!lost && route.request().method() === "POST") {
        lost = true;
        const result = await route.fetch();
        assert.equal(result.status(), 201, await result.text());
        original = await result.json();
        return route.abort("failed");
      }
      return route.continue();
    });
    await review
      .getByRole("button", { name: "Import page", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue("A calmer handover");
    assert.ok(lost && original);
    await page.waitForURL(
      (url) => url.searchParams.get("page") === original.id,
    );
    await page.unroute(routePath);
    const editor = page.getByRole("textbox", { name: "Document", exact: true });
    await expect(
      editor.getByRole("heading", { name: "Next step", exact: true }),
    ).toBeVisible();
    await expect(editor.locator("table")).toHaveCount(1);
    const tasks = editor.locator('ul[data-type="taskList"] > li'),
      checkbox = await tasks
        .first()
        .locator('input[type="checkbox"]')
        .boundingBox(),
      taskText = await tasks
        .first()
        .locator(":scope > div > p")
        .first()
        .boundingBox();
    assert.ok(
      checkbox &&
        taskText &&
        taskText.x >= checkbox.x + checkbox.width + 4 &&
        Math.abs(
          taskText.y + taskText.height / 2 - checkbox.y - checkbox.height / 2,
        ) < 8,
      "Checklist controls and their first text line must be aligned horizontally.",
    );
    await tasks.nth(1).locator('input[type="checkbox"]').check();
    await expect
      .poll(async () => {
        const current = await request("pages/" + original.id, {
          cookie: f.cookie,
        });
        return flatten(current.data.document).filter(
          (node) => node.type === "taskItem",
        )[1]?.attrs.checked;
      })
      .toBe(true);
    await tasks.nth(1).locator('input[type="checkbox"]').uncheck();
    await expect(
      editor.getByText("Review the flow", { exact: true }),
    ).toBeVisible();
    await editor.getByText("Review the flow", { exact: true }).click();
    await editor
      .locator("td")
      .filter({ hasText: /^Review the flow$/ })
      .locator("p")
      .fill("Review the full flow");
    await expect
      .poll(async () => {
        const current = await request("pages/" + original.id, {
          cookie: f.cookie,
        });
        return JSON.stringify(current.data.document).includes(
          "Review the full flow",
        );
      })
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "Table actions", exact: true }),
    ).toBeVisible();
    const flow = await page
        .getByRole("toolbar", { name: "Table controls", exact: true })
        .boundingBox(),
      lastTask = await tasks.last().boundingBox(),
      grid = await editor.locator("table").boundingBox();
    assert.ok(
      flow &&
        lastTask &&
        grid &&
        flow.y >= lastTask.y + lastTask.height &&
        flow.y + flow.height <= grid.y,
      "The table toolbar must fit between preceding content and the table.",
    );
    await page.screenshot({
      path: ".local/ui-review/markdown-import-page.png",
      fullPage: true,
    });
    // Reviewing the same Markdown again creates matching heading IDs behind
    // the dialog. Following its link must scroll only this preview.
    await page
      .getByRole("button", { name: "Page actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", {
        name: "Import Markdown as subpage",
        exact: true,
      })
      .click();
    await dialog
      .getByLabel("Choose a Markdown file", { exact: true })
      .setInputFiles({
        name: "Handover.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(markdown),
      });
    await expect(
      dialog.getByRole("textbox", { name: "Markdown source", exact: true }),
    ).toHaveValue(markdown);
    await dialog
      .getByRole("button", { name: "Preview import", exact: true })
      .click();
    await review
      .getByRole("link", { name: "the next step", exact: true })
      .click();
    await expect
      .poll(() =>
        review
          .locator(".markdown-preview")
          .evaluate((element) => element.scrollTop),
      )
      .toBeGreaterThan(50);
    assert.equal(new URL(page.url()).searchParams.get("page"), original.id);
    await review
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await page.reload();
    await expect(
      editor.getByRole("heading", { name: "Next step", exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      editor.getByText("Review the full flow", { exact: true }),
    ).toBeVisible();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: ".local/ui-review/markdown-import-mobile.png",
      fullPage: true,
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
  }
});

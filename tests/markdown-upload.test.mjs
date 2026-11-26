import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  markdownImportMaxBytes,
  markdownImportSizeLabel,
} from "../packages/shared/dist/markdown-limits.js";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";

async function account() {
  const registered = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(registered.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
async function fixture() {
  const owner = await account(),
    cookie = owner.cookie,
    space = (
      await request("spaces", {
        method: "POST",
        cookie,
        body: { name: "Knowledge studio" },
      })
    ).data,
    parent = (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie,
        body: { title: "Library", kind: "folder" },
      })
    ).data,
    path = `spaces/${space.id}/imports/markdown`,
    metadata = {
      filename: "Überblick.md",
      titleFromHeading: true,
      parentId: parent.id,
    };
  async function post(
    source,
    settings = metadata,
    {
      commit = false,
      actor = cookie,
      origin = base,
      extra = false,
      duplicate = false,
      settingsField = "settings",
    } = {},
  ) {
    const body = new FormData(),
      buffer = typeof source === "string" ? Buffer.from(source) : source;
    body.append(
      "file",
      new Blob([buffer], { type: "text/markdown" }),
      "payload.md",
    );
    body.append(
      settingsField,
      typeof settings === "string" ? settings : JSON.stringify(settings),
    );
    if (extra) body.append("extra", "unexpected");
    if (duplicate) body.append("file", new Blob([buffer]), "second.md");
    const response = await fetch(
      base + "/api/v1/" + path + (commit ? "" : "/preview"),
      {
        method: "POST",
        headers: { Cookie: actor || "", Origin: origin },
        body,
      },
    );
    return { response, data: await response.json() };
  }
  async function commit(
    source,
    review,
    requestId = randomUUID(),
    actor = cookie,
  ) {
    return post(
      source,
      { requestId, previewToken: review.data.previewToken, input: metadata },
      { commit: true, actor },
    );
  }
  return { owner, cookie, space, parent, path, metadata, post, commit };
}

test("large CRLF Markdown bypasses JSON transport overhead, preserves Unicode metadata and retries as one native page", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(),
      source =
        "# Große Übergabe\r\n\r\n```plaintext\r\n" +
        "x\r\n".repeat(24000) +
        "```\r\n";
    assert.ok(Buffer.byteLength(source) < markdownImportMaxBytes);
    assert.ok(
      Buffer.byteLength(JSON.stringify({ markdown: source })) > 100 * 1024,
    );
    const review = await f.post(source);
    assert.equal(review.response.status, 201, JSON.stringify(review.data));
    assert.equal(review.data.title, "Große Übergabe");
    const code = review.data.document.content[0].content[0].text;
    assert.equal(code.split("\n").length, 24000);
    assert.ok(!code.includes("\r"));
    const requestId = randomUUID(),
      confirmed = await Promise.all([
        f.commit(source, review, requestId),
        f.commit(source, review, requestId),
      ]);
    for (const result of confirmed)
      assert.equal(result.response.status, 201, JSON.stringify(result.data));
    assert.equal(confirmed[0].data.id, confirmed[1].data.id);
    assert.deepEqual(confirmed.map((result) => result.data.replayed).sort(), [
      false,
      true,
    ]);
    const id = confirmed[0].data.id;
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM page_revisions WHERE page_id=$1",
          [id],
        )
      ).rows[0].count,
      1,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM files WHERE page_id=$1",
          [id],
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM page_import_requests WHERE request_id=$1",
          [requestId],
        )
      ).rows[0].count,
      1,
    );
    const legacy = await request(f.path + "/preview", {
      method: "POST",
      cookie: f.cookie,
      body: { ...f.metadata, markdown: "# JSON still works\n\nA small note." },
    });
    assert.equal(legacy.response.status, 201, JSON.stringify(legacy.data));
  } finally {
    await db.end();
  }
});

test("Markdown file bounds count bytes, accept the exact limit and reject malformed encoding without creating pages", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(),
      boundary = await f.post(Buffer.alloc(markdownImportMaxBytes, "a"), {
        ...f.metadata,
        titleFromHeading: false,
      });
    assert.equal(boundary.response.status, 201, JSON.stringify(boundary.data));
    assert.equal(
      boundary.data.document.content[0].content[0].text.length,
      markdownImportMaxBytes,
    );
    const unicode = await f.post("Überblick 😀 ".repeat(3000), {
      ...f.metadata,
      filename: "Grüße 😀.md",
      titleFromHeading: false,
    });
    assert.equal(unicode.response.status, 201, JSON.stringify(unicode.data));
    assert.equal(unicode.data.title, "Grüße 😀");
    assert.ok(unicode.data.document.content[0].content[0].text.includes("😀"));
    assert.equal(
      (await f.post(Buffer.alloc(markdownImportMaxBytes + 1, "a"))).response
        .status,
      413,
    );
    assert.equal(
      (await f.post(Buffer.from([0xff, 0xfe]))).response.status,
      400,
    );
    assert.equal(
      (await f.post("# Valid", { ...f.metadata, title: "\ud800" })).response
        .status,
      400,
    );
    assert.equal(
      (await f.post("# Valid", { ...f.metadata, filename: "\udc00.md" }))
        .response.status,
      400,
    );
    assert.equal(
      (await f.post("# Valid", { ...f.metadata, title: "Invalid\0title" }))
        .response.status,
      400,
    );
    assert.equal(
      (await f.post("# Valid", { ...f.metadata, filename: "Invalid\0file.md" }))
        .response.status,
      400,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM pages WHERE space_id=$1",
          [f.space.id],
        )
      ).rows[0].count,
      1,
    );
  } finally {
    await db.end();
  }
});

test("Markdown uploads authorize before parsing, reject ambiguous settings and retain actor/content/destination review binding", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(),
      viewer = await account(),
      editor = await account();
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [f.space.id]);
    await db.query(
      "INSERT INTO space_members VALUES($1,$2,'Viewer'),($1,$3,'Editor')",
      [f.space.id, viewer.id, editor.id],
    );
    assert.equal(
      (await f.post("# Note", f.metadata, { actor: "" })).response.status,
      401,
    );
    assert.equal(
      (await f.post("# Note", f.metadata, { actor: viewer.cookie })).response
        .status,
      404,
    );
    assert.equal(
      (await f.post("# Note", f.metadata, { origin: "https://elsewhere.test" }))
        .response.status,
      403,
    );
    assert.equal((await f.post("# Note", "not JSON")).response.status, 400);
    assert.equal(
      (await f.post("# Note", f.metadata, { settingsField: "settings[]" }))
        .response.status,
      400,
    );
    assert.equal(
      (
        await f.post("# Note", {
          ...f.metadata,
          markdown: "Conflicting source",
        })
      ).response.status,
      400,
    );
    assert.equal(
      (await f.post("# Note", f.metadata, { extra: true })).response.status,
      400,
    );
    assert.equal(
      (await f.post("# Note", f.metadata, { duplicate: true })).response.status,
      400,
    );
    const review = await f.post("# Note");
    assert.equal(review.response.status, 201, JSON.stringify(review.data));
    assert.equal((await f.commit("# Changed", review)).response.status, 409);
    assert.equal(
      (await f.commit("# Note", review, randomUUID(), editor.cookie)).response
        .status,
      400,
    );
    assert.equal(
      (await f.commit("# Note", review, randomUUID(), viewer.cookie)).response
        .status,
      404,
    );
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      f.parent.id,
    ]);
    assert.equal((await f.commit("# Note", review)).response.status, 409);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM page_import_requests WHERE actor_id=$1",
          [f.owner.id],
        )
      ).rows[0].count,
      0,
    );
  } finally {
    await db.end();
  }
});

test("a large Markdown file that expands beyond native document limits leaves no page, revision or import receipt", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(),
      source = "- A roadmap item\n".repeat(7000);
    assert.ok(Buffer.byteLength(source) < markdownImportMaxBytes);
    const review = await f.post(source);
    assert.equal(review.response.status, 400, JSON.stringify(review.data));
    assert.match(review.data.message, /20,000 elements/);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM pages WHERE space_id=$1",
          [f.space.id],
        )
      ).rows[0].count,
      1,
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
  } finally {
    await db.end();
  }
});

test("Chromium: larger UTF-8 Markdown uses a bounded file upload, previews, imports and reloads as a real editable page", async () => {
  const { chromium, expect } = await import("@playwright/test");
  let browser;
  try {
    const f = await fixture(),
      source =
        "# Große Wissensseite\n\nEin Überblick für das Team.\n\n```plaintext\n" +
        "Entscheidung, Kontext und nächster Schritt bleiben nachvollziehbar.\n".repeat(
          800,
        ) +
        "Ende der großen Notiz.\n```\n";
    assert.ok(
      Buffer.byteLength(source) > 32768 &&
        Buffer.byteLength(source) < markdownImportMaxBytes,
    );
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
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base + "/?page=" + f.parent.id);
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue("Library");
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
        name: "Übergabe.md",
        mimeType: "text/markdown",
        buffer: Buffer.alloc(markdownImportMaxBytes + 1, "a"),
      });
    await expect(dialog.getByRole("alert")).toHaveText(
      "Choose a .md or .markdown file up to " + markdownImportSizeLabel + ".",
    );
    await dialog
      .getByLabel("Choose a Markdown file", { exact: true })
      .setInputFiles({
        name: "Übergabe.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(source),
      });
    await expect(
      dialog.getByRole("textbox", { name: "Markdown source", exact: true }),
    ).toHaveValue(source);
    const sent = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/v1/" + f.path + "/preview",
    );
    await dialog
      .getByRole("button", { name: "Preview import", exact: true })
      .click();
    assert.match(
      (await sent).headers()["content-type"],
      /^multipart\/form-data;/,
    );
    const review = page.getByRole("dialog", {
      name: "Review Markdown import",
      exact: true,
    });
    await expect(
      review.getByRole("heading", { name: "Große Wissensseite", exact: true }),
    ).toBeVisible();
    assert.ok((await review.locator("pre").innerText()).length > 32768);
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/markdown-large-review.png",
    });
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/" + f.path &&
        response.request().method() === "POST",
    );
    await review
      .getByRole("button", { name: "Import page", exact: true })
      .click();
    const response = await created;
    assert.equal(response.status(), 201, await response.text());
    const imported = await response.json();
    await page.waitForURL(
      (url) => url.searchParams.get("page") === imported.id,
    );
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue("Große Wissensseite");
    const editor = page.getByRole("textbox", { name: "Document", exact: true });
    await expect(
      editor.getByText("Ein Überblick für das Team.", { exact: true }),
    ).toBeVisible();
    assert.ok(
      (await editor.locator("pre").innerText()).includes(
        "Ende der großen Notiz.",
      ),
    );
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue("Große Wissensseite");
    await expect(
      editor.getByText("Ein Überblick für das Team.", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: ".local/ui-review/markdown-large-page.png" });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
  }
});

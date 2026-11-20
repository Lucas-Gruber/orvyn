import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { exportMarkdown } from "../packages/editor/dist/markdown-export.js";
import {
  importMarkdown,
  bindMarkdownDocument,
} from "../packages/editor/dist/markdown.js";
import { normalizeDocument } from "../packages/editor/dist/index.js";
import { documentHeadings, pageLink } from "../packages/editor/dist/links.js";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";

const paragraph = (text) => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : [],
});
const body = `# A calmer handover

Keep **clear context**, _small details_ and [the next step](#next-step).

## Next step

- [x] Add a plan
- [ ] Review together
  - a useful detail

| Area | Next |
| --- | --- |
| Experience | Review the flow |

> Make the next step easier.

\`\`\`ts
const nextStep = "Keep it clear";
\`\`\`
`;
function context(id, extra = {}) {
  return {
    title: "A calmer handover",
    pageUrl: base + pageLink(id),
    page: () => undefined,
    file: () => undefined,
    person: () => undefined,
    includePeopleNames: false,
    ...extra,
  };
}
function semantic(document, id) {
  const headings = documentHeadings(document),
    indices = new Map(headings.map((heading, index) => [heading.id, index])),
    value = JSON.parse(JSON.stringify(document));
  function walk(node) {
    if (node.type === "heading") delete node.attrs.id;
    for (const mark of node.marks || []) {
      if (mark.type !== "link") continue;
      const url = new URL(mark.attrs.href, base),
        target = url.hash.startsWith("#h-") ? url.hash.slice(3) : "";
      if (url.searchParams.get("page") === id && indices.has(target))
        mark.attrs.href = "heading:" + indices.get(target);
    }
    node.content?.forEach(walk);
  }
  walk(value);
  return value;
}
async function account() {
  const result = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(result.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
async function fixture(db) {
  const owner = await account(),
    viewer = await account(),
    cookie = owner.cookie,
    space = (
      await request("spaces", {
        method: "POST",
        cookie,
        body: { name: "The studio" },
      })
    ).data;
  await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
  await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
    space.id,
    viewer.id,
  ]);
  async function page(title) {
    return (
      await request(`spaces/${space.id}/pages`, {
        method: "POST",
        cookie,
        body: { title },
      })
    ).data;
  }
  const source = await page("A calmer handover"),
    related = await page("A helpful guide"),
    hidden = await page("PRIVATE delivery details");
  const restricted = await request(`pages/${hidden.id}/permissions`, {
    method: "PUT",
    cookie,
    body: {
      version: hidden.version,
      visibility: "restricted",
      grants: [],
      confirm: true,
    },
  });
  assert.equal(
    restricted.response.status,
    200,
    JSON.stringify(restricted.data),
  );
  let document = bindMarkdownDocument(
    importMarkdown(body, { filename: "Handover.md", titleFromHeading: true })
      .document,
    source.id,
  );
  document.content.push({
    type: "paragraph",
    content: [
      { type: "text", text: "A note from " },
      { type: "orvynPerson", attrs: { userId: owner.id } },
      { type: "text", text: " and " },
      { type: "orvynPerson", attrs: { userId: viewer.id } },
    ],
  });
  document.content.push(
    {
      type: "orvynPagePreview",
      attrs: { pageId: related.id, headingId: null },
    },
    { type: "orvynPagePreview", attrs: { pageId: hidden.id, headingId: null } },
  );
  document.content.push({
    type: "paragraph",
    content: [
      {
        type: "text",
        text: "A related note",
        marks: [{ type: "link", attrs: { href: pageLink(hidden.id) } }],
      },
    ],
  });
  document = normalizeDocument(document);
  await db.query(
    "UPDATE pages SET document=$2,document_schema_version=13 WHERE id=$1",
    [source.id, document],
  );
  const path = `pages/${source.id}/export/markdown`,
    preview = (actor = cookie, query = "") =>
      request(path + query, { cookie: actor }),
    download = (review, actor = cookie, query = "") =>
      request(
        `pages/${source.id}/export.md?review=${review.data.digest}${query}`,
        { cookie: actor },
      );
  return {
    owner,
    viewer,
    cookie,
    space,
    source,
    related,
    hidden,
    document,
    path,
    preview,
    download,
  };
}

test("Markdown export round-trips ordinary blocks, nested tasks, code and permanent self-heading links without leaking page IDs", () => {
  const id = randomUUID(),
    nextId = randomUUID(),
    imported = importMarkdown(body, {
      filename: "Handover.md",
      titleFromHeading: true,
    }),
    document = bindMarkdownDocument(imported.document, id),
    result = exportMarkdown(document, context(id)),
    restored = bindMarkdownDocument(
      importMarkdown(result.markdown, {
        filename: "Again.md",
        titleFromHeading: true,
      }).document,
      nextId,
    );
  assert.deepEqual(result.warnings, []);
  assert.ok(result.markdown.includes("#next-step"));
  assert.ok(!result.markdown.includes(id));
  assert.deepEqual(semantic(document, id), semantic(restored, nextId));
  const literal = normalizeDocument({
      type: "doc",
      content: [
        paragraph("Literal <script> &eacute; **not bold** [not a link] ---"),
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "```\nkeep &amp; literal\n\n" }],
        },
      ],
    }),
    encoded = exportMarkdown(literal, context(id)),
    decoded = importMarkdown(encoded.markdown, {
      filename: "Code.md",
      titleFromHeading: true,
    });
  assert.deepEqual(
    JSON.parse(JSON.stringify(decoded.document)),
    JSON.parse(JSON.stringify(literal)),
  );
  assert.ok(!encoded.markdown.includes("<script>"));
  for (const value of ["", "one line", "one line\n", "one line\n\n"]) {
    const original = normalizeDocument({
        type: "doc",
        content: [
          {
            type: "codeBlock",
            attrs: { language: "plaintext" },
            content: value ? [{ type: "text", text: value }] : [],
          },
        ],
      }),
      serialized = exportMarkdown(original, context(id)),
      restored = importMarkdown(serialized.markdown, {
        filename: "Code.md",
        titleFromHeading: true,
      }).document;
    assert.deepEqual(
      JSON.parse(JSON.stringify(restored)),
      JSON.parse(JSON.stringify(original)),
    );
  }
  const codeTable = normalizeDocument({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [{ type: "tableHeader", content: [paragraph("Code")] }],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "a | b",
                          marks: [{ type: "code" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
    serializedTable = exportMarkdown(codeTable, context(id)),
    restoredTable = importMarkdown(serializedTable.markdown, {
      filename: "Table.md",
      titleFromHeading: true,
    }).document;
  assert.deepEqual(
    JSON.parse(JSON.stringify(restoredTable)),
    JSON.parse(JSON.stringify(codeTable)),
  );
  const slashed = JSON.parse(JSON.stringify(codeTable));
  slashed.content[0].content[1].content[0].content[0].content[0].text =
    "a \\| b";
  const slashedExport = exportMarkdown(slashed, context(id)),
    slashedImport = importMarkdown(slashedExport.markdown, {
      filename: "Literal.md",
      titleFromHeading: true,
    });
  assert.equal(
    slashedImport.document.content[0].content[1].content[0].content[0]
      .content[0].text,
    "a \\| b",
  );
  assert.ok(
    slashedExport.warnings.some((warning) =>
      /backslashes before pipes/.test(warning),
    ),
  );
});

test("Markdown export explains layout conversions, expands readable sections and emits a usable outline for skipped heading levels", () => {
  const id = randomUUID(),
    inaccessible = randomUUID(),
    document = normalizeDocument({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { id: randomUUID(), level: 4 },
          content: [{ type: "text", text: "A useful detail" }],
        },
        { type: "orvynToc" },
        {
          type: "orvynColumns",
          content: [
            { type: "orvynColumn", content: [paragraph("The left idea")] },
            { type: "orvynColumn", content: [paragraph("The right idea")] },
          ],
        },
        {
          type: "orvynCallout",
          attrs: { tone: "info" },
          content: [paragraph("A helpful note")],
        },
        {
          type: "orvynToggle",
          content: [
            {
              type: "orvynToggleSummary",
              content: [{ type: "text", text: "Details" }],
            },
            {
              type: "orvynToggleContent",
              content: [paragraph("Read these details")],
            },
          ],
        },
        {
          type: "orvynVideo",
          attrs: {
            provider: "youtube",
            resourceId: "dQw4w9WgXcQ",
            title: "A useful video",
          },
        },
        { type: "orvynWhiteboard", attrs: { pageId: inaccessible } },
      ],
    }),
    result = exportMarkdown(document, context(id)),
    restored = importMarkdown(result.markdown, {
      filename: "Readable.md",
      titleFromHeading: true,
    }).document;
  for (const value of [
    "The left idea",
    "The right idea",
    "A helpful note",
    "Read these details",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  ])
    assert.ok(result.markdown.includes(value));
  assert.ok(result.warnings.some((warning) => /Columns/.test(warning)));
  assert.ok(result.warnings.some((warning) => /expanded/.test(warning)));
  assert.ok(result.warnings.some((warning) => /static heading/.test(warning)));
  assert.ok(!result.markdown.includes(inaccessible));
  assert.ok(!JSON.stringify(restored).includes('"codeBlock"'));
});

test("Markdown export previews and downloads require current source and reference access without copying linked content", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      owner = await f.preview(),
      viewer = await f.preview(f.viewer.cookie);
    assert.equal(owner.response.status, 200, JSON.stringify(owner.data));
    assert.equal(viewer.response.status, 200, JSON.stringify(viewer.data));
    assert.ok(owner.data.markdown.includes("PRIVATE delivery details"));
    assert.ok(viewer.data.markdown.includes("A helpful guide"));
    assert.ok(!JSON.stringify(viewer.data).includes("PRIVATE"));
    assert.ok(!JSON.stringify(viewer.data).includes(f.hidden.id));
    assert.ok(viewer.data.markdown.includes("A related note"));
    const outsider = await account();
    assert.equal((await f.preview(outsider.cookie)).response.status, 404);
    assert.equal(
      (await f.download(viewer, outsider.cookie)).response.status,
      404,
    );
    assert.equal(
      (await f.download(owner, f.viewer.cookie)).response.status,
      409,
    );
    const file = await f.download(viewer, f.viewer.cookie);
    assert.equal(file.response.status, 200);
    assert.equal(file.data, viewer.data.markdown);
    assert.match(file.response.headers.get("content-type"), /^text\/markdown/);
    assert.equal(
      file.response.headers.get("cache-control"),
      "private, no-store",
    );
    assert.match(
      file.response.headers.get("content-disposition"),
      /attachment;.*filename\*=UTF-8''/,
    );
  } finally {
    await db.end();
  }
});

test("Markdown names require explicit opt-in and current source membership/read access, including on a reviewed download", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      anonymous = await f.preview(),
      named = await f.preview(f.cookie, "?includePeopleNames=true");
    assert.equal(named.response.status, 200, JSON.stringify(named.data));
    assert.ok(anonymous.data.markdown.includes("@person"));
    for (const identity of [
      f.owner.id,
      f.viewer.id,
      f.owner.email,
      f.viewer.email,
    ])
      assert.ok(!JSON.stringify(anonymous.data).includes(identity));
    assert.ok(named.data.markdown.includes(f.owner.email));
    assert.ok(named.data.markdown.includes(f.viewer.email));
    assert.equal(
      (await f.download(named, f.cookie, "&includePeopleNames=true")).response
        .status,
      200,
    );
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.space.id, f.viewer.id],
    );
    assert.equal(
      (await f.download(named, f.cookie, "&includePeopleNames=true")).response
        .status,
      409,
    );
    const current = await f.preview(f.cookie, "?includePeopleNames=true");
    assert.ok(!current.data.markdown.includes(f.viewer.email));
    assert.ok(current.data.markdown.includes("@person"));
    assert.equal((await f.download(anonymous)).response.status, 200);
  } finally {
    await db.end();
  }
});

test("Markdown downloads recheck reviewed bytes and access, sanitize filenames and export record documents without parent/schema data", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      old = await f.preview();
    await db.query(
      "UPDATE pages SET document=$2,version=version+1,title=$3,title_version=title_version+1 WHERE id=$1",
      [
        f.source.id,
        { type: "doc", content: [paragraph("A revised handover")] },
        "Überblick / O'Reilly\r\nnotes",
      ],
    );
    assert.equal((await f.download(old)).response.status, 409);
    const current = await f.preview(),
      file = await f.download(current);
    assert.equal(file.response.status, 200, JSON.stringify(file.data));
    assert.ok(!/[\\/\r\n]/.test(current.data.filename));
    assert.ok(file.response.headers.get("content-disposition").includes("%27"));
    assert.equal(file.data, current.data.markdown);
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      f.source.id,
    ]);
    assert.equal((await f.preview(f.viewer.cookie)).response.status, 404);
    assert.equal(
      (await f.download(current, f.viewer.cookie)).response.status,
      404,
    );
    const database = (
        await request(`spaces/${f.space.id}/databases`, {
          method: "POST",
          cookie: f.cookie,
          body: { name: "PRIVATE project directory" },
        })
      ).data,
      property = (
        await request(`databases/${database.id}/properties`, {
          method: "POST",
          cookie: f.cookie,
          body: { name: "PRIVATE budget", type: "Text" },
        })
      ).data,
      record = (
        await request(`databases/${database.id}/records`, {
          method: "POST",
          cookie: f.cookie,
          body: {
            title: "Launch note",
            values: { [property.id]: "PRIVATE commercial terms" },
          },
        })
      ).data;
    await db.query("UPDATE pages SET document=$2 WHERE id=$1", [
      record.pageId,
      { type: "doc", content: [paragraph("A useful page note")] },
    ]);
    const exported = await request(`pages/${record.pageId}/export/markdown`, {
      cookie: f.cookie,
    });
    assert.equal(exported.response.status, 200, JSON.stringify(exported.data));
    assert.ok(exported.data.markdown.includes("A useful page note"));
    assert.ok(!JSON.stringify(exported.data).includes("PRIVATE"));
    assert.ok(!JSON.stringify(exported.data).includes(database.id));
    assert.equal(
      (
        await request(`pages/${database.id}/export/markdown`, {
          cookie: f.cookie,
        })
      ).response.status,
      400,
    );
  } finally {
    await db.end();
  }
});

test("Markdown attachment links preserve exact ready-file permissions and never become anonymous grants", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      png = Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082",
        "hex",
      );
    async function upload(pageId, filename) {
      const data = new FormData();
      data.append("file", new Blob([png], { type: "image/png" }), filename);
      const response = await fetch(base + `/api/v1/pages/${pageId}/files`, {
          method: "POST",
          headers: { Cookie: f.cookie, Origin: base },
          body: data,
        }),
        file = await response.json();
      assert.equal(response.status, 201, JSON.stringify(file));
      return file;
    }
    const own = await upload(f.source.id, "A useful sketch.png"),
      secret = await upload(f.hidden.id, "PRIVATE diagram.png");
    await db.query(
      "UPDATE pages SET document=$2,version=version+1 WHERE id=$1",
      [
        f.source.id,
        {
          type: "doc",
          content: [
            {
              type: "orvynImage",
              attrs: { fileId: own.id, label: "A useful sketch" },
            },
            {
              type: "orvynFile",
              attrs: { fileId: secret.id, label: "PRIVATE diagram.png" },
            },
          ],
        },
      ],
    );
    const review = await f.preview(f.viewer.cookie);
    assert.equal(review.response.status, 200, JSON.stringify(review.data));
    assert.ok(review.data.markdown.includes(own.id));
    assert.ok(!JSON.stringify(review.data).includes(secret.id));
    assert.ok(!JSON.stringify(review.data).includes("PRIVATE"));
    const url = base + `/api/v1/files/${own.id}/download`;
    assert.equal((await fetch(url)).status, 401);
    const authorized = await fetch(url, {
      headers: { Cookie: f.viewer.cookie },
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(Buffer.from(await authorized.arrayBuffer()), png);
    const deleted = await request(`files/${own.id}`, {
      method: "DELETE",
      cookie: f.cookie,
      body: {},
    });
    assert.equal(deleted.response.status, 200, JSON.stringify(deleted.data));
    assert.equal(
      (await f.download(review, f.viewer.cookie)).response.status,
      409,
    );
  } finally {
    await db.end();
  }
});

test("Chromium: export previews ignore late options, reject a concurrent change, refresh and download reviewed Markdown with a shortcut on mobile", async () => {
  const { chromium, expect } = await import("@playwright/test"),
    db = new Pool({ connectionString: process.env.DATABASE_URL });
  let browser;
  try {
    const f = await fixture(db);
    browser = await chromium.launch({
      executablePath: "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const owner = await browser.newContext({
      viewport: { width: 1365, height: 1000 },
    });
    await owner.addCookies([
      { name: "orvyn_session", value: f.cookie.split("=")[1], url: base },
    ]);
    const page = await owner.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base + "/?page=" + f.source.id);
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue(f.source.title);
    await page
      .getByRole("button", { name: "Page actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Export Markdown", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
        name: "Export Markdown",
        exact: true,
      }),
      content = dialog.getByRole("textbox", {
        name: "Exported Markdown",
        exact: true,
      });
    await expect.poll(() => content.inputValue()).toContain("@person");
    assert.ok(!(await content.inputValue()).includes(f.owner.email));
    let arrived, release;
    const held = new Promise((resolve) => (arrived = resolve)),
      gate = new Promise((resolve) => (release = resolve)),
      routePath = "**/api/v1/" + f.path + "*";
    await page.route(routePath, async (route) => {
      if (
        new URL(route.request().url()).searchParams.get(
          "includePeopleNames",
        ) === "false"
      ) {
        const response = await route.fetch();
        arrived();
        await gate;
        return route.fulfill({ response });
      }
      return route.continue();
    });
    try {
      await dialog
        .getByRole("button", { name: "Refresh", exact: true })
        .click();
      await held;
      await dialog
        .getByRole("checkbox", { name: /^Include visible people names/ })
        .check();
      await expect.poll(() => content.inputValue()).toContain(f.owner.email);
      const oldResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/v1/" + f.path &&
          new URL(response.url()).searchParams.get("includePeopleNames") ===
            "false",
      );
      release();
      await (await oldResponse).finished();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await expect.poll(() => content.inputValue()).toContain(f.owner.email);
    } finally {
      release();
      await page.unroute(routePath);
    }
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/markdown-export-dialog.png",
      fullPage: true,
    });
    const collaborator = await browser.newContext({
      viewport: { width: 1365, height: 900 },
    });
    await collaborator.addCookies([
      { name: "orvyn_session", value: f.cookie.split("=")[1], url: base },
    ]);
    const remote = await collaborator.newPage();
    await remote.goto(base + "/?page=" + f.source.id);
    await remote
      .getByRole("textbox", { name: "Document", exact: true })
      .fill("A revised handover from the team.");
    await expect
      .poll(
        async () =>
          (await request(`pages/${f.source.id}`, { cookie: f.cookie })).data
            .document.content[0]?.content?.[0]?.text,
      )
      .toBe("A revised handover from the team.");
    await dialog
      .getByRole("button", { name: "Download .md", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "The saved page or linked access changed. Refresh the export before downloading.",
    );
    await expect(
      dialog.getByRole("button", { name: "Download .md", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect
      .poll(() => content.inputValue())
      .toContain("A revised handover from the team.");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: ".local/ui-review/markdown-export-mobile.png",
      fullPage: true,
    });
    const expected = await content.inputValue(),
      saved = page.waitForEvent("download");
    await content.focus();
    await page.keyboard.press("Control+Enter");
    const download = await saved;
    assert.equal(download.suggestedFilename(), "A calmer handover.md");
    assert.equal(await readFile(await download.path(), "utf8"), expected);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await db.end();
  }
});

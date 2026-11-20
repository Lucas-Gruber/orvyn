import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { posix } from "node:path";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import {
  bundleSegment,
  bundleRelative,
  uniqueSegment,
} from "../apps/api/dist/imports/markdown-bundle-paths.js";
import {
  markdownHeadingAnchors,
  exportMarkdown,
} from "../packages/editor/dist/markdown-export.js";
import { normalizeDocument } from "../packages/editor/dist/index.js";
import { importMarkdown } from "../packages/editor/dist/markdown.js";
import { documentHeadings } from "../packages/editor/dist/links.js";
import { pageLink } from "../packages/editor/dist/links.js";
const require = createRequire(
    new URL("../apps/api/package.json", import.meta.url),
  ),
  { unzipSync, strFromU8 } = require("fflate"),
  paragraph = (text) => ({
    type: "paragraph",
    content: text ? [{ type: "text", text }] : [],
  }),
  png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmqkAAAAASUVORK5CYII=",
    "base64",
  );
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
async function account() {
  const registered = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(registered.response);
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
        body: { name: "Knowledge studio" },
      })
    ).data;
  await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
  await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
    space.id,
    viewer.id,
  ]);
  async function page(title, parentId = null, kind = "page") {
    const result = await request(`spaces/${space.id}/pages`, {
      method: "POST",
      cookie,
      body: { title, parentId, kind },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  const root = await page("Studio handbook", null, "folder"),
    first = await page("Getting started", root.id),
    second = await page("Working together", root.id),
    nested = await page("Review checklist", second.id),
    hidden = await page("PRIVATE strategy", root.id),
    external = await page("Reference guide");
  const database = (
    await request(`spaces/${space.id}/databases`, {
      method: "POST",
      cookie,
      body: { name: "Structured projects", parentId: root.id },
    })
  ).data;
  await request(`databases/${database.id}/records`, {
    method: "POST",
    cookie,
    body: { title: "A database record outside this export" },
  });
  await page("A separate drawing", root.id, "whiteboard");
  await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
    hidden.id,
  ]);
  const heading = randomUUID(),
    duplicate = randomUUID();
  await db.query(
    "UPDATE pages SET document=$2,document_schema_version=13 WHERE id=$1",
    [
      second.id,
      normalizeDocument({
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { id: heading, level: 2 },
            content: [{ type: "text", text: "Next step" }],
          },
          paragraph("Keep the context clear."),
          {
            type: "heading",
            attrs: { id: duplicate, level: 3 },
            content: [{ type: "text", text: "Next step" }],
          },
        ],
      }),
    ],
  );
  const form = new FormData();
  form.append(
    "file",
    new Blob([png], { type: "image/png" }),
    "Team diagram.png",
  );
  const upload = await fetch(base + `/api/v1/pages/${first.id}/files`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: process.env.TEST_ORIGIN || base },
    body: form,
  });
  assert.equal(upload.status, 201);
  const file = await upload.json();
  const hiddenForm = new FormData();
  hiddenForm.append(
    "file",
    new Blob([Buffer.from("PRIVATE bytes")]),
    "PRIVATE attachment.txt",
  );
  const hiddenFile = await (
    await fetch(base + `/api/v1/pages/${hidden.id}/files`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: process.env.TEST_ORIGIN || base },
      body: hiddenForm,
    })
  ).json();
  await db.query(
    "UPDATE pages SET document=$2,document_schema_version=13 WHERE id=$1",
    [
      first.id,
      normalizeDocument({
        type: "doc",
        content: [
          paragraph("A useful place to begin."),
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "The next step",
                marks: [
                  {
                    type: "link",
                    attrs: { href: pageLink(second.id, duplicate) },
                  },
                ],
              },
            ],
          },
          {
            type: "orvynPagePreview",
            attrs: { pageId: second.id, headingId: heading },
          },
          {
            type: "orvynPagePreview",
            attrs: { pageId: external.id, headingId: null },
          },
          {
            type: "orvynPagePreview",
            attrs: { pageId: hidden.id, headingId: null },
          },
          {
            type: "orvynImage",
            attrs: { fileId: file.id, alt: "A team diagram" },
          },
          { type: "orvynFile", attrs: { fileId: hiddenFile.id } },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Prepared by " },
              { type: "orvynPerson", attrs: { userId: owner.id } },
            ],
          },
        ],
      }),
    ],
  );
  const ids = [root.id, first.id, second.id, nested.id],
    input = {
      pageIds: ids,
      includeAttachments: true,
      includePeopleNames: false,
    },
    preview = (body = input, actor = viewer.cookie) =>
      request(`pages/${root.id}/export/bundle/preview`, {
        method: "POST",
        cookie: actor,
        body,
      }),
    download = (result, body = input, actor = viewer.cookie) =>
      fetch(base + `/api/v1/pages/${root.id}/export/bundle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: actor,
          Origin: process.env.TEST_ORIGIN || base,
        },
        body: JSON.stringify({ ...body, review: result.data.digest }),
      });
  return {
    owner,
    viewer,
    cookie,
    space,
    root,
    first,
    second,
    nested,
    hidden,
    external,
    file,
    hiddenFile,
    heading,
    duplicate,
    page,
    ids,
    input,
    preview,
    download,
  };
}
test("portable Markdown paths reject traversal/device names, deduplicate Unicode names and generate unique cross-page heading anchors", () => {
  for (const input of [
    "../..",
    "C:\\escape/../CON",
    "con.txt",
    "NUL",
    "a".repeat(47) + ".x",
    "<script>",
    "\u202eevil",
    "😀".repeat(80),
  ]) {
    const value = bundleSegment(input);
    assert.ok(value && !/[\\/:*?"<>|\u202e]/.test(value));
    assert.ok(!/[. ]$/.test(value));
    assert.ok(!/^(con|nul)(\.|$)/i.test(value));
    assert.ok(!/[\uD800-\uDFFF]/u.test(value));
  }
  assert.equal(
    bundleRelative("Handbook/First/index.md", "Handbook/Team notes/index.md"),
    "../Team%20notes/index.md",
  );
  const ids = [randomUUID(), randomUUID(), randomUUID()],
    document = normalizeDocument({
      type: "doc",
      content: ["Next", "Next-1", "Next"].map((text, index) => ({
        type: "heading",
        attrs: { id: ids[index], level: 2 },
        content: [{ type: "text", text }],
      })),
    }),
    anchors = markdownHeadingAnchors(document, "Document");
  assert.deepEqual([...anchors.values()], ["next", "next-1", "next-2"]);
  const collisions = importMarkdown(
      "# Document\n\n## Next\n\n## Next-1\n\n## Next\n\n[First](#next) [Second](#next-1) [Third](#next-2)",
      { filename: "Document.md", titleFromHeading: true },
    ),
    importedHeadings = documentHeadings(collisions.document),
    links = collisions.document.content
      .at(-1)
      .content.filter((node) =>
        node.marks?.some((mark) => mark.type === "link"),
      )
      .map(
        (node) => node.marks.find((mark) => mark.type === "link").attrs.href,
      );
  assert.deepEqual(
    links.map((href) => href.split("#h-")[1]),
    importedHeadings.map((heading) => heading.id),
  );
  const names = new Set();
  assert.equal(uniqueSegment("Guide.pdf", names, true), "Guide.pdf");
  assert.equal(uniqueSegment("guide.pdf", names, true), "guide - 2.pdf");
  assert.ok(
    uniqueSegment("a".repeat(80) + ".png", names, true).endsWith(".png"),
  );
  const result = exportMarkdown(
    normalizeDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Open next",
              marks: [
                { type: "link", attrs: { href: pageLink(ids[0], ids[1]) } },
              ],
            },
          ],
        },
      ],
    }),
    {
      title: "Source",
      pageUrl: base + pageLink(randomUUID()),
      page: () => ({
        title: "Next",
        href: "../Next/index.md#next-1",
        headingAvailable: true,
      }),
      file: () => undefined,
      person: () => undefined,
      includePeopleNames: false,
    },
  );
  assert.ok(result.markdown.includes("../Next/index.md#next-1"));
  assert.ok(
    !result.warnings.some((warning) => /unavailable heading/.test(warning)),
  );
});
test("Markdown hierarchy ZIP exports only the reviewed readable selection, relative heading/page links and independent attachment bytes", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      tree = await request(`pages/${f.root.id}/export/tree`, {
        cookie: f.viewer.cookie,
      });
    assert.equal(tree.response.status, 200);
    assert.equal(tree.data.pages[0].parentId, null);
    assert.deepEqual(
      new Set(tree.data.pages.map((page) => page.id)),
      new Set(f.ids),
    );
    assert.ok(!JSON.stringify(tree.data).includes("PRIVATE"));
    const preview = await f.preview();
    assert.equal(preview.response.status, 201, JSON.stringify(preview.data));
    assert.equal(preview.data.files.length, 1);
    assert.equal(preview.data.pages.length, 4);
    for (const secret of [
      "PRIVATE",
      f.hidden.id,
      f.hiddenFile.id,
      f.owner.id,
      f.owner.email,
    ])
      assert.ok(!JSON.stringify(preview.data).includes(secret));
    const response = await f.download(preview);
    assert.equal(response.status, 201);
    assert.match(response.headers.get("content-type"), /^application\/zip/);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const zip = unzipSync(new Uint8Array(await response.arrayBuffer())),
      manifest = JSON.parse(strFromU8(zip["manifest.json"]));
    assert.equal(manifest.pages.length, 4);
    assert.equal(manifest.files.length, 1);
    assert.equal(
      manifest.pages.find((page) => page.title === f.nested.title).parent,
      preview.data.pages.find((page) => page.id === f.second.id).path,
    );
    const text = strFromU8(
      zip[preview.data.pages.find((page) => page.id === f.first.id).path],
    );
    assert.ok(text.includes("../Working%20together/index.md#next-step-1"));
    assert.ok(text.includes("../Working%20together/index.md#next-step"));
    assert.ok(text.includes("../_attachments/Team%20diagram.png"));
    assert.ok(text.includes(f.external.id));
    assert.ok(!text.includes("PRIVATE"));
    assert.ok(!text.includes(f.hidden.id));
    assert.ok(!text.includes(f.owner.email));
    assert.ok(!text.includes(f.file.id));
    assert.deepEqual(Buffer.from(zip[preview.data.files[0].path]), png);
    const allText = Object.values(zip)
      .map((bytes) => Buffer.from(bytes).toString())
      .join("\n");
    assert.ok(!allText.includes("PRIVATE"));
    const noFiles = { ...f.input, includeAttachments: false },
      linked = await f.preview(noFiles),
      linkedResponse = await f.download(linked, noFiles),
      linkedZip = unzipSync(new Uint8Array(await linkedResponse.arrayBuffer()));
    assert.equal(linked.data.files.length, 0);
    assert.ok(
      strFromU8(
        linkedZip[
          linked.data.pages.find((page) => page.id === f.first.id).path
        ],
      ).includes(`/api/v1/files/${f.file.id}/download`),
    );
    const names = { ...f.input, includePeopleNames: true },
      named = await f.preview(names),
      namedZip = unzipSync(
        new Uint8Array(await (await f.download(named, names)).arrayBuffer()),
      );
    assert.ok(
      strFromU8(
        namedZip[named.data.pages.find((page) => page.id === f.first.id).path],
      ).includes(f.owner.email),
    );
  } finally {
    await db.end();
  }
});
test("bundle reviews bind content, selection, independent file/page access and current authentication without exporting unselected ancestors", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      original = await f.preview();
    assert.equal(
      (await request(`pages/${f.root.id}/export/tree`)).response.status,
      401,
    );
    const outsider = await account();
    assert.equal(
      (await f.preview(f.input, outsider.cookie)).response.status,
      404,
    );
    assert.equal(
      (await f.preview({ ...f.input, pageIds: [...f.ids, f.hidden.id] }))
        .response.status,
      404,
    );
    assert.equal(
      (await f.preview({ ...f.input, pageIds: [f.first.id] })).response.status,
      400,
    );
    assert.equal(
      (await f.preview({ ...f.input, pageIds: [...f.ids, f.first.id] }))
        .response.status,
      400,
    );
    assert.equal(
      (await f.preview({ ...f.input, pageIds: [...f.ids, f.external.id] }))
        .response.status,
      404,
    );
    assert.equal(
      (
        await request(`pages/${f.root.id}/export/bundle/preview`, {
          method: "POST",
          cookie: f.cookie,
          body: f.input,
          origin: "https://elsewhere.invalid",
        })
      ).response.status,
      403,
    );
    await db.query("UPDATE pages SET title='A revised next step' WHERE id=$1", [
      f.second.id,
    ]);
    assert.equal((await f.download(original)).status, 409);
    const fresh = await f.preview();
    assert.equal(
      (await f.download(fresh, { ...f.input, includeAttachments: false }))
        .status,
      409,
    );
    await db.query(
      "UPDATE files SET state='deleted',deleted_at=now() WHERE id=$1",
      [f.file.id],
    );
    assert.equal((await f.download(fresh)).status, 409);
    const sparse = {
        ...f.input,
        pageIds: [f.root.id, f.nested.id],
        includeAttachments: false,
      },
      sparseReview = await f.preview(sparse);
    assert.equal(sparseReview.response.status, 201);
    assert.ok(
      !JSON.stringify(sparseReview.data).includes("A revised next step"),
    );
    assert.equal(
      sparseReview.data.pages.find((page) => page.id === f.nested.id).path,
      "Studio handbook/Review checklist/index.md",
    );
    const restricted = await f.preview();
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      f.second.id,
    ]);
    assert.equal((await f.download(restricted)).status, 404);
    const current = await f.preview({
      pageIds: [f.root.id],
      includeAttachments: false,
      includePeopleNames: false,
    });
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.space.id, f.viewer.id],
    );
    assert.equal(
      (
        await f.download(current, {
          pageIds: [f.root.id],
          includeAttachments: false,
          includePeopleNames: false,
        })
      ).status,
      404,
    );
  } finally {
    await db.end();
  }
});
test("bundle paths remain distinct on case-insensitive filesystems, preserve selected hierarchy and bound oversized copies", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let changedFile;
  try {
    const f = await fixture(db),
      one = await f.page("CON", f.root.id),
      two = await f.page("con", f.root.id),
      three = await f.page("../..", f.root.id),
      four = await f.page("<img src=x onerror=alert(1)>", f.root.id),
      input = {
        ...f.input,
        pageIds: [...f.ids, one.id, two.id, three.id, four.id],
      },
      result = await f.preview(input);
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    const response = await f.download(result, input),
      zip = unzipSync(new Uint8Array(await response.arrayBuffer())),
      names = Object.keys(zip);
    assert.equal(
      new Set(names.map((path) => path.toLowerCase())).size,
      names.length,
    );
    assert.ok(
      !names.some(
        (path) => posix.isAbsolute(path) || path.split("/").includes(".."),
      ),
    );
    assert.ok(!strFromU8(zip[result.data.pages[0].path]).includes("<img"));
    changedFile = f.file.id;
    await db.query("UPDATE files SET size=$2 WHERE id=$1", [
      f.file.id,
      33 * 1024 * 1024,
    ]);
    assert.equal((await f.preview()).response.status, 400);
    const noCopies = { ...f.input, includeAttachments: false };
    assert.equal((await f.preview(noCopies)).response.status, 201);
  } finally {
    if (changedFile)
      await db.query("UPDATE files SET size=$2 WHERE id=$1", [
        changedFile,
        png.length,
      ]);
    await db.end();
  }
});
test("bundle selection/file bounds exclude other page kinds and never expand an oversized request or archive silently", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let fakeFiles = [],
    changedFile;
  try {
    const f = await fixture(db);
    await db.query(
      "INSERT INTO pages(space_id,parent_id,title,kind,created_by,last_edited_by) SELECT $1,$2,'Note '||n,'page',$3,$3 FROM generate_series(1,501) AS n",
      [f.space.id, f.root.id, f.owner.id],
    );
    const result = await request(`pages/${f.root.id}/export/tree`, {
      cookie: f.viewer.cookie,
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.data.pages.length, 500);
    assert.equal(result.data.truncated, true);
    const firstHundred = {
      ...f.input,
      pageIds: result.data.pages.slice(0, 100).map((page) => page.id),
      includeAttachments: false,
    };
    assert.equal((await f.preview(firstHundred)).response.status, 201);
    assert.equal(
      (
        await f.preview({
          ...firstHundred,
          pageIds: result.data.pages.slice(0, 101).map((page) => page.id),
        })
      ).response.status,
      400,
    );
    const rows = (
      await db.query(
        "INSERT INTO files(page_id,object_key,filename,media_type,size,state,uploaded_by) SELECT $1,'limit-test/'||gen_random_uuid(),'copy '||n||'.txt','application/octet-stream',1,'ready',$2 FROM generate_series(1,100) AS n RETURNING id",
        [f.first.id, f.owner.id],
      )
    ).rows;
    fakeFiles = rows.map((file) => file.id);
    changedFile = f.file.id;
    await db.query("UPDATE pages SET document=$2 WHERE id=$1", [
      f.first.id,
      {
        type: "doc",
        content: [f.file, ...rows].map((file) => ({
          type: "orvynFile",
          attrs: { fileId: file.id },
        })),
      },
    ]);
    const withFiles = { ...f.input, pageIds: [f.root.id, f.first.id] };
    assert.equal((await f.preview(withFiles)).response.status, 400);
    assert.equal(
      (await f.preview({ ...withFiles, includeAttachments: false })).response
        .status,
      201,
    );
    await db.query("UPDATE pages SET document=$2 WHERE id=$1", [
      f.first.id,
      {
        type: "doc",
        content: [{ type: "orvynFile", attrs: { fileId: f.file.id } }],
      },
    ]);
    await db.query("UPDATE files SET size=$2 WHERE id=$1", [
      f.file.id,
      32 * 1024 * 1024,
    ]);
    assert.equal(
      (await f.preview(withFiles)).response.status,
      400,
      "Markdown and manifest bytes share the attachment budget",
    );
  } finally {
    await db.query("DELETE FROM files WHERE id=ANY($1::uuid[])", [fakeFiles]);
    if (changedFile)
      await db.query("UPDATE files SET size=$2 WHERE id=$1", [
        changedFile,
        png.length,
      ]);
    await db.end();
  }
});
test("Chromium: choose a page hierarchy, review file paths, reject changed content and late options, refresh and download a real ZIP on desktop and mobile", async () => {
  const { chromium } = await import("@playwright/test"),
    db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
  const treeGate = deferred(),
    treeReached = deferred(),
    previewGate = deferred(),
    previewReached = deferred();
  try {
    const f = await fixture(db),
      context = await browser.newContext({
        viewport: { width: 1365, height: 1050 },
        acceptDownloads: true,
      });
    await context.addCookies([
      {
        name: "orvyn_session",
        value: f.viewer.cookie.split("=")[1],
        url: base,
      },
    ]);
    const page = await context.newPage();
    await page.route(
      "**/export/tree",
      async (route) => {
        const response = await route.fetch();
        treeReached.resolve();
        await treeGate.promise;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    await page.goto(base + pageLink(f.root.id));
    await page
      .getByRole("button", { name: "Page actions", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Export pages as ZIP" }).click();
    const dialog = page.getByRole("dialog", {
      name: "Export pages",
      exact: true,
    });
    await treeReached.promise;
    await dialog
      .getByRole("checkbox", { name: /Include visible people names/ })
      .check();
    await dialog
      .getByRole("checkbox", { name: /Include visible people names/ })
      .uncheck();
    treeGate.resolve();
    await dialog
      .getByRole("button", { name: "Review export", exact: true })
      .waitFor();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '[aria-label="Pages to export"] input:checked',
        ).length === 4,
    );
    assert.ok(!(await dialog.textContent()).includes("PRIVATE"));
    await page.route(
      "**/export/bundle/preview",
      async (route) => {
        const response = await route.fetch();
        previewReached.resolve();
        await previewGate.promise;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    await dialog
      .getByRole("button", { name: "Review export", exact: true })
      .click();
    await previewReached.promise;
    await dialog
      .getByRole("checkbox", { name: /Copy embedded images and files/ })
      .uncheck();
    const settled = page.waitForResponse((response) =>
      response.url().endsWith("/export/bundle/preview"),
    );
    previewGate.resolve();
    await (await settled).finished();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: "Download ZIP", exact: true })
        .count(),
      0,
    );
    await dialog
      .getByRole("checkbox", { name: /Copy embedded images and files/ })
      .check();
    await dialog
      .getByRole("button", { name: "Review export", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Download ZIP", exact: true })
      .waitFor();
    await dialog
      .getByText("Files and conversion notes", { exact: true })
      .click();
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/markdown-bundle-review.png",
    });
    await db.query("UPDATE pages SET title='Updated checklist' WHERE id=$1", [
      f.nested.id,
    ]);
    await dialog
      .getByRole("button", { name: "Download ZIP", exact: true })
      .click();
    await dialog.getByRole("alert").filter({ hasText: "changed" }).waitFor();
    await dialog
      .getByRole("button", { name: "Review export", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Download ZIP", exact: true })
      .waitFor();
    const downloadPromise = page.waitForEvent("download");
    await dialog
      .getByRole("button", { name: "Download ZIP", exact: true })
      .click();
    const download = await downloadPromise;
    await download.saveAs(".local/ui-review/markdown-bundle-sample.zip");
    assert.equal(download.suggestedFilename(), "Studio handbook.zip");
    const zip = unzipSync(
      new Uint8Array(await readFile(await download.path())),
    );
    assert.ok(strFromU8(zip["manifest.json"]).includes("Updated checklist"));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: ".local/ui-review/markdown-bundle-mobile.png",
    });
    assert.ok(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    );
    await dialog
      .getByRole("button", { name: "Starting page only", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Review export", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Download ZIP", exact: true })
      .waitFor();
    const onePromise = page.waitForEvent("download");
    await dialog
      .getByRole("button", { name: "Download ZIP", exact: true })
      .focus();
    await page.keyboard.press("Control+Enter");
    const one = await onePromise,
      oneZip = unzipSync(new Uint8Array(await readFile(await one.path())));
    assert.equal(
      JSON.parse(strFromU8(oneZip["manifest.json"])).pages.length,
      1,
    );
  } finally {
    treeGate.resolve();
    previewGate.resolve();
    await browser.close();
    await db.end();
  }
});

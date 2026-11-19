import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
const text = (value) => ({
  type: "paragraph",
  content: [{ type: "text", text: value }],
});
async function account() {
  const r = await request("auth/register", {
    method: "POST",
    body: { email: randomUUID() + "@example.test", password: randomUUID() },
  });
  assert.equal(r.response.status, 201);
  const cookie = sessionCookie(r.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
export async function publicationFixture(db) {
  const owner = await account(),
    viewer = await account(),
    space = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Studio handbook" },
      })
    ).data;
  await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
  await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
    space.id,
    viewer.id,
  ]);
  async function create(
    title,
    content = [text("A calm place to work.")],
    parentId = null,
    kind = "page",
  ) {
    const r = await request(`spaces/${space.id}/pages`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title, parentId, kind },
    });
    assert.equal(r.response.status, 201, JSON.stringify(r.data));
    if (kind !== "whiteboard")
      await db.query("UPDATE pages SET document=$2 WHERE id=$1", [
        r.data.id,
        { type: "doc", content },
      ]);
    return r.data;
  }
  const root = await create("The studio handbook"),
    child = await create(
      "Working together",
      [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Our rhythm" }],
        },
        text("Start with a clear question. Make room for focused work."),
      ],
      root.id,
    ),
    secret = await create(
      "PRIVATE payroll",
      [text("NEVER PUBLISH salary records")],
      root.id,
    );
  const input = {
    scope: { pageIds: [child.id], databases: [], extraFileIds: [] },
    settings: {
      label: "Team handbook",
      passwordProtected: false,
      indexable: false,
      expiresAt: null,
    },
    target: null,
  };
  const path = `pages/${root.id}/publications`;
  async function preview(value = input, cookie = owner.cookie) {
    return request(path + "/preview", { method: "POST", cookie, body: value });
  }
  async function publish(value = input) {
    const review = await preview(value);
    assert.equal(review.response.status, 201, JSON.stringify(review.data));
    const body = {
      requestId: randomUUID(),
      previewToken: review.data.previewToken,
      input: value,
    };
    const result = await request(path, {
      method: "POST",
      cookie: owner.cookie,
      body,
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return {
      ...result.data,
      token: new URL(result.data.url).pathname.split("/").at(-1),
      body,
    };
  }
  return {
    owner,
    viewer,
    space,
    root,
    child,
    secret,
    input,
    path,
    create,
    preview,
    publish,
  };
}
test("publications publish only reviewed pages, sanitize private references and preserve cross-page heading destinations", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await publicationFixture(db);
    await db.query("UPDATE pages SET document=$2 WHERE id=$1", [
      f.root.id,
      {
        type: "doc",
        content: [
          text("Welcome to the studio."),
          { type: "orvynPagePreview", attrs: { pageId: f.secret.id } },
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Read the working rhythm",
                marks: [
                  { type: "link", attrs: { href: "/?page=" + f.child.id } },
                ],
              },
              {
                type: "text",
                text: "Internal notes",
                marks: [
                  { type: "link", attrs: { href: "/?page=" + f.secret.id } },
                ],
              },
            ],
          },
          { type: "orvynPerson", attrs: { userId: f.viewer.id } },
        ].filter((n) => n.type !== "orvynPerson"),
      },
    ]);
    assert.equal(
      (await f.preview(f.input, f.viewer.cookie)).response.status,
      404,
    );
    const review = await f.preview();
    assert.equal(review.response.status, 201, JSON.stringify(review.data));
    assert.equal(review.data.snapshot.pages.length, 2);
    assert.equal(review.data.warnings.excludedBlocks, 1);
    const pub = await f.publish(),
      read = await request("publications/" + pub.token);
    assert.equal(read.response.status, 200);
    const raw = JSON.stringify(read.data);
    assert.ok(!raw.includes(f.secret.id));
    assert.ok(!raw.includes("payroll"));
    assert.ok(raw.includes("?page=" + f.child.id));
    assert.match(
      read.data.snapshot.pages.find((p) => p.id === f.child.id).document
        .content[0].attrs.id,
      /^legacy-/,
    );
    assert.equal(read.response.headers.get("referrer-policy"), "no-referrer");
    assert.match(read.response.headers.get("x-robots-tag"), /noindex/);
    assert.equal((await request("pages/" + f.root.id)).response.status, 401);
    await db.query(
      "UPDATE pages SET document=$2,version=version+1 WHERE id=$1",
      [f.child.id, { type: "doc", content: [text("Unreviewed change")] }],
    );
    assert.ok(
      !JSON.stringify(
        (await request("publications/" + pub.token)).data,
      ).includes("Unreviewed change"),
    );
    const stale = await request(f.path, {
      method: "POST",
      cookie: f.owner.cookie,
      body: {
        requestId: randomUUID(),
        previewToken: review.data.previewToken,
        input: f.input,
      },
    });
    assert.equal(stale.response.status, 409);
    const tamper = structuredClone(pub.body);
    tamper.input.settings.indexable = true;
    tamper.requestId = randomUUID();
    assert.equal(
      (
        await request(f.path, {
          method: "POST",
          cookie: f.owner.cookie,
          body: tamper,
        })
      ).response.status,
      409,
    );
    const retry = await request(f.path, {
      method: "POST",
      cookie: f.owner.cookie,
      body: pub.body,
    });
    assert.equal(retry.response.status, 201);
    assert.equal(retry.data.id, pub.id);
  } finally {
    await db.end();
  }
});
test("publications password gates, expiry, disabling, reviewed updates and permanent revocation protect every anonymous read", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await publicationFixture(db),
      input = structuredClone(f.input);
    input.settings.passwordProtected = true;
    input.settings.password = "private-test-link";
    const pub = await f.publish(input),
      endpoint = "publications/" + pub.token;
    const locked = await request(endpoint);
    assert.equal(locked.response.status, 401);
    assert.equal(locked.data.passwordRequired, true);
    assert.ok(!JSON.stringify(locked.data).includes(f.root.title));
    assert.equal(
      (
        await request(endpoint + "/unlock", {
          method: "POST",
          body: { password: "wrong" },
        })
      ).response.status,
      403,
    );
    assert.equal(
      (
        await request(endpoint + "/unlock", {
          method: "POST",
          origin: "https://evil.test",
          body: { password: input.settings.password },
        })
      ).response.status,
      403,
    );
    const unlocked = await request(endpoint + "/unlock", {
      method: "POST",
      body: { password: input.settings.password },
    });
    assert.equal(unlocked.response.status, 201);
    const gate = unlocked.response.headers.getSetCookie()[0].split(";")[0];
    assert.equal(
      (await request(endpoint, { cookie: gate })).response.status,
      200,
    );
    const changed = await request(f.path + "/" + pub.id, {
      method: "PATCH",
      cookie: f.owner.cookie,
      body: { version: pub.version, enabled: false },
    });
    assert.equal(changed.response.status, 200);
    assert.equal(
      (await request(endpoint, { cookie: gate })).response.status,
      404,
    );
    const enabled = await request(f.path + "/" + pub.id, {
      method: "PATCH",
      cookie: f.owner.cookie,
      body: { version: changed.data.version, enabled: true },
    });
    assert.equal(enabled.response.status, 200);
    assert.equal(
      (await request(endpoint, { cookie: gate })).response.status,
      401,
    );
    const update = structuredClone(input);
    delete update.settings.password;
    update.target = { id: pub.id, version: enabled.data.version };
    const updated = await f.publish(update);
    assert.equal(updated.id, pub.id);
    assert.equal(updated.url, pub.url);
    await db.query(
      "UPDATE publications SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [pub.id],
    );
    assert.equal((await request(endpoint)).response.status, 404);
    await db.query("UPDATE publications SET expires_at=NULL WHERE id=$1", [
      pub.id,
    ]);
    assert.equal(
      (
        await request(f.path + "/" + pub.id, {
          method: "DELETE",
          body: {},
          cookie: f.owner.cookie,
        })
      ).response.status,
      200,
    );
    assert.equal((await request(endpoint)).response.status, 404);
    assert.equal(
      (
        await request(f.path + "/" + pub.id, {
          method: "PATCH",
          cookie: f.owner.cookie,
          body: { version: updated.version + 1, enabled: true },
        })
      ).response.status,
      409,
    );
  } finally {
    await db.end();
  }
});
test("source and ancestor policy changes revoke publications permanently even when access is later restored", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await publicationFixture(db),
      parent = await f.create("Private parent"),
      child = await f.create(
        "Selected descendant",
        [text("A selected leaf")],
        parent.id,
      );
    const input = structuredClone(f.input);
    input.scope.pageIds = [child.id];
    const pub = await f.publish(input);
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      parent.id,
    ]);
    assert.equal(
      (await request("publications/" + pub.token)).response.status,
      404,
    );
    await db.query("UPDATE pages SET visibility='space' WHERE id=$1", [
      parent.id,
    ]);
    assert.equal(
      (await request("publications/" + pub.token)).response.status,
      404,
    );
    const fresh = await f.publish(input);
    await db.query("DELETE FROM pages WHERE id=$1", [child.id]);
    assert.equal(
      (await request("publications/" + fresh.token)).response.status,
      404,
    );
  } finally {
    await db.end();
  }
});
test("public attachment grants never expose unselected foreign files and disappear with the source permission", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await publicationFixture(db),
      payload = "A deliberately selected attachment";
    const data = new FormData();
    data.append(
      "file",
      new Blob([payload], { type: "text/plain" }),
      "notes.txt",
    );
    const upload = await fetch(
      base + "/api/v1/pages/" + f.secret.id + "/files",
      {
        method: "POST",
        headers: { Origin: process.env.TEST_ORIGIN, Cookie: f.owner.cookie },
        body: data,
      },
    );
    assert.equal(upload.status, 201);
    const file = await upload.json();
    await db.query("UPDATE pages SET document=$2 WHERE id=$1", [
      f.root.id,
      {
        type: "doc",
        content: [
          { type: "orvynFile", attrs: { fileId: file.id, label: "Notes" } },
        ],
      },
    ]);
    const pub = await f.publish();
    assert.equal(
      (await request("publications/" + pub.token + "/files/" + file.id))
        .response.status,
      404,
    );
    assert.ok(
      !JSON.stringify(
        (await request("publications/" + pub.token)).data,
      ).includes(file.id),
    );
    const explicit = structuredClone(f.input);
    explicit.scope.extraFileIds = [file.id];
    explicit.settings.passwordProtected = true;
    explicit.settings.password = "attachment-test";
    const selected = await f.publish(explicit),
      endpoint = "publications/" + selected.token;
    assert.equal(
      (await request(endpoint + "/files/" + file.id)).response.status,
      401,
    );
    const unlock = await request(endpoint + "/unlock", {
        method: "POST",
        body: { password: explicit.settings.password },
      }),
      cookie = unlock.response.headers.getSetCookie()[0].split(";")[0];
    const download = await request(endpoint + "/files/" + file.id, { cookie });
    assert.equal(download.response.status, 200);
    assert.equal(download.data, payload);
    assert.match(
      download.response.headers.get("content-disposition"),
      /^attachment/,
    );
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      f.secret.id,
    ]);
    assert.equal(
      (await request(endpoint + "/files/" + file.id, { cookie })).response
        .status,
      404,
    );
  } finally {
    await db.end();
  }
});

test("publication UI reviews an explicit scope, serves anonymous page navigation without private requests and remains usable on mobile", async () => {
  const { chromium, expect } = await import("./browser-tools.mjs"),
    { mkdir } = await import("node:fs/promises");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let browser;
  try {
    const f = await publicationFixture(db),
      heading = randomUUID();
    await db.query("UPDATE pages SET document=$2,icon=$3 WHERE id=$1", [
      f.child.id,
      {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2, id: heading },
            content: [{ type: "text", text: "Our working rhythm" }],
          },
          text(
            "Make room for focused work. Share progress early, and leave a little space to think.",
          ),
          {
            type: "orvynCallout",
            attrs: { tone: "info" },
            content: [
              text(
                "A good handover tells the next person what matters, where things stand, and what comes next.",
              ),
            ],
          },
          {
            type: "heading",
            attrs: { level: 3 },
            content: [{ type: "text", text: "A few shared habits" }],
          },
          {
            type: "bulletList",
            content: [
              "Write it down while it is fresh.",
              "Keep decisions close to the work.",
              "Ask for a second pair of eyes.",
            ].map((value) => ({ type: "listItem", content: [text(value)] })),
          },
          text("Small habits make a calmer workspace."),
        ],
      },
      "🌿",
    ]);
    await db.query("UPDATE pages SET document=$2,icon=$3 WHERE id=$1", [
      f.root.id,
      {
        type: "doc",
        content: [
          text(
            "Everything you need to feel at home in our studio. A shared place for the way we work, the decisions we make, and the ideas we want to keep.",
          ),
          {
            type: "heading",
            attrs: { level: 2 },
            content: [
              { type: "text", text: "A little clarity goes a long way" },
            ],
          },
          {
            type: "orvynCallout",
            attrs: { tone: "info" },
            content: [
              text(
                "Start here. This handbook is a living guide to working together with care.",
              ),
            ],
          },
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Read our working rhythm",
                marks: [
                  {
                    type: "link",
                    attrs: { href: "/?page=" + f.child.id + "#h-" + heading },
                  },
                ],
              },
            ],
          },
          { type: "orvynPagePreview", attrs: { pageId: f.secret.id } },
        ],
      },
      "📖",
    ]);
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const owner = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await owner.addCookies([
      { name: "orvyn_session", value: f.owner.cookie.split("=")[1], url: base },
    ]);
    await owner.addInitScript(() =>
      localStorage.setItem("orvyn.theme", "light"),
    );
    const page = await owner.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base + "/?page=" + f.root.id);
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue(f.root.title);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const share = page.getByRole("dialog", { name: "Share page", exact: true });
    await expect(share).toBeVisible();
    await share.getByRole("tab", { name: "Publish", exact: true }).click();
    await share.getByRole("checkbox", { name: /Working together/ }).check();
    await share
      .getByRole("button", { name: "Review publication", exact: true })
      .click();
    const review = page.getByRole("dialog", {
      name: "Review publication",
      exact: true,
    });
    await expect(review).toBeVisible();
    await expect(
      review.getByText("2 pages · 0 attachments", { exact: true }),
    ).toBeVisible();
    await expect(
      review.getByText("PRIVATE payroll", { exact: true }),
    ).toHaveCount(0);
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/publication-review.png",
      fullPage: true,
    });
    const saved = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/v1/" + f.path &&
        r.request().method() === "POST",
    );
    await review
      .getByRole("button", { name: "Publish snapshot", exact: true })
      .click();
    const response = await saved;
    assert.equal(response.status(), 201, await response.text());
    const published = await response.json();
    await expect(
      share.getByRole("button", { name: "Copy link", exact: true }),
    ).toBeVisible();
    const anonymous = await browser.newContext({
        viewport: { width: 1365, height: 1000 },
      }),
      forbidden = [];
    await anonymous.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith("/api/v1/publications/")) {
        forbidden.push(path);
        return route.abort();
      }
      return route.continue();
    });
    const publicPage = await anonymous.newPage();
    publicPage.on("pageerror", (error) => errors.push(error.message));
    const html = await publicPage.goto(published.url);
    assert.equal(html.status(), 200);
    assert.equal(html.headers()["referrer-policy"], "no-referrer");
    await expect(
      publicPage.getByRole("heading", { name: f.root.title, exact: true }),
    ).toBeVisible();
    await expect(publicPage.locator("meta[name=robots]")).toHaveAttribute(
      "content",
      /noindex/,
    );
    await publicPage
      .getByRole("link", { name: "Read our working rhythm", exact: true })
      .click();
    await expect(
      publicPage.getByRole("heading", {
        name: "Our working rhythm",
        exact: true,
      }),
    ).toBeVisible();
    assert.equal(new URL(publicPage.url()).hash, "#h-" + heading);
    await expect(
      publicPage.getByRole("heading", { name: f.child.title, exact: true }),
    ).toBeVisible();
    await publicPage.screenshot({
      path: ".local/ui-review/publication-reader.png",
      fullPage: true,
    });
    await publicPage.setViewportSize({ width: 390, height: 844 });
    await publicPage.screenshot({
      path: ".local/ui-review/publication-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await publicPage.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.deepEqual(forbidden, []);
    assert.deepEqual(errors, []);
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      f.child.id,
    ]);
    await publicPage.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      publicPage.getByRole("heading", {
        name: "This link is unavailable",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      publicPage.getByText("Make room for focused work.", { exact: false }),
    ).toHaveCount(0);
    assert.deepEqual(forbidden, []);
  } finally {
    await browser?.close();
    await db.end();
  }
});

test("public whiteboards omit deleted elements and unknown metadata, hydrate only approved images and never connect to private collaboration", async () => {
  const { chromium, expect } = await import("./browser-tools.mjs");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let browser;
  try {
    const f = await publicationFixture(db),
      board = await f.create("A shared sketch", [], null, "whiteboard"),
      privateBoard = await f.create("A private sketch", [], null, "whiteboard");
    const element = (id, extra = {}) => ({
      id,
      type: "rectangle",
      x: 10,
      y: 10,
      width: 200,
      height: 100,
      angle: 0,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      groupIds: [],
      frameId: null,
      boundElements: null,
      index: "a0",
      updated: 1,
      link: null,
      locked: false,
      strokeColor: "#333333",
      backgroundColor: "#ddd3eb",
      strokeWidth: 2,
      roughness: 1,
      opacity: 100,
      strokeStyle: "solid",
      fillStyle: "solid",
      roundness: null,
      ...extra,
    });
    const uploadData = new FormData();
    uploadData.append(
      "file",
      new Blob(
        [
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOFkAAAAASUVORK5CYII=",
            "base64",
          ),
        ],
        { type: "image/png" },
      ),
      "private-operating-system-name.png",
    );
    const uploaded = await fetch(
      base + "/api/v1/pages/" + board.id + "/files",
      {
        method: "POST",
        headers: { Origin: process.env.TEST_ORIGIN, Cookie: f.owner.cookie },
        body: uploadData,
      },
    );
    assert.equal(uploaded.status, 201);
    const file = await uploaded.json();
    const scene = {
      backgroundColor: "#ffffff",
      gridSize: null,
      elements: [
        element("visible", {
          customData: { secret: "PRIVATE custom metadata" },
          roundness: { type: 3, secret: "PRIVATE nested metadata" },
          unexpected: "PRIVATE unknown field",
        }),
        element("deleted", {
          isDeleted: true,
          secret: "PRIVATE deleted history",
        }),
        element("photo", {
          type: "image",
          index: "a1",
          x: 300,
          fileId: file.id,
          status: "saved",
          scale: [1, 1],
          crop: null,
        }),
      ],
    };
    await db.query(
      "UPDATE whiteboard_documents SET scene=$2,version=version+1 WHERE page_id=$1",
      [board.id, scene],
    );
    await db.query("UPDATE pages SET document=$2 WHERE id=$1", [
      f.root.id,
      {
        type: "doc",
        content: [
          text("A diagram for everyone."),
          { type: "orvynWhiteboard", attrs: { pageId: board.id } },
          { type: "orvynWhiteboard", attrs: { pageId: privateBoard.id } },
        ],
      },
    ]);
    const input = structuredClone(f.input);
    input.scope.pageIds = [board.id];
    const pub = await f.publish(input),
      read = await request("publications/" + pub.token),
      raw = JSON.stringify(read.data);
    assert.equal(read.response.status, 200);
    assert.ok(!raw.includes("PRIVATE"));
    assert.ok(!raw.includes(privateBoard.id));
    assert.ok(!raw.includes("private-operating-system-name"));
    assert.equal(
      read.data.snapshot.pages.find((p) => p.id === board.id).whiteboard
        .elements.length,
      2,
    );
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
      }),
      privateRequests = [],
      external = [],
      sockets = [],
      errors = [];
    await context.route("**/api/v1/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith("/api/v1/publications/")) {
        privateRequests.push(path);
        return route.abort();
      }
      return route.continue();
    });
    context.on("request", (request) => {
      if (
        !request.url().startsWith(base) &&
        !request.url().startsWith("data:") &&
        !request.url().startsWith("blob:")
      )
        external.push(request.url());
    });
    const page = await context.newPage();
    page.on("websocket", (socket) => sockets.push(socket.url()));
    page.on("pageerror", (error) => errors.push(error.message));
    const image = page.waitForResponse((r) =>
      new URL(r.url()).pathname.endsWith("/files/" + file.id),
    );
    await page.goto(pub.url);
    await expect(page.locator(".public-canvas canvas").first()).toBeVisible();
    assert.equal((await image).status(), 200);
    await expect(page.locator(".public-canvas .toolbar-rectangle")).toHaveCount(
      0,
    );
    assert.deepEqual(privateRequests, []);
    assert.deepEqual(sockets, []);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    const protectedInput = structuredClone(f.input);
    protectedInput.settings.passwordProtected = true;
    protectedInput.settings.password = "browser-secret-link";
    const locked = await f.publish(protectedInput);
    await page.goto(locked.url);
    await expect(
      page.getByRole("heading", {
        name: "This page is password protected",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: f.root.title, exact: true }),
    ).toHaveCount(0);
    assert.ok(!(await page.content()).includes("A diagram for everyone."));
    await page
      .getByLabel("Password", { exact: true })
      .fill(protectedInput.settings.password);
    await page
      .getByRole("button", { name: "Open shared page", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: f.root.title, exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: f.root.title, exact: true }),
    ).toBeVisible();
    assert.deepEqual(privateRequests, []);
  } finally {
    await browser?.close();
    await db.end();
  }
});

test("publication requests serialize retries and permission loss, and reject expired, altered or actor-mismatched previews", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await publicationFixture(db),
      review = await f.preview(),
      body = {
        requestId: randomUUID(),
        previewToken: review.data.previewToken,
        input: f.input,
      };
    const responses = await Promise.all([
      request(f.path, { method: "POST", cookie: f.owner.cookie, body }),
      request(f.path, { method: "POST", cookie: f.owner.cookie, body }),
    ]);
    assert.ok(
      responses.every((r) => r.response.status === 201),
      JSON.stringify(responses.map((r) => r.data)),
    );
    assert.equal(responses[0].data.id, responses[1].data.id);
    const bad = {
      ...body,
      requestId: randomUUID(),
      previewToken: body.previewToken.slice(0, -2) + "aa",
    };
    assert.equal(
      (
        await request(f.path, {
          method: "POST",
          cookie: f.owner.cookie,
          body: bad,
        })
      ).response.status,
      400,
    );
    const member = await account();
    await db.query("INSERT INTO space_members VALUES($1,$2,'Admin')", [
      f.space.id,
      member.id,
    ]);
    const memberReview = await f.preview(f.input, member.cookie);
    assert.equal(memberReview.response.status, 201);
    const memberBody = {
      requestId: randomUUID(),
      previewToken: memberReview.data.previewToken,
      input: f.input,
    };
    assert.equal(
      (
        await request(f.path, {
          method: "POST",
          cookie: f.owner.cookie,
          body: memberBody,
        })
      ).response.status,
      400,
    );
    const memberPublication = await request(f.path, {
      method: "POST",
      cookie: member.cookie,
      body: memberBody,
    });
    assert.equal(
      memberPublication.response.status,
      201,
      JSON.stringify(memberPublication.data),
    );
    const token = new URL(memberPublication.data.url).pathname
      .split("/")
      .at(-1);
    await db.query(
      "UPDATE space_members SET role='Viewer' WHERE space_id=$1 AND user_id=$2",
      [f.space.id, member.id],
    );
    assert.equal((await request("publications/" + token)).response.status, 404);
    await db.query(
      "UPDATE space_members SET role='Admin' WHERE space_id=$1 AND user_id=$2",
      [f.space.id, member.id],
    );
    assert.equal((await request("publications/" + token)).response.status, 404);
    // A validly signed but elapsed review cannot publish a different request.
    const { decodePublicationPreview, signPublicationPreview } =
      await import("../apps/api/dist/publications/security.js");
    const decoded = decodePublicationPreview(body.previewToken);
    const expired = signPublicationPreview({
      ...decoded,
      expires: Date.now() - 1,
    });
    assert.equal(
      (
        await request(f.path, {
          method: "POST",
          cookie: f.owner.cookie,
          body: { ...body, requestId: randomUUID(), previewToken: expired },
        })
      ).response.status,
      409,
    );
  } finally {
    await db.end();
  }
});

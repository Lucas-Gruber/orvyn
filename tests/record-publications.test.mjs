import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
const paragraph = (text) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
async function fixture(db) {
  const registered = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(registered.response),
    space = (
      await request("spaces", {
        method: "POST",
        cookie,
        body: { name: "Private work" },
      })
    ).data;
  const created = await request("spaces/" + space.id + "/databases", {
    method: "POST",
    cookie,
    body: { name: "PRIVATE parent database" },
  });
  assert.equal(created.response.status, 201);
  const database = created.data,
    id = database.id,
    title = database.properties.find((p) => p.type === "Title"),
    status = database.properties.find((p) => p.type === "Status");
  async function property(name, type, extra = {}) {
    const r = await request("databases/" + id + "/properties", {
      method: "POST",
      cookie,
      body: { name, type, ...extra },
    });
    assert.equal(r.response.status, 201, JSON.stringify(r.data));
    return r.data;
  }
  const estimate = await property("Estimate", "Number"),
    secret = await property("PRIVATE internal budget", "Text");
  async function record(name, values = {}) {
    const r = await request("databases/" + id + "/records", {
      method: "POST",
      cookie,
      body: { title: name, values },
    });
    assert.equal(r.response.status, 201);
    return r.data;
  }
  const root = await record("Launch note", {
      [estimate.id]: 3,
      [secret.id]: "PRIVATE commercial data",
      [status.id]: status.config.options[0].id,
    }),
    other = await record("A useful reference"),
    hidden = await record("PRIVATE unselected row");
  await db.query("UPDATE pages SET document=$2 WHERE id=$1", [
    root.pageId,
    {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2, id: randomUUID() },
          content: [{ type: "text", text: "The next small step" }],
        },
        paragraph("Make the work easier for the next person to pick up."),
      ],
    },
  ]);
  const path = "pages/" + root.pageId + "/publications",
    input = {
      scope: {
        pageIds: [],
        databases: [],
        records: [
          {
            recordId: root.pageId,
            propertyIds: [title.id, status.id, estimate.id],
          },
        ],
        extraFileIds: [],
      },
      settings: {
        label: "A shared launch note",
        passwordProtected: false,
        indexable: false,
        expiresAt: null,
      },
      target: null,
    };
  const preview = (value) =>
    request(path + "/preview", {
      method: "POST",
      cookie,
      body: value || input,
    });
  async function publish(value = input) {
    const review = await preview(value);
    assert.equal(review.response.status, 201, JSON.stringify(review.data));
    const r = await request(path, {
      method: "POST",
      cookie,
      body: {
        requestId: randomUUID(),
        previewToken: review.data.previewToken,
        input: value,
      },
    });
    assert.equal(r.response.status, 201, JSON.stringify(r.data));
    return { ...r.data, token: new URL(r.data.url).pathname.split("/").at(-1) };
  }
  return {
    cookie,
    space,
    id,
    database,
    title,
    status,
    estimate,
    secret,
    root,
    other,
    hidden,
    path,
    input,
    property,
    record,
    preview,
    publish,
  };
}
test("direct record snapshots publish selected properties and body without the parent database, siblings, hidden values or metadata", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      preview = await f.preview();
    assert.equal(preview.response.status, 201, JSON.stringify(preview.data));
    const snapshot = preview.data.snapshot;
    assert.equal(snapshot.pages.length, 1);
    assert.equal(snapshot.pages[0].id, f.root.pageId);
    assert.equal(snapshot.pages[0].parentId, null);
    assert.deepEqual(
      snapshot.pages[0].record.properties.map((p) => p.id),
      [f.title.id, f.status.id, f.estimate.id],
    );
    assert.ok(JSON.stringify(snapshot).includes("Make the work easier"));
    assert.ok(!JSON.stringify(snapshot).includes("PRIVATE"));
    assert.ok(!JSON.stringify(snapshot).includes(f.id));
    assert.ok(!JSON.stringify(snapshot).includes(f.hidden.pageId));
    const pub = await f.publish();
    assert.equal(
      (await request("publications/" + pub.token)).response.status,
      200,
    );
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      f.id,
    ]);
    assert.equal(
      (await request("publications/" + pub.token)).response.status,
      404,
    );
    await db.query("UPDATE pages SET visibility='space' WHERE id=$1", [f.id]);
    assert.equal(
      (await request("publications/" + pub.token)).response.status,
      404,
    );
  } finally {
    await db.end();
  }
});
test("direct record properties are independent of saved filters, reject identity/unknown fields and bind schema, row and page revisions", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      person = await f.property("Private people", "Person");
    await db.query(
      "UPDATE database_views SET config=jsonb_set(config,'{filters}',$2::jsonb),version=version+1 WHERE database_id=$1",
      [
        f.id,
        JSON.stringify([
          { propertyId: f.estimate.id, operator: "gt", value: 100 },
        ]),
      ],
    );
    assert.equal((await f.preview()).response.status, 201);
    const identity = structuredClone(f.input);
    identity.scope.records[0].propertyIds.push(person.id);
    assert.equal((await f.preview(identity)).response.status, 400);
    const unknown = structuredClone(f.input);
    unknown.scope.records[0].propertyIds.push(randomUUID());
    assert.equal((await f.preview(unknown)).response.status, 400);
    const duplicate = structuredClone(f.input);
    duplicate.scope.records.push(duplicate.scope.records[0]);
    assert.equal((await f.preview(duplicate)).response.status, 400);
    const review = await f.preview();
    await db.query(
      "UPDATE database_records SET version=version+1 WHERE page_id=$1",
      [f.root.pageId],
    );
    assert.equal(
      (
        await request(f.path, {
          method: "POST",
          cookie: f.cookie,
          body: {
            requestId: randomUUID(),
            previewToken: review.data.previewToken,
            input: f.input,
          },
        })
      ).response.status,
      409,
    );
    const metadata = await request(f.path + "/records/" + f.root.pageId, {
      cookie: f.cookie,
    });
    assert.equal(metadata.response.status, 200);
    assert.ok(!JSON.stringify(metadata.data).includes(f.id));
    assert.ok(
      !JSON.stringify(metadata.data).includes("PRIVATE commercial data"),
    );
    assert.equal(
      metadata.data.properties.find((p) => p.id === person.id).allowed,
      false,
    );
  } finally {
    await db.end();
  }
});
test("direct record relations resolve only other approved records and exact owned file fields receive public download grants", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      relation = await f.property("Related", "Relation", {
        relationDatabaseId: f.id,
      }),
      files = await f.property("Brief", "Files");
    const form = new FormData();
    form.append(
      "file",
      new Blob(["A reviewed brief"], { type: "text/plain" }),
      "brief.txt",
    );
    const upload = await fetch(
      base + "/api/v1/pages/" + f.root.pageId + "/files",
      {
        method: "POST",
        headers: { Origin: process.env.TEST_ORIGIN, Cookie: f.cookie },
        body: form,
      },
    );
    assert.equal(upload.status, 201);
    const file = await upload.json();
    await db.query(
      "UPDATE database_records SET values=values||$2::jsonb,version=version+1 WHERE page_id=$1",
      [
        f.root.pageId,
        {
          [relation.id]: [f.other.pageId, f.hidden.pageId],
          [files.id]: [file.id],
        },
      ],
    );
    const input = structuredClone(f.input);
    input.scope.records[0].propertyIds.push(relation.id, files.id);
    input.scope.records.push({
      recordId: f.other.pageId,
      propertyIds: [f.title.id],
    });
    const review = await f.preview(input);
    assert.equal(review.response.status, 201, JSON.stringify(review.data));
    assert.equal(review.data.snapshot.pages.length, 2);
    assert.ok(!JSON.stringify(review.data.snapshot).includes("PRIVATE"));
    const record = review.data.snapshot.pages.find(
      (p) => p.id === f.root.pageId,
    ).record;
    assert.deepEqual(record.values[relation.id], [f.other.pageId]);
    const pub = await f.publish(input),
      download = await request(
        "publications/" + pub.token + "/files/" + file.id,
      );
    assert.equal(download.response.status, 200);
    assert.equal(download.data, "A reviewed brief");
  } finally {
    await db.end();
  }
});

test("Chromium: share a record directly, choose its properties, add a related record and revoke it without publishing the parent database", async () => {
  const { chromium, expect } = await import("./browser-tools.mjs"),
    { mkdir } = await import("node:fs/promises");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let browser;
  try {
    const f = await fixture(db),
      relation = await f.property("Related note", "Relation", {
        relationDatabaseId: f.id,
      });
    await db.query(
      "UPDATE database_records SET values=values||$2::jsonb,version=version+1 WHERE page_id=$1",
      [f.root.pageId, { [relation.id]: [f.other.pageId, f.hidden.pageId] }],
    );
    await db.query("SELECT orvyn_replace_record_relations($1)", [
      f.root.pageId,
    ]);
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const owner = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await owner.addCookies([
      { name: "orvyn_session", value: f.cookie.split("=")[1], url: base },
    ]);
    await owner.addInitScript(() =>
      localStorage.setItem("orvyn.theme", "light"),
    );
    const page = await owner.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/?page=" + f.root.pageId);
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue(f.root.title);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const share = page.getByRole("dialog", { name: "Share page", exact: true });
    await share.getByRole("tab", { name: "Publish", exact: true }).click();
    const fields = share
      .locator(".publication-record-scope")
      .filter({ has: page.getByText(f.root.title, { exact: true }) });
    await expect(fields).toBeVisible();
    await fields
      .getByRole("checkbox", { name: "Estimate", exact: true })
      .check();
    await fields.getByRole("checkbox", { name: "Status", exact: true }).check();
    await share
      .getByRole("button", { name: "Review publication", exact: true })
      .click();
    const review = page.getByRole("dialog", {
      name: "Review publication",
      exact: true,
    });
    await expect(review).toBeVisible();
    await expect(review.getByText(/1 pages · 0 attachments/)).toBeVisible();
    await expect(
      review.getByText("PRIVATE parent database", { exact: true }),
    ).toHaveCount(0);
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/record-publication-review.png",
      fullPage: true,
    });
    const created = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/v1/" + f.path &&
        r.request().method() === "POST",
    );
    await review
      .getByRole("button", { name: "Publish snapshot", exact: true })
      .click();
    const response = await created;
    assert.equal(response.status(), 201, await response.text());
    const pub = await response.json();
    await expect(
      share.getByRole("button", { name: "Copy link", exact: true }),
    ).toBeVisible();
    const anonymous = await browser.newContext({
        viewport: { width: 1280, height: 900 },
      }),
      forbidden = [];
    await anonymous.route("**/api/v1/**", (route) => {
      if (
        !new URL(route.request().url()).pathname.startsWith(
          "/api/v1/publications/",
        )
      ) {
        forbidden.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    const reader = await anonymous.newPage();
    reader.on("pageerror", (e) => errors.push(e.message));
    await reader.goto(pub.url);
    await expect(
      reader.getByRole("heading", { name: f.root.title, exact: true }),
    ).toBeVisible();
    await expect(
      reader
        .locator(".public-page-properties")
        .getByText("Estimate", { exact: true }),
    ).toBeVisible();
    await expect(
      reader.getByRole("heading", { name: "The next small step", exact: true }),
    ).toBeVisible();
    const html = await reader.content();
    assert.ok(!html.includes("PRIVATE"));
    assert.ok(!html.includes(f.id));
    await reader.screenshot({
      path: ".local/ui-review/record-publication-reader.png",
      fullPage: true,
    });
    await reader.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await reader.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await reader.screenshot({
      path: ".local/ui-review/record-publication-mobile.png",
      fullPage: true,
    });
    await share
      .getByRole("button", { name: "Published link actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Update snapshot", exact: true })
      .click();
    await fields
      .getByRole("checkbox", { name: "Related note", exact: true })
      .check();
    await share
      .getByRole("checkbox", { name: new RegExp(f.other.title) })
      .check();
    await expect(share.locator(".publication-record-scope")).toHaveCount(2);
    await share
      .getByRole("button", { name: "Review publication", exact: true })
      .click();
    await expect(review).toBeVisible();
    await review
      .locator(".public-page-properties")
      .getByRole("link", { name: f.other.title, exact: true })
      .click();
    await expect(review.locator(".publication-title h1")).toHaveText(
      f.other.title,
    );
    assert.equal(new URL(page.url()).searchParams.get("page"), f.root.pageId);
    await review
      .getByRole("button", { name: "Update publication", exact: true })
      .click();
    await expect(review).not.toBeVisible();
    await reader.reload();
    await reader
      .locator(".public-page-properties")
      .getByRole("link", { name: f.other.title, exact: true })
      .click();
    await expect(
      reader.getByRole("heading", { name: f.other.title, exact: true }),
    ).toBeVisible();
    assert.ok(!(await reader.content()).includes("PRIVATE parent database"));
    assert.deepEqual(forbidden, []);
    assert.deepEqual(errors, []);
    await expect(
      reader
        .getByRole("navigation", { name: "Published pages", exact: true })
        .locator("details"),
    ).not.toHaveAttribute("open");
    await reader.bringToFront();
    await reader.waitForFunction(() => document.visibilityState === "visible");
    let releaseStatus;
    const statusGate = new Promise((resolve) => (releaseStatus = resolve));
    let startedResolve, startedTimer;
    const started = new Promise((resolve, reject) => {
      startedTimer = setTimeout(
        () => reject(Error("Status check did not start")),
        12000,
      );
      startedResolve = () => {
        clearTimeout(startedTimer);
        resolve();
      };
    });
    let hold = true;
    await reader.route("**/api/v1/publications/*/status", async (route) => {
      const result = await route.fetch();
      if (hold) {
        hold = false;
        startedResolve();
        await statusGate;
      }
      await route.fulfill({ response: result });
    });
    await reader.evaluate(() => window.dispatchEvent(new Event("focus")));
    await started;
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      f.id,
    ]);
    await reader.evaluate(() => window.dispatchEvent(new Event("focus")));
    releaseStatus();
    await expect(
      reader.getByRole("heading", {
        name: "This link is unavailable",
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await browser?.close();
    await db.end();
  }
});

test("record document properties remain independent when the same row also appears in a published database view", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      input = structuredClone(f.input);
    input.scope.databases = [
      {
        databaseId: f.id,
        viewId: f.database.views.find((view) => view.type === "Table").id,
        recordIds: [f.root.pageId, f.other.pageId],
        propertyIds: [f.title.id],
      },
    ];
    const preview = await f.preview(input);
    assert.equal(preview.response.status, 201, JSON.stringify(preview.data));
    const record = preview.data.snapshot.pages.find(
        (page) => page.id === f.root.pageId,
      ),
      database = preview.data.snapshot.pages.find(
        (page) => page.id === f.id,
      ).database;
    assert.deepEqual(
      database.properties.map((property) => property.id),
      [f.title.id],
    );
    assert.equal(database.records[0].values[f.estimate.id], undefined);
    assert.equal(record.record.values[f.estimate.id], 3);
    assert.ok(
      !JSON.stringify(preview.data.snapshot).includes(
        "PRIVATE commercial data",
      ),
    );
  } finally {
    await db.end();
  }
});

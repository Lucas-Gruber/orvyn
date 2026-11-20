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
    owner = (await request("auth/me", { cookie })).data;
  const space = (
    await request("spaces", {
      method: "POST",
      cookie,
      body: { name: "Shared product work" },
    })
  ).data;
  async function database(name) {
    const r = await request(`spaces/${space.id}/databases`, {
      method: "POST",
      cookie,
      body: { name },
    });
    assert.equal(r.response.status, 201, JSON.stringify(r.data));
    return r.data;
  }
  const databasePage = await database("Studio projects"),
    id = databasePage.id,
    path = "pages/" + id + "/publications";
  async function property(name, type, extra = {}) {
    const r = await request("databases/" + id + "/properties", {
      method: "POST",
      cookie,
      body: { name, type, ...extra },
    });
    assert.equal(r.response.status, 201, JSON.stringify(r.data));
    return r.data;
  }
  async function record(title, values = {}) {
    const r = await request("databases/" + id + "/records", {
      method: "POST",
      cookie,
      body: { title, values },
    });
    assert.equal(r.response.status, 201, JSON.stringify(r.data));
    return r.data;
  }
  const title = databasePage.properties.find((p) => p.type === "Title"),
    status = databasePage.properties.find((p) => p.type === "Status"),
    date = databasePage.properties.find((p) => p.type === "Date"),
    estimate = await property("Estimate", "Number"),
    secret = await property("PRIVATE budget", "Text");
  const a = await record("A thoughtful start", {
      [status.id]: status.config.options[0].id,
      [estimate.id]: 3,
      [secret.id]: "PRIVATE commercial terms",
    }),
    b = await record("Make it clearer", {
      [status.id]: status.config.options[1].id,
      [estimate.id]: 5,
    }),
    hidden = await record("PRIVATE roadmap record", {
      [status.id]: status.config.options[2].id,
      [estimate.id]: 99,
    });
  await db.query("UPDATE pages SET document=$2 WHERE id=$1", [
    a.pageId,
    {
      type: "doc",
      content: [paragraph("PRIVATE record body until explicitly selected")],
    },
  ]);
  const view = databasePage.views.find((v) => v.type === "Table"),
    input = {
      scope: {
        pageIds: [],
        databases: [
          {
            databaseId: id,
            viewId: view.id,
            recordIds: [a.pageId, b.pageId],
            propertyIds: [title.id, status.id, estimate.id],
          },
        ],
        extraFileIds: [],
      },
      settings: {
        label: "Studio roadmap",
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
    const r = await preview(value);
    assert.equal(r.response.status, 201, JSON.stringify(r.data));
    const body = {
        requestId: randomUUID(),
        previewToken: r.data.previewToken,
        input: value,
      },
      result = await request(path, { method: "POST", cookie, body });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return {
      ...result.data,
      token: new URL(result.data.url).pathname.split("/").at(-1),
      body,
    };
  }
  return {
    db,
    cookie,
    owner,
    space,
    id,
    path,
    databasePage,
    database,
    property,
    record,
    title,
    status,
    date,
    estimate,
    secret,
    a,
    b,
    hidden,
    view,
    input,
    preview,
    publish,
  };
}
test("database publications project only selected view fields and records, without record bodies, hidden options, identity or automatic covers", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      preview = await f.preview();
    assert.equal(preview.response.status, 201, JSON.stringify(preview.data));
    const projection = preview.data.snapshot.pages.find(
      (p) => p.id === f.id,
    ).database;
    assert.equal(projection.records.length, 2);
    assert.deepEqual(
      projection.properties.map((p) => p.id),
      [f.title.id, f.status.id, f.estimate.id],
    );
    assert.ok(!JSON.stringify(preview.data.snapshot).includes("PRIVATE"));
    assert.ok(!JSON.stringify(preview.data.snapshot).includes(f.hidden.pageId));
    assert.equal(
      projection.properties.find((p) => p.id === f.status.id).options.length,
      2,
    );
    const pub = await f.publish(),
      read = await request("publications/" + pub.token);
    assert.equal(read.response.status, 200);
    assert.equal(read.data.snapshot.pages.length, 1);
    assert.equal(read.data.snapshot.files.length, 0);
    assert.ok(!JSON.stringify(read.data).includes(f.owner.email));
    assert.ok(!JSON.stringify(read.data).includes("createdBy"));
    const body = structuredClone(f.input);
    body.scope.pageIds = [f.a.pageId];
    const included = await f.preview(body);
    assert.equal(included.response.status, 201, JSON.stringify(included.data));
    const record = included.data.snapshot.pages.find(
      (p) => p.id === f.a.pageId,
    );
    assert.ok(JSON.stringify(record.document).includes("PRIVATE record body"));
    assert.equal(record.record.values[f.estimate.id], 3);
    assert.ok(!JSON.stringify(record.record).includes(f.secret.id));
    const board = structuredClone(f.input);
    board.scope.databases[0].viewId = f.databasePage.views.find(
      (v) => v.type === "Board",
    ).id;
    assert.equal((await f.preview(board)).response.status, 201);
    board.scope.databases[0].propertyIds = [f.title.id];
    assert.equal((await f.preview(board)).response.status, 400);
  } finally {
    await db.end();
  }
});
test("database publication reviews reject hidden fields, keep unlabelled people anonymous, reject mismatched rows/views, stale schema/record revisions and later record policy changes", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      person = await f.property("People", "Person");
    const config = {
      ...f.view.config,
      visibleProperties: [f.title.id, f.status.id, f.estimate.id, person.id],
    };
    await db.query(
      "UPDATE database_views SET config=$2,version=version+1 WHERE id=$1",
      [f.view.id, config],
    );
    const hidden = structuredClone(f.input);
    hidden.scope.databases[0].propertyIds.push(f.secret.id);
    assert.equal((await f.preview(hidden)).response.status, 400);
    const identity = structuredClone(f.input);
    identity.scope.databases[0].propertyIds.push(person.id);
    const anonymousIdentity = await f.preview(identity);
    assert.equal(
      anonymousIdentity.response.status,
      201,
      JSON.stringify(anonymousIdentity.data),
    );
    for (const row of anonymousIdentity.data.snapshot.pages.find(
      (page) => page.id === f.id,
    ).database.records)
      assert.deepEqual(row.values[person.id], []);
    const other = await f.database("Another database"),
      wrong = structuredClone(f.input);
    wrong.scope.databases[0].viewId = other.views[0].id;
    assert.equal((await f.preview(wrong)).response.status, 404);
    const wrongRecord = await request("databases/" + other.id + "/records", {
        method: "POST",
        cookie: f.cookie,
        body: { title: "Another row" },
      }),
      wrongRows = structuredClone(f.input);
    wrongRows.scope.databases[0].recordIds = [wrongRecord.data.pageId];
    assert.equal((await f.preview(wrongRows)).response.status, 409);
    const review = await f.preview();
    assert.equal(review.response.status, 201);
    await db.query(
      "UPDATE database_records SET version=version+1 WHERE page_id=$1",
      [f.a.pageId],
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
    const pub = await f.publish();
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      f.a.pageId,
    ]);
    assert.equal(
      (await request("publications/" + pub.token)).response.status,
      404,
    );
    const directory = await request(f.path + "/databases/" + f.id, {
      cookie: f.cookie,
    });
    assert.equal(directory.response.status, 200);
    const choices = await request(f.path + "/databases/" + f.id + "/records", {
      method: "POST",
      cookie: f.cookie,
      body: { viewId: f.view.id },
    });
    assert.equal(choices.response.status, 201);
    assert.ok(choices.data.records.some((r) => r.id === f.a.pageId));
    assert.deepEqual(Object.keys(choices.data.records[0]).sort(), [
      "id",
      "title",
    ]);
  } finally {
    await db.end();
  }
});
test("database publication files require an explicitly selected field and relations only resolve records in the approved scope", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      files = await f.property("Files", "Files"),
      relation = await f.property("Related work", "Relation", {
        relationDatabaseId: f.id,
      });
    const form = new FormData();
    form.append(
      "file",
      new Blob(["Deliberately shared bytes"], { type: "text/plain" }),
      "project-brief.txt",
    );
    const upload = await fetch(
      base + "/api/v1/pages/" + f.a.pageId + "/files",
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
        f.a.pageId,
        { [files.id]: [file.id], [relation.id]: [f.b.pageId, f.hidden.pageId] },
      ],
    );
    await db.query("SELECT orvyn_replace_record_relations($1)", [f.a.pageId]);
    const noFiles = await f.publish();
    assert.equal(
      (await request("publications/" + noFiles.token + "/files/" + file.id))
        .response.status,
      404,
    );
    const input = structuredClone(f.input);
    input.scope.databases[0].propertyIds.push(files.id, relation.id);
    const review = await f.preview(input);
    assert.equal(review.response.status, 201, JSON.stringify(review.data));
    const projection = review.data.snapshot.pages.find(
      (p) => p.id === f.id,
    ).database;
    assert.deepEqual(
      projection.records.find((r) => r.pageId === f.a.pageId).values[
        relation.id
      ],
      [f.b.pageId],
    );
    assert.equal(review.data.warnings.excludedRelations, 1);
    assert.ok(!JSON.stringify(review.data.snapshot).includes(f.hidden.pageId));
    assert.equal(review.data.snapshot.files[0].filename, "project-brief.txt");
    const pub = await f.publish(input),
      download = await request(
        "publications/" + pub.token + "/files/" + file.id,
      );
    assert.equal(download.response.status, 200);
    assert.equal(download.data, "Deliberately shared bytes");
  } finally {
    await db.end();
  }
});

test("Chromium: publish a deliberately selected board, read scoped item dialogs, update the snapshot and navigate approved record text", async () => {
  const { chromium, expect } = await import("./browser-tools.mjs"),
    { mkdir } = await import("node:fs/promises");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let browser;
  try {
    const f = await fixture(db),
      board = f.databasePage.views.find((view) => view.type === "Board");
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
    });
    await context.addCookies([
      { name: "orvyn_session", value: f.cookie.split("=")[1], url: base },
    ]);
    await context.addInitScript(() =>
      localStorage.setItem("orvyn.theme", "light"),
    );
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/?page=" + f.id);
    await expect(
      page.getByRole("heading", { name: "Studio projects", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const share = page.getByRole("dialog", { name: "Share page", exact: true });
    await share.getByRole("tab", { name: "Publish", exact: true }).click();
    const scope = share.locator(".database-public-scope");
    await expect(scope).toBeVisible();
    await scope
      .getByLabel("Published view", { exact: true })
      .selectOption(board.id);
    await scope
      .getByRole("checkbox", { name: "Estimate", exact: true })
      .check();
    await scope.getByRole("checkbox", { name: f.a.title, exact: true }).check();
    await scope.getByRole("checkbox", { name: f.b.title, exact: true }).check();
    await expect(
      scope.getByRole("checkbox", { name: /Also include these items/ }),
    ).not.toBeChecked();
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/database-publication-scope.png",
      fullPage: true,
    });
    await share
      .getByRole("button", { name: "Review publication", exact: true })
      .click();
    const review = page.getByRole("dialog", {
      name: "Review publication",
      exact: true,
    });
    await expect(review).toBeVisible();
    await expect(review.locator(".public-database-card")).toHaveCount(2);
    await expect(
      review.getByText("PRIVATE commercial terms", { exact: true }),
    ).toHaveCount(0);
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
    const publication = await response.json();
    await expect(
      share.getByRole("button", { name: "Copy link", exact: true }),
    ).toBeVisible();
    const anonymous = await browser.newContext({
        viewport: { width: 1365, height: 900 },
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
    await reader.goto(publication.url);
    await expect(
      reader.getByRole("heading", { name: "Studio projects", exact: true }),
    ).toBeVisible();
    await expect(reader.locator(".public-database-card")).toHaveCount(2);
    await expect(
      reader.getByText("PRIVATE roadmap record", { exact: true }),
    ).toHaveCount(0);
    await reader.screenshot({
      path: ".local/ui-review/database-publication-board.png",
      fullPage: true,
    });
    await reader.getByRole("button", { name: f.a.title, exact: true }).click();
    const detail = reader.getByRole("dialog", { name: f.a.title, exact: true });
    await expect(detail).toBeVisible();
    await expect(detail.getByText("Estimate", { exact: true })).toBeVisible();
    await expect(detail.getByText("3", { exact: true })).toBeVisible();
    await expect(
      detail.getByText("PRIVATE record body until explicitly selected", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      detail.getByText(/The original page text is not shared/),
    ).toBeVisible();
    await detail
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await reader.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await reader.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await reader.screenshot({
      path: ".local/ui-review/database-publication-mobile.png",
      fullPage: true,
    });
    await share
      .getByRole("button", { name: "Published link actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Update snapshot", exact: true })
      .click();
    await expect(
      scope.getByRole("checkbox", { name: f.a.title, exact: true }),
    ).toBeChecked();
    await scope
      .getByRole("checkbox", { name: /Also include these items/ })
      .check();
    await share
      .getByRole("button", { name: "Review publication", exact: true })
      .click();
    await expect(review).toBeVisible();
    await review
      .locator(".public-database-card")
      .getByRole("button", { name: f.a.title, exact: true })
      .click();
    const previewRecord = page.getByRole("dialog", {
      name: f.a.title,
      exact: true,
    });
    await expect(
      previewRecord.getByText("PRIVATE record body until explicitly selected", {
        exact: true,
      }),
    ).toBeVisible();
    await previewRecord
      .getByRole("link", { name: "Open full page", exact: true })
      .click();
    await expect(review.locator(".publication-title h1")).toHaveText(f.a.title);
    assert.equal(
      new URL(page.url()).searchParams.get("page"),
      f.id,
      "Preview links stay inside the reviewed snapshot",
    );
    await review
      .getByRole("button", { name: "Update publication", exact: true })
      .click();
    await expect(review).not.toBeVisible();
    await reader.reload();
    await reader.getByRole("button", { name: f.a.title, exact: true }).click();
    const sharedDetail = reader.getByRole("dialog", {
      name: f.a.title,
      exact: true,
    });
    await expect(
      sharedDetail.getByText("PRIVATE record body until explicitly selected", {
        exact: true,
      }),
    ).toBeVisible();
    assert.deepEqual(forbidden, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await db.end();
  }
});

test("Chromium: all five public views use approved values and expose no private requests or horizontal page overflow", async () => {
  const { chromium, expect } = await import("./browser-tools.mjs");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let browser;
  try {
    const f = await fixture(db);
    await db.query(
      "UPDATE database_records SET values=values||$2::jsonb WHERE page_id=$1",
      [f.a.pageId, { [f.date.id]: "2026-11-20" }],
    );
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
        viewport: { width: 1100, height: 850 },
      }),
      forbidden = [],
      errors = [];
    await context.route("**/api/v1/**", (route) => {
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
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    for (const view of f.databasePage.views) {
      const input = structuredClone(f.input);
      input.scope.databases[0].viewId = view.id;
      input.scope.databases[0].propertyIds.push(f.date.id);
      const pub = await f.publish(input);
      await page.goto(pub.url);
      await expect(
        page.getByRole("heading", { name: "Studio projects", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: f.a.title, exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: f.a.title, exact: true }).click();
      await expect(
        page.getByRole("dialog", { name: f.a.title, exact: true }),
      ).toBeVisible();
      await page
        .getByRole("dialog", { name: f.a.title, exact: true })
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        view.type,
      );
      await page.setViewportSize({ width: 1100, height: 850 });
    }
    assert.deepEqual(forbidden, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await db.end();
  }
});

test("publication record scope paginates beyond 200 items, applies the saved filter and requires publish access independently of database access", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      rows = (
        await db.query(
          "INSERT INTO pages(space_id,title,parent_id,kind) SELECT $1,'Iteration '||lpad(i::text,3,'0'),$2,'record' FROM generate_series(1,205) i RETURNING id,title",
          [f.space.id, f.id],
        )
      ).rows;
    await db.query(
      "INSERT INTO database_records(page_id,database_id,values) SELECT id,$1,jsonb_build_object($3::text,right(title,3)::int) FROM pages WHERE id=ANY($2::uuid[])",
      [f.id, rows.map((row) => row.id), f.estimate.id],
    );
    const input = structuredClone(f.input);
    input.scope.databases[0].recordIds = rows.map((row) => row.id);
    const full = await f.preview(input);
    assert.equal(full.response.status, 201, JSON.stringify(full.data));
    const records = full.data.snapshot.pages.find((p) => p.id === f.id).database
      .records;
    assert.equal(records.length, 205);
    assert.equal(records[0].title, "Iteration 001");
    assert.equal(records.at(-1).title, "Iteration 205");
    const config = {
      ...f.view.config,
      filters: [{ propertyId: f.estimate.id, operator: "gte", value: 100 }],
    };
    await db.query(
      "UPDATE database_views SET config=$2,version=version+1 WHERE id=$1",
      [f.view.id, config],
    );
    assert.equal((await f.preview(input)).response.status, 409);
    input.scope.databases[0].recordIds = rows
      .filter((row) => Number(row.title.slice(-3)) >= 100)
      .map((row) => row.id);
    assert.equal((await f.preview(input)).response.status, 201);
    const registered = await request("auth/register", {
        method: "POST",
        body: { email: randomUUID() + "@example.test", password: randomUUID() },
      }),
      cookie = sessionCookie(registered.response),
      admin = (await request("auth/me", { cookie })).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [f.space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Admin')", [
      f.space.id,
      admin.id,
    ]);
    const target = input.scope.databases[0].recordIds[0];
    await db.query("UPDATE pages SET visibility='restricted' WHERE id=$1", [
      target,
    ]);
    await db.query("INSERT INTO page_permissions VALUES($1,$2,'Viewer')", [
      target,
      admin.id,
    ]);
    assert.equal(
      (await request("databases/" + f.id, { cookie })).response.status,
      200,
    );
    assert.equal(
      (
        await request(f.path + "/preview", {
          method: "POST",
          cookie,
          body: input,
        })
      ).response.status,
      409,
    );
    const choices = await request(f.path + "/databases/" + f.id + "/records", {
      method: "POST",
      cookie,
      body: { viewId: f.view.id, selectedIds: [target] },
    });
    assert.equal(choices.response.status, 201);
    assert.ok(!choices.data.records.some((record) => record.id === target));
    assert.equal(choices.data.selected.length, 0);
  } finally {
    await db.end();
  }
});

test("publication relation projections reveal no inaccessible reference counts and honor the current target database", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      relation = await f.property("Related", "Relation", {
        relationDatabaseId: f.id,
      });
    await db.query(
      "UPDATE database_records SET values=values||$2::jsonb WHERE page_id=$1",
      [f.a.pageId, { [relation.id]: [f.b.pageId, f.hidden.pageId] }],
    );
    await db.query("SELECT orvyn_replace_record_relations($1)", [f.a.pageId]);
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [f.space.id]);
    const registered = await request("auth/register", {
        method: "POST",
        body: { email: randomUUID() + "@example.test", password: randomUUID() },
      }),
      cookie = sessionCookie(registered.response),
      admin = (await request("auth/me", { cookie })).data;
    await db.query("INSERT INTO space_members VALUES($1,$2,'Admin')", [
      f.space.id,
      admin.id,
    ]);
    await db.query(
      "UPDATE pages SET visibility='restricted' WHERE id=ANY($1::uuid[])",
      [[f.b.pageId, f.hidden.pageId]],
    );
    assert.equal(
      (
        await request("databases/" + f.id + "/records/" + f.hidden.pageId, {
          cookie,
        })
      ).response.status,
      404,
    );
    const input = structuredClone(f.input);
    input.scope.databases[0].recordIds = [f.a.pageId];
    input.scope.databases[0].propertyIds.push(relation.id);
    const hidden = await request(f.path + "/preview", {
      method: "POST",
      cookie,
      body: input,
    });
    assert.equal(hidden.response.status, 201, JSON.stringify(hidden.data));
    assert.equal(hidden.data.warnings.excludedRelations, 0);
    assert.deepEqual(
      hidden.data.snapshot.pages[0].database.records[0].values[relation.id],
      [],
    );
    await db.query("UPDATE pages SET visibility='space' WHERE id=$1", [
      f.b.pageId,
    ]);
    const visible = await request(f.path + "/preview", {
      method: "POST",
      cookie,
      body: input,
    });
    assert.equal(visible.response.status, 201);
    assert.equal(visible.data.warnings.excludedRelations, 1);
    const target = await f.database("A different target");
    await db.query(
      "UPDATE database_properties SET config=jsonb_set(config,'{databaseId}',to_jsonb($2::text)) WHERE id=$1",
      [relation.id, target.id],
    );
    await db.query(
      "UPDATE databases SET schema_version=schema_version+1 WHERE page_id=$1",
      [f.id],
    );
    input.scope.databases[0].recordIds = [f.a.pageId, f.b.pageId];
    const retargeted = await f.preview(input);
    assert.equal(
      retargeted.response.status,
      201,
      JSON.stringify(retargeted.data),
    );
    assert.deepEqual(
      retargeted.data.snapshot.pages
        .find((page) => page.id === f.id)
        .database.records.find((record) => record.pageId === f.a.pageId).values[
        relation.id
      ],
      [],
    );
    assert.equal(retargeted.data.warnings.excludedRelations, 0);
  } finally {
    await db.end();
  }
});

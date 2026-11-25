import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";

async function account() {
  const email = randomUUID() + "@example.test",
    result = await request("auth/register", {
      method: "POST",
      body: { email, password: randomUUID() },
    }),
    cookie = sessionCookie(result.response),
    me = await request("auth/me", { cookie });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  return { ...me.data, email, cookie };
}
async function fixture(db) {
  const owner = await account(),
    colleague = await account(),
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
    colleague.id,
  ]);
  const database = (
      await request(`spaces/${space.id}/databases`, {
        method: "POST",
        cookie,
        body: { name: "PRIVATE project directory" },
      })
    ).data,
    id = database.id,
    title = database.properties.find((p) => p.type === "Title");
  async function property(name, type, extra = {}) {
    const result = await request(`databases/${id}/properties`, {
      method: "POST",
      cookie,
      body: { name, type, ...extra },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  const people = await property("People", "Person"),
    creator = await property("Created by", "CreatedBy"),
    editor = await property("Last edited by", "LastEditedBy"),
    count = await property("Shared people", "Formula", {
      formula: 'length(prop("People"))',
    }),
    byline = await property("Byline", "Formula", {
      formula: '"By " + prop("Created by")',
    }),
    relation = await property("Related notes", "Relation", {
      relationDatabaseId: id,
    }),
    unique = await property("Distinct authors", "Rollup", {
      rollup: {
        relationId: relation.id,
        targetPropertyId: creator.id,
        aggregation: "unique",
      },
    });
  async function record(title, values = {}) {
    const result = await request(`databases/${id}/records`, {
      method: "POST",
      cookie,
      body: { title, values },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  const other = await record("A useful reference"),
    root = await record("A clearer handover", {
      [people.id]: [owner.id, colleague.id],
      [relation.id]: [other.pageId],
    });
  await db.query(
    "UPDATE pages SET created_by=$2,last_edited_by=$2 WHERE id=$1",
    [other.pageId, colleague.id],
  );
  await db.query("UPDATE pages SET document=$2 WHERE id=$1", [
    root.pageId,
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "A small handover from " },
            { type: "orvynPerson", attrs: { userId: owner.id } },
            { type: "text", text: " and " },
            { type: "orvynPerson", attrs: { userId: colleague.id } },
            {
              type: "text",
              text: ". Share the next step, keep the work clear.",
            },
          ],
        },
      ],
    },
  ]);
  const path = `pages/${root.pageId}/publications`,
    input = {
      scope: {
        pageIds: [],
        databases: [],
        records: [
          {
            recordId: root.pageId,
            propertyIds: [
              title,
              people,
              creator,
              editor,
              count,
              byline,
              relation,
              unique,
            ].map((p) => p.id),
          },
          { recordId: other.pageId, propertyIds: [title.id, creator.id] },
        ],
        people: [],
        extraFileIds: [],
      },
      settings: {
        label: "The handover",
        passwordProtected: false,
        indexable: false,
        expiresAt: null,
      },
      target: null,
    },
    preview = (value = input) =>
      request(path + "/preview", { method: "POST", cookie, body: value }),
    choices = (scope = input.scope, actor = cookie) =>
      request(path + "/people", { method: "POST", cookie: actor, body: scope });
  async function publish(value = input) {
    const review = await preview(value);
    assert.equal(review.response.status, 201, JSON.stringify(review.data));
    const result = await request(path, {
      method: "POST",
      cookie,
      body: {
        requestId: randomUUID(),
        previewToken: review.data.previewToken,
        input: value,
      },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  function page(review) {
    assert.equal(review.response.status, 201, JSON.stringify(review.data));
    return review.data.snapshot.pages.find((p) => p.id === root.pageId);
  }
  return {
    owner,
    colleague,
    cookie,
    space,
    database,
    id,
    title,
    people,
    creator,
    editor,
    count,
    byline,
    relation,
    unique,
    root,
    other,
    path,
    input,
    preview,
    choices,
    publish,
    page,
  };
}

test("public people fields and mentions stay anonymous by default, including formulas and rollup identity targets", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      review = await f.preview(),
      page = f.page(review),
      serialized = JSON.stringify(review.data.snapshot);
    assert.deepEqual(page.record.values[f.people.id], []);
    assert.equal(page.record.values[f.creator.id], null);
    assert.equal(page.record.values[f.editor.id], null);
    assert.equal(page.record.values[f.count.id], 0);
    assert.equal(page.record.values[f.byline.id], "By ");
    assert.equal(page.record.values[f.unique.id], 0);
    assert.equal(review.data.warnings.omittedPeople, 2);
    assert.ok(serialized.includes("@person"));
    for (const privateValue of [
      f.owner.id,
      f.owner.email,
      f.colleague.id,
      f.colleague.email,
      "PRIVATE project directory",
    ])
      assert.ok(!serialized.includes(privateValue), privateValue);
  } finally {
    await db.end();
  }
});

test("public names are explicitly authored, use scoped opaque IDs and drive scalar formulas and selected-target rollups", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db);
    f.input.scope.people = [{ userId: f.owner.id, label: "Studio lead" }];
    let review = await f.preview(),
      page = f.page(review),
      personIds = page.record.values[f.people.id];
    assert.equal(personIds.length, 1);
    assert.notEqual(personIds[0], f.owner.id);
    assert.equal(
      page.record.properties.find((p) => p.id === f.people.id).options[0].label,
      "Studio lead",
    );
    assert.equal(page.record.values[f.creator.id], personIds[0]);
    assert.equal(page.record.values[f.byline.id], "By Studio lead");
    assert.equal(page.record.values[f.count.id], 1);
    assert.equal(page.record.values[f.unique.id], 0);
    assert.ok(JSON.stringify(page.document).includes("@Studio lead"));
    assert.ok(JSON.stringify(page.document).includes("@person"));
    f.input.scope.people.push({ userId: f.colleague.id, label: "Reviewer" });
    review = await f.preview();
    page = f.page(review);
    assert.equal(page.record.values[f.count.id], 2);
    assert.equal(page.record.values[f.unique.id], 1);
    assert.equal(review.data.warnings.omittedPeople, 0);
    const serialized = JSON.stringify(review.data.snapshot);
    for (const privateValue of [
      f.owner.id,
      f.owner.email,
      f.colleague.id,
      f.colleague.email,
    ])
      assert.ok(!serialized.includes(privateValue));
    // A second publication root cannot be used to correlate a person's aliases.
    const otherRoot = await request(
      `pages/${f.other.pageId}/publications/preview`,
      { method: "POST", cookie: f.cookie, body: f.input },
    );
    assert.equal(
      otherRoot.response.status,
      201,
      JSON.stringify(otherRoot.data),
    );
    const otherPage = otherRoot.data.snapshot.pages.find(
      (p) => p.id === f.root.pageId,
    );
    assert.notEqual(otherPage.record.values[f.people.id][0], personIds[0]);
  } finally {
    await db.end();
  }
});

test("private public-name choices resolve only selected references and current readers, with independent publish access", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      outsider = await account(),
      scoped = structuredClone(f.input.scope);
    scoped.people = [{ userId: outsider.id, label: "Unrelated" }];
    let choices = await f.choices(scoped);
    assert.equal(choices.response.status, 201, JSON.stringify(choices.data));
    assert.deepEqual(
      choices.data.people.map((p) => p.id).sort(),
      [f.owner.id, f.colleague.id].sort(),
    );
    assert.equal(
      choices.data.people.find((p) => p.id === f.colleague.id).privateLabel,
      f.colleague.displayName,
    );
    assert.ok(!JSON.stringify(choices.data).includes(outsider.email));
    assert.ok(
      !JSON.stringify(
        f.page(await f.preview({ ...f.input, scope: scoped })),
      ).includes("Unrelated"),
    );
    assert.equal(
      (await f.choices(scoped, f.colleague.cookie)).response.status,
      404,
    );
    assert.equal(
      (await f.choices(scoped, outsider.cookie)).response.status,
      404,
    );
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.space.id, f.colleague.id],
    );
    choices = await f.choices(scoped);
    assert.equal(choices.response.status, 201);
    assert.equal(
      choices.data.people.find((p) => p.id === f.colleague.id).privateLabel,
      "Person no longer on this page",
    );
    assert.ok(!JSON.stringify(choices.data).includes(f.colleague.email));
    await db.query("UPDATE pages SET document=$2 WHERE id=$1", [
      f.root.pageId,
      { type: "doc", content: [{ type: "paragraph" }] },
    ]);
    scoped.records = [{ recordId: f.root.pageId, propertyIds: [f.title.id] }];
    choices = await f.choices(scoped);
    assert.equal(choices.response.status, 201);
    assert.deepEqual(choices.data.people, []);
  } finally {
    await db.end();
  }
});

test("public name edits bind the exact review, escape as text, validate duplicate labels and remain fixed after account changes", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db);
    f.input.scope.people = [
      { userId: f.owner.id, label: '<img src=x onerror="alert(1)"> Lead' },
    ];
    const review = await f.preview();
    f.page(review);
    const changed = structuredClone(f.input);
    changed.scope.people[0].label = "Another name";
    const rejected = await request(f.path, {
      method: "POST",
      cookie: f.cookie,
      body: {
        requestId: randomUUID(),
        previewToken: review.data.previewToken,
        input: changed,
      },
    });
    assert.equal(rejected.response.status, 409);
    const duplicate = structuredClone(f.input);
    duplicate.scope.people.push(duplicate.scope.people[0]);
    assert.equal((await f.preview(duplicate)).response.status, 400);
    duplicate.scope.people = [{ userId: f.owner.id, label: "\n" }];
    assert.equal((await f.preview(duplicate)).response.status, 400);
    const published = await f.publish(),
      token = new URL(published.url).pathname.split("/").at(-1);
    await db.query("UPDATE users SET email=$2 WHERE id=$1", [
      f.owner.id,
      randomUUID() + "@example.test",
    ]);
    const anonymous = await request(`publications/${token}`);
    assert.equal(anonymous.response.status, 200);
    assert.deepEqual(anonymous.data.snapshot, review.data.snapshot);
    const html = await (await fetch(published.url)).text();
    assert.ok(!html.includes('<img src=x onerror="alert(1)">'));
    assert.ok(!html.includes(f.owner.id));
    assert.ok(!html.includes(f.owner.email));
  } finally {
    await db.end();
  }
});

test("Chromium: choose public names without copying addresses, cancel drafts, preview and read isolated person fields and mentions", async () => {
  const { chromium, expect } = await import("@playwright/test"),
    db = new Pool({ connectionString: process.env.DATABASE_URL });
  let browser;
  try {
    const f = await fixture(db);
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
    await page.goto(base + "/?page=" + f.root.pageId);
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue("A clearer handover");
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const share = page.getByRole("dialog", { name: "Share page", exact: true });
    await share.getByRole("tab", { name: "Publish", exact: true }).click();
    const scope = share.locator(".publication-record-scope");
    await scope.getByRole("checkbox", { name: /^People/ }).check();
    await scope.getByRole("checkbox", { name: /^Created by/ }).check();
    await scope
      .getByRole("checkbox", { name: "Shared people", exact: true })
      .check();
    let arrived, release;
    const received = new Promise((resolve) => (arrived = resolve)),
      gate = new Promise((resolve) => (release = resolve)),
      pickerPath = "**/api/v1/" + f.path + "/people";
    await page.route(pickerPath, async (route) => {
      const result = await route.fetch();
      arrived();
      await gate;
      await route.fulfill({ response: result });
    });
    try {
      await share
        .getByRole("button", { name: "Choose names", exact: true })
        .click();
      await received;
      await scope.getByRole("checkbox", { name: /^Created by/ }).uncheck();
      release();
      await expect(share.getByRole("alert")).toHaveText(
        "The selection changed. Open public names again.",
      );
      await expect(
        page.getByRole("dialog", { name: "Choose public names", exact: true }),
      ).toHaveCount(0);
    } finally {
      release();
      await page.unroute(pickerPath);
    }
    await scope.getByRole("checkbox", { name: /^Created by/ }).check();
    await share
      .getByRole("button", { name: "Choose names", exact: true })
      .click();
    const names = page.getByRole("dialog", {
        name: "Choose public names",
        exact: true,
      }),
      own = names.getByRole("checkbox", {
        name: "Share public name for " + f.owner.displayName,
        exact: true,
      });
    await expect(own).not.toBeChecked();
    await own.check();
    const label = names.getByRole("textbox", {
      name: "Public name for " + f.owner.displayName,
      exact: true,
    });
    await expect(label).toHaveValue("");
    await label.fill("Studio lead");
    await names.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      share.getByText("People stay anonymous by default", { exact: true }),
    ).toBeVisible();
    await share
      .getByRole("button", { name: "Choose names", exact: true })
      .click();
    await own.check();
    await expect(label).toHaveValue("");
    await label.fill("Studio lead");
    await names
      .getByRole("button", { name: "Use these names", exact: true })
      .click();
    await expect(
      share.getByText("1 name chosen", { exact: true }),
    ).toBeVisible();
    await share
      .getByRole("button", { name: "Review publication", exact: true })
      .click();
    const review = page.getByRole("dialog", {
      name: "Review publication",
      exact: true,
    });
    await expect(review).toBeVisible();
    await expect(review.getByText(/@Studio lead/)).toBeVisible();
    await expect(review.getByText(f.owner.email, { exact: true })).toHaveCount(
      0,
    );
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/public-people-review.png",
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
    const publication = await response.json(),
      anonymous = await browser.newContext({
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
    await expect(reader.getByText(/@Studio lead/)).toBeVisible();
    await expect(reader.getByText("Studio lead", { exact: true })).toHaveCount(
      2,
    );
    assert.ok(!(await reader.content()).includes(f.owner.id));
    assert.ok(!(await reader.content()).includes(f.owner.email));
    assert.ok(!(await reader.content()).includes(f.colleague.id));
    assert.ok(!(await reader.content()).includes(f.colleague.email));
    await reader.screenshot({
      path: ".local/ui-review/public-people-reader.png",
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
      path: ".local/ui-review/public-people-mobile.png",
      fullPage: true,
    });
    assert.deepEqual(forbidden, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await db.end();
  }
});

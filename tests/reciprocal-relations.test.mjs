import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";

async function account() {
  const result = await request("auth/register", {
    method: "POST",
    body: { email: randomUUID() + "@example.test", password: randomUUID() },
  });
  const cookie = sessionCookie(result.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
async function fixture(db) {
  const owner = await account(),
    targetOwner = await account(),
    writer = await account(),
    viewer = await account();
  async function space(user, name) {
    return (
      await request("spaces", {
        method: "POST",
        cookie: user.cookie,
        body: { name },
      })
    ).data;
  }
  const sourceSpace = await space(owner, "Product studio"),
    targetSpace = await space(targetOwner, "Research lab");
  await db.query("UPDATE spaces SET kind='team' WHERE id=ANY($1::uuid[])", [
    [sourceSpace.id, targetSpace.id],
  ]);
  await db.query(
    "INSERT INTO space_members VALUES($1,$2,'Editor'),($1,$3,'Editor'),($1,$4,'Viewer'),($5,$6,'Editor'),($5,$3,'Viewer')",
    [
      sourceSpace.id,
      targetOwner.id,
      writer.id,
      viewer.id,
      targetSpace.id,
      owner.id,
    ],
  );
  async function database(user, space, name) {
    return (
      await request(`spaces/${space.id}/databases`, {
        method: "POST",
        cookie: user.cookie,
        body: { name },
      })
    ).data;
  }
  const source = await database(owner, sourceSpace, "Decisions"),
    target = await database(targetOwner, targetSpace, "Projects");
  async function metadata(database, user = owner) {
    return (await request(`databases/${database.id}`, { cookie: user.cookie }))
      .data;
  }
  const pair = await request(`databases/${source.id}/properties`, {
    method: "POST",
    cookie: owner.cookie,
    body: {
      name: "Projects",
      type: "Relation",
      relationDatabaseId: target.id,
      reciprocalName: "Decisions",
    },
  });
  assert.equal(pair.response.status, 201, JSON.stringify(pair.data));
  const relation = pair.data,
    reverse = (await metadata(target)).properties.find(
      (property) => property.id === relation.config.reciprocalPropertyId,
    );
  assert.ok(reverse);
  async function record(
    database,
    user,
    title,
    values = {},
    visibility = "space",
  ) {
    const result = await request(`databases/${database.id}/records`, {
      method: "POST",
      cookie: user.cookie,
      body: { title, values, visibility },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  const project = await record(
    target,
    targetOwner,
    "A more thoughtful first week",
  );
  const decision = await record(source, owner, "Keep the first step simple");
  async function get(database, record, user = owner) {
    return (
      await request(`databases/${database.id}/records/${record.pageId}`, {
        cookie: user.cookie,
      })
    ).data.record;
  }
  async function write(database, record, values, user = owner, version) {
    const current = await get(database, record, user);
    return request(`databases/${database.id}/records/${record.pageId}`, {
      method: "PATCH",
      cookie: user.cookie,
      body: { version: version ?? current.version, values },
    });
  }
  return {
    owner,
    targetOwner,
    writer,
    viewer,
    sourceSpace,
    targetSpace,
    source,
    target,
    relation,
    reverse,
    project,
    decision,
    metadata,
    record,
    get,
    write,
  };
}

test("two-way properties require editor rights on both schemas, mirror either editing direction and retain unreadable inverse links", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db);
    assert.equal(f.reverse.config.databaseId, f.source.id);
    assert.equal(f.reverse.config.reciprocalPropertyId, f.relation.id);
    const beforeSource = (await f.metadata(f.source)).properties.length,
      beforeTarget = (await f.metadata(f.target)).properties.length;
    const forbidden = await request(`databases/${f.source.id}/properties`, {
      method: "POST",
      cookie: f.writer.cookie,
      body: {
        name: "New pair",
        type: "Relation",
        relationDatabaseId: f.target.id,
        reciprocalName: "Other decisions",
      },
    });
    assert.equal(forbidden.response.status, 404);
    assert.equal((await f.metadata(f.source)).properties.length, beforeSource);
    assert.equal((await f.metadata(f.target)).properties.length, beforeTarget);
    for (const body of [
      { name: "Not a relation", type: "Text", reciprocalName: "Wrong" },
      { name: "No target", type: "Relation", reciprocalName: "Wrong" },
      {
        name: "Blank reverse",
        type: "Relation",
        relationDatabaseId: f.target.id,
        reciprocalName: " ",
      },
    ])
      assert.equal(
        (
          await request(`databases/${f.source.id}/properties`, {
            method: "POST",
            cookie: f.owner.cookie,
            body,
          })
        ).response.status,
        400,
      );
    // Editing a source link requires only reader access to its target record.
    assert.equal(
      (
        await f.write(
          f.source,
          f.decision,
          { [f.relation.id]: [f.project.pageId] },
          f.writer,
        )
      ).response.status,
      200,
    );
    assert.deepEqual(
      (await f.get(f.target, f.project, f.targetOwner)).values[f.reverse.id],
      [f.decision.pageId],
    );
    assert.deepEqual(
      (await f.get(f.source, f.decision, f.viewer)).values[f.relation.id],
      [],
    );
    assert.equal(
      (await f.write(f.target, f.project, { [f.reverse.id]: [] }, f.writer))
        .response.status,
      404,
    );
    assert.equal(
      (
        await f.write(
          f.target,
          f.project,
          { [f.reverse.id]: [] },
          f.targetOwner,
        )
      ).response.status,
      200,
    );
    assert.deepEqual(
      (await f.get(f.source, f.decision)).values[f.relation.id],
      [],
    );
    const secret = await f.record(
      f.source,
      f.owner,
      "Private decision",
      { [f.relation.id]: [f.project.pageId] },
      "restricted",
    );
    assert.equal(
      (
        await f.write(f.source, f.decision, {
          [f.relation.id]: [f.project.pageId],
        })
      ).response.status,
      200,
    );
    const incoming = await f.get(f.target, f.project, f.targetOwner);
    assert.deepEqual(incoming.values[f.reverse.id], [f.decision.pageId]);
    assert.ok(!JSON.stringify(incoming).includes(secret.pageId));
    assert.equal(
      (
        await f.write(
          f.target,
          f.project,
          { [f.reverse.id]: [] },
          f.targetOwner,
        )
      ).response.status,
      200,
    );
    assert.deepEqual(
      (await f.get(f.source, f.decision)).values[f.relation.id],
      [],
    );
    assert.deepEqual((await f.get(f.source, secret)).values[f.relation.id], [
      f.project.pageId,
    ]);
    assert.deepEqual(
      (
        await db.query(
          "SELECT values->$2 AS links FROM database_records WHERE page_id=$1",
          [f.project.pageId, f.reverse.id],
        )
      ).rows[0].links,
      [secret.pageId],
    );
    const count = (
      await request(`databases/${f.target.id}/properties`, {
        method: "POST",
        cookie: f.targetOwner.cookie,
        body: {
          name: "Decision count",
          type: "Formula",
          formula: 'length(prop("Decisions"))',
        },
      })
    ).data;
    const query = async (user) =>
      (
        await request(`databases/${f.target.id}/query`, {
          method: "POST",
          cookie: user.cookie,
          body: {},
        })
      ).data;
    assert.equal((await query(f.targetOwner)).records[0].values[count.id], 0);
    assert.equal((await query(f.owner)).records[0].values[count.id], 1);
  } finally {
    await db.end();
  }
});

test("simultaneous opposite edits remain atomic and self-relations enforce matching diagonal links", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db);
    const a = await f.get(f.source, f.decision),
      b = await f.get(f.target, f.project, f.targetOwner);
    const results = await Promise.all([
      f.write(
        f.source,
        f.decision,
        { [f.relation.id]: [f.project.pageId] },
        f.owner,
        a.version,
      ),
      f.write(
        f.target,
        f.project,
        { [f.reverse.id]: [f.decision.pageId] },
        f.targetOwner,
        b.version,
      ),
    ]);
    assert.deepEqual(
      results.map((result) => result.response.status).sort(),
      [200, 409],
    );
    assert.deepEqual(
      (await f.get(f.source, f.decision)).values[f.relation.id],
      [f.project.pageId],
    );
    assert.deepEqual(
      (await f.get(f.target, f.project, f.targetOwner)).values[f.reverse.id],
      [f.decision.pageId],
    );
    const self = await request(`databases/${f.source.id}/properties`, {
      method: "POST",
      cookie: f.owner.cookie,
      body: {
        name: "Depends on",
        type: "Relation",
        relationDatabaseId: f.source.id,
        reciprocalName: "Required by",
      },
    });
    assert.equal(self.response.status, 201);
    const out = self.data.id,
      inside = self.data.config.reciprocalPropertyId;
    const other = await f.record(f.source, f.owner, "Another step");
    assert.equal(
      (await f.write(f.source, f.decision, { [out]: [other.pageId] })).response
        .status,
      200,
    );
    assert.deepEqual((await f.get(f.source, other)).values[inside], [
      f.decision.pageId,
    ]);
    assert.equal(
      (
        await f.write(f.source, f.decision, {
          [out]: [f.decision.pageId],
          [inside]: [],
        })
      ).response.status,
      400,
    );
    assert.deepEqual((await f.get(f.source, f.decision)).values[out], [
      other.pageId,
    ]);
    assert.equal(
      (await f.write(f.source, f.decision, { [out]: [f.decision.pageId] }))
        .response.status,
      200,
    );
    const diagonal = await f.get(f.source, f.decision);
    assert.deepEqual(diagonal.values[out], [f.decision.pageId]);
    assert.deepEqual(diagonal.values[inside], [f.decision.pageId]);
    assert.deepEqual((await f.get(f.source, other)).values[inside], []);
    assert.equal(
      (await f.write(f.source, f.decision, { [inside]: [] })).response.status,
      200,
    );
    const cleared = await f.get(f.source, f.decision);
    assert.deepEqual(cleared.values[out], []);
    assert.deepEqual(cleared.values[inside], []);
  } finally {
    await db.end();
  }
});

test("record templates mirror their defaults, schema clones retain self-pairs, and deleting either side disconnects without erasing stored values", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db);
    assert.equal(
      (
        await f.write(f.source, f.decision, {
          [f.relation.id]: [f.project.pageId],
        })
      ).response.status,
      200,
    );
    async function save(kind, recordId) {
      return (
        await request(`databases/${f.source.id}/templates`, {
          method: "POST",
          cookie: f.owner.cookie,
          body: {
            name: "A connected process",
            kind,
            ...(recordId ? { recordId } : {}),
          },
        })
      ).data;
    }
    async function apply(template) {
      const result = await request(`templates/${template.id}/apply`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: {
          requestId: randomUUID(),
          version: template.version,
          title: "Another connected process",
        },
      });
      assert.equal(result.response.status, 201, JSON.stringify(result.data));
      return result.data;
    }
    const recordTemplate = await save("record", f.decision.pageId),
      copied = await apply(recordTemplate);
    assert.ok(
      (await f.get(f.target, f.project)).values[f.reverse.id].includes(
        copied.pageId,
      ),
    );
    const self = (
      await request(`databases/${f.source.id}/properties`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: {
          name: "Next step",
          type: "Relation",
          relationDatabaseId: f.source.id,
          reciprocalName: "Previous step",
        },
      })
    ).data;
    const schemaTemplate = await save("database"),
      clone = await apply(schemaTemplate),
      clonedDb = { id: clone.pageId };
    const meta = await f.metadata(clonedDb);
    const external = meta.properties.find(
        (property) => property.name === "Projects",
      ),
      next = meta.properties.find((property) => property.name === "Next step"),
      previous = meta.properties.find(
        (property) => property.name === "Previous step",
      );
    assert.equal(external.config.databaseId, f.target.id);
    assert.equal(external.config.reciprocalPropertyId, undefined);
    assert.equal(next.config.databaseId, clone.pageId);
    assert.equal(next.config.reciprocalPropertyId, previous.id);
    assert.equal(previous.config.reciprocalPropertyId, next.id);
    assert.notEqual(next.id, self.id);
    const step = await f.record(clonedDb, f.owner, "First cloned step"),
      last = await f.record(clonedDb, f.owner, "Next cloned step", {
        [previous.id]: [step.pageId],
        [external.id]: [f.project.pageId],
      });
    assert.deepEqual((await f.get(clonedDb, step)).values[next.id], [
      last.pageId,
    ]);
    assert.ok(
      !(await f.get(f.target, f.project)).values[f.reverse.id].includes(
        last.pageId,
      ),
    );
    // The target owner can remove its own property after source access is lost.
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.sourceSpace.id, f.targetOwner.id],
    );
    const before = await f.metadata(f.target, f.targetOwner);
    assert.equal(
      (
        await request(`databases/${f.target.id}/properties/${f.reverse.id}`, {
          method: "DELETE",
          cookie: f.targetOwner.cookie,
          body: { schemaVersion: before.schemaVersion },
        })
      ).response.status,
      200,
    );
    assert.equal(
      (await f.metadata(f.source)).properties.find(
        (property) => property.id === f.relation.id,
      ).config.reciprocalPropertyId,
      undefined,
    );
    const archived = await f.metadata(f.target, f.targetOwner);
    assert.equal(
      (
        await request(
          `databases/${f.target.id}/properties/${f.reverse.id}/restore`,
          {
            method: "POST",
            cookie: f.targetOwner.cookie,
            body: { schemaVersion: archived.schemaVersion },
          },
        )
      ).response.status,
      200,
    );
    assert.equal(
      (await f.metadata(f.target)).properties.find(
        (property) => property.id === f.reverse.id,
      ).config.reciprocalPropertyId,
      undefined,
    );
    assert.equal(
      (await f.write(f.source, f.decision, { [f.relation.id]: [] })).response
        .status,
      200,
    );
    assert.ok(
      (await f.get(f.target, f.project)).values[f.reverse.id].includes(
        f.decision.pageId,
      ),
    );
  } finally {
    await db.end();
  }
});

test("two-way CSV writes roll back both databases at the stored-link limit and never create a partial fifty-first record", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      title = f.source.properties.find((property) => property.type === "Title");
    const field =
      '"' + JSON.stringify([f.project.pageId]).replaceAll('"', '""') + '"';
    const csv = (count) =>
      "Name,Projects\n" +
      Array.from(
        { length: count },
        (_, index) => `Decision ${index + 1},${field}`,
      ).join("\n") +
      "\n";
    async function upload(action, text, settings) {
      const body = new FormData();
      body.append("file", new Blob([text], { type: "text/csv" }), "paired.csv");
      body.append("settings", JSON.stringify(settings));
      const response = await fetch(
        `${base}/api/v1/databases/${f.source.id}/import/csv/${action}`,
        {
          method: "POST",
          headers: { Origin: process.env.TEST_ORIGIN, Cookie: f.owner.cookie },
          body,
        },
      );
      return { status: response.status, data: await response.json() };
    }
    const mapping = [
      { column: 0, propertyId: title.id },
      { column: 1, propertyId: f.relation.id },
    ];
    const tooMany = csv(51),
      preview = await upload("preview", tooMany, { mapping });
    assert.equal(preview.data.canImport, true);
    assert.equal(
      (await upload("confirm", tooMany, { token: preview.data.token })).status,
      400,
    );
    assert.deepEqual(
      (await f.get(f.target, f.project)).values[f.reverse.id],
      [],
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM database_records WHERE database_id=$1",
          [f.source.id],
        )
      ).rows[0].n,
      1,
    );
    const accepted = csv(50),
      valid = await upload("preview", accepted, { mapping });
    assert.equal(
      (await upload("confirm", accepted, { token: valid.data.token })).status,
      201,
    );
    assert.equal(
      (await f.get(f.target, f.project)).values[f.reverse.id].length,
      50,
    );
    const blocked = await request(`databases/${f.source.id}/records`, {
      method: "POST",
      cookie: f.owner.cookie,
      body: {
        title: "Must not appear",
        values: { [f.relation.id]: [f.project.pageId] },
      },
    });
    assert.equal(blocked.response.status, 400);
    assert.equal(
      (
        await db.query(
          "SELECT 1 FROM pages WHERE space_id=$1 AND title='Must not appear'",
          [f.sourceSpace.id],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM database_records WHERE database_id=$1",
          [f.source.id],
        )
      ).rows[0].n,
      51,
    );
    const freed = (
      await request(`databases/${f.source.id}/query`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: {},
      })
    ).data.records.find((record) => record.title === "Decision 1");
    assert.equal(
      (await f.write(f.source, freed, { [f.relation.id]: [] })).response.status,
      200,
    );
    assert.equal(
      (await f.get(f.target, f.project)).values[f.reverse.id].length,
      49,
    );
  } finally {
    await db.end();
  }
});

test("simultaneous imports from different spaces lock shared inverse targets in a stable order", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      secondProject = await f.record(
        f.target,
        f.targetOwner,
        "A second project",
      );
    const other = (
      await request(`spaces/${f.targetSpace.id}/databases`, {
        method: "POST",
        cookie: f.targetOwner.cookie,
        body: { name: "Experiments" },
      })
    ).data;
    const secondPair = await request(`databases/${other.id}/properties`, {
      method: "POST",
      cookie: f.targetOwner.cookie,
      body: {
        name: "Projects",
        type: "Relation",
        relationDatabaseId: f.target.id,
        reciprocalName: "Experiments",
      },
    });
    assert.equal(secondPair.response.status, 201);
    const aTitle = f.source.properties.find(
        (property) => property.type === "Title",
      ),
      bTitle = other.properties.find((property) => property.type === "Title");
    const csv = (prefix, ids) =>
      "Name,Projects\n" +
      ids
        .map(
          (id, index) =>
            prefix +
            (index + 1) +
            ',"' +
            JSON.stringify([id]).replaceAll('"', '""') +
            '"',
        )
        .join("\n") +
      "\n";
    async function upload(database, user, action, text, settings) {
      const body = new FormData();
      body.append(
        "file",
        new Blob([text], { type: "text/csv" }),
        "parallel.csv",
      );
      body.append("settings", JSON.stringify(settings));
      const response = await fetch(
        `${base}/api/v1/databases/${database.id}/import/csv/${action}`,
        {
          method: "POST",
          headers: { Origin: process.env.TEST_ORIGIN, Cookie: user.cookie },
          body,
        },
      );
      return { status: response.status, data: await response.json() };
    }
    const a = csv("Alpha ", [f.project.pageId, secondProject.pageId]),
      b = csv("Beta ", [secondProject.pageId, f.project.pageId]);
    const previews = await Promise.all([
      upload(f.source, f.owner, "preview", a, {
        mapping: [
          { column: 0, propertyId: aTitle.id },
          { column: 1, propertyId: f.relation.id },
        ],
      }),
      upload(other, f.targetOwner, "preview", b, {
        mapping: [
          { column: 0, propertyId: bTitle.id },
          { column: 1, propertyId: secondPair.data.id },
        ],
      }),
    ]);
    assert.ok(previews.every((preview) => preview.data.canImport));
    const results = await Promise.all([
      upload(f.source, f.owner, "confirm", a, {
        token: previews[0].data.token,
      }),
      upload(other, f.targetOwner, "confirm", b, {
        token: previews[1].data.token,
      }),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      [201, 201],
      JSON.stringify(results),
    );
    for (const project of [f.project, secondProject]) {
      const record = await f.get(f.target, project);
      assert.equal(record.values[f.reverse.id].length, 1);
      assert.equal(
        record.values[secondPair.data.config.reciprocalPropertyId].length,
        1,
      );
    }
  } finally {
    await db.end();
  }
});

import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { pageLink } from "../packages/editor/dist/links.js";
test("Chromium: configure two-way properties, edit either side live, retain independent permissions and fit mobile", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const contexts = [],
    errors = [];
  let page;
  async function session(user) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
      reducedMotion: "reduce",
    });
    contexts.push(context);
    await context.addInitScript(() =>
      localStorage.setItem("orvyn.theme", "light"),
    );
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
    p.on("pageerror", (error) => errors.push(error.message));
    return p;
  }
  try {
    await mkdir(".local/ui-review", { recursive: true });
    const f = await fixture(db),
      other = await f.record(f.source, f.owner, "Collect the first questions");
    page = await session(f.owner);
    const target = await session(f.targetOwner);
    await page.goto(base + pageLink(f.source.id));
    await target.goto(base + pageLink(f.target.id));
    await page
      .getByRole("button", { name: "Add a property", exact: true })
      .click();
    const builder = page.getByRole("dialog", {
      name: "New property",
      exact: true,
    });
    await builder
      .getByLabel("Property name", { exact: true })
      .fill("Research context");
    await builder
      .getByLabel("Property type", { exact: true })
      .selectOption("Relation");
    await builder.getByLabel("Related database", { exact: true }).click();
    const databases = page.getByRole("dialog", {
      name: "Choose a database",
      exact: true,
    });
    await databases
      .getByRole("searchbox", { name: "Search databases", exact: true })
      .fill("Projects");
    await databases
      .getByRole("list", { name: "Search results", exact: true })
      .getByRole("button")
      .filter({ hasText: "Projects" })
      .click();
    const toggle = builder.getByRole("checkbox", {
      name: "Create a two-way relation",
      exact: true,
    });
    await expect(toggle).toBeEnabled();
    await toggle.check();
    const inverseName = builder.getByLabel(
      "Property name in related database",
      { exact: true },
    );
    await expect(inverseName).toHaveValue("Decisions 2");
    await inverseName.fill("Product decisions");
    await page.screenshot({
      path: ".local/ui-review/reciprocal-property-setup.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await builder.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: ".local/ui-review/reciprocal-property-mobile.png",
      fullPage: true,
    });
    await builder
      .getByRole("button", { name: "Add property", exact: true })
      .click();
    await expect(builder).not.toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1050 });
    const sourceTable = page.locator(".database-table"),
      targetTable = target.locator(".database-table");
    const sourceRow = sourceTable.getByRole("row").filter({
      has: page.getByRole("button", { name: f.decision.title, exact: true }),
    });
    const otherRow = sourceTable.getByRole("row").filter({
      has: page.getByRole("button", { name: other.title, exact: true }),
    });
    const forward = sourceRow.locator("td.property-relation").nth(1);
    const reverse = targetTable.locator("td.property-relation").nth(1);
    await forward
      .getByRole("button", { name: "Research context", exact: true })
      .click();
    const forwardPicker = page.getByRole("dialog", {
      name: "Research context links",
      exact: true,
    });
    await forwardPicker
      .getByRole("option", { name: f.project.title, exact: false })
      .click();
    await forwardPicker
      .getByRole("button", { name: "Apply links", exact: true })
      .click();
    await expect(
      forward.getByRole("link", { name: f.project.title, exact: true }),
    ).toBeVisible();
    await expect(
      reverse.getByRole("link", { name: f.decision.title, exact: true }),
    ).toBeVisible();
    await target.screenshot({
      path: ".local/ui-review/reciprocal-target-database.png",
      fullPage: true,
    });
    await reverse
      .getByRole("button", { name: "Product decisions", exact: true })
      .click();
    const reversePicker = target.getByRole("dialog", {
      name: "Product decisions links",
      exact: true,
    });
    await reversePicker
      .getByRole("option", { name: f.decision.title, exact: false })
      .click();
    await reversePicker
      .getByRole("option", { name: other.title, exact: false })
      .click();
    await reversePicker
      .getByRole("button", { name: "Apply links", exact: true })
      .click();
    await expect(forward.getByRole("link")).toHaveCount(0);
    await expect(
      otherRow.getByRole("link", { name: f.project.title, exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      otherRow.getByRole("link", { name: f.project.title, exact: true }),
    ).toBeVisible();
    const readTarget = await session(f.writer);
    await readTarget.goto(base + pageLink(f.source.id));
    await readTarget
      .getByRole("button", { name: "Add a property", exact: true })
      .click();
    const readonlyBuilder = readTarget.getByRole("dialog", {
      name: "New property",
      exact: true,
    });
    await readonlyBuilder
      .getByLabel("Property type", { exact: true })
      .selectOption("Relation");
    await readonlyBuilder
      .getByLabel("Related database", { exact: true })
      .click();
    const readonlyPicker = readTarget.getByRole("dialog", {
      name: "Choose a database",
      exact: true,
    });
    await readonlyPicker
      .getByRole("searchbox", { name: "Search databases", exact: true })
      .fill("Projects");
    await readonlyPicker
      .getByRole("list", { name: "Search results", exact: true })
      .getByRole("button")
      .filter({ hasText: "Projects" })
      .click();
    await expect(
      readonlyBuilder.getByRole("checkbox", {
        name: "Create a two-way relation",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(readonlyBuilder).toContainText(
      "Editing access to the related database is required",
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page)
      await page.screenshot({
        path: ".local/ui-review/reciprocal-relations-failure.png",
        fullPage: true,
      });
    console.error("Reciprocal browser errors", errors);
    throw error;
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
    await db.end();
  }
});

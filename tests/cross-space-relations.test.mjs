import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { chromium, expect } from "./browser-tools.mjs";
import { pageLink } from "../packages/editor/dist/links.js";
import { migrate } from "../apps/api/dist/migrations.js";

async function account() {
  const r = await request("auth/register", {
    method: "POST",
    body: { email: randomUUID() + "@example.test", password: randomUUID() },
  });
  const cookie = sessionCookie(r.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
async function fixture(db) {
  const owner = await account(),
    targetOwner = await account(),
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
    "INSERT INTO space_members VALUES($1,$2,'Viewer'),($3,$4,'Viewer')",
    [sourceSpace.id, viewer.id, targetSpace.id, owner.id],
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
  const source = await database(owner, sourceSpace, "Product decisions"),
    target = await database(targetOwner, targetSpace, "Research projects");
  async function property(user, database, name, type, extra = {}) {
    const result = await request(`databases/${database.id}/properties`, {
      method: "POST",
      cookie: user.cookie,
      body: { name, type, ...extra },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  const hours = await property(targetOwner, target, "Hours", "Number");
  const notes = await property(owner, source, "Notes", "Text");
  const relation = await property(owner, source, "Projects", "Relation", {
    relationDatabaseId: target.id,
  });
  const rollup = await property(owner, source, "Research hours", "Rollup", {
    rollup: {
      relationId: relation.id,
      targetPropertyId: hours.id,
      aggregation: "sum",
    },
  });
  const count = await property(owner, source, "Project count", "Formula", {
    formula: 'length(prop("Projects"))',
  });
  async function record(user, database, title, values, visibility = "space") {
    const result = await request(`databases/${database.id}/records`, {
      method: "POST",
      cookie: user.cookie,
      body: { title, values, visibility },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  const project = await record(
    targetOwner,
    target,
    "Understand the first week",
    { [hours.id]: 7 },
  );
  const secret = await record(
    targetOwner,
    target,
    "Confidential research",
    { [hours.id]: 99 },
    "restricted",
  );
  const decision = await record(owner, source, "A clearer first impression", {
    [relation.id]: [project.pageId],
    [notes.id]: "Make the first step feel effortless.",
  });
  const query = async (user = owner, extra = {}) =>
    (
      await request(`databases/${source.id}/query`, {
        method: "POST",
        cookie: user.cookie,
        body: extra,
      })
    ).data;
  return {
    owner,
    targetOwner,
    viewer,
    sourceSpace,
    targetSpace,
    source,
    target,
    hours,
    notes,
    relation,
    rollup,
    count,
    project,
    secret,
    decision,
    query,
    property,
    record,
  };
}

test("migration backfills cross-space relation edges without changing existing page or record revisions", async () => {
  const root = new Pool({ connectionString: process.env.DATABASE_URL });
  const name = "orvyn_test_" + randomBytes(8).toString("hex");
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = "/" + name;
  let db;
  try {
    await root.query("CREATE DATABASE " + name);
    db = new Pool({ connectionString: url.toString() });
    await migrate(db, 35);
    const owner = (
      await db.query(
        "INSERT INTO users(email,password_hash) VALUES('cross-upgrade@example.test','existing') RETURNING id",
      )
    ).rows[0].id;
    const spaces = (
      await db.query(
        "INSERT INTO spaces(owner_id,name) VALUES($1,'First'),($1,'Second') RETURNING id",
        [owner],
      )
    ).rows;
    const source = randomUUID(),
      target = randomUUID(),
      sourceRecord = randomUUID(),
      targetRecord = randomUUID(),
      relation = randomUUID();
    await db.query(
      "INSERT INTO pages(id,space_id,title,kind,created_by,last_edited_by) VALUES($1,$2,'Source','database',$5,$5),($3,$4,'Target','database',$5,$5)",
      [source, spaces[0].id, target, spaces[1].id, owner],
    );
    await db.query("INSERT INTO databases(page_id) VALUES($1),($2)", [
      source,
      target,
    ]);
    await db.query(
      "INSERT INTO database_properties(id,database_id,name,type,config,position) VALUES($1,$2,'Related','Relation',$3,0)",
      [relation, source, { databaseId: target }],
    );
    await db.query(
      "INSERT INTO pages(id,space_id,parent_id,title,kind,created_by,last_edited_by) VALUES($1,$2,$3,'First record','record',$7,$7),($4,$5,$6,'Other record','record',$7,$7)",
      [
        sourceRecord,
        spaces[0].id,
        source,
        targetRecord,
        spaces[1].id,
        target,
        owner,
      ],
    );
    await db.query(
      "INSERT INTO database_records(page_id,database_id,values) VALUES($1,$2,'{}')",
      [targetRecord, target],
    );
    await db.query(
      "INSERT INTO database_records(page_id,database_id,values) VALUES($1,$2,$3)",
      [sourceRecord, source, { [relation]: [targetRecord] }],
    );
    await db.query("SELECT orvyn_replace_record_relations($1)", [sourceRecord]);
    assert.equal(
      (
        await db.query("SELECT * FROM record_relations WHERE source_id=$1", [
          sourceRecord,
        ])
      ).rowCount,
      0,
    );
    const before = (
      await db.query(
        "SELECT p.version,p.updated_at::text,r.version AS record_version FROM pages p JOIN database_records r ON r.page_id=p.id WHERE p.id=$1",
        [sourceRecord],
      )
    ).rows[0];
    await migrate(db);
    assert.deepEqual(
      (
        await db.query(
          "SELECT p.version,p.updated_at::text,r.version AS record_version FROM pages p JOIN database_records r ON r.page_id=p.id WHERE p.id=$1",
          [sourceRecord],
        )
      ).rows[0],
      before,
    );
    assert.deepEqual(
      (
        await db.query(
          "SELECT orvyn_record_relation_values($1,$2,$3) AS value",
          [sourceRecord, relation, owner],
        )
      ).rows[0].value,
      [targetRecord],
    );
  } finally {
    if (db) await db.end();
    await root.query("DROP DATABASE IF EXISTS " + name);
    await root.end();
  }
});

test("cross-space relation queries, formulas, rollups, filters, exports and templates recheck independent target membership and preserve hidden references", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db);
    const values = (result) =>
      result.records.find((record) => record.pageId === f.decision.pageId)
        .values;
    assert.deepEqual(values(await f.query())[f.relation.id], [
      f.project.pageId,
    ]);
    assert.equal(values(await f.query())[f.rollup.id], 7);
    assert.equal(values(await f.query())[f.count.id], 1);
    const hidden = await f.query(f.viewer);
    assert.deepEqual(values(hidden)[f.relation.id], []);
    assert.equal(values(hidden)[f.rollup.id], null);
    assert.equal(values(hidden)[f.count.id], 0);
    assert.ok(!JSON.stringify(hidden).includes(f.project.title));
    const relatedPath = `databases/${f.source.id}/properties/${f.relation.id}/records`;
    assert.equal(
      (await request(relatedPath, { cookie: f.viewer.cookie })).response.status,
      404,
    );
    const current = (
      await request(`databases/${f.source.id}/records/${f.decision.pageId}`, {
        cookie: f.owner.cookie,
      })
    ).data.record;
    for (const id of [f.secret.pageId, randomUUID()]) {
      const result = await request(
        `databases/${f.source.id}/records/${f.decision.pageId}`,
        {
          method: "PATCH",
          cookie: f.owner.cookie,
          body: { version: current.version, values: { [f.relation.id]: [id] } },
        },
      );
      assert.equal(result.response.status, 400);
      assert.equal(
        result.data.message,
        "Choose current readable records from the related database",
      );
    }
    assert.equal(
      (
        await f.query(f.owner, {
          filters: [
            {
              propertyId: f.relation.id,
              operator: "contains",
              value: f.project.pageId,
            },
          ],
        })
      ).records.length,
      1,
    );
    assert.equal(
      (
        await f.query(f.viewer, {
          filters: [
            {
              propertyId: f.relation.id,
              operator: "contains",
              value: f.project.pageId,
            },
          ],
        })
      ).records.length,
      0,
    );
    const template = (
      await request(`databases/${f.source.id}/templates`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: {
          name: "A considered decision",
          kind: "record",
          recordId: f.decision.pageId,
        },
      })
    ).data;
    const schemaTemplate = (
      await request(`databases/${f.source.id}/templates`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: { name: "Decision process", kind: "database" },
      })
    ).data;
    const apply = async (template) =>
      request(`templates/${template.id}/apply`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: {
          requestId: randomUUID(),
          version: template.version,
          title: "Another decision",
        },
      });
    const applied = await apply(template);
    assert.equal(applied.response.status, 201);
    assert.deepEqual(
      (
        await request(
          `databases/${f.source.id}/records/${applied.data.pageId}`,
          { cookie: f.owner.cookie },
        )
      ).data.record.values[f.relation.id],
      [f.project.pageId],
    );
    const cloned = await apply(schemaTemplate);
    assert.equal(cloned.response.status, 201);
    const cloneMeta = (
      await request(`databases/${cloned.data.pageId}`, {
        cookie: f.owner.cookie,
      })
    ).data;
    assert.equal(
      cloneMeta.properties.find((property) => property.type === "Relation")
        .config.databaseId,
      f.target.id,
    );
    // Target-only membership grants data visibility but never record edit rights.
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      f.targetSpace.id,
      f.viewer.id,
    ]);
    assert.equal(values(await f.query(f.viewer))[f.rollup.id], 7);
    assert.deepEqual(values(await f.query(f.viewer))[f.relation.id], [
      f.project.pageId,
    ]);
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=ANY($2::uuid[])",
      [f.targetSpace.id, [f.owner.id, f.viewer.id]],
    );
    assert.equal(values(await f.query())[f.rollup.id], null);
    const exported = (
      await request(`databases/${f.source.id}/export.json`, {
        cookie: f.owner.cookie,
      })
    ).data;
    assert.ok(!JSON.stringify(exported).includes(f.project.title));
    assert.ok(!JSON.stringify(exported.records).includes(f.project.pageId));
    const preview = (
      await request(`templates/${template.id}`, { cookie: f.owner.cookie })
    ).data;
    assert.deepEqual(preview.preview.values[f.relation.id], []);
    const afterRevocation = await apply(template);
    assert.equal(afterRevocation.response.status, 201);
    assert.deepEqual(
      (
        await request(
          `databases/${f.source.id}/records/${afterRevocation.data.pageId}`,
          { cookie: f.owner.cookie },
        )
      ).data.record.values[f.relation.id],
      [],
    );
    assert.equal((await apply(schemaTemplate)).response.status, 400);
    // Editing the visible empty selection must not erase the inaccessible old ID.
    const latest = (
      await request(`databases/${f.source.id}/records/${f.decision.pageId}`, {
        cookie: f.owner.cookie,
      })
    ).data.record;
    const edit = await request(
      `databases/${f.source.id}/records/${f.decision.pageId}`,
      {
        method: "PATCH",
        cookie: f.owner.cookie,
        body: {
          version: latest.version,
          values: {
            [f.relation.id]: [],
            [f.notes.id]: "Still editable in the source space",
          },
        },
      },
    );
    assert.equal(edit.response.status, 200);
    assert.deepEqual(
      (
        await db.query(
          "SELECT values->$2 AS links FROM database_records WHERE page_id=$1",
          [f.decision.pageId, f.relation.id],
        )
      ).rows[0].links,
      [f.project.pageId],
    );
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      f.targetSpace.id,
      f.owner.id,
    ]);
    assert.deepEqual(values(await f.query())[f.relation.id], [
      f.project.pageId,
    ]);
    assert.equal(values(await f.query())[f.rollup.id], 7);
  } finally {
    await db.end();
  }
});

import { peer, waitFor } from "./collaboration-peer.mjs";
test("cross-space subscriptions refresh other replicas on target changes and grants, then stop announcing inaccessible target activity", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let client;
  try {
    const f = await fixture(db);
    // A historical link may remain stored after its target becomes inaccessible.
    await db.query(
      "UPDATE database_records SET values=jsonb_set(values,ARRAY[$2::text],$3::jsonb),version=version+1 WHERE page_id=$1",
      [
        f.decision.pageId,
        f.relation.id,
        JSON.stringify([f.project.pageId, f.secret.pageId]),
      ],
    );
    await db.query("SELECT orvyn_replace_record_relations($1)", [
      f.decision.pageId,
    ]);
    client = peer(
      JSON.parse(process.env.COLLABORATION_TEST_URLS)[1],
      f.source.id,
      f.owner.cookie,
    );
    let changes = 0,
      watched = -1;
    client.provider.on("stateless", ({ payload }) => {
      const message = JSON.parse(payload);
      if (message.type === "database-changed") changes++;
      if (message.type === "records-watched") watched = message.count;
    });
    await waitFor(
      () => client.provider.isSynced,
      "Cross-space source client synced",
    );
    client.provider.sendStateless(
      JSON.stringify({ type: "watch-records", recordIds: [f.decision.pageId] }),
    );
    await waitFor(() => watched === 1, "Cross-space source watch registered");
    async function rename(record, title) {
      const page = (
        await request("pages/" + record.pageId, {
          cookie: f.targetOwner.cookie,
        })
      ).data;
      assert.equal(
        (
          await request(`pages/${page.id}/title`, {
            method: "PATCH",
            cookie: f.targetOwner.cookie,
            body: { title, titleVersion: page.title_version },
          })
        ).response.status,
        200,
      );
    }
    const initial = changes;
    await rename(f.secret, "A private research update");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(changes, initial);
    await rename(f.project, "A shared research update");
    await waitFor(
      () => changes > initial,
      "Readable cross-space rename announced",
    );
    assert.ok(
      (await f.query()).records[0].relations.some(
        (record) => record.title === "A shared research update",
      ),
    );
    const previous = changes;
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.targetSpace.id, f.owner.id],
    );
    await waitFor(
      () => changes > previous,
      "Target-space revocation clears its old projection",
    );
    const hidden = changes;
    await rename(f.project, "Later inaccessible activity");
    await rename(f.secret, "Still private");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(
      changes,
      hidden,
      "Hidden cross-space activity sends no source invalidation",
    );
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      f.targetSpace.id,
      f.owner.id,
    ]);
    await waitFor(
      () => changes > hidden,
      "Target-space grant refreshes existing source subscription",
    );
    assert.ok(
      (await f.query()).records[0].relations.some(
        (record) => record.title === "Later inaccessible activity",
      ),
    );
    assert.ok(!JSON.stringify(await f.query()).includes("Still private"));
  } finally {
    client?.destroy();
    await db.end();
  }
});

test("CSV import accepts readable cross-space links and rejects an entire confirmation after target membership is revoked", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db);
    const title = f.source.properties.find(
      (property) => property.type === "Title",
    );
    const input =
      'Name,Projects\nImported decision,"' +
      JSON.stringify([f.project.pageId]).replaceAll('"', '""') +
      '"\n';
    const mapping = [
      { column: 0, propertyId: title.id },
      { column: 1, propertyId: f.relation.id },
    ];
    async function upload(action, settings) {
      const body = new FormData();
      body.append(
        "file",
        new Blob([input], { type: "text/csv" }),
        "cross-space.csv",
      );
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
    const preview = await upload("preview", { mapping });
    assert.equal(preview.status, 201);
    assert.equal(preview.data.canImport, true);
    const before = (await f.query()).records.length;
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.targetSpace.id, f.owner.id],
    );
    assert.equal(
      (await upload("confirm", { token: preview.data.token })).status,
      400,
    );
    assert.equal((await f.query()).records.length, before);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      f.targetSpace.id,
      f.owner.id,
    ]);
    const again = await upload("preview", { mapping });
    assert.equal(again.data.canImport, true);
    assert.equal(
      (await upload("confirm", { token: again.data.token })).status,
      201,
    );
    const imported = (await f.query()).records.find(
      (record) => record.title === "Imported decision",
    );
    assert.deepEqual(imported.values[f.relation.id], [f.project.pageId]);
    assert.equal(imported.values[f.rollup.id], 7);
  } finally {
    await db.end();
  }
});

test("Chromium: choose a related database across spaces, link records, update live calculations and remove revoked target content", async () => {
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
    const f = await fixture(db);
    await request(`spaces/${f.targetSpace.id}/databases`, {
      method: "POST",
      cookie: f.targetOwner.cookie,
      body: { name: "Research library" },
    });
    await request(`spaces/${f.sourceSpace.id}/pages`, {
      method: "POST",
      cookie: f.owner.cookie,
      body: { title: "Research index" },
    });
    const privateSpace = (
      await request("spaces", {
        method: "POST",
        cookie: f.targetOwner.cookie,
        body: { name: "Private research" },
      })
    ).data;
    await request(`spaces/${privateSpace.id}/databases`, {
      method: "POST",
      cookie: f.targetOwner.cookie,
      body: { name: "Research secrets" },
    });
    page = await session(f.owner);
    await page.goto(base + pageLink(f.source.id));
    const table = page.locator(".database-table");
    const field = table.locator("td.property-relation").first();
    await expect(
      field.getByRole("link", { name: f.project.title, exact: true }),
    ).toBeVisible();
    await expect(table.locator("td.property-rollup")).toHaveText("7");
    await page
      .getByRole("button", { name: "Add a property", exact: true })
      .click();
    const builder = page.getByRole("dialog", {
      name: "New property",
      exact: true,
    });
    await builder
      .getByLabel("Property name", { exact: true })
      .fill("Context links");
    await builder
      .getByLabel("Property type", { exact: true })
      .selectOption("Relation");
    await expect(
      builder.getByRole("button", { name: "Add property", exact: true }),
    ).toBeDisabled();
    await builder.getByLabel("Related database", { exact: true }).click();
    const picker = page.getByRole("dialog", {
      name: "Choose a database",
      exact: true,
    });
    const input = picker.getByRole("searchbox", {
      name: "Search databases",
      exact: true,
    });
    await input.fill("Research");
    const results = picker.getByRole("list", {
      name: "Search results",
      exact: true,
    });
    await expect(results.getByRole("button")).toHaveCount(2);
    await expect(results).toContainText("Research lab");
    await expect(results).not.toContainText("Research secrets");
    await expect(results).not.toContainText("Research index");
    await expect(
      picker.getByLabel("Content type", { exact: true }),
    ).toHaveCount(0);
    await picker
      .getByLabel("Search space", { exact: true })
      .selectOption(f.sourceSpace.id);
    await expect(results.getByRole("button")).toHaveCount(0);
    await picker
      .getByLabel("Search space", { exact: true })
      .selectOption(f.targetSpace.id);
    await expect(results.getByRole("button")).toHaveCount(2);
    await page.screenshot({
      path: ".local/ui-review/cross-space-database-picker.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await picker.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: ".local/ui-review/cross-space-database-picker-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await results
      .getByRole("button")
      .filter({ hasText: "Research projects" })
      .click();
    await expect(picker).not.toBeVisible();
    await expect(
      builder.getByLabel("Related database", { exact: true }),
    ).toContainText("Research lab");
    await builder
      .getByRole("button", { name: "Add property", exact: true })
      .click();
    await expect(builder).not.toBeVisible();
    const contextField = table.locator("td.property-relation").nth(1);
    await contextField
      .getByRole("button", { name: "Context links", exact: true })
      .click();
    const links = page.getByRole("dialog", {
      name: "Context links links",
      exact: true,
    });
    await expect(
      links.getByRole("option", { name: f.secret.title, exact: false }),
    ).toHaveCount(0);
    await links
      .getByRole("option", { name: f.project.title, exact: false })
      .click();
    await links
      .getByRole("button", { name: "Apply links", exact: true })
      .click();
    await expect(
      contextField.getByRole("link", { name: f.project.title, exact: true }),
    ).toBeVisible();
    const viewer = await session(f.viewer);
    await viewer.goto(base + pageLink(f.source.id));
    await expect(viewer.locator(".database-table")).toContainText(
      f.decision.title,
    );
    await expect(
      viewer.getByRole("link", { name: f.project.title, exact: true }),
    ).toHaveCount(0);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      f.targetSpace.id,
      f.viewer.id,
    ]);
    await expect(
      viewer.getByRole("link", { name: f.project.title, exact: true }).first(),
    ).toBeVisible();
    const targetPage = (
      await request("pages/" + f.project.pageId, {
        cookie: f.targetOwner.cookie,
      })
    ).data;
    await request(`pages/${targetPage.id}/title`, {
      method: "PATCH",
      cookie: f.targetOwner.cookie,
      body: {
        title: "Learn what makes the first week work",
        titleVersion: targetPage.title_version,
      },
    });
    await expect(
      field.getByRole("link", {
        name: "Learn what makes the first week work",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      viewer
        .getByRole("link", {
          name: "Learn what makes the first week work",
          exact: true,
        })
        .first(),
    ).toBeVisible();
    const targetRecord = (
      await request(`databases/${f.target.id}/records/${f.project.pageId}`, {
        cookie: f.targetOwner.cookie,
      })
    ).data.record;
    await request(`databases/${f.target.id}/records/${f.project.pageId}`, {
      method: "PATCH",
      cookie: f.targetOwner.cookie,
      body: { version: targetRecord.version, values: { [f.hours.id]: 12 } },
    });
    await expect(table.locator("td.property-rollup")).toHaveText("12");
    await expect(viewer.locator("td.property-rollup")).toHaveText("12");
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.targetSpace.id, f.owner.id],
    );
    await expect(field.getByRole("link")).toHaveCount(0);
    await expect(contextField.getByRole("link")).toHaveCount(0);
    await expect(table.locator("td.property-rollup")).not.toHaveText("12");
    await expect(
      viewer
        .getByRole("link", {
          name: "Learn what makes the first week work",
          exact: true,
        })
        .first(),
    ).toBeVisible();
    await page.reload();
    await expect(table).toContainText(f.decision.title);
    await expect(field.getByRole("link")).toHaveCount(0);
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page)
      await page.screenshot({
        path: ".local/ui-review/cross-space-relations-failure.png",
        fullPage: true,
      });
    console.error("Cross-space browser errors", errors);
    throw error;
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
    await db.end();
  }
});

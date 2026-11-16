import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { peer, waitFor } from "./collaboration-peer.mjs";
const account = async (name) => {
  const result = await request("auth/register", {
      method: "POST",
      body: {
        email: name + "-" + randomUUID().slice(0, 12) + "@example.test",
        password: randomUUID(),
      },
    }),
    cookie = sessionCookie(result.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
};
async function fixture(db) {
  const owner = await account("alex"),
    writer = await account("sam"),
    viewer = await account("jules"),
    space = (
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Delivery team" },
      })
    ).data;
  await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
  await db.query(
    "INSERT INTO space_members VALUES($1,$2,'Editor'),($1,$3,'Viewer')",
    [space.id, writer.id, viewer.id],
  );
  const createDb = async (name) =>
      (
        await request(`spaces/${space.id}/databases`, {
          method: "POST",
          cookie: owner.cookie,
          body: { name },
        })
      ).data,
    target = await createDb("Projects"),
    source = await createDb("Tasks"),
    relation = await request(`databases/${source.id}/properties`, {
      method: "POST",
      cookie: owner.cookie,
      body: {
        name: "Project",
        type: "Relation",
        relationDatabaseId: target.id,
      },
    });
  assert.equal(relation.response.status, 201, JSON.stringify(relation.data));
  const add = async (title, visibility = "space") => {
    const result = await request(`databases/${target.id}/records`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title, visibility, values: {} },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data;
  };
  return {
    owner,
    writer,
    viewer,
    space,
    target,
    source,
    relation: relation.data,
    project: await add("Website launch"),
    other: await add("Documentation rollout"),
    secret: await add("Private acquisition", "restricted"),
  };
}
const query = async (f, user, body = {}) =>
  request(`databases/${f.source.id}/query`, {
    method: "POST",
    cookie: user.cookie,
    body,
  });
async function addTask(f, title, ids) {
  const result = await request(`databases/${f.source.id}/records`, {
    method: "POST",
    cookie: f.owner.cookie,
    body: { title, values: { [f.relation.id]: ids } },
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  return result.data;
}
async function visibility(f, record, visibility) {
  const page = (
    await request("pages/" + record.pageId, { cookie: f.owner.cookie })
  ).data;
  const result = await request(`pages/${record.pageId}/permissions`, {
    method: "PUT",
    cookie: f.owner.cookie,
    body: { version: page.version, confirm: true, visibility, grants: [] },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
}
const filter = (f, operator, value) => ({
  propertyId: f.relation.id,
  operator,
  value,
});

test("relations enforce target scope/read access, filter current references and exports, preserve hidden links and reject hidden-ID presence probes", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db);
    assert.equal(f.relation.config.databaseId, f.target.id);
    const task = await addTask(f, "Write release notes", [
        f.project.pageId.toUpperCase(),
        f.secret.pageId,
      ]),
      onlyPrivate = await addTask(f, "Internal preparation", [f.secret.pageId]),
      empty = await addTask(f, "Unassigned", []);
    const owner = (await query(f, f.owner)).data.records.find(
      (r) => r.pageId === task.pageId,
    );
    assert.deepEqual(
      new Set(owner.values[f.relation.id]),
      new Set([f.project.pageId, f.secret.pageId]),
    );
    assert.ok(owner.relations.some((r) => r.title === f.secret.title));
    const data = (await query(f, f.viewer)).data,
      visible = data.records.find((r) => r.pageId === task.pageId);
    assert.deepEqual(visible.values[f.relation.id], [f.project.pageId]);
    assert.deepEqual(
      visible.relations.map((r) => r.title),
      [f.project.title],
    );
    assert.deepEqual(
      data.records.find((r) => r.pageId === onlyPrivate.pageId).values[
        f.relation.id
      ],
      [],
    );
    assert.ok(!JSON.stringify(data).includes(f.secret.pageId));
    assert.ok(!JSON.stringify(data).includes(f.secret.title));
    for (const id of [f.secret.pageId, randomUUID()])
      assert.equal(
        (await query(f, f.viewer, { filters: [filter(f, "contains", id)] }))
          .data.records.length,
        0,
      );
    assert.deepEqual(
      new Set(
        (
          await query(f, f.viewer, { filters: [filter(f, "empty")] })
        ).data.records.map((r) => r.pageId),
      ),
      new Set([onlyPrivate.pageId, empty.pageId]),
    );
    assert.deepEqual(
      (
        await query(f, f.viewer, { filters: [filter(f, "notEmpty")] })
      ).data.records.map((r) => r.pageId),
      [task.pageId],
    );
    assert.equal(
      (
        await query(f, f.viewer, {
          sorts: [{ propertyId: f.relation.id, direction: "asc" }],
        })
      ).response.status,
      400,
    );
    const choices = await request(
      `databases/${f.source.id}/properties/${f.relation.id}/records?q=`,
      { cookie: f.viewer.cookie },
    );
    assert.equal(choices.response.status, 200);
    assert.ok(choices.data.records.some((r) => r.id === f.project.pageId));
    assert.ok(!JSON.stringify(choices.data).includes(f.secret.pageId));
    const update = await request(
      `databases/${f.source.id}/records/${task.pageId}`,
      {
        method: "PATCH",
        cookie: f.writer.cookie,
        body: {
          version: visible.version,
          values: { [f.relation.id]: [f.other.pageId] },
        },
      },
    );
    assert.equal(update.response.status, 200, JSON.stringify(update.data));
    assert.deepEqual(update.data.values[f.relation.id], [f.other.pageId]);
    const raw = (
      await db.query("SELECT values FROM database_records WHERE page_id=$1", [
        task.pageId,
      ])
    ).rows[0].values[f.relation.id];
    assert.deepEqual(
      new Set(raw),
      new Set([f.other.pageId, f.secret.pageId]),
      "editing visible links preserves references the caller cannot see",
    );
    const probe = async (id) =>
      request(`databases/${f.source.id}/records/${task.pageId}`, {
        method: "PATCH",
        cookie: f.writer.cookie,
        body: {
          version: update.data.version,
          values: { [f.relation.id]: [id] },
        },
      });
    const hidden = await probe(f.secret.pageId),
      unknown = await probe(randomUUID());
    assert.equal(hidden.response.status, 400);
    assert.equal(unknown.response.status, 400);
    assert.deepEqual(
      hidden.data,
      unknown.data,
      "an explicitly supplied inaccessible ID is rejected even when already stored",
    );
    const wrong = await probe(task.pageId);
    assert.equal(
      wrong.response.status,
      400,
      "source record belongs to the wrong target database",
    );
    for (const format of ["json", "csv"]) {
      const exported = await request(
        `databases/${f.source.id}/export.${format}`,
        { cookie: f.viewer.cookie },
      );
      assert.equal(exported.response.status, 200);
      assert.ok(!JSON.stringify(exported.data).includes(f.secret.pageId));
      assert.ok(!JSON.stringify(exported.data).includes(f.secret.title));
      assert.ok(JSON.stringify(exported.data).includes(f.other.pageId));
    }
    const third = (
        await request(`databases/${f.target.id}/records`, {
          method: "POST",
          cookie: f.owner.cookie,
          body: {
            title: "Excluded view target",
            visibility: "restricted",
            values: {},
          },
        })
      ).data,
      secondField = (
        await request(`databases/${f.source.id}/properties`, {
          method: "POST",
          cookie: f.owner.cookie,
          body: {
            name: "Other project",
            type: "Relation",
            relationDatabaseId: f.target.id,
          },
        })
      ).data,
      current = (await query(f, f.owner)).data.records.find(
        (r) => r.pageId === task.pageId,
      );
    assert.equal(
      (
        await request(`databases/${f.source.id}/records/${task.pageId}`, {
          method: "PATCH",
          cookie: f.owner.cookie,
          body: {
            version: current.version,
            values: { [secondField.id]: [third.pageId] },
          },
        })
      ).response.status,
      200,
    );
    const view = (
      await request(`databases/${f.source.id}/views`, {
        method: "POST",
        cookie: f.owner.cookie,
        body: {
          name: "Project only",
          type: "Table",
          config: {
            visibleProperties: [
              f.source.properties.find((p) => p.type === "Title").id,
              f.relation.id,
            ],
          },
        },
      })
    ).data;
    const scoped = (await query(f, f.owner, { viewId: view.id })).data;
    assert.ok(!JSON.stringify(scoped).includes(third.pageId));
    assert.ok(!JSON.stringify(scoped).includes(third.title));
    const scopedExport = await request(
      `databases/${f.source.id}/export.json?viewId=${view.id}`,
      { cookie: f.owner.cookie },
    );
    assert.equal(scopedExport.response.status, 200);
    assert.ok(!JSON.stringify(scopedExport.data).includes(third.pageId));
    assert.ok(!JSON.stringify(scopedExport.data).includes(third.title));
    const otherSpace = (
        await request("spaces", {
          method: "POST",
          cookie: f.owner.cookie,
          body: { name: "Separate space" },
        })
      ).data,
      foreign = (
        await request(`spaces/${otherSpace.id}/databases`, {
          method: "POST",
          cookie: f.owner.cookie,
          body: { name: "Foreign database" },
        })
      ).data;
    for (const body of [
      { name: "No target", type: "Relation" },
      { name: "Wrong space", type: "Relation", relationDatabaseId: foreign.id },
      {
        name: "Not a database",
        type: "Relation",
        relationDatabaseId: task.pageId,
      },
      { name: "Extra config", type: "Text", relationDatabaseId: f.target.id },
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
    assert.equal(
      (
        await request(`databases/${f.source.id}/properties`, {
          method: "POST",
          cookie: f.viewer.cookie,
          body: {
            name: "Forbidden",
            type: "Relation",
            relationDatabaseId: f.target.id,
          },
        })
      ).response.status,
      404,
    );
    const last = (await query(f, f.owner)).data.records.find(
        (r) => r.pageId === task.pageId,
      ),
      clear = await request(`databases/${f.source.id}/records/${task.pageId}`, {
        method: "PATCH",
        cookie: f.owner.cookie,
        body: { version: last.version, values: { [f.relation.id]: [] } },
      });
    assert.equal(clear.response.status, 200);
    assert.deepEqual(clear.data.values[f.relation.id], []);
    assert.equal(
      (
        await db.query(
          "SELECT 1 FROM record_relations WHERE source_id=$1 AND property_id=$2",
          [task.pageId, f.relation.id],
        )
      ).rowCount,
      0,
    );
  } finally {
    await db.end();
  }
});

test("CSV relation references validate at preview and commit, import atomically and export only current authorized links", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      title = f.source.properties.find((p) => p.type === "Title"),
      csv = (name, ids) =>
        "Name,Project\n" +
        name +
        ',"' +
        JSON.stringify(ids).replaceAll('"', '""') +
        '"\n';
    async function upload(action, text, settings = {}) {
      const body = new FormData();
      body.append(
        "file",
        new Blob([text], { type: "text/csv" }),
        "relations.csv",
      );
      body.append("settings", JSON.stringify(settings));
      const response = await fetch(
        `${base}/api/v1/databases/${f.source.id}/import/csv/${action}`,
        {
          method: "POST",
          headers: { Origin: process.env.TEST_ORIGIN, Cookie: f.writer.cookie },
          body,
        },
      );
      return { status: response.status, data: await response.json() };
    }
    const mapping = [
        { column: 0, propertyId: title.id },
        { column: 1, propertyId: f.relation.id },
      ],
      input = csv("Imported task", [f.project.pageId]),
      preview = await upload("preview", input, { mapping });
    assert.equal(preview.status, 201);
    assert.equal(preview.data.canImport, true, JSON.stringify(preview.data));
    const result = await upload("confirm", input, {
      token: preview.data.token,
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.createdRecords, 1);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM record_relations WHERE source_id=$1",
          [result.data.recordIds[0]],
        )
      ).rows[0].n,
      1,
    );
    const a = await upload("preview", csv("Rejected", [f.secret.pageId]), {
        mapping,
      }),
      b = await upload("preview", csv("Rejected", [randomUUID()]), { mapping });
    assert.equal(a.data.canImport, false);
    assert.equal(b.data.canImport, false);
    assert.deepEqual(a.data.errors, b.data.errors);
    assert.equal(a.data.token, null);
    const second = csv("Access changed", [f.project.pageId]),
      before = await upload("preview", second, { mapping });
    assert.equal(before.data.canImport, true);
    await visibility(f, f.project, "restricted");
    assert.equal(
      (await upload("confirm", second, { token: before.data.token })).status,
      400,
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
    const exported = await request(`databases/${f.source.id}/export.json`, {
      cookie: f.writer.cookie,
    });
    assert.deepEqual(exported.data.records[0].values[f.relation.id], []);
    assert.ok(!JSON.stringify(exported.data).includes(f.project.pageId));
    await visibility(f, f.project, "space");
    assert.equal(
      (await upload("confirm", second, { token: before.data.token })).status,
      201,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM database_records WHERE database_id=$1",
          [f.source.id],
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await db.end();
  }
});

test("related-record invalidations cross replicas, clear revoked targets once and never announce already-inaccessible target activity", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    clients = [];
  try {
    const f = await fixture(db),
      task = await addTask(f, "Linked task", [
        f.project.pageId,
        f.secret.pageId,
      ]),
      client = peer(
        JSON.parse(process.env.COLLABORATION_TEST_URLS)[1],
        f.source.id,
        f.viewer.cookie,
      );
    clients.push(client);
    let changes = 0,
      watched = -1;
    client.provider.on("stateless", ({ payload }) => {
      const message = JSON.parse(payload);
      if (message.type === "database-changed") changes++;
      if (message.type === "records-watched") watched = message.count;
    });
    await waitFor(
      () => client.provider.isSynced,
      "Source database client synced",
    );
    client.provider.sendStateless(
      JSON.stringify({ type: "watch-records", recordIds: [task.pageId] }),
    );
    await waitFor(
      () => watched === 1,
      "Visible source subscription registered",
    );
    const rename = async (record, name) => {
      const p = (
        await request("pages/" + record.pageId, { cookie: f.owner.cookie })
      ).data;
      assert.equal(
        (
          await request(`pages/${p.id}/title`, {
            method: "PATCH",
            cookie: f.owner.cookie,
            body: { title: name, titleVersion: p.title_version },
          })
        ).response.status,
        200,
      );
    };
    const initial = changes;
    await rename(f.secret, "Private revision one");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(
      changes,
      initial,
      "a hidden target's rename must not announce source activity",
    );
    await rename(f.project, "Website refresh");
    await waitFor(
      () => changes > initial,
      "Authorized target rename refreshes another replica",
    );
    assert.ok(
      (await query(f, f.viewer)).data.records[0].relations.some(
        (r) => r.title === "Website refresh",
      ),
    );
    const previous = changes;
    await visibility(f, f.project, "restricted");
    await waitFor(
      () => changes > previous,
      "Formerly readable target is removed promptly",
    );
    assert.deepEqual(
      (await query(f, f.viewer)).data.records[0].values[f.relation.id],
      [],
    );
    const hidden = changes;
    await rename(f.project, "Private revision two");
    await rename(f.secret, "Private revision three");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(changes, hidden);
  } finally {
    clients.forEach((client) => client.destroy());
    await db.end();
  }
});

test("subscription fingerprints invalidate a stale relation snapshot when rights change before watch registration", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let client;
  try {
    const f = await fixture(db),
      task = await addTask(f, "Subscribed task", [f.project.pageId]),
      snapshot = (await query(f, f.viewer)).data;
    assert.match(snapshot.fingerprint, /^[a-f0-9]{16}$/);
    client = peer(
      JSON.parse(process.env.COLLABORATION_TEST_URLS)[0],
      f.source.id,
      f.viewer.cookie,
    );
    let changes = 0,
      acks = 0;
    client.provider.on("stateless", ({ payload }) => {
      const data = JSON.parse(payload);
      if (data.type === "database-changed") changes++;
      if (data.type === "records-watched") acks++;
    });
    await waitFor(() => client.provider.isSynced, "Snapshot client connected");
    await visibility(f, f.project, "restricted");
    client.provider.sendStateless(
      JSON.stringify({
        type: "watch-records",
        recordIds: [task.pageId],
        relationProperties: snapshot.relationProperties,
        fingerprint: snapshot.fingerprint,
      }),
    );
    await waitFor(
      () => acks === 1 && changes >= 1,
      "Stale pre-subscription data must trigger a fresh load",
    );
    const fresh = (await query(f, f.viewer)).data;
    assert.deepEqual(fresh.records[0].values[f.relation.id], []);
    assert.notEqual(fresh.fingerprint, snapshot.fingerprint);
    client.provider.sendStateless(
      JSON.stringify({
        type: "watch-records",
        recordIds: [task.pageId],
        relationProperties: fresh.relationProperties,
        fingerprint: fresh.fingerprint,
      }),
    );
    await waitFor(() => acks === 2, "Fresh snapshot accepted");
    const baseline = changes,
      page = (
        await request("pages/" + f.project.pageId, { cookie: f.owner.cookie })
      ).data;
    await request(`pages/${page.id}/title`, {
      method: "PATCH",
      cookie: f.owner.cookie,
      body: {
        title: "Later private activity",
        titleVersion: page.title_version,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(
      changes,
      baseline,
      "the handshake does not subscribe to subsequent hidden changes",
    );
  } finally {
    client?.destroy();
    await db.end();
  }
});

test("Chromium: create a relation property, select/open related records, refresh titles and hide private/revoked targets for live readers", async () => {
  const { chromium, expect } = await import("@playwright/test"),
    { mkdir } = await import("node:fs/promises"),
    { pageLink } = await import("../packages/editor/dist/links.js"),
    db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    }),
    contexts = [],
    errors = [];
  async function session(user) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    contexts.push(context);
    await context.addCookies([
      {
        name: "orvyn_session",
        value: user.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    return page;
  }
  try {
    await mkdir(".local/ui-review", { recursive: true });
    const f = await fixture(db),
      task = await addTask(f, "Write release notes", []),
      owner = await session(f.owner),
      viewer = await session(f.viewer);
    await owner.goto(base + pageLink(f.source.id));
    await expect(
      owner.getByRole("button", { name: task.title, exact: true }),
    ).toBeVisible();
    const builder = owner.locator("details.property-builder");
    await builder.locator("summary").click();
    await builder
      .getByLabel("Property name", { exact: true })
      .fill("Related work");
    await builder
      .getByLabel("Property type", { exact: true })
      .selectOption("Relation");
    await builder
      .getByLabel("Related database", { exact: true })
      .selectOption(f.target.id);
    await builder
      .getByRole("button", { name: "Add property", exact: true })
      .click();
    await expect(
      owner.getByText("Property created", { exact: true }),
    ).toBeVisible();
    await builder.locator("summary").click();
    const field = owner.locator("td.property-relation").first();
    await field.getByRole("button", { name: "Project", exact: true }).click();
    const picker = owner.getByRole("dialog", {
      name: "Project links",
      exact: true,
    });
    await picker.getByLabel("Search Project", { exact: true }).fill("Website");
    await picker
      .getByRole("option", { name: f.project.title, exact: false })
      .click();
    await picker
      .getByRole("button", { name: "Apply links", exact: true })
      .click();
    await expect(
      field.getByRole("link", { name: f.project.title, exact: true }),
    ).toBeVisible();
    await field.getByRole("button", { name: "Project", exact: true }).click();
    await picker.getByLabel("Search Project", { exact: true }).fill("Private");
    await picker
      .getByRole("option", { name: f.secret.title, exact: false })
      .click();
    await picker
      .getByRole("button", { name: "Apply links", exact: true })
      .click();
    await expect(
      field.getByRole("link", { name: f.secret.title, exact: true }),
    ).toBeVisible();
    await viewer.goto(base + pageLink(f.source.id));
    const readField = viewer.locator("td.property-relation").first();
    await expect(
      readField.getByRole("link", { name: f.project.title, exact: true }),
    ).toBeVisible();
    await expect(
      viewer.getByRole("link", { name: f.secret.title, exact: true }),
    ).toHaveCount(0);
    await expect(
      readField.getByRole("button", { name: "Project", exact: true }),
    ).toHaveCount(0);
    await owner.screenshot({
      path: ".local/ui-review/database-relations.png",
      fullPage: true,
    });
    const p = (
      await request("pages/" + f.project.pageId, { cookie: f.owner.cookie })
    ).data;
    await request(`pages/${p.id}/title`, {
      method: "PATCH",
      cookie: f.owner.cookie,
      body: { title: "Website refresh", titleVersion: p.title_version },
    });
    await expect(
      readField.getByRole("link", { name: "Website refresh", exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await readField
      .getByRole("link", { name: "Website refresh", exact: true })
      .click();
    await expect(
      viewer.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue("Website refresh");
    await viewer.goto(base + pageLink(f.source.id));
    await expect(
      readField.getByRole("link", { name: "Website refresh", exact: true }),
    ).toBeVisible();
    await visibility(f, f.project, "restricted");
    await expect(readField.getByRole("link")).toHaveCount(0, {
      timeout: 10000,
    });
    await expect(readField).toHaveText("Empty");
    await owner.reload();
    await expect(
      owner
        .locator("td.property-relation")
        .first()
        .getByRole("link", { name: f.secret.title, exact: true }),
    ).toBeVisible();
    assert.deepEqual(errors, []);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
    await browser.close();
    await db.end();
  }
});

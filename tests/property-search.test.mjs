import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { chromium, expect } from "./browser-tools.mjs";
import { migrate } from "../apps/api/dist/migrations.js";
async function account() {
  const r = await request("auth/register", {
    method: "POST",
    body: { email: randomUUID() + "@example.test", password: randomUUID() },
  });
  const cookie = sessionCookie(r.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
const search = (user, q, extra = {}) =>
  request("search?" + new URLSearchParams({ q, ...extra }), {
    cookie: user.cookie,
  });
async function fixture(db) {
  const owner = await account(),
    viewer = await account();
  const space = (
    await request("spaces", {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Product studio" },
    })
  ).data;
  await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
  await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
    space.id,
    viewer.id,
  ]);
  const database = (
    await request(`spaces/${space.id}/databases`, {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Roadmap" },
    })
  ).data;
  const path = `databases/${database.id}`;
  const add = async (name, type, extra = {}) => {
    const r = await request(path + "/properties", {
      method: "POST",
      cookie: owner.cookie,
      body: { name, type, ...extra },
    });
    assert.equal(r.response.status, 201, JSON.stringify(r.data));
    return r.data;
  };
  const notes = await add("Notes", "Text"),
    tags = await add("Tags", "MultiSelect", {
      options: ["Zephyr", "Überprüfung"],
    });
  const priority = await add("Priority", "Select", {
    options: ["Immediate", "Later"],
  });
  const effort = await add("Effort", "Number"),
    checked = await add("Approved", "Checkbox"),
    due = await add("Launch date", "Date");
  const email = await add("Contact", "Email"),
    url = await add("Reference", "URL"),
    phone = await add("Telephone", "Phone");
  const person = await add("Assignee", "Person"),
    formula = await add("Derived", "Formula", {
      formula: '"calculatedquasar"',
    });
  const created = await add("Created", "CreatedTime"),
    edited = await add("Edited", "LastEditedTime");
  const make = async (title, values = {}, visibility = "space") => {
    const r = await request(path + "/records", {
      method: "POST",
      cookie: owner.cookie,
      body: { title, values, visibility },
    });
    assert.equal(r.response.status, 201, JSON.stringify(r.data));
    return r.data;
  };
  const values = {
    [notes.id]:
      "Prepare comet launch with <script>literalquasar</script> notes.",
    [tags.id]: tags.config.options.map((o) => o.id),
    [priority.id]: priority.config.options[0].id,
    [effort.id]: 731,
    [checked.id]: true,
    [due.id]: "2026-12-17",
    [email.id]: "help@stellar.example",
    [url.id]: "https://stellar.example/handbook",
    [phone.id]: "+49 123 7654321",
    [person.id]: [owner.id],
  };
  const row = await make("Release checklist", values);
  const hidden = await make(
    "Private release",
    { [notes.id]: "hiddenquasar", [tags.id]: [tags.config.options[0].id] },
    "restricted",
  );
  const get = async () => (await request(path, { cookie: owner.cookie })).data;
  const editProperty = async (property, body) =>
    request(path + "/properties/" + property.id, {
      method: "PATCH",
      cookie: owner.cookie,
      body: {
        name: property.name,
        schemaVersion: (await get()).schemaVersion,
        ...body,
      },
    });
  return {
    owner,
    viewer,
    space,
    database,
    path,
    notes,
    tags,
    priority,
    effort,
    checked,
    due,
    email,
    url,
    phone,
    person,
    formula,
    created,
    edited,
    row,
    hidden,
    get,
    make,
    editProperty,
  };
}

test("property search migration backfills current scalar values and option labels without rewriting record/page revisions", async () => {
  const root = new Pool({ connectionString: process.env.DATABASE_URL }),
    name = "orvyn_property_" + randomBytes(8).toString("hex");
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = "/" + name;
  let db;
  try {
    await root.query("CREATE DATABASE " + name);
    db = new Pool({ connectionString: url.toString() });
    await migrate(db, 38);
    const owner = (
      await db.query(
        "INSERT INTO users(email) VALUES('legacy-search@example.test') RETURNING id",
      )
    ).rows[0].id;
    const space = (
      await db.query(
        "INSERT INTO spaces(owner_id,name) VALUES($1,'Legacy') RETURNING id",
        [owner],
      )
    ).rows[0].id;
    const database = (
      await db.query(
        "INSERT INTO pages(space_id,title,kind) VALUES($1,'Legacy database','database') RETURNING id",
        [space],
      )
    ).rows[0].id;
    await db.query("INSERT INTO databases(page_id) VALUES($1)", [database]);
    const notes = randomUUID(),
      tags = randomUUID(),
      archived = randomUUID(),
      active = randomUUID(),
      orphan = randomUUID();
    await db.query(
      "INSERT INTO database_properties(id,database_id,name,type,config) VALUES($1,$2,'Notes','Text','{}'),($3,$2,'Tags','MultiSelect',$4),($5,$2,'Old notes','Text','{}')",
      [
        notes,
        database,
        tags,
        { options: [{ id: active, label: "Zephyr", color: "blue" }] },
        archived,
      ],
    );
    await db.query(
      "UPDATE database_properties SET deleted_at=now() WHERE id=$1",
      [archived],
    );
    const record = (
      await db.query(
        "INSERT INTO pages(space_id,parent_id,title,kind,version) VALUES($1,$2,'Legacy record','record',7) RETURNING id",
        [space, database],
      )
    ).rows[0].id;
    await db.query(
      "INSERT INTO database_records(page_id,database_id,values,version) VALUES($1,$2,$3,9)",
      [
        record,
        database,
        {
          [notes]: "legacyquasar",
          [tags]: [active, orphan],
          [archived]: "archivedquasar",
        },
      ],
    );
    const before = (
      await db.query(
        "SELECT p.version,p.updated_at::text,r.version AS record_version FROM pages p JOIN database_records r ON r.page_id=p.id WHERE p.id=$1",
        [record],
      )
    ).rows[0];
    await migrate(db);
    assert.deepEqual(
      (
        await db.query(
          "SELECT p.version,p.updated_at::text,r.version AS record_version FROM pages p JOIN database_records r ON r.page_id=p.id WHERE p.id=$1",
          [record],
        )
      ).rows[0],
      before,
    );
    const projection = (
      await db.query(
        "SELECT property_text,property_vector@@orvyn_search_query('legacyquasar Zeph') AS matches FROM page_search WHERE page_id=$1",
        [record],
      )
    ).rows[0];
    assert.equal(projection.matches, true);
    assert.match(projection.property_text, /Tags: Zephyr/);
    for (const absent of ["archivedquasar", active, orphan, archived])
      assert.equal(projection.property_text.includes(absent), false);
    assert.equal(
      (
        await db.query(
          "SELECT 1 FROM pg_indexes WHERE indexname='page_search_property_words' AND indexdef LIKE '%USING gin%'",
        )
      ).rowCount,
      1,
    );
  } finally {
    await db?.end();
    await root.query("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)");
    await root.end();
  }
});

test("global property/tag/metadata search uses readable current values, safe previews and explicit scopes without resolving referenced content", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      outsider = await account();
    for (const term of [
      "Zeph",
      "überprü",
      "Immediate",
      "731",
      "true",
      "stellar",
      "7654321",
      "2026-12-17",
      "literalquasar",
    ]) {
      const r = await search(f.viewer, term, { scope: "properties" });
      assert.equal(r.response.status, 200, JSON.stringify(r.data));
      assert.deepEqual(
        r.data.map((item) => item.id),
        [f.row.pageId],
        term,
      );
      assert.equal(r.data[0].match_source, "properties");
      assert.ok(r.data[0].excerpt.length <= 450);
      assert.ok(r.data[0].highlights.length > 0);
    }
    assert.deepEqual((await search(f.viewer, "hiddenquasar")).data, []);
    assert.deepEqual((await search(outsider, "Zephyr")).data, []);
    assert.deepEqual(
      (await search(f.viewer, "Zephyr", { scope: "title" })).data,
      [],
    );
    assert.deepEqual(
      (await search(f.viewer, "Zephyr", { scope: "content" })).data,
      [],
    );
    const page = (
      await request(`pages/${f.row.pageId}`, { cookie: f.owner.cookie })
    ).data;
    await request(`pages/${f.row.pageId}`, {
      method: "PUT",
      cookie: f.owner.cookie,
      body: {
        title: page.title,
        version: page.version,
        document: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "A documentquasar for the release" },
              ],
            },
          ],
        },
      },
    });
    const mixed = (await search(f.viewer, "documentquasar Zephyr")).data;
    assert.deepEqual(
      mixed.map((item) => item.id),
      [f.row.pageId],
    );
    assert.equal(mixed[0].match_source, "mixed");
    assert.equal(
      (await search(f.viewer, "documentquasar", { scope: "content" })).data[0]
        .match_source,
      "content",
    );
    const date = (
      await db.query(
        "SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day FROM pages WHERE id=$1",
        [f.row.pageId],
      )
    ).rows[0].day;
    assert.ok(
      (await search(f.viewer, date, { scope: "properties" })).data.some(
        (row) => row.id === f.row.pageId,
      ),
    );
    for (const hidden of [
      f.owner.id,
      f.tags.config.options[0].id,
      f.formula.id,
      "calculatedquasar",
    ])
      assert.deepEqual(
        (await search(f.viewer, hidden, { scope: "properties" })).data,
        [],
        hidden,
      );
    const related = await request(f.path + "/properties", {
      method: "POST",
      cookie: f.owner.cookie,
      body: {
        name: "Related",
        type: "Relation",
        relationDatabaseId: f.database.id,
      },
    });
    const current = (
      await request(f.path + "/records/" + f.row.pageId, {
        cookie: f.owner.cookie,
      })
    ).data.record;
    await request(f.path + "/records/" + f.row.pageId, {
      method: "PATCH",
      cookie: f.owner.cookie,
      body: {
        version: current.version,
        values: { [related.data.id]: [f.hidden.pageId] },
      },
    });
    assert.deepEqual((await search(f.viewer, "hiddenquasar")).data, []);
    const raw = JSON.stringify((await search(f.viewer, "literalquasar")).data);
    assert.match(raw, /<script>literalquasar<\/script>/);
    assert.equal(raw.includes("property_text"), false);
    assert.equal(raw.includes("preview_text"), false);
  } finally {
    await db.end();
  }
});

test("property search paginates after current record permissions and binds its cursor to the selected scope", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      visible = [];
    for (let i = 0; i < 20; i++) {
      const row = await f.make(
        "Search item " + i,
        { [f.notes.id]: "cursorquasar" },
        i % 3 ? "space" : "restricted",
      );
      if (i % 3) visible.push(row.pageId);
    }
    const found = [],
      filters = {
        scope: "properties",
        spaceId: f.space.id,
        kind: "record",
        limit: "5",
      };
    let after = "",
      firstCursor;
    do {
      const r = await search(f.viewer, "cursorquasar", { ...filters, after });
      assert.equal(r.response.status, 200, JSON.stringify(r.data));
      assert.ok(r.data.length <= 5);
      found.push(...r.data.map((row) => row.id));
      after = r.response.headers.get("X-Next-Cursor") || "";
      firstCursor ||= after;
    } while (after);
    assert.equal(new Set(found).size, found.length);
    assert.deepEqual(new Set(found), new Set(visible));
    assert.equal(
      (
        await search(f.viewer, "cursorquasar", {
          ...filters,
          scope: "content",
          after: firstCursor,
        })
      ).response.status,
      400,
    );
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.space.id, f.viewer.id],
    );
    assert.deepEqual(
      (
        await search(f.viewer, "cursorquasar", {
          ...filters,
          after: firstCursor,
        })
      ).data,
      [],
    );
  } finally {
    await db.end();
  }
});

test("property search updates option labels, record edits, schema deletion/restoration and trash immediately, with transactional rollback", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db);
    const renamed = f.tags.config.options.map((option, i) => ({
      ...option,
      label: i ? option.label : "Aurora",
    }));
    assert.equal(
      (await f.editProperty(f.tags, { options: renamed })).response.status,
      200,
    );
    assert.deepEqual((await search(f.viewer, "Zephyr")).data, []);
    assert.equal((await search(f.viewer, "Aurora")).data[0].id, f.row.pageId);
    assert.equal(
      (
        await f.editProperty(f.tags, {
          options: [renamed[1]],
          confirmOptionRemoval: true,
        })
      ).response.status,
      200,
    );
    assert.deepEqual((await search(f.viewer, "Aurora")).data, []);
    assert.equal(
      (
        await request(f.path + "/properties/" + f.notes.id, {
          method: "DELETE",
          cookie: f.owner.cookie,
          body: { schemaVersion: (await f.get()).schemaVersion },
        })
      ).response.status,
      200,
    );
    assert.deepEqual((await search(f.viewer, "literalquasar")).data, []);
    assert.equal(
      (
        await request(f.path + "/properties/" + f.notes.id + "/restore", {
          method: "POST",
          cookie: f.owner.cookie,
          body: { schemaVersion: (await f.get()).schemaVersion },
        })
      ).response.status,
      200,
    );
    assert.equal(
      (await search(f.viewer, "literalquasar")).data[0].id,
      f.row.pageId,
    );
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "UPDATE database_records SET values=jsonb_set(values,ARRAY[$1::text],to_jsonb('rollbackquasar'::text)) WHERE page_id=$2",
        [f.notes.id, f.row.pageId],
      );
      assert.deepEqual((await search(f.viewer, "rollbackquasar")).data, []);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    const snapshot = (
      await request(f.path + "/records/" + f.row.pageId, {
        cookie: f.owner.cookie,
      })
    ).data.record;
    assert.equal(
      (
        await request(f.path + "/records/" + f.row.pageId, {
          method: "PATCH",
          cookie: f.owner.cookie,
          body: {
            version: snapshot.version,
            values: { [f.notes.id]: "newvaluequasar" },
          },
        })
      ).response.status,
      200,
    );
    assert.deepEqual((await search(f.viewer, "literalquasar")).data, []);
    assert.equal(
      (await search(f.viewer, "newvaluequasar")).data[0].id,
      f.row.pageId,
    );
    await db.query("UPDATE pages SET deleted_at=now() WHERE id=$1", [
      f.row.pageId,
    ]);
    assert.deepEqual((await search(f.viewer, "newvaluequasar")).data, []);
    await db.query("UPDATE pages SET deleted_at=NULL WHERE id=$1", [
      f.row.pageId,
    ]);
    assert.equal(
      (await search(f.viewer, "newvaluequasar")).data[0].id,
      f.row.pageId,
    );
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.space.id, f.viewer.id],
    );
    assert.deepEqual((await search(f.viewer, "newvaluequasar")).data, []);
  } finally {
    await db.end();
  }
});

test("Chromium: search by tags/properties, switch scopes, navigate to records and review safe desktop/mobile results", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await chromium.launch({
      executablePath: "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
  try {
    const f = await fixture(db),
      context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
    await context.addCookies([
      {
        name: "orvyn_session",
        value: f.viewer.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/?page=${f.database.id}`);
    await page
      .getByRole("button", { name: "Search Ctrl+P", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
        name: "Search your workspace",
        exact: true,
      }),
      input = dialog.getByRole("searchbox", {
        name: "Search pages",
        exact: true,
      });
    await input.fill("zeph");
    await expect(
      dialog.getByText("Property match", { exact: true }),
    ).toBeVisible();
    await expect(dialog.locator("mark")).toContainText(["Zeph"]);
    await dialog
      .getByRole("combobox", { name: "Search in", exact: true })
      .selectOption("properties");
    await input.fill("literalquasar");
    await expect(
      dialog.getByRole("button", { name: /^Release checklist/ }),
    ).toBeVisible();
    assert.equal(await page.evaluate(() => globalThis.searchAttack), undefined);
    assert.equal(await dialog.locator("script").count(), 0);
    const current = (
      await request(f.path + "/records/" + f.row.pageId, {
        cookie: f.owner.cookie,
      })
    ).data.record;
    const updated = await request(f.path + "/records/" + f.row.pageId, {
      method: "PATCH",
      cookie: f.owner.cookie,
      body: {
        version: current.version,
        values: {
          [f.notes.id]: "Coordinate the product launch, research and release.",
        },
      },
    });
    assert.equal(updated.response.status, 200, JSON.stringify(updated.data));
    await input.fill("Zephyr");
    await expect(
      dialog.getByRole("button", { name: /^Release checklist/ }),
    ).toBeVisible();
    await expect(dialog.locator("mark")).toHaveText("Zephyr");
    await expect(dialog.locator(".search-result-excerpt")).toHaveText(
      "Tags: Zephyr, Überprüfung",
    );
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/property-search.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: ".local/ui-review/property-search-mobile.png",
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await dialog
      .getByRole("button")
      .filter({ hasText: "Release checklist" })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue("Release checklist");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await db.end();
  }
});

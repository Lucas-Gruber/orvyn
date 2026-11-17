import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { documentSchemaVersion } from "../packages/editor/dist/index.js";
import { pageLink } from "../packages/editor/dist/links.js";

async function account() {
  const r = await request("auth/register", {
    method: "POST",
    body: { email: randomUUID() + "@example.test", password: randomUUID() },
  });
  const cookie = sessionCookie(r.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
function status(r, code = 201) {
  assert.equal(r.response.status, code, JSON.stringify(r.data));
  return r.data;
}
async function fixture(db) {
  const owner = await account(),
    editor = await account(),
    viewer = await account(),
    outsider = await account(),
    space = status(
      await request("spaces", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "Product studio" },
      }),
    );
  await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
  await db.query(
    "INSERT INTO space_members VALUES($1,$2,'Editor'),($1,$3,'Viewer')",
    [space.id, editor.id, viewer.id],
  );
  const database = status(
    await request(`spaces/${space.id}/databases`, {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Roadmap" },
    }),
  );
  const prop = async (name, type, extra = {}) =>
    status(
      await request(`databases/${database.id}/properties`, {
        method: "POST",
        cookie: owner.cookie,
        body: { name, type, ...extra },
      }),
    );
  const hours = await prop("Hours", "Number"),
    formula = await prop("Double hours", "Formula", {
      formula: 'prop("Hours") * 2',
    }),
    self = await prop("Related tasks", "Relation", {
      relationDatabaseId: database.id,
    }),
    rollup = await prop("Related hours", "Rollup", {
      rollup: {
        relationId: self.id,
        aggregation: "sum",
        targetPropertyId: hours.id,
      },
    }),
    files = await prop("Resources", "Files"),
    person = await prop("Owner", "Person");
  const createRecord = async (title, values = {}, visibility = "space") =>
    status(
      await request(`databases/${database.id}/records`, {
        method: "POST",
        cookie: owner.cookie,
        body: { title, values, visibility },
      }),
    );
  return {
    owner,
    editor,
    viewer,
    outsider,
    space,
    database,
    hours,
    formula,
    self,
    rollup,
    files,
    person,
    createRecord,
  };
}
const save = (f, name, recordId, cookie = f.owner.cookie) =>
  request(`databases/${f.database.id}/templates`, {
    method: "POST",
    cookie,
    body: {
      name,
      kind: recordId ? "record" : "database",
      ...(recordId ? { recordId } : {}),
    },
  });
const apply = (f, template, extra = {}, cookie = f.owner.cookie) =>
  request(`templates/${template.id}/apply`, {
    method: "POST",
    cookie,
    body: {
      requestId: randomUUID(),
      version: template.version,
      title: "A new project",
      ...extra,
    },
  });

test("database templates clone schema, formulas, self-relations, rollups and saved views independently with idempotent creation", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      original = await f.createRecord("Original task", { [f.hours.id]: 6 }),
      metadata = status(
        await request(`databases/${f.database.id}`, { cookie: f.owner.cookie }),
        200,
      ),
      view = metadata.views.find((v) => v.type === "Table"),
      statusField = metadata.properties.find((p) => p.type === "Status");
    status(
      await request(`databases/${f.database.id}/views/${view.id}`, {
        method: "PATCH",
        cookie: f.owner.cookie,
        body: {
          name: "Active projects",
          type: "Table",
          version: view.version,
          config: {
            ...view.config,
            openMode: "modal",
            filters: [
              {
                propertyId: statusField.id,
                operator: "eq",
                value: statusField.config.options[0].id,
              },
            ],
            sorts: [{ propertyId: f.hours.id, direction: "desc" }],
          },
        },
      }),
      200,
    );
    const template = status(await save(f, "Product roadmap")),
      requestId = randomUUID();
    const [a, b] = await Promise.all([
      apply(f, template, { requestId }),
      apply(f, template, { requestId }),
    ]);
    const first = status(a),
      second = status(b);
    assert.equal(first.pageId, second.pageId);
    assert.notEqual(first.pageId, f.database.id);
    const cloned = status(
        await request(`databases/${first.pageId}`, { cookie: f.owner.cookie }),
        200,
      ),
      field = (name) => cloned.properties.find((p) => p.name === name);
    assert.notEqual(field("Hours").id, f.hours.id);
    assert.equal(field("Related tasks").config.databaseId, first.pageId);
    assert.equal(
      field("Related hours").config.rollup.relationId,
      field("Related tasks").id,
    );
    assert.equal(
      field("Related hours").config.rollup.targetPropertyId,
      field("Hours").id,
    );
    assert.ok(
      JSON.stringify(field("Double hours").config.expression).includes(
        field("Hours").id,
      ),
    );
    assert.ok(
      !JSON.stringify(field("Double hours").config.expression).includes(
        f.hours.id,
      ),
    );
    const clonedView = cloned.views.find((v) => v.name === "Active projects"),
      clonedStatus = field(statusField.name);
    assert.equal(clonedView.config.openMode, "modal");
    assert.equal(clonedView.config.filters[0].propertyId, clonedStatus.id);
    assert.equal(
      clonedView.config.filters[0].value,
      clonedStatus.config.options[0].id,
    );
    assert.notEqual(
      clonedStatus.config.options[0].id,
      statusField.config.options[0].id,
    );
    assert.equal(clonedView.config.sorts[0].propertyId, field("Hours").id);
    assert.equal(
      status(
        await request(`databases/${first.pageId}/query`, {
          method: "POST",
          cookie: f.owner.cookie,
          body: {},
        }),
        200,
      ).records.length,
      0,
    );
    assert.equal(
      (await apply(f, template, { requestId, title: "Changed retry" })).response
        .status,
      409,
    );
    assert.equal(
      (
        await request(`databases/${f.database.id}/records/${original.pageId}`, {
          cookie: f.owner.cookie,
        })
      ).data.record.values[f.hours.id],
      6,
    );
  } finally {
    await db.end();
  }
});

test("record templates freeze document/defaults, copy attachments, regenerate self heading links and recheck current source permissions", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      source = await f.createRecord("Launch checklist", {
        [f.hours.id]: 3,
        [f.person.id]: [f.editor.id],
      }),
      heading = randomUUID();
    const data = new FormData();
    data.append(
      "file",
      new Blob(["A useful checklist attachment"], { type: "text/plain" }),
      "checklist.txt",
    );
    const upload = await fetch(`${base}/api/v1/pages/${source.pageId}/files`, {
      method: "POST",
      headers: { Origin: process.env.TEST_ORIGIN, Cookie: f.owner.cookie },
      body: data,
    });
    assert.equal(upload.status, 201);
    const file = await upload.json();
    let page = status(
      await request(`pages/${source.pageId}`, { cookie: f.owner.cookie }),
      200,
    );
    const document = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 4, id: heading },
          content: [{ type: "text", text: "Before launch" }],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Return to checklist",
              marks: [
                {
                  type: "link",
                  attrs: { href: pageLink(source.pageId, heading) },
                },
              ],
            },
          ],
        },
        {
          type: "orvynFile",
          attrs: { fileId: file.id, caption: "Project checklist" },
        },
      ],
    };
    status(
      await request(`pages/${source.pageId}`, {
        method: "PUT",
        cookie: f.owner.cookie,
        body: {
          version: page.version,
          title: page.title,
          document,
          documentSchemaVersion,
        },
      }),
      200,
    );
    const record = status(
      await request(`databases/${f.database.id}/records/${source.pageId}`, {
        cookie: f.owner.cookie,
      }),
      200,
    ).record;
    status(
      await request(`databases/${f.database.id}/records/${source.pageId}`, {
        method: "PATCH",
        cookie: f.owner.cookie,
        body: { version: record.version, values: { [f.files.id]: [file.id] } },
      }),
      200,
    );
    const template = status(await save(f, "Release checklist", source.pageId)),
      preview = status(
        await request(`templates/${template.id}`, { cookie: f.owner.cookie }),
        200,
      );
    assert.equal(preview.preview.values[f.hours.id], 3);
    assert.equal(preview.preview.fileCount, 1);
    // Source changes do not mutate the saved template; only an explicit refresh does.
    await db.query(
      "UPDATE database_records SET values=jsonb_set(values,$2::text[],'9') WHERE page_id=$1",
      [source.pageId, [f.hours.id]],
    );
    await db.query(
      "DELETE FROM space_members WHERE space_id=$1 AND user_id=$2",
      [f.space.id, f.editor.id],
    );
    const result = status(await apply(f, template, { title: "Release v2" }));
    const copy = status(
        await request(`pages/${result.pageId}`, { cookie: f.owner.cookie }),
        200,
      ),
      copied = status(
        await request(`databases/${f.database.id}/records/${result.pageId}`, {
          cookie: f.owner.cookie,
        }),
        200,
      ).record;
    assert.equal(copied.values[f.hours.id], 3);
    assert.deepEqual(copied.values[f.person.id], []);
    assert.ok(result.omittedDefaults >= 1);
    const copiedHeading = copy.document.content[0].attrs.id;
    assert.equal(copy.document.content[0].attrs.level, 4);
    assert.notEqual(copiedHeading, heading);
    assert.equal(
      copy.document.content[1].content[0].marks[0].attrs.href,
      pageLink(copy.id, copiedHeading),
    );
    const copiedFile = copied.values[f.files.id][0];
    assert.notEqual(copiedFile, file.id);
    assert.equal(copy.document.content[2].attrs.fileId, copiedFile);
    const bytes = await fetch(`${base}/api/v1/files/${copiedFile}/download`, {
      headers: { Cookie: f.owner.cookie },
      redirect: "follow",
    });
    assert.equal(bytes.status, 200);
    assert.equal(await bytes.text(), "A useful checklist attachment");
    page = status(
      await request(`pages/${source.pageId}`, { cookie: f.owner.cookie }),
      200,
    );
    status(
      await request(`pages/${source.pageId}/permissions`, {
        method: "PUT",
        cookie: f.owner.cookie,
        body: {
          version: page.version,
          confirm: true,
          visibility: "restricted",
          grants: [],
        },
      }),
      200,
    );
    for (const cookie of [f.viewer.cookie, f.outsider.cookie]) {
      assert.equal(
        (await request(`templates/${template.id}`, { cookie })).response.status,
        404,
      );
      assert.equal((await apply(f, template, {}, cookie)).response.status, 404);
    }
    assert.equal(
      (
        await request(`databases/${f.database.id}/templates`, {
          cookie: f.viewer.cookie,
        })
      ).data.templates.length,
      0,
    );
    assert.equal(
      (
        await request(`databases/${f.database.id}/records/${source.pageId}`, {
          cookie: f.viewer.cookie,
        })
      ).response.status,
      404,
    );
    assert.equal(
      (await save(f, "Blocked", result.pageId, f.viewer.cookie)).response
        .status,
      404,
    );
    status(
      await request(`templates/${template.id}`, {
        method: "PATCH",
        cookie: f.owner.cookie,
        body: {
          name: "Refreshed checklist",
          version: template.version,
          refresh: true,
        },
      }),
      200,
    );
    assert.equal((await apply(f, template)).response.status, 409);
    const refreshed = status(
      await request(`templates/${template.id}`, { cookie: f.owner.cookie }),
      200,
    );
    assert.equal(refreshed.preview.values[f.hours.id], 9);
    status(
      await request(`templates/${template.id}`, {
        method: "DELETE",
        cookie: f.owner.cookie,
        body: { version: refreshed.version },
      }),
      200,
    );
    assert.equal(
      (await request(`templates/${template.id}`, { cookie: f.owner.cookie }))
        .response.status,
      404,
    );
    assert.equal(
      (await request(`pages/${result.pageId}`, { cookie: f.owner.cookie }))
        .response.status,
      200,
    );
  } finally {
    await db.end();
  }
});

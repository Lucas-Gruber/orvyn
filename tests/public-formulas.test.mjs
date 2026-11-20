import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
async function fixture(db) {
  const registration = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(registration.response),
    space = (
      await request("spaces", {
        method: "POST",
        cookie,
        body: { name: "The product studio" },
      })
    ).data;
  const database = (
      await request("spaces/" + space.id + "/databases", {
        method: "POST",
        cookie,
        body: { name: "The next release" },
      })
    ).data,
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
    secret = await property("PRIVATE cost", "Number"),
    doubled = await property("Double estimate", "Formula", {
      formula: 'prop("Estimate") * 2',
    }),
    ready = await property("Planned", "Formula", {
      formula: 'prop("Estimate") > 2',
    }),
    hiddenCalculation = await property("Internal total", "Formula", {
      formula: 'prop("PRIVATE cost") * prop("Estimate")',
    }),
    relation = await property("Related work", "Relation", {
      relationDatabaseId: id,
    }),
    count = await property("Shared references", "Formula", {
      formula: 'length(prop("Related work"))',
    }),
    statusLabel = await property("Status label", "Formula", {
      formula: 'prop("Status") + " plan"',
    });
  async function record(name, values) {
    const r = await request("databases/" + id + "/records", {
      method: "POST",
      cookie,
      body: { title: name, values },
    });
    assert.equal(r.response.status, 201);
    return r.data;
  }
  const first = await record("A thoughtful launch", {
      [estimate.id]: 3,
      [secret.id]: 900,
      [status.id]: status.config.options[0].id,
    }),
    other = await record("A clearer handover", { [estimate.id]: 5 }),
    hidden = await record("PRIVATE unseen work", { [estimate.id]: 80 });
  await db.query(
    "UPDATE database_records SET values=values||$2::jsonb,version=version+1 WHERE page_id=$1",
    [
      first.pageId,
      {
        [relation.id]: [other.pageId, hidden.pageId],
        [doubled.id]: "PRIVATE cached output",
      },
    ],
  );
  await db.query("SELECT orvyn_replace_record_relations($1)", [first.pageId]);
  const input = {
      scope: {
        pageIds: [],
        databases: [
          {
            databaseId: id,
            viewId: database.views.find((v) => v.type === "Table").id,
            recordIds: [first.pageId, other.pageId],
            propertyIds: [
              title.id,
              estimate.id,
              doubled.id,
              ready.id,
              relation.id,
              count.id,
              status.id,
              statusLabel.id,
            ],
          },
        ],
        extraFileIds: [],
      },
      settings: {
        label: "The release plan",
        passwordProtected: false,
        indexable: false,
        expiresAt: null,
      },
      target: null,
    },
    path = "pages/" + id + "/publications";
  const preview = (value) =>
    request(path + "/preview", {
      method: "POST",
      cookie,
      body: value || input,
    });
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
  return {
    cookie,
    space,
    database,
    id,
    title,
    status,
    estimate,
    secret,
    doubled,
    ready,
    hiddenCalculation,
    relation,
    count,
    statusLabel,
    first,
    other,
    hidden,
    input,
    path,
    property,
    preview,
    publish,
  };
}
test("public formulas recompute only approved scalar/list inputs and ignore private cached output and unselected relations", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      review = await f.preview();
    assert.equal(review.response.status, 201, JSON.stringify(review.data));
    const projection = review.data.snapshot.pages.find(
        (page) => page.id === f.id,
      ).database,
      first = projection.records.find(
        (record) => record.pageId === f.first.pageId,
      );
    assert.equal(first.values[f.doubled.id], 6);
    assert.equal(first.values[f.ready.id], true);
    assert.equal(first.values[f.count.id], 1);
    assert.equal(first.values[f.statusLabel.id], "To do plan");
    assert.equal(
      projection.properties.find((p) => p.id === f.ready.id).resultType,
      "boolean",
    );
    assert.ok(!JSON.stringify(review.data.snapshot).includes("PRIVATE"));
    assert.ok(!JSON.stringify(review.data.snapshot).includes('"expression"'));
    assert.ok(!JSON.stringify(review.data.snapshot).includes(f.hidden.pageId));
    const pub = await f.publish(),
      token = new URL(pub.url).pathname.split("/").at(-1);
    await db.query(
      "UPDATE database_records SET values=values||$2::jsonb,version=version+1 WHERE page_id=$1",
      [f.first.pageId, { [f.estimate.id]: 8 }],
    );
    assert.equal(
      (await request("publications/" + token)).data.snapshot.pages
        .find((page) => page.id === f.id)
        .database.records.find((record) => record.pageId === f.first.pageId)
        .values[f.doubled.id],
      6,
    );
  } finally {
    await db.end();
  }
});
test("public formula selection requires every visible input and rejects hidden or identity dependencies before publishing", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      missing = structuredClone(f.input);
    missing.scope.databases[0].propertyIds =
      missing.scope.databases[0].propertyIds.filter(
        (id) => id !== f.estimate.id,
      );
    assert.equal((await f.preview(missing)).response.status, 400);
    const privateInput = structuredClone(f.input);
    privateInput.scope.databases[0].propertyIds.push(f.hiddenCalculation.id);
    assert.equal((await f.preview(privateInput)).response.status, 400);
    const people = await f.property("Private people", "Person"),
      identity = await f.property("People count", "Formula", {
        formula: 'length(prop("Private people"))',
      });
    const config = {
      ...f.database.views.find((view) => view.type === "Table").config,
      visibleProperties: [
        f.title.id,
        f.estimate.id,
        f.doubled.id,
        f.hiddenCalculation.id,
        identity.id,
      ],
    };
    const viewId = f.input.scope.databases[0].viewId;
    await db.query(
      "UPDATE database_views SET config=$2,version=version+1 WHERE id=$1",
      [viewId, config],
    );
    const meta = await request(f.path + "/databases/" + f.id, {
        cookie: f.cookie,
      }),
      view = meta.data.views.find((view) => view.id === viewId);
    assert.equal(
      view.properties.find((p) => p.id === f.hiddenCalculation.id).allowed,
      false,
    );
    assert.equal(
      view.properties.find((p) => p.id === identity.id).allowed,
      false,
    );
    assert.deepEqual(
      view.properties.find((p) => p.id === f.doubled.id).dependencies,
      [{ id: f.estimate.id, name: "Estimate" }],
    );
    const direct = {
      ...f.input,
      scope: {
        pageIds: [],
        databases: [],
        records: [
          {
            recordId: f.first.pageId,
            propertyIds: [f.title.id, f.estimate.id, f.doubled.id],
          },
        ],
        extraFileIds: [],
      },
    };
    const record = await request(
      "pages/" + f.first.pageId + "/publications/preview",
      { method: "POST", cookie: f.cookie, body: direct },
    );
    assert.equal(record.response.status, 201, JSON.stringify(record.data));
    assert.equal(record.data.snapshot.pages[0].record.values[f.doubled.id], 6);
    const review = await request(
      "pages/" + f.first.pageId + "/publications/preview",
      { method: "POST", cookie: f.cookie, body: direct },
    );
    await db.query(
      "UPDATE database_records SET version=version+1 WHERE page_id=$1",
      [f.first.pageId],
    );
    assert.equal(
      (
        await request("pages/" + f.first.pageId + "/publications", {
          method: "POST",
          cookie: f.cookie,
          body: {
            requestId: randomUUID(),
            previewToken: review.data.previewToken,
            input: direct,
          },
        })
      ).response.status,
      409,
    );
  } finally {
    await db.end();
  }
});

test("Chromium: formulas require explicitly selected inputs, disappear when an input is removed and render public numeric/boolean values without private calls", async () => {
  const { chromium, expect } = await import("./browser-tools.mjs"),
    { mkdir } = await import("node:fs/promises");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  let browser;
  try {
    const f = await fixture(db);
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
    await page.goto(base + "/?page=" + f.id);
    await expect(
      page.getByRole("heading", { name: "The next release", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const share = page.getByRole("dialog", { name: "Share page", exact: true });
    await share.getByRole("tab", { name: "Publish", exact: true }).click();
    const scope = share.locator(".database-public-scope"),
      calculation = scope.getByRole("checkbox", { name: /^Double estimate/ }),
      estimate = scope.getByRole("checkbox", { name: "Estimate", exact: true });
    await expect(calculation).toBeDisabled();
    await estimate.check();
    await expect(calculation).toBeEnabled();
    await calculation.check();
    await estimate.uncheck();
    await expect(calculation).not.toBeChecked();
    await expect(calculation).toBeDisabled();
    await estimate.check();
    await calculation.check();
    await scope.getByRole("checkbox", { name: "Planned", exact: true }).check();
    await scope
      .getByRole("checkbox", { name: f.first.title, exact: true })
      .check();
    await scope
      .getByRole("checkbox", { name: f.other.title, exact: true })
      .check();
    await share
      .getByRole("button", { name: "Review publication", exact: true })
      .click();
    const review = page.getByRole("dialog", {
      name: "Review publication",
      exact: true,
    });
    await expect(review).toBeVisible();
    await expect(review.getByText("6", { exact: true })).toBeVisible();
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/public-formula-review.png",
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
    const publication = await response.json();
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
      reader.getByRole("heading", { name: "The next release", exact: true }),
    ).toBeVisible();
    const row = reader.getByRole("row").filter({
      has: reader.getByRole("button", { name: f.first.title, exact: true }),
    });
    await expect(row.getByText("6", { exact: true })).toBeVisible();
    await expect(
      row.getByRole("img", { name: "Checked", exact: true }),
    ).toBeVisible();
    await expect(
      reader.getByText(/Calculated from shared values/),
    ).toBeVisible();
    assert.ok(!(await reader.content()).includes("PRIVATE"));
    await reader.screenshot({
      path: ".local/ui-review/public-formula-reader.png",
      fullPage: true,
    });
    await reader.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await reader.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.deepEqual(forbidden, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await db.end();
  }
});

test("public formula arithmetic preserves null and finite-number rules while parameterized text remains data", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      division = await f.property("No division", "Formula", {
        formula: 'prop("Estimate") / 0',
      }),
      overflow = await f.property("Too large", "Formula", {
        formula: 'prop("Estimate") * 1e308',
      }),
      label = await f.property("Label", "Text"),
      upper = await f.property("Upper label", "Formula", {
        formula: 'upper(prop("Label"))',
      }),
      value = 'quote \' and JSON ["x"] remain data';
    await db.query(
      "UPDATE database_records SET values=values||$2::jsonb,version=version+1 WHERE page_id=$1",
      [f.first.pageId, { [label.id]: value }],
    );
    const input = structuredClone(f.input);
    input.scope.databases[0].propertyIds.push(
      division.id,
      overflow.id,
      label.id,
      upper.id,
    );
    const preview = await f.preview(input);
    assert.equal(preview.response.status, 201, JSON.stringify(preview.data));
    const first = preview.data.snapshot.pages
      .find((page) => page.id === f.id)
      .database.records.find((record) => record.pageId === f.first.pageId);
    assert.equal(first.values[division.id], null);
    assert.equal(first.values[overflow.id], null);
    assert.equal(first.values[upper.id], value.toUpperCase());
  } finally {
    await db.end();
  }
});

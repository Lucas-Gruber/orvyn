import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { chromium, expect } from "./browser-tools.mjs";
import { waitFor } from "./collaboration-peer.mjs";

// A deterministic private image fixture; no external image hosts.
function cover() {
  const w = 640,
    h = 320,
    pixels = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const circle = Math.hypot(x - 435, y - 135) < 93;
      const arch =
        x > 85 &&
        x < 250 &&
        y > 70 &&
        (y > 155 || Math.hypot(x - 167, y - 155) < 82);
      const color = arch
        ? [111, 111, 156]
        : circle
          ? [207, 157, 117]
          : [239, 233, 222];
      const offset = y * (w * 3 + 1) + 1 + x * 3;
      color.forEach((v, c) => (pixels[offset + c] = v));
    }
  const crc = (bytes) => {
    let value = -1;
    for (const byte of bytes) {
      value ^= byte;
      for (let i = 0; i < 8; i++)
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const bytes = Buffer.concat([Buffer.from(type), data]),
      size = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc(bytes));
    return Buffer.concat([size, bytes, checksum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
async function account() {
  const r = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(r.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
async function upload(
  user,
  pageId,
  name = "design-study.png",
  bytes = cover(),
) {
  const body = new FormData();
  body.append("file", new Blob([bytes]), name);
  const response = await fetch(`${base}/api/v1/pages/${pageId}/files`, {
    method: "POST",
    headers: { Origin: process.env.TEST_ORIGIN, Cookie: user.cookie },
    body,
  });
  assert.equal(response.status, 201);
  return response.json();
}
async function fixture(db) {
  const owner = await account(),
    viewer = await account(),
    outsider = await account();
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
      body: { name: "Launch roadmap" },
    })
  ).data;
  const path = `databases/${database.id}`,
    get = async () => (await request(path, { cookie: owner.cookie })).data;
  const summary = (
    await request(path + "/properties", {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Summary", type: "Text" },
    })
  ).data;
  const meta = await get(),
    status = meta.properties.find((p) => p.type === "Status"),
    board = meta.views.find((v) => v.type === "Board");
  assert.equal(
    (
      await request(path + "/views/" + board.id, {
        method: "PATCH",
        cookie: owner.cookie,
        body: {
          name: board.name,
          type: board.type,
          version: board.version,
          config: {
            ...board.config,
            visibleProperties: [
              meta.properties.find((p) => p.type === "Title").id,
              status.id,
              summary.id,
            ],
          },
        },
      })
    ).response.status,
    200,
  );
  const records = [];
  for (const [index, title, text] of [
    [
      0,
      "Design the writing experience",
      "A calmer place to turn ideas into pages.",
    ],
    [
      1,
      "Build the shared workspace",
      "Bring the whole team into the same flow.",
    ],
    [
      2,
      "Polish the first release",
      "Small details make the work feel effortless.",
    ],
  ])
    records.push(
      (
        await request(path + "/records", {
          method: "POST",
          cookie: owner.cookie,
          body: {
            title,
            values: {
              [status.id]: status.config.options[index].id,
              [summary.id]: text,
            },
          },
        })
      ).data,
    );
  const query = async (user = owner) =>
    request(path + "/query", {
      method: "POST",
      cookie: user.cookie,
      body: { viewId: board.id },
    });
  const record = async (id) =>
    (await request(path + "/records/" + id, { cookie: owner.cookie })).data
      .record;
  return {
    owner,
    viewer,
    outsider,
    space,
    database,
    path,
    status,
    board,
    records,
    query,
    record,
  };
}
async function document(user, id, content) {
  const p = (await request("pages/" + id, { cookie: user.cookie })).data;
  assert.equal(
    (
      await request("pages/" + id, {
        method: "PUT",
        cookie: user.cookie,
        body: {
          version: p.version,
          title: p.title,
          document: { type: "doc", content },
        },
      })
    ).response.status,
    200,
  );
}
const image = (id) => ({
  type: "orvynImage",
  attrs: { fileId: id, label: "Design study" },
});
async function open(browser, f, user = f.owner) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
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
  const page = await context.newPage();
  await page.goto(`${base}/?page=${f.database.id}`);
  await page.getByRole("tab", { name: "Board", exact: true }).click();
  await expect(page.locator(".board-card")).toHaveCount(3);
  return page;
}
const lane = (page, name) =>
  page.locator(".board-column").filter({
    has: page.getByRole("heading", { name: new RegExp("^" + name) }),
  });
const card = (page, title) =>
  page
    .locator(".board-card")
    .filter({ has: page.getByRole("button", { name: title, exact: true }) });
const launch = () =>
  chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });

test("Kanban image previews follow owned ready document images independently of page covers and never expose another record's attachments", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const f = await fixture(db),
      first = await upload(f.owner, f.records[0].pageId),
      second = await upload(f.owner, f.records[0].pageId, "second.png"),
      foreign = await upload(f.owner, f.records[1].pageId);
    assert.equal(
      (await f.query()).data.records.find(
        (r) => r.pageId === f.records[0].pageId,
      ).previewFileId,
      first.id,
    );
    await document(f.owner, f.records[0].pageId, [
      image(foreign.id),
      {
        type: "orvynCallout",
        attrs: { tone: "info" },
        content: [image(second.id), image(first.id)],
      },
    ]);
    let result = (await f.query()).data.records.find(
      (r) => r.pageId === f.records[0].pageId,
    );
    assert.equal(result.previewFileId, second.id);
    assert.equal(
      result.coverFileId,
      first.id,
      "Legacy automatic covers retain their existing semantics",
    );
    assert.equal(
      (
        await request("pages/" + f.records[0].pageId + "/appearance", {
          method: "PATCH",
          cookie: f.owner.cookie,
          body: {
            appearanceVersion: 1,
            icon: "✏️",
            coverPreset: null,
            coverFileId: null,
          },
        })
      ).response.status,
      200,
    );
    result = (await f.query(f.viewer)).data.records.find(
      (r) => r.pageId === f.records[0].pageId,
    );
    assert.equal(result.coverFileId, null);
    assert.equal(
      result.previewFileId,
      second.id,
      "An icon-only edit does not hide the document preview",
    );
    assert.equal(
      (
        await request("pages/" + f.records[0].pageId + "/appearance", {
          method: "PATCH",
          cookie: f.owner.cookie,
          body: {
            appearanceVersion: 2,
            icon: "✏️",
            coverPreset: null,
            coverFileId: first.id,
          },
        })
      ).response.status,
      200,
    );
    assert.equal(
      (await f.query()).data.records.find(
        (r) => r.pageId === f.records[0].pageId,
      ).previewFileId,
      first.id,
    );
    assert.equal((await f.query(f.outsider)).response.status, 404);
    assert.equal(
      (
        await fetch(`${base}/api/v1/files/${second.id}/preview`, {
          headers: { Cookie: f.outsider.cookie },
        })
      ).status,
      404,
    );
    const current = (
      await request("pages/" + f.records[0].pageId, { cookie: f.owner.cookie })
    ).data;
    assert.equal(
      (
        await request("pages/" + f.records[0].pageId + "/permissions", {
          method: "PUT",
          cookie: f.owner.cookie,
          body: {
            version: current.version,
            confirm: true,
            visibility: "restricted",
            grants: [],
          },
        })
      ).response.status,
      200,
    );
    assert.equal(
      (await f.query(f.viewer)).data.records.some(
        (r) => r.pageId === f.records[0].pageId,
      ),
      false,
    );
  } finally {
    await db.end();
  }
});

test("Chromium: Kanban opens records without inline editing, previews images, offers pointer/keyboard/menu moves, cancellation, scoped drops and live readers", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await launch();
  try {
    const f = await fixture(db),
      target = f.records[0],
      picture = await upload(f.owner, target.pageId);
    await document(f.owner, target.pageId, [image(picture.id)]);
    const page = await open(browser, f),
      viewer = await open(browser, f, f.viewer),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    viewer.on("pageerror", (e) => errors.push(e.message));
    const groups = f.status.config.options,
      name = target.title,
      selected = card(page, name);
    await expect(
      page.locator(
        ".database-board input,.database-board select,.database-board [contenteditable=true]",
      ),
    ).toHaveCount(0);
    await expect(selected.locator("img")).toBeVisible();
    await expect
      .poll(() =>
        selected
          .locator("img")
          .evaluate((el) => el.complete && el.naturalWidth > 0),
      )
      .toBe(true);
    await expect(
      viewer.getByRole("button", { name: "Move " + name, exact: true }),
    ).toHaveCount(0);
    await selected
      .getByRole("button", { name: "Move " + name, exact: true })
      .click();
    const menu = page.getByRole("menu", {
      name: "Move record to",
      exact: true,
    });
    await menu
      .getByRole("menuitem", { name: groups[2].label, exact: true })
      .click();
    await expect(
      lane(page, groups[2].label).getByRole("button", { name, exact: true }),
    ).toBeVisible();
    await expect(
      lane(viewer, groups[2].label).getByRole("button", { name, exact: true }),
    ).toBeVisible();
    await selected.getByRole("button", { name, exact: true }).focus();
    await page.keyboard.press("Alt+Shift+ArrowLeft");
    await expect(
      lane(page, groups[1].label).getByRole("button", { name, exact: true }),
    ).toBeVisible();
    await selected
      .getByRole("button", { name: "Move " + name, exact: true })
      .dragTo(lane(page, groups[0].label));
    await expect(
      lane(viewer, groups[0].label).getByRole("button", { name, exact: true }),
    ).toBeVisible();
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await selected
      .getByRole("button", { name: "Move " + name, exact: true })
      .dispatchEvent("dragstart", { dataTransfer: transfer });
    const destination = lane(page, groups[1].label),
      box = await destination.boundingBox();
    await destination.dispatchEvent("dragover", {
      dataTransfer: transfer,
      clientX: box.x + 80,
      clientY: box.y + 80,
    });
    await expect(destination).toHaveClass(/is-drop-target/);
    await expect(destination.locator(".board-drop-placeholder")).toBeVisible();
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/kanban-movement.png",
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(destination.locator(".board-drop-placeholder")).toHaveCount(0);
    await destination.dispatchEvent("drop", { dataTransfer: transfer });
    assert.equal(
      (await f.record(target.pageId)).values[f.status.id],
      groups[0].id,
    );
    const foreign = await page.evaluateHandle((id) => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", id);
      return transfer;
    }, target.pageId);
    await destination.dispatchEvent("drop", { dataTransfer: foreign });
    assert.equal(
      (await f.record(target.pageId)).values[f.status.id],
      groups[0].id,
    );
    await selected.getByRole("button", { name, exact: true }).focus();
    await page.keyboard.press("Shift+Enter");
    const dialog = page.locator("dialog.page-peek[open]");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await page.setViewportSize({ width: 390, height: 850 });
    await selected
      .getByRole("button", { name: "Move " + name, exact: true })
      .click();
    await expect(menu).toBeVisible();
    await lane(page, groups[0].label).evaluate((lane) => {
      const board = lane.closest(".database-board");
      board.scrollLeft +=
        lane.getBoundingClientRect().left - board.getBoundingClientRect().left;
    });
    await page.screenshot({
      path: ".local/ui-review/kanban-mobile.png",
      fullPage: true,
    });
    await menu
      .getByRole("menuitem", { name: groups[1].label, exact: true })
      .click();
    await waitFor(
      async () =>
        (await f.record(target.pageId)).values[f.status.id] === groups[1].id,
      "Mobile card move persisted",
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await db.end();
  }
});

test("Chromium: failed Kanban moves retain a retryable draft and a concurrent group change cancels an outdated drop", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await launch();
  try {
    const f = await fixture(db),
      page = await open(browser, f),
      target = f.records[0],
      groups = f.status.config.options;
    const endpoint = `${base}/api/v1/${f.path}/records/${target.pageId}`;
    await page.route(endpoint, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              message: "The connection was interrupted.",
            }),
          })
        : route.continue(),
    );
    await card(page, target.title)
      .getByRole("button", { name: target.title, exact: true })
      .focus();
    await page.keyboard.press("Alt+Shift+ArrowRight");
    const recovery = page.getByRole("region", {
      name: "Unsaved changes for " + target.title,
      exact: true,
    });
    await expect(recovery.getByRole("alert")).toContainText(
      "connection was interrupted",
    );
    await expect(
      lane(page, groups[1].label).getByRole("button", {
        name: target.title,
        exact: true,
      }),
    ).toBeVisible();
    assert.equal(
      (await f.record(target.pageId)).values[f.status.id],
      groups[0].id,
    );
    await page.unroute(endpoint);
    await recovery
      .getByRole("button", { name: "Retry saving", exact: true })
      .click();
    await expect(recovery).toHaveCount(0);
    await waitFor(
      async () =>
        (await f.record(target.pageId)).values[f.status.id] === groups[1].id,
      "Retried card move persisted",
    );
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await card(page, target.title)
      .getByRole("button", { name: "Move " + target.title, exact: true })
      .dispatchEvent("dragstart", { dataTransfer: transfer });
    const current = await f.record(target.pageId);
    assert.equal(
      (
        await request(`${f.path}/records/${target.pageId}`, {
          method: "PATCH",
          cookie: f.owner.cookie,
          body: {
            version: current.version,
            values: { [f.status.id]: groups[2].id },
          },
        })
      ).response.status,
      200,
    );
    await expect(
      lane(page, groups[2].label).getByRole("button", {
        name: target.title,
        exact: true,
      }),
    ).toBeVisible();
    await lane(page, groups[0].label).dispatchEvent("drop", {
      dataTransfer: transfer,
    });
    await expect(
      page.getByRole("status").filter({ hasText: "This card moved elsewhere" }),
    ).toBeVisible();
    assert.equal(
      (await f.record(target.pageId)).values[f.status.id],
      groups[2].id,
    );
    await expect(page.locator(".board-drop-placeholder")).toHaveCount(0);
  } finally {
    await browser.close();
    await db.end();
  }
});

test("Chromium: losing record edit permission during a drag removes its handles and cancels the pending move", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await launch();
  try {
    const f = await fixture(db),
      editor = await account(),
      target = f.records[0],
      groups = f.status.config.options;
    await db.query("INSERT INTO space_members VALUES($1,$2,'Editor')", [
      f.space.id,
      editor.id,
    ]);
    const page = await open(browser, f, editor),
      transfer = await page.evaluateHandle(() => new DataTransfer());
    await card(page, target.title)
      .getByRole("button", { name: "Move " + target.title, exact: true })
      .dispatchEvent("dragstart", { dataTransfer: transfer });
    const destination = lane(page, groups[1].label),
      box = await destination.boundingBox();
    await destination.dispatchEvent("dragover", {
      dataTransfer: transfer,
      clientX: box.x + 70,
      clientY: box.y + 70,
    });
    await expect(destination.locator(".board-drop-placeholder")).toBeVisible();
    const current = (
      await request("pages/" + target.pageId, { cookie: f.owner.cookie })
    ).data;
    assert.equal(
      (
        await request("pages/" + target.pageId + "/permissions", {
          method: "PUT",
          cookie: f.owner.cookie,
          body: {
            version: current.version,
            confirm: true,
            visibility: "restricted",
            grants: [{ userId: editor.id, role: "Viewer" }],
          },
        })
      ).response.status,
      200,
    );
    await expect(
      card(page, target.title).getByRole("button", {
        name: "Move " + target.title,
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(destination.locator(".board-drop-placeholder")).toHaveCount(0);
    await destination.dispatchEvent("drop", { dataTransfer: transfer });
    assert.equal(
      (await f.record(target.pageId)).values[f.status.id],
      groups[0].id,
    );
  } finally {
    await browser.close();
    await db.end();
  }
});

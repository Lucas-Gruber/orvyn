import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { MessageType } from "@hocuspocus/provider";
import { mkdir, readFile } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, Pool } from "./helpers.mjs";
import { peer, waitFor } from "./collaboration-peer.mjs";
import {
  emptyWhiteboard,
  validateWhiteboardScene,
  whiteboardFromYDoc,
  whiteboardToYDoc,
  whiteboardFiles,
  whiteboardText,
} from "../packages/editor/dist/whiteboard-model.js";

export const shape = (id = "shape", extra = {}) => ({
  id,
  type: "rectangle",
  x: 10,
  y: 20,
  width: 200,
  height: 100,
  angle: 0,
  seed: 1,
  version: 1,
  versionNonce: 1,
  index: "a0",
  isDeleted: false,
  groupIds: [],
  frameId: null,
  boundElements: null,
  updated: Date.now(),
  link: null,
  locked: false,
  strokeColor: "#1e1e1e",
  backgroundColor: "#e7ddfb",
  strokeWidth: 2,
  roughness: 1,
  opacity: 100,
  strokeStyle: "solid",
  fillStyle: "solid",
  roundness: null,
  ...extra,
});
async function account() {
  const r = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(r.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
export async function whiteboardFixture(db) {
  const owner = await account(),
    viewer = await account(),
    outsider = await account();
  const space = (
    await request("spaces", {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "Design studio" },
    })
  ).data;
  await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
  await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
    space.id,
    viewer.id,
  ]);
  const create = async (title, kind = "whiteboard") =>
    request(`spaces/${space.id}/pages`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title, kind },
    });
  const created = await create("A shared canvas");
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  const board = created.data,
    get = async (user = owner) =>
      request(`pages/${board.id}/whiteboard`, { cookie: user.cookie });
  return { owner, viewer, outsider, space, board, create, get };
}

test("whiteboard scenes validate bounded native shapes, text, links, image identities and Yjs namespaces", () => {
  const scene = {
    ...emptyWhiteboard(),
    elements: [
      shape(),
      shape("label", {
        type: "text",
        index: "a1",
        text: "A quieter workspace",
        originalText: "A quieter workspace",
        fontSize: 24,
        fontFamily: 5,
      }),
    ],
  };
  const document = whiteboardToYDoc(scene);
  try {
    assert.deepEqual(whiteboardFromYDoc(document), scene);
    assert.equal(whiteboardText(scene), "A quieter workspace");
  } finally {
    document.destroy();
  }
  for (const patch of [
    { id: undefined },
    { id: "x", type: "iframe" },
    { id: "x", type: "embeddable" },
    { id: "x", x: Infinity },
    { id: "x", link: "javascript:alert(1)" },
    { id: "x", strokeColor: "url(https://bad.test)" },
    { id: "x", type: "image", fileId: "data:image/png;base64,test" },
  ])
    assert.throws(() =>
      validateWhiteboardScene({
        ...emptyWhiteboard(),
        elements: [shape("x", patch)],
      }),
    );
  assert.throws(
    () =>
      validateWhiteboardScene({
        ...emptyWhiteboard(),
        elements: [shape(), shape()],
      }),
    /identity/,
  );
  assert.throws(
    () =>
      validateWhiteboardScene({
        ...emptyWhiteboard(),
        elements: Array.from({ length: 2001 }, (_, i) => shape("item" + i)),
      }),
    /element limit/,
  );
  const invalid = new Y.Doc();
  invalid
    .getXmlFragment("default")
    .insert(0, [new Y.XmlText("wrong document")]);
  try {
    assert.throws(() => whiteboardFromYDoc(invalid), /document type/);
  } finally {
    invalid.destroy();
  }
  assert.deepEqual(
    whiteboardFiles({
      ...emptyWhiteboard(),
      elements: [shape("image", { type: "image", fileId: randomUUID() })],
    }).length,
    1,
  );
});

test("whiteboards persist concurrent elements across replicas, search their own text, checkpoint history and revoke current access", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    clients = [];
  try {
    const f = await whiteboardFixture(db),
      urls = JSON.parse(process.env.COLLABORATION_TEST_URLS);
    const a = peer(urls[0], f.board.id, f.owner.cookie),
      b = peer(urls[1], f.board.id, f.owner.cookie),
      reader = peer(urls[1], f.board.id, f.viewer.cookie);
    clients.push(a, b, reader);
    await waitFor(
      () => a.provider.synced && b.provider.synced && reader.provider.synced,
      "Whiteboard replicas synchronized",
    );
    a.doc.getMap("elements").set("idea", shape("idea"));
    b.doc.getMap("elements").set(
      "label",
      shape("label", {
        type: "text",
        index: "a1",
        text: "Heliotrope sketch",
        originalText: "Heliotrope sketch",
        fontSize: 24,
        fontFamily: 5,
      }),
    );
    await waitFor(
      async () => (await f.get()).data.scene.elements.length === 2,
      "Both elements persisted",
    );
    await waitFor(
      () => whiteboardFromYDoc(reader.doc).elements.length === 2,
      "Read-only replica received both elements",
    );
    assert.equal(
      whiteboardText((await f.get()).data.scene),
      "Heliotrope sketch",
    );
    const search = await request("search?q=Heliotrope&scope=content", {
      cookie: f.viewer.cookie,
    });
    assert.equal(search.response.status, 200);
    assert.ok(search.data.some((r) => r.id === f.board.id));
    const history = await request(`pages/${f.board.id}/whiteboard/history`, {
      cookie: f.owner.cookie,
    });
    assert.equal(history.response.status, 200);
    assert.equal(history.data.revisions.length, 1);
    const revision = await request(`pages/${f.board.id}/whiteboard/history/1`, {
      cookie: f.viewer.cookie,
    });
    assert.deepEqual(revision.data.scene, emptyWhiteboard());
    assert.equal((await f.get(f.outsider)).response.status, 404);
    let negativeAcknowledgement = false;
    reader.provider.on("message", ({ message }) => {
      message.readVarString();
      if (
        message.readVarUint() === MessageType.SyncStatus &&
        message.readVarUint() === 0
      )
        negativeAcknowledgement = true;
    });
    reader.doc.getMap("elements").set("forbidden", shape("forbidden"));
    await waitFor(() => negativeAcknowledgement, "Read-only update refused");
    assert.equal(
      (await f.get()).data.scene.elements.some((e) => e.id === "forbidden"),
      false,
    );
    const current = (
      await request("pages/" + f.board.id, { cookie: f.owner.cookie })
    ).data;
    assert.equal(
      (
        await request("pages/" + f.board.id, {
          method: "PUT",
          cookie: f.owner.cookie,
          body: {
            version: current.version,
            title: current.title,
            document: { type: "doc", content: [{ type: "paragraph" }] },
          },
        })
      ).response.status,
      409,
    );
    assert.equal(
      (
        await db.query("SELECT 1 FROM editor_documents WHERE page_id=$1", [
          f.board.id,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await request(`pages/${f.board.id}/permissions`, {
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
    await waitFor(
      () => reader.closed,
      "Revoked whiteboard reader disconnected",
    );
    assert.equal((await f.get(f.viewer)).response.status, 404);
    assert.equal(
      (
        await request(`pages/${f.board.id}/whiteboard/history/1`, {
          cookie: f.viewer.cookie,
        })
      ).response.status,
      404,
    );
  } finally {
    for (const client of clients) client.destroy();
    await db.end();
  }
});

test("invalid whiteboard updates and foreign image references are rejected before durable state or search changes", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    clients = [];
  try {
    const f = await whiteboardFixture(db),
      url = JSON.parse(process.env.COLLABORATION_TEST_URLS)[0];
    const foreignPage = (await f.create("Separate image source")).data,
      body = new FormData();
    body.append(
      "file",
      new Blob([
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1cAAAAASUVORK5CYII=",
          "base64",
        ),
      ]),
      "private.png",
    );
    const uploaded = await fetch(
      `${process.env.TEST_URL}/api/v1/pages/${foreignPage.id}/files`,
      {
        method: "POST",
        headers: { Origin: process.env.TEST_ORIGIN, Cookie: f.owner.cookie },
        body,
      },
    );
    assert.equal(uploaded.status, 201);
    const foreign = (await uploaded.json()).id;
    for (const change of [
      (document) =>
        document
          .getMap("elements")
          .set("bad", shape("bad", { type: "iframe" })),
      (document) => document.getMap("elements").set("bad", shape("other-id")),
      (document) =>
        document
          .getMap("elements")
          .set("bad", shape("bad", { type: "image", fileId: foreign })),
      (document) => document.getMap("unknown").set("secret", true),
    ]) {
      const client = peer(url, f.board.id, f.owner.cookie);
      clients.push(client);
      await waitFor(
        () => client.provider.synced,
        "Attacker fixture synchronized",
      );
      change(client.doc);
      await waitFor(() => client.closed, "Invalid update disconnected");
      assert.deepEqual((await f.get()).data.scene, emptyWhiteboard());
      client.destroy();
      clients.pop();
    }
  } finally {
    for (const client of clients) client.destroy();
    await db.end();
  }
});

test("Chromium: draw, save, undo, export and embed a real Excalidraw canvas with independent read access and live revocation", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    }),
    clients = [];
  const base = process.env.TEST_URL;
  try {
    const f = await whiteboardFixture(db),
      seed = peer(
        JSON.parse(process.env.COLLABORATION_TEST_URLS)[0],
        f.board.id,
        f.owner.cookie,
      );
    clients.push(seed);
    await waitFor(() => seed.provider.synced, "Seed canvas synchronized");
    const text = (id, label, x, y, width = 210, size = 20) =>
      shape(id, {
        type: "text",
        index: "a" + id,
        x,
        y,
        width,
        height: 60,
        text: label,
        originalText: label,
        fontSize: size,
        fontFamily: 5,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        lineHeight: 1.25,
        autoResize: true,
        backgroundColor: "transparent",
      });
    const elements = [
      text("0", "From an idea to a shared workspace", 70, 80, 900, 32),
      shape("capture", {
        index: "a1",
        x: 70,
        y: 190,
        width: 230,
        height: 145,
        backgroundColor: "#e7ddfb",
      }),
      text("2", "Capture\nMake room for ideas", 90, 230),
      shape("connect", {
        index: "a3",
        x: 400,
        y: 190,
        width: 230,
        height: 145,
        backgroundColor: "#d3f1e4",
      }),
      text("4", "Connect\nBring the team in", 420, 230),
      shape("release", {
        index: "a5",
        x: 730,
        y: 190,
        width: 230,
        height: 145,
        backgroundColor: "#ffedca",
      }),
      text("6", "Create\nShape the next release", 750, 230),
      shape("flow1", {
        type: "arrow",
        index: "a7",
        x: 310,
        y: 260,
        width: 75,
        height: 0,
        points: [
          [0, 0],
          [75, 0],
        ],
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: "arrow",
        elbowed: false,
      }),
      shape("flow2", {
        type: "arrow",
        index: "a8",
        x: 640,
        y: 260,
        width: 75,
        height: 0,
        points: [
          [0, 0],
          [75, 0],
        ],
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: "arrow",
        elbowed: false,
      }),
    ];
    seed.doc.transact(() => {
      for (const element of elements)
        seed.doc.getMap("elements").set(element.id, element);
    });
    await waitFor(
      async () =>
        (await f.get()).data.scene.elements.length === elements.length,
      "Seed persisted",
    );
    async function session(user) {
      const context = await browser.newContext({
        viewport: { width: 1600, height: 1150 },
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
      return context.newPage();
    }
    const page = await session(f.owner),
      errors = [],
      external = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        ["http:", "https:"].includes(url.protocol) &&
        url.origin !== new URL(base).origin
      )
        external.push(url.origin);
    });
    await page.goto(`${base}/?page=${f.board.id}`);
    await expect(
      page.locator(".whiteboard .excalidraw canvas").last(),
    ).toBeVisible();
    await expect(page.locator(".whiteboard-loading")).toHaveCount(0);
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/whiteboard-initial-debug.png",
      fullPage: true,
    });
    await page.getByTestId("toolbar-rectangle").locator("..").click();
    const stage = await page.locator(".whiteboard-stage").boundingBox();
    await page.mouse.move(stage.x + 350, stage.y + 390);
    await page.mouse.down();
    await page.mouse.move(stage.x + 580, stage.y + 480, { steps: 8 });
    await page.mouse.up();
    await waitFor(
      async () =>
        (await f.get()).data.scene.elements.filter((e) => !e.isDeleted)
          .length ===
        elements.length + 1,
      "Native rectangle persisted",
    );
    await expect(page.locator(".whiteboard-error")).toHaveCount(0);
    await page.keyboard.press("Control+z");
    await waitFor(
      async () =>
        (await f.get()).data.scene.elements.filter((e) => !e.isDeleted)
          .length === elements.length,
      "Canvas undo persisted",
    );
    await page.keyboard.press("Control+Shift+z");
    await waitFor(
      async () =>
        (await f.get()).data.scene.elements.filter((e) => !e.isDeleted)
          .length ===
        elements.length + 1,
      "Canvas redo persisted",
    );
    await mkdir(".local/ui-review", { recursive: true });
    await page.keyboard.press("Escape");
    await page.keyboard.press("v");
    await page.screenshot({
      path: ".local/ui-review/whiteboard-canvas.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Whiteboard actions", exact: true })
      .click();
    const download = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Export PNG", exact: true })
      .click();
    assert.match((await download).suggestedFilename(), /\.png$/);
    await page.reload();
    await expect(page.locator(".whiteboard-loading")).toHaveCount(0);
    assert.equal(
      (await f.get()).data.scene.elements.filter((e) => !e.isDeleted).length,
      elements.length + 1,
    );
    const source = (await f.create("A page with a shared canvas", "page")).data;
    await page.goto(`${base}/?page=${source.id}`);
    const doc = page.getByRole("textbox", { name: "Document", exact: true });
    await expect(doc).toBeEditable();
    await doc.click();
    await page.keyboard.type("/Whiteboard");
    await page.getByRole("option", { name: "Whiteboard", exact: true }).click();
    const picker = page.getByRole("dialog", {
      name: "Embed a whiteboard",
      exact: true,
    });
    await expect(picker).toBeVisible();
    await picker
      .getByRole("button", { name: f.board.title, exact: true })
      .click();
    await expect(
      page.locator(".embedded-whiteboard .whiteboard-loading"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Edit whiteboard", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: ".local/ui-review/whiteboard-embedded.png",
      fullPage: true,
    });
    await waitFor(
      async () =>
        JSON.stringify(
          (await request("pages/" + source.id, { cookie: f.owner.cookie })).data
            .document,
        ).includes(f.board.id),
      "Whiteboard reference persisted",
    );
    const stored = (
      await request("pages/" + source.id, { cookie: f.owner.cookie })
    ).data;
    assert.equal(
      JSON.stringify(stored.document).includes("From an idea"),
      false,
      "Embedding stores only a target ID",
    );
    const viewer = await session(f.viewer);
    await viewer.goto(`${base}/?page=${source.id}`);
    await expect(
      viewer.locator(".embedded-whiteboard .excalidraw canvas").last(),
    ).toBeVisible();
    await expect(
      viewer.getByRole("button", { name: "Edit whiteboard", exact: true }),
    ).toHaveCount(0);
    const current = (
      await request("pages/" + f.board.id, { cookie: f.owner.cookie })
    ).data;
    assert.equal(
      (
        await request(`pages/${f.board.id}/permissions`, {
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
    await expect(
      viewer.locator(".embedded-whiteboard").getByRole("alert"),
    ).toContainText("unavailable");
    await expect(
      viewer.locator(".embedded-whiteboard .excalidraw"),
    ).toHaveCount(0);
    assert.deepEqual(external, [], "Canvas fonts/assets stay on this instance");
    assert.deepEqual(errors, []);
  } finally {
    for (const client of clients) client.destroy();
    await browser.close();
    await db.end();
  }
});

test("Chromium: private canvas images export and import as independent files, checkpoints restore, and navigation flushes pending drawing edits", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    });
  const base = process.env.TEST_URL;
  try {
    const f = await whiteboardFixture(db),
      destination = (await f.create("Imported drawing")).data;
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1150 },
      reducedMotion: "reduce",
    });
    await context.addInitScript(() =>
      localStorage.setItem("orvyn.theme", "light"),
    );
    await context.addCookies([
      {
        name: "orvyn_session",
        value: f.owner.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const page = await context.newPage(),
      errors = [];
    await context.addInitScript(() => {
      delete window.showOpenFilePicker;
      delete window.showSaveFilePicker;
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/?page=${f.board.id}`);
    await expect(page.locator(".whiteboard-loading")).toHaveCount(0);
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("toolbar-image").locator("..").click();
    await (
      await chooser
    ).setFiles({
      name: "sketch.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1cAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await mkdir(".local/ui-review", { recursive: true });
    await expect(page.getByText(/^Click to place the image/)).toBeVisible();
    const stage = await page.locator(".whiteboard-stage").boundingBox();
    await page.mouse.move(stage.x + 450, stage.y + 280);
    await page.mouse.down();
    await page.mouse.move(stage.x + 600, stage.y + 430, { steps: 5 });
    await page.mouse.up();
    await waitFor(
      async () =>
        (await f.get()).data.scene.elements.some(
          (e) => e.type === "image" && !e.isDeleted,
        ),
      "Private canvas image persisted",
    );
    const original = (await f.get()).data.scene.elements.find(
      (e) => e.type === "image" && !e.isDeleted,
    );
    assert.match(original.fileId, /^[a-f0-9-]{36}$/);
    await expect(page.locator(".whiteboard-error")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Whiteboard actions", exact: true })
      .click();
    const downloading = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Export Excalidraw file", exact: true })
      .click();
    const download = await downloading,
      bytes = await readFile(await download.path()),
      exported = JSON.parse(bytes.toString());
    assert.equal(exported.type, "excalidraw");
    assert.ok(
      exported.files[original.fileId].dataURL.startsWith(
        "data:image/png;base64,",
      ),
    );
    await page
      .getByRole("navigation", { name: "Pages", exact: true })
      .getByRole("button", { name: destination.title, exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue(destination.title);
    await expect(page.locator(".whiteboard-loading")).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue(destination.title);
    await page
      .getByRole("button", { name: "Whiteboard actions", exact: true })
      .click();
    const importAction = page.getByRole("menuitem", {
      name: "Import Excalidraw file",
      exact: true,
    });
    await expect(importAction).toBeEnabled();
    const importingFile = page.waitForEvent("filechooser");
    await importAction.click();
    await (
      await importingFile
    ).setFiles({
      name: "drawing.excalidraw",
      mimeType: "application/json",
      buffer: bytes,
    });
    const get = async () =>
      (
        await request(`pages/${destination.id}/whiteboard`, {
          cookie: f.owner.cookie,
        })
      ).data;
    await waitFor(
      async () =>
        (await get()).scene.elements.some(
          (e) => e.type === "image" && !e.isDeleted,
        ),
      "Imported image persisted independently",
    );
    const imported = (await get()).scene.elements.find(
      (e) => e.type === "image" && !e.isDeleted,
    );
    assert.notEqual(imported.fileId, original.fileId);
    assert.equal(
      (
        await db.query("SELECT page_id FROM files WHERE id=$1", [
          imported.fileId,
        ])
      ).rows[0].page_id,
      destination.id,
    );
    await page.getByTestId("toolbar-rectangle").locator("..").click();
    const nextStage = await page.locator(".whiteboard-stage").boundingBox();
    await page.mouse.move(nextStage.x + 650, nextStage.y + 300);
    await page.mouse.down();
    await page.mouse.move(nextStage.x + 800, nextStage.y + 420, { steps: 4 });
    await page.mouse.up();
    // Navigate before the debounce fires; the paused canvas must still flush its draft.
    await page
      .getByRole("navigation", { name: "Pages", exact: true })
      .getByRole("button", { name: f.board.title, exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue(f.board.title);
    assert.equal(
      (await get()).scene.elements.filter((e) => !e.isDeleted).length,
      2,
    );
    await page
      .getByRole("navigation", { name: "Pages", exact: true })
      .getByRole("button", { name: destination.title, exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Page title", exact: true }),
    ).toHaveValue(destination.title);
    await expect(page.locator(".whiteboard-loading")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Whiteboard actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Canvas history", exact: true })
      .click();
    const history = page.getByRole("dialog", {
      name: "Canvas history",
      exact: true,
    });
    await history
      .locator(".canvas-history>div")
      .filter({ hasText: "Revision 1" })
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await waitFor(
      async () =>
        (await get()).scene.elements.filter((e) => !e.isDeleted).length === 0,
      "Blank checkpoint restored",
    );
    await page
      .getByRole("button", { name: "Whiteboard actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Canvas history", exact: true })
      .click();
    await history
      .locator(".canvas-history>div")
      .first()
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await waitFor(
      async () =>
        (await get()).scene.elements.filter((e) => !e.isDeleted).length === 2,
      "Pre-restore drawing recovered",
    );
    await expect(page.locator(".whiteboard-error")).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await db.end();
  }
});

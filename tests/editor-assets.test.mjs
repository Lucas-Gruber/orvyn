import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, Pool, base } from "./helpers.mjs";
import { pageLink } from "../packages/editor/dist/links.js";
import { peer, waitFor } from "./collaboration-peer.mjs";
import * as Y from "yjs";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1cAAAAASUVORK5CYII=",
  "base64",
);
async function account() {
  const r = await request("auth/register", {
      method: "POST",
      body: { email: randomUUID() + "@example.test", password: randomUUID() },
    }),
    cookie = sessionCookie(r.response);
  return { ...(await request("auth/me", { cookie })).data, cookie };
}
async function create(owner, space, title) {
  return (
    await request(`spaces/${space}/pages`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title },
    })
  ).data;
}
async function upload(owner, page, bytes, name) {
  const data = new FormData();
  data.append("file", new Blob([bytes]), name);
  const r = await fetch(`${base}/api/v1/pages/${page}/files`, {
    method: "POST",
    headers: { Origin: process.env.TEST_ORIGIN, Cookie: owner.cookie },
    body: data,
  });
  assert.equal(r.status, 201);
  return r.json();
}
test("embedded attachments reject inaccessible/pending/unsafe image references and retain editability after deletion", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    peers = [];
  try {
    const owner = await account(),
      editor = await account(),
      viewer = await account(),
      space = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Asset rights" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query(
      "INSERT INTO space_members VALUES($1,$2,'Editor'),($1,$3,'Viewer')",
      [space.id, editor.id, viewer.id],
    );
    const target = await create(owner, space.id, "Public document"),
      privatePage = await create(owner, space.id, "Private assets");
    await request(`pages/${privatePage.id}/permissions`, {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        version: privatePage.version,
        confirm: true,
        visibility: "restricted",
        grants: [],
      },
    });
    const secret = await upload(
        owner,
        privatePage.id,
        png,
        "private-picture.png",
      ),
      image = await upload(owner, target.id, png, "image.png"),
      text = await upload(
        owner,
        target.id,
        "<svg onload=alert(1)>no</svg>",
        "unsafe.svg",
      );
    const doc = (type, fileId) => ({
      type: "doc",
      content: [{ type, attrs: { fileId, label: "Reference" } }],
    });
    const save = async (document, cookie = owner.cookie) => {
      const p = (await request("pages/" + target.id, { cookie: owner.cookie }))
        .data;
      return request("pages/" + target.id, {
        method: "PUT",
        cookie,
        body: { title: p.title, version: p.version, document },
      });
    };
    assert.equal(
      (await save(doc("orvynImage", secret.id), editor.cookie)).response.status,
      400,
    );
    assert.equal((await save(doc("orvynImage", text.id))).response.status, 400);
    const pending = (
      await db.query(
        "INSERT INTO files(page_id,object_key,filename,media_type,size,uploaded_by) VALUES($1,$2,'pending.png','image/png',10,$3) RETURNING id",
        [target.id, "pending/" + randomUUID(), owner.id],
      )
    ).rows[0];
    assert.equal(
      (await save(doc("orvynImage", pending.id))).response.status,
      400,
    );
    assert.equal(
      (await save(doc("orvynImage", secret.id))).response.status,
      200,
    );
    assert.equal(
      (await request(`files/${secret.id}/info`, { cookie: viewer.cookie }))
        .response.status,
      404,
    );
    assert.equal(
      (
        await fetch(`${base}/api/v1/files/${secret.id}/preview`, {
          headers: { Cookie: viewer.cookie },
        })
      ).status,
      404,
    );
    assert.equal(
      (await request(`files/${image.id}/info`, { cookie: viewer.cookie })).data
        .filename,
      "image.png",
    );
    assert.equal(
      (await request(`files/${image.id}/info`)).response.status,
      401,
    );
    assert.equal(
      (await save(doc("orvynImage", image.id))).response.status,
      200,
    );
    await request("files/" + image.id, {
      method: "DELETE",
      cookie: owner.cookie,
      body: {},
    });
    const retained = doc("orvynImage", image.id);
    retained.content.push({
      type: "paragraph",
      content: [{ type: "text", text: "Still editable" }],
    });
    assert.equal((await save(retained)).response.status, 200);
    assert.equal(
      (await request(`files/${image.id}/info`, { cookie: owner.cookie }))
        .response.status,
      404,
    );
    const live = await create(owner, space.id, "Live validation"),
      client = peer(
        JSON.parse(process.env.COLLABORATION_TEST_URLS)[0],
        live.id,
        owner.cookie,
      );
    peers.push(client);
    await waitFor(() => client.provider.synced, "initial asset sync");
    client.doc.transact(() => {
      const block = new Y.XmlElement("orvynImage");
      block.setAttribute("fileId", pending.id);
      block.setAttribute("label", "");
      client.doc.getXmlFragment("default").insert(1, [block]);
    });
    await waitFor(
      () => client.closed || client.rejected,
      "invalid asset update must be rejected",
    );
    assert.ok(
      !JSON.stringify(
        (await request("pages/" + live.id, { cookie: owner.cookie })).data
          .document,
      ).includes(pending.id),
    );
  } finally {
    for (const client of peers) client.destroy();
    await db.end();
  }
});
test("Chromium: upload and embed private image/file blocks, reader download, reload, removal and existing-file selection", async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL }),
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    }),
    contexts = [],
    errors = [];
  let page;
  async function session(user) {
    const c = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      reducedMotion: "reduce",
    });
    contexts.push(c);
    await c.addCookies([
      {
        name: "orvyn_session",
        value: user.cookie.split("=")[1],
        url: base,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    return p;
  }
  try {
    await mkdir(".local/ui-review", { recursive: true });
    const owner = await account(),
      viewer = await account(),
      space = (
        await request("spaces", {
          method: "POST",
          cookie: owner.cookie,
          body: { name: "Document media" },
        })
      ).data;
    await db.query("UPDATE spaces SET kind='team' WHERE id=$1", [space.id]);
    await db.query("INSERT INTO space_members VALUES($1,$2,'Viewer')", [
      space.id,
      viewer.id,
    ]);
    const source = await create(owner, space.id, "Release playbook");
    page = await session(owner);
    await page.goto(base + pageLink(source.id));
    const doc = page.getByRole("textbox", { name: "Document", exact: true });
    await expect(doc).toBeEditable();
    const imageBytes = Buffer.from(
      await page.evaluate(() => {
        const c = document.createElement("canvas");
        c.width = 900;
        c.height = 260;
        const x = c.getContext("2d");
        x.fillStyle = "#202331";
        x.fillRect(0, 0, 900, 260);
        x.font = "24px sans-serif";
        x.textAlign = "center";
        ["Draft", "Review", "Publish"].forEach((label, i) => {
          x.fillStyle = "#34354b";
          x.fillRect(40 + i * 290, 70, 240, 120);
          x.strokeStyle = "#b09aff";
          x.lineWidth = 2;
          x.strokeRect(40 + i * 290, 70, 240, 120);
          x.fillStyle = "#eeedf3";
          x.fillText(label, 160 + i * 290, 140);
          if (i < 2) {
            x.fillStyle = "#b09aff";
            x.fillText("→", 305 + i * 290, 140);
          }
        });
        return c.toDataURL("image/png").split(",")[1];
      }),
      "base64",
    );
    async function begin(name) {
      await doc.locator(":scope > p").last().click();
      await page.keyboard.type("/" + name.toLowerCase());
      await page.getByRole("option", { name, exact: true }).click();
    }
    await begin("Image");
    const imageDialog = page.getByRole("dialog", {
      name: "Insert image",
      exact: true,
    });
    await imageDialog
      .getByLabel("Image description (optional)", { exact: true })
      .fill("Draft, review and publish");
    await imageDialog
      .getByLabel("Choose image", { exact: true })
      .setInputFiles({
        name: "workflow.png",
        mimeType: "image/png",
        buffer: imageBytes,
      });
    await imageDialog
      .getByRole("button", { name: "Upload and insert", exact: true })
      .click();
    const img = doc.getByRole("img", {
      name: "Draft, review and publish",
      exact: true,
    });
    await expect(img).toBeVisible();
    await expect(img).toHaveJSProperty("naturalWidth", 900);
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await begin("File");
    const fileDialog = page.getByRole("dialog", {
      name: "Insert file",
      exact: true,
    });
    await fileDialog.getByLabel("Choose file", { exact: true }).setInputFiles({
      name: "release-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Actual release notes from the editor."),
    });
    await fileDialog
      .getByRole("button", { name: "Upload and insert", exact: true })
      .click();
    await expect(doc.locator(".editor-file-link")).toContainText(
      "release-notes.txt",
    );
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(img).toHaveJSProperty("naturalWidth", 900);
    await expect(doc.locator(".editor-file-link")).toContainText(
      "release-notes.txt",
    );
    await page.screenshot({
      path: ".local/ui-review/editor-media.png",
      fullPage: true,
    });
    const reader = await session(viewer);
    await reader.goto(base + pageLink(source.id));
    const readerDoc = reader.getByRole("textbox", {
      name: "Document",
      exact: true,
    });
    await expect(readerDoc).toHaveAttribute("contenteditable", "false");
    await expect(
      readerDoc.getByRole("button", {
        name: "Remove embedded attachment",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(readerDoc.getByRole("img")).toHaveJSProperty(
      "naturalWidth",
      900,
    );
    const downloadWait = reader.waitForEvent("download");
    await readerDoc.locator(".editor-file-link").click();
    const download = await downloadWait;
    assert.equal(download.suggestedFilename(), "release-notes.txt");
    const stream = await download.createReadStream();
    let bytes = "";
    for await (const chunk of stream) bytes += chunk;
    assert.equal(bytes, "Actual release notes from the editor.");
    await doc
      .locator(".image-asset")
      .getByRole("button", { name: "Remove embedded attachment", exact: true })
      .click();
    await expect(doc.getByRole("img")).toHaveCount(0);
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await expect(doc.locator(".editor-file-link")).toContainText(
      "release-notes.txt",
    );
    const attached = (
      await request(`pages/${source.id}/files`, { cookie: owner.cookie })
    ).data;
    assert.equal(attached.length, 2);
    await begin("Image");
    await imageDialog.getByRole("button", { name: /workflow.png/ }).click();
    await expect(
      doc.getByRole("img", { name: "workflow.png", exact: true }),
    ).toHaveJSProperty("naturalWidth", 900);
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await expect(doc.locator(".editor-file-link")).toContainText(
      "release-notes.txt",
    );
    const file = attached.find((f) => f.filename === "release-notes.txt");
    await request("files/" + file.id, {
      method: "DELETE",
      cookie: owner.cookie,
      body: {},
    });
    await page.reload();
    await expect(
      doc.getByText("Attachment unavailable or access denied.", {
        exact: true,
      }),
    ).toBeVisible();
    await doc.press("Control+End");
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await page.keyboard.insertText(
      "The rest of the document remains editable.",
    );
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    assert.deepEqual(errors, []);
  } catch (e) {
    if (page)
      await page.screenshot({
        path: ".local/ui-review/editor-media-failure.png",
        fullPage: true,
      });
    console.error("Media browser errors", errors);
    throw e;
  } finally {
    for (const c of contexts) await c.close();
    await browser.close();
    await db.end();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "./browser-tools.mjs";
import { request, sessionCookie, base } from "./helpers.mjs";
import { importMarkdown } from "../packages/editor/dist/markdown.js";
import {
  documentToYDoc,
  yDocToDocument,
  normalizeDocument,
} from "../packages/editor/dist/index.js";
import {
  documentMaxBytes,
  documentMaxNodes,
  documentStateMaxBytes,
} from "../packages/shared/dist/document-limits.js";
import * as Y from "yjs";

const roadmap =
  "# Priorisierte Verbesserungs-Roadmap (P0–P3)\n\n" +
  Array.from(
    { length: 180 },
    (_, i) => `## P${i % 4} — Verbesserung ${i + 1}

${"Ein klarer Arbeitsablauf verbindet **Kontext**, _Entscheidung_ und [Dokumentation](https://example.test/guide). ".repeat(5)}

- [ ] Änderung umsetzen
  - [x] Bestehende Inhalte und Überschriften erhalten
  - [ ] Zusammenarbeit und Speichern prüfen

| Bereich | Nächster Schritt |
| --- | --- |
| Editor | Große Dokumente bearbeiten |
| Betrieb | Verbindung wiederherstellen |

`,
  ).join("");
const countNodes = (node) =>
  1 + (node.content || []).reduce((n, child) => n + countNodes(child), 0);

async function fixture() {
  const registered = await request("auth/register", {
    method: "POST",
    body: { email: randomUUID() + "@example.test", password: randomUUID() },
  });
  const cookie = sessionCookie(registered.response);
  const space = (
    await request("spaces", {
      method: "POST",
      cookie,
      body: { name: "Product roadmap" },
    })
  ).data;
  const parent = (
    await request(`spaces/${space.id}/pages`, {
      method: "POST",
      cookie,
      body: { title: "Planung", kind: "folder" },
    })
  ).data;
  return { cookie, space, parent, path: `spaces/${space.id}/imports/markdown` };
}

test("formatted roadmaps exceed the old size/node budgets and round-trip through durable editor state", () => {
  const result = importMarkdown(roadmap, {
    filename: "Roadmap.md",
    titleFromHeading: true,
  });
  assert.ok(Buffer.byteLength(roadmap) > 96 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(result.document)) > 100000);
  assert.ok(countNodes(result.document) > 3000);
  const doc = documentToYDoc(result.document);
  try {
    assert.ok(Y.encodeStateAsUpdate(doc).byteLength < documentStateMaxBytes);
    assert.deepEqual(yDocToDocument(doc), result.document);
  } finally {
    doc.destroy();
  }
  const formatted = importMarkdown(
    "**strong** _italic_ [a link](https://example.test) ".repeat(1400),
    { filename: "Formatted.md", titleFromHeading: false },
  );
  assert.ok(countNodes(formatted.document) > 3000);
});

test("document budgets still reject excessive UTF-8 size, element count and nesting with specific errors", () => {
  assert.throws(
    () =>
      normalizeDocument({
        type: "doc",
        content: [
          { type: "paragraph", text: "😀".repeat(documentMaxBytes / 4) },
        ],
      }),
    /2 MB/,
  );
  assert.throws(
    () =>
      normalizeDocument({
        type: "doc",
        content: Array.from({ length: documentMaxNodes }, () => ({
          type: "paragraph",
        })),
      }),
    /20,000 elements/,
  );
  let nested = { type: "paragraph" };
  for (let i = 0; i < 65; i++)
    nested = { type: "blockquote", content: [nested] };
  assert.throws(
    () => normalizeDocument({ type: "doc", content: [nested] }),
    /64 levels/,
  );
});

test("large JSON Markdown reviews and confirmations retain all content without the former HTTP body ceiling", async () => {
  const f = await fixture();
  const input = {
    filename: "Roadmap.md",
    markdown: roadmap,
    titleFromHeading: true,
    parentId: f.parent.id,
  };
  const review = await request(f.path + "/preview", {
    method: "POST",
    cookie: f.cookie,
    body: input,
  });
  assert.equal(review.response.status, 201, JSON.stringify(review.data));
  const created = await request(f.path, {
    method: "POST",
    cookie: f.cookie,
    body: {
      input,
      previewToken: review.data.previewToken,
      requestId: randomUUID(),
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  assert.equal(
    created.data.document.content.filter((node) => node.type === "heading")
      .length,
    180,
  );
  assert.ok(JSON.stringify(created.data.document).includes("Verbesserung 180"));
});

test("Chromium: a complete roadmap imports, opens, edits, saves and reloads through collaboration", async () => {
  const f = await fixture();
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
  });
  const errors = [];
  try {
    await context.addCookies([
      { name: "orvyn_session", value: f.cookie.split("=")[1], url: base },
    ]);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base + "/?page=" + f.parent.id);
    await page
      .getByRole("button", { name: "Page actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", {
        name: "Import Markdown as subpage",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Import Markdown",
      exact: true,
    });
    await dialog
      .getByLabel("Choose a Markdown file", { exact: true })
      .setInputFiles({
        name: "Roadmap.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(roadmap),
      });
    await dialog
      .getByRole("button", { name: "Preview import", exact: true })
      .click();
    const review = page.getByRole("dialog", {
      name: "Review Markdown import",
      exact: true,
    });
    await expect(
      review.getByRole("heading", {
        name: "Priorisierte Verbesserungs-Roadmap (P0–P3)",
        exact: true,
      }),
    ).toBeVisible();
    await mkdir(".local/ui-review", { recursive: true });
    await page.screenshot({
      path: ".local/ui-review/roadmap-import-review.png",
    });
    await review
      .getByRole("button", { name: "Import page", exact: true })
      .click();
    const doc = page.getByRole("textbox", { name: "Document", exact: true });
    await expect(doc).toBeEditable({ timeout: 30000 });
    await expect(doc.locator("h2")).toHaveCount(180);
    await doc.locator("h2").first().click();
    await page.keyboard.press("Home");
    await page.keyboard.type("Geprueft: ");
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(doc).toBeEditable({ timeout: 30000 });
    await expect(doc.locator("h2").first()).toContainText("Geprueft: ");
    await expect(doc.locator("h2")).toHaveCount(180);
    await page.screenshot({
      path: ".local/ui-review/roadmap-import-editor.png",
    });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
  }
});

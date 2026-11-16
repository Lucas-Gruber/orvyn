import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateDocument,
  normalizeDocument,
  documentToYDoc,
  yDocToDocument,
  documentHeadings,
  pageLink,
  headingFromHash,
} from "../packages/editor/dist/index.js";
test("shared editor schema upgrades paragraphs, round-trips Yjs and rejects unsafe structures", () => {
  const doc = normalizeDocument({
    type: "doc",
    content: [{ type: "paragraph", text: "Existing content" }],
  });
  assert.deepEqual(doc, {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Existing content" }],
      },
    ],
  });
  const ydoc = documentToYDoc(doc);
  try {
    assert.deepEqual(yDocToDocument(ydoc), doc);
  } finally {
    ydoc.destroy();
  }
  const link = (href) => ({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Link",
            marks: [{ type: "link", attrs: { href } }],
          },
        ],
      },
    ],
  });
  assert.throws(
    () => validateDocument(link("javascript:alert(1)")),
    /Unsafe link/,
  );
  assert.throws(
    () => validateDocument(link("data:text/html,hello")),
    /Unsafe link/,
  );
  assert.doesNotThrow(() => validateDocument(link("https://example.test")));
  assert.throws(
    () =>
      validateDocument({
        type: "doc",
        content: [{ type: "heading", attrs: { level: 999 } }],
      }),
    /heading/,
  );
  assert.throws(
    () =>
      validateDocument({
        type: "doc",
        content: [
          {
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableCell",
                    attrs: { colspan: 1000000000 },
                    content: [{ type: "paragraph" }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    /span/,
  );
  assert.throws(() =>
    validateDocument({ type: "doc", content: [{ type: "unknown" }] }),
  );
});

test("heading identities survive Yjs and renames, legacy anchors are deterministic and malformed anchors are rejected", () => {
  const id = "c6df12f0-44c7-4c71-9c47-5b1a4dc5bd1e";
  const doc = normalizeDocument({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2, id },
        content: [{ type: "text", text: "Übersicht" }],
      },
      {
        type: "heading",
        attrs: { level: 3 },
        content: [{ type: "text", text: "Repeated" }],
      },
      {
        type: "heading",
        attrs: { level: 3 },
        content: [{ type: "text", text: "Repeated" }],
      },
    ],
  });
  const targets = documentHeadings(doc),
    ydoc = documentToYDoc(doc);
  try {
    assert.deepEqual(documentHeadings(yDocToDocument(ydoc)), targets);
  } finally {
    ydoc.destroy();
  }
  assert.equal(targets[0].id, id);
  assert.notEqual(targets[1].id, targets[2].id);
  doc.content[0].content[0].text = "Renamed heading";
  assert.equal(documentHeadings(doc)[0].id, id);
  const link = pageLink(id, targets[1].id);
  assert.equal(
    new URL(link, "https://example.test").searchParams.get("page"),
    id,
  );
  assert.equal(
    headingFromHash(new URL(link, "https://example.test").hash),
    targets[1].id,
  );
  assert.equal(headingFromHash('#h-"><script>'), "");
  for (const bad of [123, "", "x".repeat(4000), 'x" onclick="alert(1)'])
    assert.throws(
      () =>
        validateDocument({
          type: "doc",
          content: [{ type: "heading", attrs: { level: 1, id: bad } }],
        }),
      /anchor/,
    );
});

test("linked database references round-trip through Yjs and reject unsafe identifiers", () => {
  const databaseId = "1b4a872d-8b47-482f-9daa-2a32fb390674",
    viewId = "b7dd873f-d427-4853-a5c9-3867edb784e2";
  const document = {
    type: "doc",
    content: [{ type: "orvynDatabase", attrs: { databaseId, viewId } }],
  };
  const ydoc = documentToYDoc(document);
  try {
    assert.deepEqual(
      JSON.parse(JSON.stringify(yDocToDocument(ydoc))),
      document,
    );
  } finally {
    ydoc.destroy();
  }
  for (const attrs of [
    { databaseId: "javascript:alert(1)", viewId },
    { databaseId, viewId: "not-a-view" },
    { databaseId: null, viewId: null },
  ])
    assert.throws(
      () =>
        validateDocument({
          type: "doc",
          content: [{ type: "orvynDatabase", attrs }],
        }),
      /database block reference/,
    );
});

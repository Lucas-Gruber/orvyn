import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateDocument,
  normalizeDocument,
  documentToYDoc,
  yDocToDocument,
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

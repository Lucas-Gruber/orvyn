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

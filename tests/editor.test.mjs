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
  columnWidths,
  resizeColumnPair,
} from "../packages/editor/dist/index.js";
import {
  parseVideoUrl,
  videoSource,
} from "../packages/editor/dist/embed-model.js";
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

test("H4 headings round-trip through Yjs with stable anchors while levels above H4 remain invalid", () => {
  const id = "f618bfad-5f6a-4a2d-b030-7c791a640c62",
    document = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 4, id },
          content: [{ type: "text", text: "Detailed notes" }],
        },
      ],
    },
    normalized = normalizeDocument(document),
    ydoc = documentToYDoc(normalized);
  try {
    assert.deepEqual(yDocToDocument(ydoc), normalized);
    assert.deepEqual(documentHeadings(yDocToDocument(ydoc)), [
      { id, level: 4, text: "Detailed notes" },
    ]);
  } finally {
    ydoc.destroy();
  }
  for (const level of [0, 5, 6, 999, "4"])
    assert.throws(
      () =>
        validateDocument({
          ...document,
          content: [{ ...document.content[0], attrs: { level, id } }],
        }),
      /heading/,
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
test("structured editor blocks round-trip nested content and reject invalid callout/toggle structures", () => {
  const doc = normalizeDocument({
    type: "doc",
    content: [
      {
        type: "orvynCallout",
        attrs: { tone: "warning" },
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Keep this exact text" }],
          },
        ],
      },
      {
        type: "orvynToggle",
        content: [
          {
            type: "orvynToggleSummary",
            content: [{ type: "text", text: "Details" }],
          },
          {
            type: "orvynToggleContent",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Nested body" }],
              },
            ],
          },
        ],
      },
      { type: "orvynToc" },
      {
        type: "codeBlock",
        attrs: { language: "javascript" },
        content: [
          { type: "text", text: 'const text = "<script> stays code";' },
        ],
      },
    ],
  });
  const ydoc = documentToYDoc(doc);
  try {
    assert.deepEqual(yDocToDocument(ydoc), doc);
  } finally {
    ydoc.destroy();
  }
  for (const content of [
    [
      {
        type: "orvynCallout",
        attrs: { tone: "url(javascript:alert(1))" },
        content: [{ type: "paragraph" }],
      },
    ],
    [{ type: "orvynToggle", content: [{ type: "paragraph" }] }],
    [
      {
        type: "orvynToggleSummary",
        content: [{ type: "text", text: "Standalone" }],
      },
    ],
    [{ type: "orvynToc", content: [{ type: "paragraph" }] }],
  ])
    assert.throws(() => validateDocument({ type: "doc", content }));
});
test("attachment blocks preserve IDs and labels without accepting external image sources", () => {
  const id = "7782bfa8-5549-4f32-8d2f-8abc5edc4b33",
    doc = normalizeDocument({
      type: "doc",
      content: [
        {
          type: "orvynImage",
          attrs: {
            fileId: id,
            label: "<script> is a label",
            src: "https://tracking.example/image.png",
          },
        },
        { type: "orvynFile", attrs: { fileId: id, label: "Read me" } },
      ],
    });
  assert.deepEqual(
    { ...doc.content[0].attrs },
    {
      fileId: id,
      label: "<script> is a label",
    },
  );
  const ydoc = documentToYDoc(doc);
  try {
    assert.deepEqual(yDocToDocument(ydoc), doc);
  } finally {
    ydoc.destroy();
  }
  for (const attrs of [
    { fileId: "javascript:alert(1)" },
    { fileId: id, label: "a".repeat(501) },
    { fileId: id, label: 123 },
  ])
    assert.throws(
      () =>
        validateDocument({
          type: "doc",
          content: [{ type: "orvynImage", attrs }],
        }),
      /attachment block/,
    );
});
test("page preview nodes round-trip references without embedding destination content", () => {
  const pageId = "e199da77-1d93-4aa1-bac9-e29888aa0ee7",
    headingId = "05452401-b3f4-42d0-9e98-a584bb192b24",
    doc = normalizeDocument({
      type: "doc",
      content: [
        {
          type: "orvynPagePreview",
          attrs: {
            pageId,
            headingId,
            title: "Must not persist cached private metadata",
          },
        },
      ],
    });
  assert.deepEqual({ ...doc.content[0].attrs }, { pageId, headingId });
  const ydoc = documentToYDoc(doc);
  try {
    assert.deepEqual(yDocToDocument(ydoc), doc);
  } finally {
    ydoc.destroy();
  }
  for (const attrs of [{ pageId: "bad" }, { pageId, headingId: '"><script>' }])
    assert.throws(
      () =>
        validateDocument({
          type: "doc",
          content: [{ type: "orvynPagePreview", attrs }],
        }),
      /preview/,
    );
});
test("video embeds allow only canonical provider resource IDs and never arbitrary iframe URLs", () => {
  const id = "AbCdEf012_-";
  for (const href of [
    "https://youtu.be/" + id,
    "https://www.youtube.com/watch?v=" + id + "&tracking=discard",
    "https://www.youtube-nocookie.com/embed/" + id,
  ])
    assert.deepEqual(parseVideoUrl(href), {
      provider: "youtube",
      resourceId: id,
    });
  assert.equal(
    videoSource("youtube", id),
    "https://www.youtube-nocookie.com/embed/" + id,
  );
  assert.deepEqual(parseVideoUrl("https://vimeo.com/123456789"), {
    provider: "vimeo",
    resourceId: "123456789",
  });
  assert.deepEqual(
    parseVideoUrl("https://www.loom.com/share/" + "a".repeat(32)),
    { provider: "loom", resourceId: "a".repeat(32) },
  );
  for (const href of [
    "http://youtube.com/watch?v=" + id,
    "https://youtube.com.evil.test/watch?v=" + id,
    "https://youtube.com@127.0.0.1/watch?v=" + id,
    "https://127.0.0.1/",
    "javascript:alert(1)",
    "data:text/html,iframe",
    "https://vimeo.com/123?h=private",
    "https://www.youtube.com:444/watch?v=" + id,
  ])
    assert.equal(parseVideoUrl(href), null);
  const doc = normalizeDocument({
      type: "doc",
      content: [
        {
          type: "orvynVideo",
          attrs: {
            provider: "youtube",
            resourceId: id,
            title: "A video",
            src: "https://evil.test",
          },
        },
      ],
    }),
    ydoc = documentToYDoc(doc);
  try {
    assert.deepEqual(yDocToDocument(ydoc), doc);
  } finally {
    ydoc.destroy();
  }
  assert.ok(!JSON.stringify(doc).includes("evil.test"));
  for (const attrs of [
    { provider: "unknown", resourceId: id },
    { provider: "youtube", resourceId: '"><script>' },
    { provider: "vimeo", resourceId: "123", title: "a".repeat(161) },
  ])
    assert.throws(
      () =>
        validateDocument({
          type: "doc",
          content: [{ type: "orvynVideo", attrs }],
        }),
      /video embed/,
    );
});
test("columns preserve nested blocks and reject invalid column counts and standalone cells", () => {
  const cell = (text) => ({
    type: "orvynColumn",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  const doc = normalizeDocument({
      type: "doc",
      content: [
        { type: "orvynColumns", content: [cell("Left"), cell("Right")] },
        {
          type: "orvynColumns",
          content: [cell("One"), cell("Two"), cell("Three")],
        },
      ],
    }),
    ydoc = documentToYDoc(doc);
  try {
    assert.deepEqual(yDocToDocument(ydoc), doc);
  } finally {
    ydoc.destroy();
  }
  for (const content of [
    [cell("Invalid")],
    [{ type: "orvynColumns", content: [cell("One")] }],
    [
      {
        type: "orvynColumns",
        content: Array.from({ length: 4 }, () => cell("Too many")),
      },
    ],
  ])
    assert.throws(() => validateDocument({ type: "doc", content }));
});

test("column widths round-trip through Yjs, bound adjacent resizing and reject malformed layouts", () => {
  const layout = (widths) => ({
    type: "doc",
    content: [
      {
        type: "orvynColumns",
        attrs: { widths },
        content: [
          { type: "orvynColumn", content: [{ type: "paragraph" }] },
          { type: "orvynColumn", content: [{ type: "paragraph" }] },
        ],
      },
    ],
  });
  const normalized = validateDocument(layout([6700, 3300]));
  const ydoc = documentToYDoc(normalized);
  try {
    assert.deepEqual(yDocToDocument(ydoc), normalized);
  } finally {
    ydoc.destroy();
  }
  assert.equal(validateDocument(layout(null)).content[0].attrs.widths, null);
  for (const invalid of [
    [10000],
    [5000, 5000, 0],
    [0, 10000],
    [1499, 8501],
    [5000, 5001],
    [5000.5, 4999.5],
    ["5000", 5000],
    "50%",
    {},
    [],
  ])
    assert.throws(
      () => validateDocument(layout(invalid)),
      /layout column widths/,
    );
  assert.deepEqual(columnWidths(null, 3), [3333, 3334, 3333]);
  assert.deepEqual(
    resizeColumnPair([3000, 4000, 3000], 0, 9900),
    [5500, 1500, 3000],
  );
  assert.deepEqual(
    resizeColumnPair([3000, 4000, 3000], 1, -10),
    [3000, 1500, 5500],
  );
  assert.deepEqual(resizeColumnPair([5000, 5000], 0, NaN), [5000, 5000]);
});

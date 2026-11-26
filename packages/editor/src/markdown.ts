import { createHash } from "node:crypto";
import { normalizeDocument } from "./index.js";
import {
  parseMarkdown,
  markdownImportPreviewId,
  type MarkdownImportOptions,
} from "./markdown-parser.js";
export { markdownImportPreviewId } from "./markdown-parser.js";
export type { MarkdownImportOptions } from "./markdown-parser.js";

type Node = {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: Node[];
};

export function bindMarkdownDocument(document: unknown, pageId: string) {
  const result = structuredClone(document) as Node;
  function walk(node: Node) {
    for (const mark of node.marks || []) {
      const href = mark.attrs?.href;
      if (
        mark.type === "link" &&
        typeof href === "string" &&
        (href === "?page=" + markdownImportPreviewId ||
          href.startsWith("?page=" + markdownImportPreviewId + "#h-"))
      )
        mark.attrs = {
          ...mark.attrs,
          href:
            "/?page=" +
            pageId +
            href.slice(("?page=" + markdownImportPreviewId).length),
        };
    }
    node.content?.forEach(walk);
  }
  walk(result);
  return normalizeDocument(result);
}

export function importMarkdown(source: string, options: MarkdownImportOptions) {
  const result = parseMarkdown(source, options, {
    headingId(index) {
      const hex = createHash("sha256")
        .update(source + "\0" + index)
        .digest("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    },
  });
  return { ...result, document: normalizeDocument(result.document) };
}

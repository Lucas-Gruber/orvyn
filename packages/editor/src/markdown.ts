import { createHash } from "node:crypto";
import {
  lexer,
  type Token,
  type Tokens,
  type MarkedToken as KnownToken,
} from "marked";
import { decodeHTML } from "entities";
import { normalizeDocument } from "./index.js";

type Node = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Mark[];
  content?: Node[];
};
type Mark = { type: string; attrs?: Record<string, unknown> };
export interface MarkdownImportOptions {
  filename: string;
  title?: string;
  titleFromHeading: boolean;
}
export const markdownImportPreviewId = "00000000-0000-4000-8000-000000000001";
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
  if (
    !source.trim() ||
    Buffer.byteLength(source, "utf8") > 32768 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source)
  )
    throw Error("Choose a non-empty Markdown text file up to 32 KB.");
  const warnings = new Set<string>(),
    tokens = lexer(source.replace(/^\uFEFF/, ""), { gfm: true }),
    ids = new WeakMap<Token, string>(),
    anchors = new Map<string, string>(),
    slugs = new Map<string, number>();
  let remaining = 6000,
    headingIndex = 0;
  const first = tokens.find((token) => token.type !== "space");
  const titleHeading =
    options.titleFromHeading && first?.type === "heading" && first.depth === 1
      ? (first as Tokens.Heading)
      : null;
  function bounded(depth: number) {
    if (--remaining < 0 || depth > 48)
      throw Error("The Markdown contains too many blocks or nested elements.");
  }
  function plain(items: Token[]): string {
    return items
      .map((token) =>
        "tokens" in token && token.tokens
          ? plain(token.tokens)
          : "text" in token
            ? token.type === "codespan"
              ? token.text
              : decodeHTML(token.text)
            : "",
      )
      .join("");
  }
  function headings(items: Token[], depth = 0) {
    bounded(depth);
    for (const raw of items) {
      const token = raw as KnownToken;
      if (token.type === "heading") {
        const text = plain(token.tokens),
          base = text
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s_-]/gu, "")
            .trim()
            .replace(/\s+/g, "-"),
          count = slugs.get(base) || 0,
          slug = base + (count ? "-" + count : ""),
          hex = createHash("sha256")
            .update(source + "\0" + headingIndex++)
            .digest("hex"),
          id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
        slugs.set(base, count + 1);
        ids.set(token, id);
        anchors.set(
          slug,
          "?page=" +
            markdownImportPreviewId +
            (token === titleHeading ? "" : "#h-" + id),
        );
      }
      if (token.type === "blockquote") headings(token.tokens, depth + 1);
      if (token.type === "list")
        for (const item of token.items) headings(item.tokens, depth + 1);
    }
  }
  headings(tokens);
  function href(raw: string): string | undefined {
    const value = decodeHTML(raw).trim();
    if (value.startsWith("#")) {
      let slug = value.slice(1);
      try {
        slug = decodeURIComponent(slug);
      } catch {}
      const resolved = anchors.get(slug.toLowerCase());
      if (resolved) return resolved;
      warnings.add("Links to missing headings are kept as plain text.");
      return;
    }
    try {
      const url = new URL(value);
      if (["https:", "http:", "mailto:", "tel:"].includes(url.protocol))
        return url.toString();
    } catch {}
    warnings.add(
      "Relative file links and unsupported link targets are kept as plain text.",
    );
  }
  function inline(items: Token[], marks: Mark[] = [], depth = 0): Node[] {
    bounded(depth);
    return items.flatMap((raw): Node[] => {
      const token = raw as KnownToken;
      bounded(depth);
      const text = (value: string, active = marks): Node[] =>
        value
          ? [
              {
                type: "text",
                text: value,
                ...(active.length ? { marks: active } : {}),
              },
            ]
          : [];
      if (
        token.type === "strong" ||
        token.type === "em" ||
        token.type === "del"
      )
        return inline(
          token.tokens,
          [
            ...marks,
            {
              type: { strong: "bold", em: "italic", del: "strike" }[token.type],
            },
          ],
          depth + 1,
        );
      if (token.type === "link") {
        const target = href(token.href);
        return inline(
          token.tokens,
          target
            ? [
                ...marks,
                {
                  type: "link",
                  attrs: {
                    href: target,
                    target: "_blank",
                    rel: "noopener noreferrer nofollow",
                  },
                },
              ]
            : marks,
          depth + 1,
        );
      }
      if (token.type === "image") {
        warnings.add(
          "Images are imported as text links. Upload attachments separately after importing.",
        );
        const target = href(token.href);
        return text(
          "[Image: " +
            decodeHTML(token.text || "image") +
            (target ? "" : " · " + token.href) +
            "]",
          target
            ? [...marks, { type: "link", attrs: { href: target } }]
            : marks,
        );
      }
      if (token.type === "codespan")
        return text(token.text, [{ type: "code" }]);
      if (token.type === "checkbox") return [];
      if (token.type === "br") return [{ type: "hardBreak" }];
      if (token.type === "html") {
        warnings.add(
          "HTML is preserved as visible text, without running scripts or embeds.",
        );
        return text(token.text);
      }
      if (token.type === "text" && token.tokens)
        return inline(token.tokens, marks, depth + 1);
      if ("text" in token) return text(decodeHTML(token.text));
      return text(token.raw);
    });
  }
  const paragraph = (content: Node[] = []): Node => ({
    type: "paragraph",
    content,
  });
  function list(token: Tokens.List, depth: number): Node[] {
    const groups: Node[] = [];
    let previous = "",
      current: Node | undefined;
    for (const [index, item] of token.items.entries()) {
      const kind = item.task
        ? "taskList"
        : token.ordered
          ? "orderedList"
          : "bulletList";
      if (kind !== previous) {
        current = {
          type: kind,
          ...(kind === "orderedList"
            ? {
                attrs: {
                  start:
                    (typeof token.start === "number" ? token.start : 1) + index,
                },
              }
            : {}),
          content: [],
        };
        groups.push(current);
        previous = kind;
      }
      const content = blocks(item.tokens, depth + 1);
      if (content[0]?.type !== "paragraph") content.unshift(paragraph());
      current!.content!.push({
        type: item.task ? "taskItem" : "listItem",
        ...(item.task ? { attrs: { checked: !!item.checked } } : {}),
        content,
      });
    }
    return groups;
  }
  function blocks(items: Token[], depth = 0): Node[] {
    bounded(depth);
    return items.flatMap((raw): Node[] => {
      const token = raw as KnownToken;
      bounded(depth);
      if (
        token === titleHeading ||
        token.type === "space" ||
        token.type === "checkbox" ||
        token.type === "def"
      )
        return [];
      if (token.type === "heading") {
        if (token.depth > 4)
          warnings.add("Heading levels 5 and 6 use Orvyn’s heading level 4.");
        return [
          {
            type: "heading",
            attrs: { level: Math.min(4, token.depth), id: ids.get(token) },
            content: inline(token.tokens),
          },
        ];
      }
      if (token.type === "paragraph" || token.type === "text")
        return [
          paragraph(
            token.tokens
              ? inline(token.tokens)
              : [{ type: "text", text: decodeHTML(token.text) }],
          ),
        ];
      if (token.type === "hr") return [{ type: "horizontalRule" }];
      if (token.type === "blockquote")
        return [
          { type: "blockquote", content: blocks(token.tokens, depth + 1) },
        ];
      if (token.type === "list") return list(token, depth + 1);
      if (token.type === "code" || token.type === "html") {
        if (token.type === "html")
          warnings.add(
            "HTML is preserved as visible text, without running scripts or embeds.",
          );
        const lang =
          token.type === "code"
            ? token.lang?.split(/\s+/)[0] || "plaintext"
            : "html";
        // Marked includes the fence separator when a blank trailing line is
        // present. The editor stores the code itself, without that separator.
        const codeText =
          token.type === "code" && token.codeBlockStyle !== "indented"
            ? token.text.replace(/\n$/, "")
            : token.text;
        return [
          {
            type: "codeBlock",
            attrs: {
              language: /^[a-zA-Z0-9+#._-]{1,40}$/.test(lang)
                ? lang
                : "plaintext",
            },
            content: codeText ? [{ type: "text", text: codeText }] : [],
          },
        ];
      }
      if (token.type === "table") {
        const row = (cells: Tokens.TableCell[], header: boolean): Node => ({
          type: "tableRow",
          content: token.header.map((_, index) => ({
            type: header ? "tableHeader" : "tableCell",
            content: [
              paragraph(cells[index] ? inline(cells[index].tokens) : []),
            ],
          })),
        });
        if (token.align.some(Boolean))
          warnings.add("Table text alignment uses Orvyn’s default alignment.");
        return [
          {
            type: "table",
            content: [
              row(token.header, true),
              ...token.rows.map((cells) => row(cells, false)),
            ],
          },
        ];
      }
      warnings.add("An unsupported Markdown block is preserved as text.");
      return [paragraph([{ type: "text", text: token.raw }])];
    });
  }
  const fallback = options.filename
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)!
      .replace(/\.(?:md|markdown)$/i, "")
      .trim(),
    title =
      options.title?.trim() ||
      (titleHeading ? plain(titleHeading.tokens).trim() : "") ||
      fallback ||
      "Imported page";
  if (title.length > 300)
    throw Error("Choose a page title up to 300 characters.");
  const content = blocks(tokens);
  const document = normalizeDocument({
    type: "doc",
    content: content.length ? content : [paragraph()],
  });
  return { title, document, warnings: [...warnings] };
}

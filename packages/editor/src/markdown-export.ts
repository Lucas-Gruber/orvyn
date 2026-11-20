import { normalizeDocument } from "./index.js";
import { documentHeadings } from "./links.js";
import {
  markdownImportMaxBytes,
  markdownImportSizeLabel,
} from "@orvyn/shared/markdown-limits";

interface Node {
  type: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: { type: string; attrs?: Record<string, any> }[];
  content?: Node[];
}
export interface MarkdownExportContext {
  title: string;
  pageUrl: string;
  page: (
    id: string,
    headingId?: string,
  ) => { title: string; href: string } | undefined;
  file: (
    id: string,
    image?: boolean,
  ) => { label: string; href: string } | undefined;
  person: (id: string) => string | undefined;
  includePeopleNames: boolean;
}

export function exportMarkdown(input: unknown, context: MarkdownExportContext) {
  const document = normalizeDocument(input) as Node,
    warnings = new Set<string>(),
    slugs = new Map<string, number>(),
    headingSlugs = new Map<string, string>(),
    headings = documentHeadings(document),
    pageUrl = new URL(context.pageUrl);
  const exportTitle =
    context.title.replace(/[\t\r\n]+/g, " ").trim() || "Untitled";
  if (exportTitle !== context.title)
    warnings.add(
      "Line breaks or tabs in the page title use spaces in Markdown.",
    );
  let headingIndex = 0;
  function person(id: string) {
    const label = context.includePeopleNames ? context.person(id) : undefined;
    if (!label)
      warnings.add(
        "People without an included current name are exported as @person.",
      );
    return "@" + (label || "person");
  }
  function plain(node: Node): string {
    if (node.type === "orvynPerson") return person(node.attrs?.userId);
    return node.text || (node.content || []).map(plain).join("");
  }
  function slug(text: string) {
    const base = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .trim()
        .replace(/\s+/g, "-"),
      count = slugs.get(base) || 0;
    slugs.set(base, count + 1);
    return base + (count ? "-" + count : "");
  }
  slug(exportTitle);
  function collect(node: Node) {
    if (node.type === "heading") {
      const heading = headings[headingIndex++];
      if (heading) headingSlugs.set(heading.id, slug(plain(node)));
    }
    node.content?.forEach(collect);
  }
  collect(document);
  function text(value: string) {
    return value
      .replace(/[\\`*_[\]{}!#~|]/g, "\\$&")
      .replace(/^(\s*)([-+])(?=[\s+-])/gm, "$1\\$2")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/^(\s*\d+)\./gm, "$1\\.")
      .replace(/^ {4,}/gm, (spaces) => "&#32;".repeat(spaces.length));
  }
  function href(value: unknown): string | undefined {
    if (typeof value !== "string") return;
    try {
      const url = new URL(value, pageUrl);
      if (!["http:", "https:", "mailto:", "tel:"].includes(url.protocol))
        return;
      const id =
        url.origin === pageUrl.origin && url.pathname === "/"
          ? url.searchParams.get("page")
          : null;
      if (id && id === pageUrl.searchParams.get("page")) {
        const heading = url.hash.startsWith("#h-") ? url.hash.slice(3) : "";
        if (headingSlugs.has(heading)) return "#" + headingSlugs.get(heading);
        if (heading)
          warnings.add(
            "An unavailable heading link points to its page instead.",
          );
        return (
          "#" +
          exportTitle
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s_-]/gu, "")
            .trim()
            .replace(/\s+/g, "-")
        );
      }
      if (id) {
        const heading = url.hash.startsWith("#h-") ? url.hash.slice(3) : "",
          target = context.page(id, heading);
        if (!target) {
          warnings.add(
            "Links to unavailable pages are exported as plain text.",
          );
          return;
        }
        if (heading && new URL(target.href).hash !== url.hash)
          warnings.add(
            "An unavailable heading link points to its page instead.",
          );
        return target.href;
      }
      return url.toString();
    } catch {
      return;
    }
  }
  function link(label: string, url: string) {
    return (
      "[" +
      label +
      "](<" +
      url.replace(/[<>\s\\]/g, (value) => encodeURIComponent(value)) +
      ">)"
    );
  }
  function inline(node: Node, tableCell = false): string {
    if (node.type === "hardBreak") return "  \n";
    if (node.type === "orvynPerson") return text(person(node.attrs?.userId));
    if (node.type !== "text")
      return (node.content || [])
        .map((child) => inline(child, tableCell))
        .join("");
    let value = text(node.text || "");
    const code = node.marks?.some((mark) => mark.type === "code");
    if (code && tableCell && /\\\|/.test(node.text || "")) {
      warnings.add(
        "Code with backslashes before pipes in table cells is exported as ordinary text.",
      );
      value = text(node.text || "");
    } else if (code) {
      const raw = node.text || "",
        longest = Math.max(
          0,
          ...(raw.match(/`+/g) || []).map((part) => part.length),
        ),
        fence = "`".repeat(longest + 1),
        pad = !/^\s*$/.test(raw) && /^[`\s]|[`\s]$/.test(raw) ? " " : "";
      value = fence + pad + raw.replace(/\r?\n/g, " ") + pad + fence;
    } else {
      for (const mark of node.marks || []) {
        const delimiter = { bold: "**", italic: "_", strike: "~~" }[
          mark.type as "bold" | "italic" | "strike"
        ];
        if (delimiter)
          value = value.replace(
            /^(\s*)(.*?)(\s*)$/s,
            (_match, leading: string, body: string, trailing: string) =>
              body ? leading + delimiter + body + delimiter + trailing : value,
          );
        if (mark.type === "underline")
          warnings.add(
            "Underlined text keeps its text without underline formatting.",
          );
      }
    }
    const mark = node.marks?.find((mark) => mark.type === "link"),
      target = mark && href(mark.attrs?.href);
    return target ? link(value, target) : value;
  }
  function list(node: Node, tableCell = false): string {
    return (node.content || [])
      .map((item, index) => {
        const prefix =
            node.type === "orderedList"
              ? String((node.attrs?.start || 1) + index) + ". "
              : node.type === "taskList"
                ? "- [" + (item.attrs?.checked ? "x" : " ") + "] "
                : "- ",
          body = blocks(item.content || [], tableCell).replace(/\n+$/, ""),
          indent = " ".repeat(node.type === "taskList" ? 2 : prefix.length);
        return (
          prefix +
          body
            .split("\n")
            .map((line, i) => (i ? indent + line : line))
            .join("\n")
        );
      })
      .join("\n");
  }
  function table(node: Node): string {
    const rows = node.content || [],
      grid: string[][] = [],
      occupied = new Map<number, number>();
    let width = 0;
    for (const [rowIndex, row] of rows.entries()) {
      const line: string[] = [];
      let column = 0;
      for (const cell of row.content || []) {
        while ((occupied.get(column) || 0) > rowIndex) line[column++] = "";
        const colspan = cell.attrs?.colspan || 1,
          rowspan = cell.attrs?.rowspan || 1;
        if (colspan > 1 || rowspan > 1)
          warnings.add(
            "Merged table cells expand into an ordinary Markdown grid.",
          );
        if (column + colspan > 100) {
          warnings.add("A very wide table is exported as readable row lists.");
          return rows
            .map(
              (row) =>
                "- " +
                (row.content || [])
                  .map((cell) => blocks(cell.content || [], true).trim())
                  .join(" · "),
            )
            .join("\n");
        }
        const content = blocks(cell.content || [], true).trim();
        if (content.includes("\n"))
          warnings.add(
            "Multiple lines inside table cells become one readable line.",
          );
        if (cell.attrs?.align)
          warnings.add("Table text alignment uses the Markdown default.");
        let escaped = "",
          slashes = 0;
        for (const character of content.replace(/\n+/g, " / ")) {
          if (character === "|" && slashes % 2 === 0) escaped += "\\";
          escaped += character;
          slashes = character === "\\" ? slashes + 1 : 0;
        }
        line[column] = escaped;
        for (let offset = 0; offset < colspan; offset++) {
          if (offset) line[column + offset] = "";
          if (rowspan > 1) occupied.set(column + offset, rowIndex + rowspan);
        }
        column += colspan;
      }
      width = Math.max(
        width,
        column,
        ...[...occupied]
          .filter(([, end]) => end > rowIndex)
          .map(([column]) => column + 1),
      );
      grid.push(line);
    }
    if (!grid.length || !width) return "";
    const render = (row: string[]) =>
      "| " +
      Array.from({ length: width }, (_, column) => row[column] || "").join(
        " | ",
      ) +
      " |";
    if (!rows[0]?.content?.every((cell) => cell.type === "tableHeader")) {
      warnings.add(
        "A table without a header uses an empty Markdown header row.",
      );
      grid.unshift([]);
    }
    return [
      render(grid[0]!),
      render(Array.from({ length: width }, () => "---")),
      ...grid.slice(1).map(render),
    ].join("\n");
  }
  function block(node: Node, tableCell = false): string {
    const children = node.content || [];
    switch (node.type) {
      case "paragraph":
        return inline(node, tableCell);
      case "heading":
        return (
          "#".repeat(node.attrs?.level || 1) + " " + inline(node, tableCell)
        );
      case "bulletList":
      case "orderedList":
      case "taskList":
        return list(node, tableCell);
      case "blockquote":
        return blocks(children, tableCell)
          .trimEnd()
          .split("\n")
          .map((line) => ">" + (line ? " " + line : ""))
          .join("\n");
      case "horizontalRule":
        return "---";
      case "codeBlock": {
        const raw = children.map((node) => node.text || "").join(""),
          length = Math.max(
            3,
            ...[...(raw.match(/`+/g) || [])].map((run) => run.length + 1),
          ),
          fence = "`".repeat(length);
        return (
          fence +
          (node.attrs?.language && node.attrs.language !== "plaintext"
            ? node.attrs.language
            : "") +
          "\n" +
          raw +
          "\n" +
          fence
        );
      }
      case "table":
        return table(node);
      case "orvynImage":
      case "orvynFile": {
        const file = context.file(
          node.attrs?.fileId,
          node.type === "orvynImage",
        );
        if (!file) {
          warnings.add(
            "Unavailable images or attachments have no exported link.",
          );
          return node.type === "orvynImage"
            ? "Image unavailable"
            : "Attachment unavailable";
        }
        warnings.add(
          "Attachment links require current access and a sign-in to Orvyn; file bytes are separate.",
        );
        const label = text(node.attrs?.label || file.label);
        return (node.type === "orvynImage" ? "!" : "") + link(label, file.href);
      }
      case "orvynPagePreview":
      case "orvynDatabase":
      case "orvynWhiteboard": {
        const page = context.page(
          node.attrs?.pageId || node.attrs?.databaseId,
          node.attrs?.headingId,
        );
        if (page && node.attrs?.headingId && !new URL(page.href).hash)
          warnings.add(
            "An unavailable heading link points to its page instead.",
          );
        warnings.add(
          "Linked page, database and whiteboard blocks become links without copying their content.",
        );
        return page
          ? link(text(page.title), href(page.href) || page.href)
          : "Linked content unavailable";
      }
      case "orvynVideo": {
        warnings.add("Video embeds become ordinary links.");
        const { provider, resourceId } = node.attrs || {},
          target =
            provider === "youtube"
              ? "https://www.youtube.com/watch?v=" + resourceId
              : provider === "vimeo"
                ? "https://vimeo.com/" + resourceId
                : "https://www.loom.com/share/" + resourceId;
        return link(text(node.attrs?.title || "Video"), target);
      }
      case "orvynColumns":
        warnings.add("Columns are exported in reading order.");
        return children
          .map((node) => blocks(node.content || [], tableCell))
          .join("\n\n");
      case "orvynCallout":
        warnings.add("Callouts become quoted text.");
        return blocks(children, tableCell)
          .trimEnd()
          .split("\n")
          .map((line) => ">" + (line ? " " + line : ""))
          .join("\n");
      case "orvynToggle":
        warnings.add("Collapsible sections are exported expanded.");
        return (
          "**" +
          inline(children[0] || { type: "paragraph" }, tableCell) +
          "**\n\n" +
          blocks(children[1]?.content || [], tableCell)
        );
      case "orvynToc": {
        warnings.add("The table of contents becomes a static heading list.");
        const levels: number[] = [];
        return headings
          .map((heading) => {
            while (levels.length && levels[levels.length - 1]! >= heading.level)
              levels.pop();
            const indent = "  ".repeat(levels.length);
            levels.push(heading.level);
            return (
              indent +
              "- " +
              link(
                text(heading.text || "Untitled heading"),
                "#" + headingSlugs.get(heading.id),
              )
            );
          })
          .join("\n");
      }
      default:
        return blocks(children, tableCell);
    }
  }
  function blocks(nodes: Node[], tableCell = false): string {
    return nodes.map((node) => block(node, tableCell)).join("\n\n");
  }
  const markdown =
    "# " +
    text(exportTitle) +
    "\n\n" +
    blocks(document.content || []).replace(/\n+$/, "") +
    "\n";
  const bytes = Buffer.byteLength(markdown);
  if (bytes > 1024 * 1024)
    throw Error("This page is too large to export as Markdown.");
  if (bytes > markdownImportMaxBytes)
    warnings.add(
      "This file exceeds Orvyn’s current " +
        markdownImportSizeLabel +
        " Markdown import limit. Use a Markdown editor or split the file before reimporting.",
    );
  return { markdown, warnings: [...warnings] };
}

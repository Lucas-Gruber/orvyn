import { randomUUID } from "node:crypto";
import { normalizeDocument } from "@orvyn/editor";
import {
  documentHeadings,
  headingFromHash,
  pageLink,
} from "@orvyn/editor/links";

export function cloneTemplateDocument(
  input: unknown,
  sourcePageId: string,
  targetPageId: string,
  files: Map<string, string>,
  eligiblePeople: Set<string>,
  origin: string,
) {
  const source = normalizeDocument(input),
    headings = documentHeadings(source),
    nextHeadings = headings.map(() => randomUUID()),
    anchors = new Map<string, string>(),
    base = new URL(origin);
  headings.forEach((h, i) => {
    if (!anchors.has(h.id)) anchors.set(h.id, nextHeadings[i]!);
  });
  let index = 0,
    omittedPeople = 0;
  function href(value: string) {
    try {
      const url = new URL(value, base),
        page = url.searchParams.get("page"),
        heading = headingFromHash(url.hash);
      if (
        url.origin === base.origin &&
        url.pathname === "/" &&
        (page === sourcePageId || (!page && value.startsWith("#h-") && heading))
      )
        return pageLink(targetPageId, anchors.get(heading) || heading);
    } catch {
      /* Keep validated external links verbatim. */
    }
    return value;
  }
  function walk(node: any): any {
    let next = structuredClone(node);
    if (next.type === "heading")
      next.attrs = { ...next.attrs, id: nextHeadings[index++] };
    if (["orvynImage", "orvynFile"].includes(next.type)) {
      const fileId = files.get(next.attrs.fileId);
      if (!fileId) throw new Error("A template attachment is unavailable.");
      next.attrs.fileId = fileId;
    }
    if (
      next.type === "orvynPagePreview" &&
      next.attrs.pageId === sourcePageId
    ) {
      next.attrs.pageId = targetPageId;
      if (next.attrs.headingId)
        next.attrs.headingId =
          anchors.get(next.attrs.headingId) || next.attrs.headingId;
    }
    if (next.type === "orvynPerson" && !eligiblePeople.has(next.attrs.userId)) {
      omittedPeople++;
      next = {
        type: "text",
        text: "@Person unavailable",
        ...(next.marks ? { marks: next.marks } : {}),
      };
    }
    if (next.marks)
      next.marks = next.marks.map((mark: any) =>
        mark.type === "link"
          ? { ...mark, attrs: { ...mark.attrs, href: href(mark.attrs.href) } }
          : mark,
      );
    if (next.content) next.content = next.content.map(walk);
    return next;
  }
  return { document: normalizeDocument(walk(source)), omittedPeople };
}

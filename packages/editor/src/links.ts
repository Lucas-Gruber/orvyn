export const validHeadingId = (id: unknown): id is string =>
  typeof id === "string" &&
  /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|legacy-[a-f0-9]{16}-[1-9][0-9]{0,3})$/.test(
    id,
  );
export function headingFromHash(hash: string) {
  const id = hash.startsWith("#h-") ? hash.slice(3) : "";
  return validHeadingId(id) ? id : "";
}
export const pageLink = (pageId: string, headingId = "") =>
  `/?page=${encodeURIComponent(pageId)}${validHeadingId(headingId) ? "#h-" + headingId : ""}`;
export function documentAssets(document: any) {
  const refs = new Map<string, { fileId: string; image: boolean }>();
  function walk(node: any) {
    if (["orvynImage", "orvynFile"].includes(node.type)) {
      const image = node.type === "orvynImage";
      refs.set(node.attrs.fileId + ":" + image, {
        fileId: node.attrs.fileId,
        image,
      });
    }
    for (const child of node.content || []) walk(child);
  }
  walk(document);
  return [...refs.values()];
}
export function newDocumentAssets(next: any, previous: any) {
  const old = new Set(
    documentAssets(previous).map((r) => r.fileId + ":" + r.image),
  );
  return documentAssets(next).filter((r) => !old.has(r.fileId + ":" + r.image));
}
export function documentReferences(document: any, origin: string) {
  const references = new Map<string, { pageId: string; headingId: string }>(),
    base = new URL(origin);
  function walk(node: any) {
    if (
      node.type === "orvynPagePreview" &&
      typeof node.attrs?.pageId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        node.attrs.pageId,
      )
    ) {
      const headingId = validHeadingId(node.attrs.headingId)
        ? node.attrs.headingId
        : "";
      references.set(node.attrs.pageId + ":" + headingId, {
        pageId: node.attrs.pageId,
        headingId,
      });
    }
    for (const mark of node.marks || []) {
      if (mark.type !== "link" || typeof mark.attrs?.href !== "string")
        continue;
      try {
        const url = new URL(mark.attrs.href, base),
          pageId = url.searchParams.get("page");
        if (
          url.origin !== base.origin ||
          url.pathname !== "/" ||
          !pageId ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
            pageId,
          )
        )
          continue;
        const headingId = headingFromHash(url.hash);
        references.set(pageId + ":" + headingId, { pageId, headingId });
      } catch {
        /* Non-URL text is not an internal reference. */
      }
    }
    for (const child of node.content || []) walk(child);
  }
  walk(document);
  return [...references.values()];
}
export function documentExcerpt(document: any) {
  const chunks: string[] = [];
  function walk(node: any) {
    if (
      ["paragraph", "heading", "codeBlock", "orvynToggleSummary"].includes(
        node.type,
      )
    ) {
      const value = text(node).trim();
      if (value) chunks.push(value);
      return;
    }
    for (const child of node.content || []) walk(child);
  }
  walk(document);
  return chunks.join(" ").replace(/\s+/g, " ").trim().slice(0, 280);
}
function text(node: any): string {
  return node.text || (node.content || []).map(text).join("");
}
// Old documents have no stored IDs. Derive the same initial anchor on the API
// and in read-only clients; an editable client persists it before editing.
function legacyId(label: string, occurrence: number) {
  let a = 2166136261,
    b = 5381;
  for (let i = 0; i < label.length; i++) {
    a = Math.imul(a ^ label.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ label.charCodeAt(i);
  }
  return `legacy-${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}-${occurrence}`;
}
export function documentHeadings(
  document: any,
): { id: string; text: string; level: number }[] {
  const headings: { id: string; text: string; level: number }[] = [],
    counts = new Map<string, number>();
  function walk(node: any) {
    if (node.type === "heading") {
      const label = text(node),
        count = (counts.get(label) || 0) + 1;
      counts.set(label, count);
      headings.push({
        id: validHeadingId(node.attrs?.id)
          ? node.attrs.id
          : legacyId(label, count),
        text: label || "Untitled heading",
        level: node.attrs?.level || 1,
      });
    }
    for (const child of node.content || []) walk(child);
  }
  walk(document);
  return headings;
}

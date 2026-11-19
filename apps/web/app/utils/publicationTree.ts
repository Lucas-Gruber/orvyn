import type { PublicPage } from "@orvyn/shared";
export interface PublicationTreeEntry {
  page: PublicPage;
  depth: number;
  hasChildren: boolean;
  path: string[];
}
export function publicationTrail(
  pages: PublicPage[],
  rootId: string,
  id: string,
): PublicPage[] {
  const byId = new Map(pages.map((page) => [page.id, page])),
    trail: PublicPage[] = [],
    seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    trail.unshift(current);
    if (current.id === rootId) break;
    current = byId.get(current.parentId || rootId);
  }
  return trail;
}
export function publicationTree(
  pages: PublicPage[],
  rootId: string,
): PublicationTreeEntry[] {
  const root = pages.find((page) => page.id === rootId);
  if (!root) return [];
  const byId = new Map(pages.map((page) => [page.id, page])),
    children = new Map<string, PublicPage[]>(),
    seen = new Set<string>(),
    result: PublicationTreeEntry[] = [];
  for (const page of pages) {
    if (page.id === rootId) continue;
    const parent =
      page.parentId && byId.has(page.parentId) ? page.parentId : rootId;
    const siblings = children.get(parent) || [];
    siblings.push(page);
    children.set(parent, siblings);
  }
  for (const siblings of children.values())
    siblings.sort(
      (a, b) =>
        a.order - b.order ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id),
    );
  function visit(page: PublicPage, path: string[]) {
    if (seen.has(page.id)) return;
    seen.add(page.id);
    result.push({
      page,
      depth: path.length,
      hasChildren: !!children.get(page.id)?.length,
      path,
    });
    for (const child of children.get(page.id) || [])
      visit(child, [...path, page.id]);
  }
  visit(root, []);
  // A malformed/stale parent cycle must not trap the reader or hide approved pages.
  for (const page of pages) if (!seen.has(page.id)) visit(page, [rootId]);
  return result;
}

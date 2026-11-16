interface TreePage {
  id: string;
  parent_id: string | null;
  title: string;
  sort_order?: number;
  sort_rank?: number;
}
export function pageOrder(a: TreePage, b: TreePage) {
  return (
    (a.sort_rank ?? a.sort_order ?? 0) - (b.sort_rank ?? b.sort_order ?? 0) ||
    a.title.localeCompare(b.title) ||
    a.id.localeCompare(b.id)
  );
}
export function visiblePageTree<T extends TreePage>(
  pages: T[],
  expanded: string[],
) {
  const byId = new Map(pages.map((page) => [page.id, page])),
    children = new Map<string | null, T[]>(),
    open = new Set(expanded),
    seen = new Set<string>(),
    result: (T & { depth: number; children: boolean })[] = [];
  for (const page of pages) {
    const parent =
      page.parent_id && byId.has(page.parent_id) ? page.parent_id : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(page);
  }
  for (const siblings of children.values()) siblings.sort(pageOrder);
  function visit(parent: string | null, depth: number) {
    for (const page of children.get(parent) || []) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      result.push({ ...page, depth, children: children.has(page.id) });
      if (open.has(page.id)) visit(page.id, depth + 1);
    }
  }
  visit(null, 0);
  return result;
}
export function pageContains(
  pages: Map<string, TreePage>,
  ancestor: string,
  candidate: string,
) {
  const seen = new Set<string>();
  let page = pages.get(candidate);
  while (page && !seen.has(page.id)) {
    if (page.id === ancestor) return true;
    seen.add(page.id);
    page = page.parent_id ? pages.get(page.parent_id) : undefined;
  }
  return false;
}

export function validPersonId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  );
}
/** Identity references only. Names/emails are resolved within the current page. */
export function documentPeople(document: unknown): string[] {
  const ids = new Set<string>();
  function visit(node: any) {
    if (node?.type === "orvynPerson" && validPersonId(node.attrs?.userId))
      ids.add(node.attrs.userId);
    if (Array.isArray(node?.content)) node.content.forEach(visit);
  }
  visit(document);
  return [...ids];
}

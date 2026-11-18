import type { Property, ViewConfig } from "./index.js";

/** Apply a view's layout without changing the database schema's canonical order. */
export function orderedViewProperties(
  properties: Property[],
  config: ViewConfig,
  visibleOnly = true,
): Property[] {
  const positions = new Map(
    (config.propertyOrder || []).map((id, index) => [id, index]),
  );
  const visible =
    visibleOnly && config.visibleProperties.length
      ? new Set([
          ...config.visibleProperties,
          ...properties
            .filter((property) => property.type === "Title")
            .map((property) => property.id),
          ...[config.groupBy, config.dateProperty].filter(
            (id): id is string => !!id,
          ),
        ])
      : null;
  return properties
    .filter((property) => !visible || visible.has(property.id))
    .sort((left, right) => {
      if (left.type === "Title") return right.type === "Title" ? 0 : -1;
      if (right.type === "Title") return 1;
      return (
        (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      );
    });
}

export function reorderPropertyIds(
  order: string[],
  source: string,
  target: string,
  after = false,
): string[] {
  if (source === target || !order.includes(source) || !order.includes(target))
    return [...order];
  const next = order.filter((id) => id !== source),
    position = next.indexOf(target) + (after ? 1 : 0);
  next.splice(position, 0, source);
  return next;
}

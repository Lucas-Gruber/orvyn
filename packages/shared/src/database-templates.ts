import type { Property, ViewConfig, ViewType, FormulaNode } from "./index.js";

export interface TemplateView {
  id: string;
  name: string;
  type: ViewType;
  config: ViewConfig;
}

// A schema template creates a separate database. Rebind every local identifier,
// including formula ASTs, self-relations, rollups, view fields and select values.
export function cloneDatabaseSchema(
  sourceDatabaseId: string,
  targetDatabaseId: string,
  sourceProperties: Property[],
  sourceViews: TemplateView[],
  newId = () => crypto.randomUUID() as string,
) {
  if (
    sourceProperties.length > 50 ||
    sourceProperties.filter((p) => p.type === "Title").length !== 1 ||
    !sourceViews.length ||
    sourceViews.length > 20
  )
    throw new Error("The database template has an invalid schema.");
  const ids = new Map(sourceProperties.map((p) => [p.id, newId()])),
    options = new Map(
      sourceProperties.map((p) => [
        p.id,
        new Map((p.config.options || []).map((option) => [option.id, newId()])),
      ]),
    );
  const local = (id: string) => {
    const next = ids.get(id);
    if (!next) throw new Error("The template refers to a missing property.");
    return next;
  };
  function expression(n: FormulaNode): FormulaNode {
    if (n.kind === "property") return { ...n, id: local(n.id) };
    if (n.kind === "binary")
      return { ...n, left: expression(n.left), right: expression(n.right) };
    if (n.kind === "unary") return { ...n, arg: expression(n.arg) };
    if (n.kind === "call") return { ...n, args: n.args.map(expression) };
    return { ...n };
  }
  const properties = sourceProperties.map((p, position) => {
      const config = structuredClone(p.config);
      if (config.options)
        config.options = config.options.map((option) => ({
          ...option,
          id: options.get(p.id)!.get(option.id)!,
        }));
      if (p.type === "Relation" && config.databaseId === sourceDatabaseId)
        config.databaseId = targetDatabaseId;
      if (config.expression) config.expression = expression(config.expression);
      if (config.rollup) {
        const relation = sourceProperties.find(
          (r) => r.id === config.rollup!.relationId && r.type === "Relation",
        );
        if (!relation)
          throw new Error("The template refers to a missing relation.");
        config.rollup = {
          ...config.rollup,
          relationId: local(config.rollup.relationId),
          ...(config.rollup.targetPropertyId &&
          relation.config.databaseId === sourceDatabaseId
            ? { targetPropertyId: local(config.rollup.targetPropertyId) }
            : {}),
        };
      }
      return { ...p, id: local(p.id), config, position };
    }),
    views = sourceViews.map((v, position) => ({
      ...structuredClone(v),
      id: newId(),
      position,
      version: 1,
      config: {
        ...structuredClone(v.config),
        visibleProperties: v.config.visibleProperties.map(local),
        ...(v.config.propertyOrder
          ? { propertyOrder: v.config.propertyOrder.map(local) }
          : {}),
        groupBy: v.config.groupBy ? local(v.config.groupBy) : null,
        dateProperty: v.config.dateProperty
          ? local(v.config.dateProperty)
          : null,
        sorts: v.config.sorts.map((s) => ({
          ...s,
          propertyId: local(s.propertyId),
        })),
        filters: v.config.filters.map((f) => {
          const mapping = options.get(f.propertyId),
            mapValue = (
              value: Exclude<ViewConfig["filters"][number]["value"], undefined>,
            ) =>
              typeof value === "string" ? mapping?.get(value) || value : value;
          return {
            ...structuredClone(f),
            propertyId: local(f.propertyId),
            ...(f.value !== undefined
              ? {
                  value: Array.isArray(f.value)
                    ? f.value.map(mapValue)
                    : mapValue(f.value),
                }
              : {}),
          };
        }),
      },
    }));
  return { properties, views };
}

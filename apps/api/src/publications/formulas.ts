import type { PoolClient } from "pg";
import {
  type Property,
  type PublicValue,
  type FormulaNode,
  formulaPropertyType,
  formulaType,
  FormulaError,
  rollupAggregations,
} from "@orvyn/shared";
import { formulaSql } from "../databases/formula.js";
import { fail } from "../runtime.js";

export function publicationFormulaDependencies(
  property: Property,
  properties: Property[],
): string[] {
  if (property.type === "Rollup") {
    const config = property.config.rollup,
      relation = properties.find(
        (candidate) =>
          candidate.id === config?.relationId && candidate.type === "Relation",
      );
    if (
      !config ||
      !relation ||
      !relation.config.databaseId ||
      !rollupAggregations.includes(config.aggregation) ||
      (config.aggregation === "count"
        ? !!config.targetPropertyId
        : !config.targetPropertyId)
    )
      throw new FormulaError("The rollup inputs are unavailable.");
    return [relation.id];
  }
  if (property.type !== "Formula") return [];
  const byId = new Map(properties.map((property) => [property.id, property])),
    dependencies = new Set<string>(),
    visiting = new Set([property.id]);
  let remaining = 512;
  function walk(node: FormulaNode | undefined, depth = 0) {
    if (!node || --remaining < 0 || depth > 32)
      throw new FormulaError(
        "The formula dependencies are unavailable or too complex.",
      );
    if (node.kind === "property") {
      const dependency = byId.get(node.id);
      if (!dependency || visiting.has(dependency.id))
        throw new FormulaError(
          "The formula dependencies are unavailable or cyclic.",
        );
      dependencies.add(dependency.id);
      if (dependency.type === "Formula") {
        visiting.add(dependency.id);
        walk(dependency.config.expression, depth + 1);
        visiting.delete(dependency.id);
      }
      return;
    }
    if (node.kind === "binary") {
      walk(node.left, depth + 1);
      walk(node.right, depth + 1);
    } else if (node.kind === "unary") walk(node.arg, depth + 1);
    else if (node.kind === "call")
      for (const arg of node.args) walk(arg, depth + 1);
  }
  walk(property.config.expression);
  return [...dependencies];
}
export function publicationFormulaInputs(
  property: Property,
  properties: Property[],
  visible: Property[],
  allowed: ReadonlySet<string>,
) {
  try {
    if (
      property.type === "Formula" &&
      formulaType(property.config.expression!, properties) === "list"
    )
      return { allowed: false, dependencies: [] };
    const dependencies = publicationFormulaDependencies(property, properties),
      byId = new Map(visible.map((property) => [property.id, property]));
    return {
      allowed:
        allowed.has(property.type) &&
        dependencies.every((id) => {
          const dependency = byId.get(id);
          return dependency && allowed.has(dependency.type);
        }),
      dependencies: dependencies.map((id) => ({
        id,
        name:
          properties.find((property) => property.id === id)?.name ||
          "Unavailable input",
      })),
    };
  } catch {
    return { allowed: false, dependencies: [] };
  }
}
export interface PublicationFormulaContext {
  recordId: string;
  properties: Property[];
  selected: Property[];
  values: Record<string, PublicValue>;
}
export function checkPublicationFormulas(
  selected: Property[],
  properties: Property[],
) {
  const ids = new Set(selected.map((property) => property.id));
  for (const property of selected.filter(
    (property) => property.type === "Formula" || property.type === "Rollup",
  )) {
    let dependencies: string[];
    try {
      dependencies = publicationFormulaDependencies(property, properties);
      if (
        property.type === "Formula" &&
        formulaType(property.config.expression!, properties) === "list"
      )
        fail(400, "Publish a scalar formula result instead of a list.");
    } catch {
      return fail(
        400,
        "The inputs for " +
          property.name +
          " are unavailable. Choose another property.",
      );
    }
    if (dependencies.some((id) => !ids.has(id)))
      fail(
        400,
        "Select every input property for " +
          property.name +
          " before publishing this calculation.",
      );
  }
}

// Evaluate the existing bounded formula language against approved values only.
// The generated SELECT has parameters and private numeric helper functions;
// it never reads a private record, relation, directory or property table.
export async function computePublicationFormulas(
  c: PoolClient,
  contexts: PublicationFormulaContext[],
  phase: "all" | "independent" | "dependent" = "all",
) {
  for (const context of contexts) {
    const formulas = context.selected.filter((property) => {
      if (property.type !== "Formula") return false;
      if (phase === "all") return true;
      const dependent = publicationFormulaDependencies(
        property,
        context.properties,
      ).some(
        (id) =>
          context.properties.find((candidate) => candidate.id === id)?.type ===
          "Rollup",
      );
      return phase === "dependent" ? dependent : !dependent;
    });
    if (!formulas.length) continue;
    checkPublicationFormulas(context.selected, context.properties);
    const params: (string | null)[] = [],
      bindings = new Map<string, string>(),
      fields = new Map<string, string>();
    const bind = (value: unknown) => {
      const key = typeof value + ":" + JSON.stringify(value);
      const known = bindings.get(key);
      if (known) return known;
      params.push(value === null ? null : String(value));
      const parameter = "($" + params.length + "::text)";
      bindings.set(key, parameter);
      return parameter;
    };
    const field = (property: Property): string => {
      const known = fields.get(property.id);
      if (known) return known;
      let value: PublicValue = context.values[property.id] ?? null;
      if (property.type === "Select" || property.type === "Status")
        value =
          property.config.options?.find((option) => option.id === value)
            ?.label ?? null;
      if (property.type === "MultiSelect")
        value = (Array.isArray(value) ? value : [])
          .slice()
          .sort()
          .flatMap(
            (id) =>
              property.config.options?.find((option) => option.id === id)
                ?.label || [],
          );
      const type = formulaPropertyType(property),
        parameter = bind(type === "list" ? JSON.stringify(value ?? []) : value);
      const expression =
        parameter +
        (type === "list"
          ? "::jsonb"
          : property.type.endsWith("Time")
            ? "::timestamptz::text"
            : type === "number"
              ? "::double precision"
              : type === "boolean"
                ? "::boolean"
                : "::text");
      fields.set(property.id, expression);
      return expression;
    };
    let columns: string[];
    try {
      columns = formulas.map(
        (property, index) =>
          formulaSql(
            property.config.expression!,
            context.properties,
            bind,
            field,
          ).sql +
          " AS f" +
          index,
      );
    } catch (error) {
      if (error instanceof FormulaError)
        fail(
          400,
          "A public formula is unavailable. Review its selected inputs.",
        );
      throw error;
    }
    const row = (await c.query("SELECT " + columns.join(","), params)).rows[0];
    for (const [index, property] of formulas.entries()) {
      const value = row["f" + index];
      context.values[property.id] =
        typeof value === "number" && !Number.isFinite(value) ? null : value;
    }
  }
}

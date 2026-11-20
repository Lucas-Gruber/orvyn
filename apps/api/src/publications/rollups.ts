import type { PoolClient } from "pg";
import {
  rollupTargetSupported,
  type Property,
  type PublicValue,
} from "@orvyn/shared";
import {
  computePublicationFormulas,
  type PublicationFormulaContext,
} from "./formulas.js";
import { fail } from "../runtime.js";

export interface PublicationCalculationContext extends PublicationFormulaContext {
  databaseId: string;
}

export async function computePublicationCalculations(
  c: PoolClient,
  contexts: PublicationCalculationContext[],
) {
  if (
    !contexts.some((context) =>
      context.selected.some((property) => property.type === "Rollup"),
    )
  ) {
    await computePublicationFormulas(c, contexts);
    return;
  }
  await computePublicationFormulas(c, contexts, "independent");
  const registry = new Map<string, PublicationCalculationContext[]>();
  for (const context of contexts) {
    const instances = registry.get(context.recordId) || [];
    instances.push(context);
    registry.set(context.recordId, instances);
  }
  let remaining = 2000,
    edges = 10000;
  const memo = new Map<string, number | null>(),
    indices = new Map(contexts.map((context, index) => [context, index]));
  async function evaluate(
    context: PublicationCalculationContext,
    property: Property,
    depth = 0,
    path: ReadonlySet<string> = new Set(),
  ): Promise<number | null> {
    if (depth >= 2 || path.has(property.id))
      return fail(
        400,
        "Public rollups support at most two relation steps without cycles.",
      );
    const key = indices.get(context) + ":" + property.id + ":" + depth;
    if (memo.has(key)) return memo.get(key)!;
    if (--remaining < 0)
      return fail(
        400,
        "Choose fewer shared rollup fields or items for this publication.",
      );
    const config = property.config.rollup,
      relation = context.selected.find(
        (candidate) =>
          candidate.id === config?.relationId && candidate.type === "Relation",
      );
    if (!config || !relation?.config.databaseId)
      return fail(
        400,
        "Select the relation property used by " + property.name + ".",
      );
    const raw = context.values[relation.id],
      ids = [...new Set(Array.isArray(raw) ? raw : [])];
    if ((edges -= ids.length) < 0)
      return fail(
        400,
        "Choose fewer shared relation targets for this publication.",
      );
    const targets = ids.map((id) => ({
      id,
      contexts: (registry.get(id) || []).filter(
        (target) => target.databaseId === relation.config.databaseId,
      ),
    }));
    if (targets.some((target) => !target.contexts.length))
      fail(
        400,
        "A shared rollup target is unavailable. Review the selected records.",
      );
    let result: number | null;
    if (config.aggregation === "count") result = targets.length;
    else {
      const values: PublicValue[] = [];
      for (const target of targets) {
        const candidate = target.contexts.find((instance) =>
          instance.selected.some(
            (field) => field.id === config.targetPropertyId,
          ),
        );
        if (!candidate)
          return fail(
            400,
            "Share the target field on every included related item before publishing " +
              property.name +
              ".",
          );
        const field = candidate.selected.find(
          (field) => field.id === config.targetPropertyId,
        )!;
        if (
          !rollupTargetSupported(
            field,
            candidate.properties,
            config.aggregation,
          )
        )
          fail(400, "This rollup requires a compatible shared target field.");
        let value =
          field.type === "Rollup"
            ? await evaluate(
                candidate,
                field,
                depth + 1,
                new Set([...path, property.id]),
              )
            : (candidate.values[field.id] ?? null);
        if (
          ["Select", "Status", "CreatedBy", "LastEditedBy"].includes(field.type)
        )
          value =
            field.config.options?.find((option) => option.id === value)
              ?.label ?? null;
        values.push(value);
      }
      const present = values.filter((value) => value !== null && value !== "");
      if (config.aggregation === "countValues") result = present.length;
      else if (config.aggregation === "unique")
        result = new Set(
          present.map((value) => typeof value + ":" + JSON.stringify(value)),
        ).size;
      else {
        if (
          present.some(
            (value) => typeof value !== "number" || !Number.isFinite(value),
          )
        )
          fail(400, "Numeric rollups require shared numeric target values.");
        const aggregate = {
          sum: "sum",
          average: "avg",
          min: "min",
          max: "max",
        }[config.aggregation];
        if (!aggregate) fail(400, "Unknown public rollup calculation.");
        const expression = aggregate + "(item.value::numeric)";
        const row = (
          await c.query(
            `SELECT orvyn_formula_finite(${config.aggregation === "sum" ? "coalesce(" + expression + ",0::numeric)" : expression}) AS value FROM jsonb_array_elements_text($1::jsonb) item(value)`,
            [JSON.stringify(present)],
          )
        ).rows[0];
        result = row.value;
      }
    }
    memo.set(key, result);
    context.values[property.id] = result;
    return result;
  }
  for (const context of contexts)
    for (const property of context.selected)
      if (property.type === "Rollup") await evaluate(context, property);
  await computePublicationFormulas(c, contexts, "dependent");
}

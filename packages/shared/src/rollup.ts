import { z } from "zod";
import type { Property } from "./index.js";
import {
  formulaPropertyType,
  formulaType,
  type FormulaNode,
} from "./formula.js";

export const rollupAggregations = [
  "count",
  "sum",
  "average",
  "min",
  "max",
  "countValues",
  "unique",
] as const;
export const rollupInput = z
  .object({
    relationId: z.uuid().transform((id) => id.toLowerCase()),
    targetPropertyId: z
      .uuid()
      .transform((id) => id.toLowerCase())
      .optional(),
    aggregation: z.enum(rollupAggregations),
  })
  .strict();
export type RollupConfig = z.infer<typeof rollupInput>;

// Numeric rollup targets are validated against the actor's two-step catalog by
// the API. Formula targets must still depend only on their local scalar fields.
export function rollupTargetSupported(
  property: Property,
  properties: Property[],
  aggregation: string,
) {
  if (["Files", "Relation"].includes(property.type)) return false;
  const seen = new Set<string>();
  function visit(n: FormulaNode): boolean {
    if (n.kind === "property") {
      const p = properties.find((p) => p.id === n.id);
      if (!p || ["Files", "Relation", "Rollup"].includes(p.type)) return false;
      if (p.type !== "Formula") return true;
      if (!p.config.expression || seen.has(p.id)) return false;
      seen.add(p.id);
      const valid = visit(p.config.expression);
      seen.delete(p.id);
      return valid;
    }
    if (n.kind === "binary") return visit(n.left) && visit(n.right);
    if (n.kind === "unary") return visit(n.arg);
    if (n.kind === "call") return n.args.every(visit);
    return true;
  }
  try {
    const type =
      property.type === "Formula" && property.config.expression
        ? formulaType(property.config.expression, properties)
        : formulaPropertyType(property);
    if (
      property.type === "Formula" &&
      (!property.config.expression || !visit(property.config.expression))
    )
      return false;
    return ["sum", "average", "min", "max"].includes(aggregation)
      ? type === "number"
      : type !== "list";
  } catch {
    return false;
  }
}

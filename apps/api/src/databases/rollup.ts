import type { Pool, PoolClient } from "pg";
import {
  rollupTargetSupported,
  type Property,
  type RollupConfig,
} from "@orvyn/shared";
import { fail } from "../runtime.js";

// Sidecar data is never serialized with a source database's property metadata.
const catalogs = new WeakMap<Property[], Map<string, Property[]>>();
export async function targetProperties(
  c: Pool | PoolClient,
  uid: string,
  databaseId: string,
): Promise<Property[] | null> {
  const result = await c.query(
    `SELECT d.page_id,coalesce(jsonb_agg(jsonb_build_object('id',dp.id,'name',dp.name,'type',dp.type,'config',dp.config,'position',dp.position) ORDER BY dp.position,dp.id) FILTER(WHERE dp.id IS NOT NULL),'[]'::jsonb) AS properties
     FROM databases d JOIN pages p ON p.id=d.page_id LEFT JOIN database_properties dp ON dp.database_id=d.page_id AND dp.deleted_at IS NULL
     WHERE d.page_id=$1 AND orvyn_page_role(p.id,$2)>=10 GROUP BY d.page_id`,
    [databaseId, uid],
  );
  return result.rows[0]?.properties || null;
}
export async function loadRollupCatalog(
  c: Pool | PoolClient,
  uid: string,
  properties: Property[],
) {
  const ids = new Set(
      properties
        .filter((p) => p.type === "Rollup")
        .flatMap((p) => {
          const relation = properties.find(
            (r) =>
              r.id === p.config.rollup?.relationId && r.type === "Relation",
          );
          return relation?.config.databaseId
            ? [relation.config.databaseId]
            : [];
        }),
    ),
    catalog = new Map<string, Property[]>();
  for (const id of ids) {
    const target = await targetProperties(c, uid, id);
    if (target) catalog.set(id, target);
  }
  catalogs.set(properties, catalog);
}
export async function rollupConfig(
  c: Pool | PoolClient,
  uid: string,
  properties: Property[],
  input: RollupConfig,
) {
  const relation = properties.find(
    (p) => p.id === input.relationId && p.type === "Relation",
  );
  if (!relation?.config.databaseId)
    fail(400, "Choose a current relation property.");
  const targets = await targetProperties(c, uid, relation!.config.databaseId!);
  if (!targets) fail(400, "The related database is unavailable.");
  if (input.aggregation === "count") {
    if (input.targetPropertyId)
      fail(400, "Record count does not need a target property.");
  } else {
    const target = targets!.find((p) => p.id === input.targetPropertyId);
    if (!target || !rollupTargetSupported(target, targets!, input.aggregation))
      fail(400, "Choose a compatible local field from the related database.");
  }
  return { rollup: input, resultType: "number" as const };
}
export function rollupSql(
  property: Property,
  properties: Property[],
  bind: (value: unknown) => string,
  actor: string,
  render: (property: Property, properties: Property[]) => string,
) {
  const config = property.config.rollup,
    relation = properties.find(
      (p) => p.id === config?.relationId && p.type === "Relation",
    ),
    databaseId = relation?.config.databaseId,
    targets = databaseId
      ? catalogs.get(properties)?.get(databaseId)
      : undefined;
  if (!config || !relation || !targets) return "NULL::double precision";
  const target = targets.find((p) => p.id === config.targetPropertyId);
  if (
    config.aggregation !== "count" &&
    (!target || !rollupTargetSupported(target, targets, config.aggregation))
  )
    return "NULL::double precision";
  const scope = `FROM database_records rollup_record JOIN pages rollup_page ON rollup_page.id=rollup_record.page_id WHERE rollup_record.database_id=${bind(databaseId)}::uuid AND rollup_record.page_id IN (SELECT jsonb_array_elements_text(orvyn_record_relation_values(p.id,${bind(relation.id)}::uuid,${actor}::uuid))::uuid)`;
  if (config.aggregation === "count")
    return `(SELECT count(*)::double precision ${scope})`;
  const value = render(target!, targets);
  if (config.aggregation === "countValues" || config.aggregation === "unique")
    return `(SELECT count(${config.aggregation === "unique" ? "DISTINCT " : ""}${value})::double precision ${scope} AND (${value})::text<>'')`;
  const aggregate = { sum: "sum", average: "avg", min: "min", max: "max" }[
    config.aggregation
  ];
  const result = `(SELECT ${aggregate}((${value})::text::numeric) ${scope})`;
  return `orvyn_formula_finite(${config.aggregation === "sum" ? `coalesce(${result},0::numeric)` : result})`;
}

import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import {
  rollupTargetSupported,
  type Property,
  type RollupConfig,
} from "@orvyn/shared";
import { fail } from "../runtime.js";

// Actor-authorized schema catalogs remain sidecars and are never serialized.
const catalogs = new WeakMap<Property[], Map<string, Property[]>>();
async function targetBatch(c: Pool | PoolClient, uid: string, ids: string[]) {
  if (!ids.length) return new Map<string, Property[]>();
  const result = await c.query(
    `SELECT d.page_id,coalesce(jsonb_agg(jsonb_build_object('id',dp.id,'name',dp.name,'type',dp.type,'config',dp.config,'position',dp.position) ORDER BY dp.position,dp.id) FILTER(WHERE dp.id IS NOT NULL),'[]'::jsonb) AS properties
   FROM databases d JOIN pages p ON p.id=d.page_id LEFT JOIN database_properties dp ON dp.database_id=d.page_id AND dp.deleted_at IS NULL
   WHERE d.page_id=ANY($1::uuid[]) AND orvyn_page_role(p.id,$2)>=10 GROUP BY d.page_id`,
    [ids, uid],
  );
  return new Map<string, Property[]>(
    result.rows.map((row) => [row.page_id, row.properties]),
  );
}
export async function targetProperties(
  c: Pool | PoolClient,
  uid: string,
  databaseId: string,
): Promise<Property[] | null> {
  return (await targetBatch(c, uid, [databaseId])).get(databaseId) || null;
}
function related(property: Property, properties: Property[]) {
  return properties.find(
    (candidate) =>
      candidate.id === property.config.rollup?.relationId &&
      candidate.type === "Relation",
  );
}
export async function loadRollupCatalog(
  c: Pool | PoolClient,
  uid: string,
  properties: Property[],
) {
  const roots = properties.filter((property) => property.type === "Rollup");
  const first = [
    ...new Set(
      roots.flatMap(
        (property) => related(property, properties)?.config.databaseId || [],
      ),
    ),
  ];
  const catalog = await targetBatch(c, uid, first);
  const second = new Set<string>();
  for (const root of roots) {
    const databaseId = related(root, properties)?.config.databaseId;
    const targets = databaseId ? catalog.get(databaseId) : undefined;
    const nested = targets?.find(
      (target) =>
        target.id === root.config.rollup?.targetPropertyId &&
        target.type === "Rollup",
    );
    const leaf =
      nested && targets
        ? related(nested, targets)?.config.databaseId
        : undefined;
    if (leaf && !first.includes(leaf)) second.add(leaf);
  }
  for (const [id, targets] of await targetBatch(c, uid, [...second]))
    catalog.set(id, targets);
  for (const list of [properties, ...catalog.values()])
    catalogs.set(list, catalog);
}
function available(
  property: Property,
  properties: Property[],
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (seen.size >= 2 || seen.has(property.id)) return false;
  const config = property.config.rollup,
    relation = related(property, properties);
  const targets = relation?.config.databaseId
    ? catalogs.get(properties)?.get(relation.config.databaseId)
    : undefined;
  if (!config || !relation || !targets) return false;
  if (config.aggregation === "count") return !config.targetPropertyId;
  const target = targets.find(
    (target) => target.id === config.targetPropertyId,
  );
  if (!target || !rollupTargetSupported(target, targets, config.aggregation))
    return false;
  return (
    target.type !== "Rollup" ||
    available(target, targets, new Set([...seen, property.id]))
  );
}
export async function rollupConfig(
  c: Pool | PoolClient,
  uid: string,
  properties: Property[],
  input: RollupConfig,
  candidateId?: string,
) {
  const relation = properties.find(
    (property) =>
      property.id === input.relationId && property.type === "Relation",
  );
  if (!relation?.config.databaseId)
    fail(400, "Choose a current relation property.");
  const probe: Property = {
    id: candidateId || randomUUID(),
    name: "Calculation",
    type: "Rollup",
    config: { rollup: input, resultType: "number" },
    position: 0,
  };
  const scope = [probe, relation!];
  await loadRollupCatalog(c, uid, scope);
  const targets = catalogs.get(scope)?.get(relation!.config.databaseId!);
  if (!targets) fail(400, "The related database is unavailable.");
  if (input.aggregation === "count") {
    if (input.targetPropertyId)
      fail(400, "Record count does not need a target property.");
  } else {
    const target = targets!.find(
      (property) => property.id === input.targetPropertyId,
    );
    if (!target || !rollupTargetSupported(target, targets!, input.aggregation))
      fail(400, "Choose a compatible field from the related database.");
    if (target!.type === "Rollup" && !available(probe, scope))
      fail(
        400,
        "This calculation is unavailable, circular or exceeds two relation steps.",
      );
  }
  return { rollup: input, resultType: "number" as const };
}
export function rollupSql(
  property: Property,
  properties: Property[],
  bind: (value: unknown) => string,
  actor: string,
  sourcePage: string,
  sourceRecord: string,
  seen: ReadonlySet<string>,
  render: (
    property: Property,
    properties: Property[],
    page: string,
    record: string,
    seen: ReadonlySet<string>,
  ) => string,
) {
  if (!available(property, properties, seen)) return "NULL::double precision";
  const config = property.config.rollup!,
    relation = related(property, properties)!;
  const databaseId = relation.config.databaseId!,
    targets = catalogs.get(properties)!.get(databaseId)!;
  const path = new Set([...seen, property.id]),
    page = `rollup_page_${path.size}`,
    record = `rollup_record_${path.size}`,
    edge = `rollup_edge_${path.size}`,
    field = `rollup_relation_${path.size}`,
    targetDatabase = bind(databaseId),
    relationId = bind(relation.id);
  // Join the permission-checked edge directly. Expanding a JSON relation value
  // inside a correlated IN subquery can recalculate its entire ACL projection
  // for every candidate target row in a nested aggregate.
  const scope = `FROM record_relations ${edge}
    JOIN database_properties ${field} ON ${field}.id=${edge}.property_id AND ${field}.database_id=${sourceRecord}.database_id AND ${field}.type='Relation' AND ${field}.deleted_at IS NULL AND ${field}.config->>'databaseId'=${targetDatabase}::text
    JOIN database_records ${record} ON ${record}.page_id=${edge}.target_id AND ${record}.database_id=${targetDatabase}::uuid
    JOIN pages ${page} ON ${page}.id=${record}.page_id
    WHERE ${edge}.source_id=${sourcePage}.id AND ${edge}.property_id=${relationId}::uuid AND orvyn_page_role(${sourcePage}.id,${actor}::uuid)>=10 AND orvyn_page_role(${page}.id,${actor}::uuid)>=10`;
  if (config.aggregation === "count")
    return `(SELECT count(*)::double precision ${scope})`;
  const target = targets.find(
    (target) => target.id === config.targetPropertyId,
  )!;
  const value = render(target, targets, page, record, path);
  if (config.aggregation === "countValues" || config.aggregation === "unique")
    return `(SELECT count(${config.aggregation === "unique" ? "DISTINCT " : ""}${value})::double precision ${scope} AND (${value})::text<>'')`;
  const aggregate = { sum: "sum", average: "avg", min: "min", max: "max" }[
    config.aggregation
  ];
  const result = `(SELECT ${aggregate}((${value})::text::numeric) ${scope})`;
  return `orvyn_formula_finite(${config.aggregation === "sum" ? `coalesce(${result},0::numeric)` : result})`;
}

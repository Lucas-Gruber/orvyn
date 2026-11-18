import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z, type Property } from "@orvyn/shared";
import { database } from "./model.js";
import { fail } from "../runtime.js";
import { audit } from "../auth/security.js";

export async function reciprocalContexts(
  c: PoolClient,
  uid: string,
  source: string,
  target: string,
) {
  if (
    !z.uuid().safeParse(source).success ||
    !z.uuid().safeParse(target).success
  )
    fail(404, "Database not found");
  const ids = [...new Set([source.toLowerCase(), target.toLowerCase()])];
  const found = await c.query(
    "SELECT p.id,p.space_id FROM pages p JOIN databases d ON d.page_id=p.id WHERE p.id=ANY($1::uuid[])",
    [ids],
  );
  if (found.rowCount !== ids.length) fail(404, "Database not found");
  // pageWrite locks a space for writes. Acquire both spaces in a stable order
  // before loading either schema, including when both databases share a space.
  await c.query(
    "SELECT id FROM spaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [[...new Set(found.rows.map((row) => row.space_id))]],
  );
  const left = await database(c, uid, source, 30, true);
  const right =
    source.toLowerCase() === target.toLowerCase()
      ? left
      : await database(c, uid, target, 30, true);
  return { source: left, target: right };
}

type Context = Awaited<ReturnType<typeof database>>;
export async function createReciprocalProperty(
  c: PoolClient,
  uid: string,
  source: Context,
  target: Context,
  name: string,
  reverseName: string,
) {
  const self = source.page.id === target.page.id;
  if (
    source.properties.length + (self ? 2 : 1) > 50 ||
    target.properties.length + 1 > 50
  )
    fail(400, "A database supports up to 50 active properties");
  if (self && name.toLocaleLowerCase() === reverseName.toLocaleLowerCase())
    fail(400, "Use different names for the two sides of this relation");
  if (
    target.properties.some(
      (property) =>
        property.name.toLocaleLowerCase() === reverseName.toLocaleLowerCase(),
    )
  )
    fail(400, "Choose a new name for the matching property");
  const first = randomUUID(),
    reverse = randomUUID();
  const sourcePosition =
    Math.max(-1, ...source.properties.map((property) => property.position)) + 1;
  const targetPosition = self
    ? sourcePosition + 1
    : Math.max(-1, ...target.properties.map((property) => property.position)) +
      1;
  const result = await c.query(
    "INSERT INTO database_properties(id,database_id,name,type,config,position) VALUES($1,$2,$3,'Relation',$4,$5) RETURNING id,name,type,config,position",
    [
      first,
      source.page.id,
      name,
      { databaseId: target.page.id, reciprocalPropertyId: reverse },
      sourcePosition,
    ],
  );
  await c.query(
    "INSERT INTO database_properties(id,database_id,name,type,config,position) VALUES($1,$2,$3,'Relation',$4,$5)",
    [
      reverse,
      target.page.id,
      reverseName,
      { databaseId: source.page.id, reciprocalPropertyId: first },
      targetPosition,
    ],
  );
  const pair = [first, reverse].sort();
  await c.query("INSERT INTO database_relation_pairs VALUES($1,$2)", pair);
  await audit(c, uid, "database.property_created", { pageId: source.page.id });
  await audit(c, uid, "database.property_created", { pageId: target.page.id });
  return result.rows[0] as Property;
}

const references = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (id): id is string =>
              typeof id === "string" && z.uuid().safeParse(id).success,
          ),
        ),
      ].sort()
    : [];
export interface ReciprocalUpdate {
  pageId: string;
  values: Record<string, string[]>;
}

export async function lockReciprocalImportTargets(
  c: PoolClient,
  properties: Property[],
  records: { values: Record<string, unknown> }[],
) {
  const fields = properties.filter(
    (property) =>
      property.type === "Relation" && property.config.reciprocalPropertyId,
  );
  const ids = [
    ...new Set(
      records.flatMap((record) =>
        fields.flatMap((field) => references(record.values[field.id])),
      ),
    ),
  ].sort();
  if (ids.length)
    await c.query(
      "SELECT page_id FROM database_records WHERE page_id=ANY($1::uuid[]) ORDER BY page_id FOR UPDATE",
      [ids],
    );
}

/** Lock every affected record before the caller writes its source revision. */
export async function prepareReciprocalLinks(
  c: PoolClient,
  source: string,
  properties: Property[],
  values: Record<string, unknown>,
  expectedVersion?: number,
): Promise<ReciprocalUpdate[]> {
  const changed = properties.filter(
    (property) =>
      property.type === "Relation" &&
      property.config.reciprocalPropertyId &&
      Object.hasOwn(values, property.id),
  );
  if (!changed.length) return [];
  const pairs = (
    await c.query(
      `SELECT pair.left_property_id,pair.right_property_id,
    l.database_id AS left_database,l.config AS left_config,l.deleted_at AS left_deleted,
    r.database_id AS right_database,r.config AS right_config,r.deleted_at AS right_deleted
    FROM database_relation_pairs pair JOIN database_properties l ON l.id=pair.left_property_id JOIN database_properties r ON r.id=pair.right_property_id
    WHERE pair.left_property_id=ANY($1::uuid[]) OR pair.right_property_id=ANY($1::uuid[])
    ORDER BY pair.left_property_id FOR SHARE OF pair`,
      [changed.map((property) => property.id)],
    )
  ).rows;
  if (!pairs.length) return [];
  const prior = (
    await c.query("SELECT values FROM database_records WHERE page_id=$1", [
      source,
    ])
  ).rows[0];
  if (!prior) fail(404, "Record not found");
  const oldValues = expectedVersion === undefined ? {} : prior.values;
  const plans: {
    property: Property;
    reverse: string;
    target: string;
    before: string[];
    after: string[];
  }[] = [];
  for (const property of changed) {
    const pair = pairs.find((pair) =>
      [pair.left_property_id, pair.right_property_id].includes(property.id),
    );
    if (!pair) continue; // A concurrently disconnected pair is now one-way.
    const left = pair.left_property_id === property.id;
    const reverse = left ? pair.right_property_id : pair.left_property_id;
    const target = left ? pair.right_database : pair.left_database;
    if (
      pair.left_deleted ||
      pair.right_deleted ||
      pair.left_config.reciprocalPropertyId !== pair.right_property_id ||
      pair.right_config.reciprocalPropertyId !== pair.left_property_id ||
      property.config.databaseId !== target
    )
      fail(409, "This relation changed; reload before editing it");
    const after = references(values[property.id]);
    if (after.length > 50)
      fail(400, "A two-way relation supports up to 50 stored links per record");
    if (
      Object.hasOwn(values, reverse) &&
      target ===
        properties.find((item) => item.id === reverse)?.config.databaseId &&
      after.includes(source) !== references(values[reverse]).includes(source)
    )
      fail(400, "The two sides contain conflicting links to this record");
    plans.push({
      property,
      reverse,
      target,
      before: references(oldValues[property.id]),
      after,
    });
  }
  const ids = [
    ...new Set([
      source,
      ...plans.flatMap((plan) => [...plan.before, ...plan.after]),
    ]),
  ].sort();
  const locked = (
    await c.query(
      "SELECT page_id,database_id,values,version FROM database_records WHERE page_id=ANY($1::uuid[]) ORDER BY page_id FOR UPDATE",
      [ids],
    )
  ).rows;
  const sourceRow = locked.find((row) => row.page_id === source);
  if (
    !sourceRow ||
    (expectedVersion !== undefined && sourceRow.version !== expectedVersion)
  )
    fail(409, "Record changed or unavailable; reload first");
  const rows = new Map(
    locked.map((row) => [row.page_id, { ...row, values: { ...row.values } }]),
  );
  const current = rows.get(source)!;
  current.values = { ...current.values, ...values };
  const updates = new Map<string, Record<string, string[]>>();
  for (const plan of plans) {
    const removed = plan.before.filter((id) => !plan.after.includes(id));
    const added = plan.after.filter((id) => !plan.before.includes(id));
    for (const [targets, add] of [
      [removed, false],
      [added, true],
    ] as const)
      for (const id of targets) {
        const row = rows.get(id);
        if (!row || row.database_id !== plan.target) continue;
        const before = references(row.values[plan.reverse]);
        const after = add
          ? [...new Set([...before, source])].sort()
          : before.filter((value) => value !== source);
        if (after.length > 50)
          fail(
            400,
            "A related record cannot accept another link in this two-way relation",
          );
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        row.values[plan.reverse] = after;
        const patch = updates.get(id) || {};
        patch[plan.reverse] = after;
        updates.set(id, patch);
      }
  }
  return [...updates].map(([pageId, values]) => ({ pageId, values }));
}
export async function applyReciprocalLinks(
  c: PoolClient,
  updates: ReciprocalUpdate[],
) {
  for (const update of updates) {
    await c.query(
      "UPDATE database_records SET values=values||$1::jsonb,version=version+1 WHERE page_id=$2",
      [update.values, update.pageId],
    );
    await c.query("SELECT orvyn_replace_record_relations($1)", [update.pageId]);
  }
}
export async function disconnectReciprocalProperty(
  c: PoolClient,
  propertyId: string,
) {
  await c.query(
    "DELETE FROM database_relation_pairs WHERE left_property_id=$1 OR right_property_id=$1",
    [propertyId],
  );
}
export async function installClonedReciprocalPairs(
  c: PoolClient,
  properties: Property[],
) {
  const ids = new Set(properties.map((property) => property.id));
  for (const property of properties) {
    const reverse = property.config.reciprocalPropertyId;
    if (!reverse || !ids.has(reverse) || property.id >= reverse) continue;
    await c.query("INSERT INTO database_relation_pairs VALUES($1,$2)", [
      property.id,
      reverse,
    ]);
  }
}

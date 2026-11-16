import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  z,
  propertyInput,
  viewInput,
  queryInput,
  computedPropertyTypes,
  type Property,
  type ViewConfig,
  type QueryInput,
  formulaPropertyType,
} from "@orvyn/shared";
import { formulaConfig, formulaSql } from "./formula.js";
import { loadRollupCatalog, rollupSql } from "./rollup.js";
import { fail } from "../runtime.js";
import { pageAccess, pageWrite } from "../permissions/access.js";
export function parse<T>(
  schema: { safeParse: (value: unknown) => any },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) return fail(400, "Invalid database request");
  return result.data as T;
}
export async function database(
  c: Pool | PoolClient,
  uid: string,
  id: string,
  min = 10,
  write = false,
) {
  const page = write
    ? await pageWrite(c as PoolClient, uid, id, min)
    : await pageAccess(c, uid, id, min);
  const row = (
    await c.query("SELECT schema_version FROM databases WHERE page_id=$1", [
      page.id,
    ])
  ).rows[0];
  if (!row) return fail(404, "Database not found");
  const properties = (
    await c.query(
      "SELECT id,name,type,config,position FROM database_properties WHERE database_id=$1 AND deleted_at IS NULL ORDER BY position,id",
      [page.id],
    )
  ).rows as Property[];
  await loadRollupCatalog(c, uid, page.space_id, properties);
  const views = (
    await c.query(
      "SELECT id,name,type,config,version FROM database_views WHERE database_id=$1 ORDER BY position,id",
      [page.id],
    )
  ).rows;
  return {
    page,
    schemaVersion: row.schema_version as number,
    properties,
    views,
  };
}
export function propertyOptions(labels: string[]) {
  if (
    labels.length < 1 ||
    new Set(labels.map((l) => l.toLowerCase())).size !== labels.length
  )
    fail(400, "Provide unique option names");
  return {
    options: labels.map((label, index) => ({
      id: randomUUID(),
      label,
      color: ["neutral", "violet", "green", "blue", "amber"][index % 5],
    })),
  };
}
export function propertyConfig(
  input: ReturnType<typeof propertyInput.parse>,
  properties: Property[] = [],
) {
  if (input.type === "Rollup") {
    if (
      !input.rollup ||
      input.options.length ||
      input.relationDatabaseId ||
      input.formula
    )
      fail(400, "Choose a relation and calculation for the rollup.");
    return { rollup: input.rollup!, resultType: "number" as const };
  }
  if (input.rollup) fail(400, "Only Rollup properties accept a calculation.");
  if (input.type === "Formula") {
    if (!input.formula || input.options.length || input.relationDatabaseId)
      fail(400, "Enter a formula without options or a related database.");
    return formulaConfig(input.formula!, properties);
  }
  if (input.formula) fail(400, "Only Formula properties accept an expression.");
  if (input.type === "Relation") {
    if (!input.relationDatabaseId || input.options.length)
      fail(400, "Choose a database for the relation property");
    return { databaseId: input.relationDatabaseId };
  }
  if (input.relationDatabaseId)
    fail(400, "A related database belongs to a relation property");
  if (["Select", "MultiSelect", "Status"].includes(input.type))
    return propertyOptions(input.options);
  if (input.options.length)
    fail(400, "Options are only supported for select and status properties");
  return {};
}
export function valueFor(
  property: Property,
  value: unknown,
  filter = false,
): any {
  if (value === null) return null;
  const invalid = (): never => fail(400, "Invalid value for " + property.name);
  if (property.type === "Formula" || property.type === "Rollup") {
    if (!filter) return invalid();
    const type = formulaPropertyType(property);
    if (
      type === "number" &&
      typeof value === "number" &&
      Number.isFinite(value)
    )
      return value;
    if (type === "boolean" && typeof value === "boolean") return value;
    if (
      (type === "text" || type === "null") &&
      typeof value === "string" &&
      value.length <= 10000
    )
      return value;
    return invalid();
  }
  if (property.type === "Title") {
    if (typeof value !== "string" || value.length > 300) return invalid();
    return value;
  }
  if (property.type === "Number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return invalid();
    return value;
  }
  if (property.type === "Checkbox") {
    if (typeof value !== "boolean") return invalid();
    return value;
  }
  if (["Select", "Status"].includes(property.type)) {
    if (
      typeof value !== "string" ||
      !property.config.options?.some((o) => o.id === value)
    )
      return invalid();
    return value;
  }
  if (["Person", "Files", "Relation"].includes(property.type)) {
    if (
      !Array.isArray(value) ||
      value.length > 50 ||
      value.some((v) => !z.uuid().safeParse(v).success)
    )
      return invalid();
    const normalized = value.map((v: string) => v.toLowerCase()).sort();
    if (new Set(normalized).size !== normalized.length) return invalid();
    return normalized;
  }
  if (property.type === "MultiSelect") {
    if (
      !Array.isArray(value) ||
      value.length > 50 ||
      new Set(value).size !== value.length ||
      value.some(
        (v) =>
          typeof v !== "string" ||
          !property.config.options?.some((o) => o.id === v),
      )
    )
      return invalid();
    return [...value].sort();
  }
  if (property.type === "Date") {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      value.startsWith("0000")
    )
      return invalid();
    try {
      if (new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value)
        return invalid();
    } catch {
      return invalid();
    }
    return value;
  }
  if ((computedPropertyTypes as readonly string[]).includes(property.type)) {
    if (!filter) return invalid();
    if (property.type.endsWith("By")) {
      if (typeof value !== "string" || !z.uuid().safeParse(value).success)
        return invalid();
      return value;
    }
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
      return invalid();
    return new Date(value).toISOString();
  }
  if (typeof value !== "string" || value.length > 10000) return invalid();
  if (
    property.type === "Email" &&
    value &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  )
    return invalid();
  if (property.type === "URL" && value) {
    try {
      if (!["https:", "http:"].includes(new URL(value).protocol))
        return invalid();
    } catch {
      return invalid();
    }
  }
  if (property.type === "Phone" && value.length > 100) return invalid();
  return value;
}
export function valuesFor(properties: Property[], input: unknown) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    JSON.stringify(input).length > 100000
  )
    return fail(400, "Invalid property values");
  const result: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(input)) {
    const property = properties.find((p) => p.id === id);
    if (!property) return fail(400, "Unknown property");
    if (
      property.type === "Title" ||
      (computedPropertyTypes as readonly string[]).includes(property.type)
    )
      fail(400, "This property is managed by the page");
    result[id] = valueFor(property, value);
  }
  return result;
}
export function checkedView(
  properties: Property[],
  type: string,
  config: ViewConfig,
) {
  const find = (id: string) =>
    properties.find((p) => p.id === id) || fail(400, "Unknown view property");
  if (
    new Set(config.visibleProperties).size !== config.visibleProperties.length
  )
    fail(400, "Duplicate visible property");
  for (const id of config.visibleProperties) find(id);
  if (
    config.groupBy &&
    !["Status", "Select"].includes(find(config.groupBy).type)
  )
    fail(400, "Group by a status or select property");
  if (config.dateProperty && find(config.dateProperty).type !== "Date")
    fail(400, "Calendar requires a date property");
  if (type === "Calendar" && config.groupBy)
    fail(400, "Calendar views group by date");
  if (type === "Board" && !config.groupBy)
    fail(400, "Choose a grouping property for the board");
  if (type === "Calendar" && !config.dateProperty)
    fail(400, "Choose a date property for the calendar");
  for (const item of [...config.filters, ...config.sorts])
    find(item.propertyId);
  return config;
}
export function formulaFilterProperty(property: Property): Property {
  if (property.type !== "Formula" && property.type !== "Rollup")
    return property;
  const type = formulaPropertyType(property);
  return {
    ...property,
    type:
      type === "number" ? "Number" : type === "boolean" ? "Checkbox" : "Text",
  };
}
function formulaBaseField(
  property: Property,
  bind: (value: unknown) => string,
  actor: string,
  page = "p",
  record = "r",
): string {
  if (property.type === "Title") return `${page}.title`;
  if (property.type === "Relation")
    return `orvyn_record_relation_values(${page}.id,${bind(property.id)}::uuid,${actor}::uuid)`;
  if (property.type === "Files")
    return `orvyn_record_file_values(${page}.id,${bind(property.id)}::uuid)`;
  if (property.type === "CreatedTime") return `${page}.created_at::text`;
  if (property.type === "LastEditedTime") return `${page}.updated_at::text`;
  if (property.type === "CreatedBy") return `${page}.created_by::text`;
  if (property.type === "LastEditedBy") return `${page}.last_edited_by::text`;
  const id = bind(property.id),
    raw = `(${record}.values->>${id})`;
  if (property.type === "Number") return `(${raw})::double precision`;
  if (property.type === "Checkbox") return `(${raw})::boolean`;
  if (property.type === "Select" || property.type === "Status")
    return `(SELECT option->>'label' FROM jsonb_array_elements(${bind(JSON.stringify(property.config.options || []))}::jsonb) option WHERE option->>'id'=${raw} LIMIT 1)`;
  if (property.type === "MultiSelect")
    return `(SELECT coalesce(jsonb_agg(option->>'label' ORDER BY option->>'id'),'[]'::jsonb) FROM jsonb_array_elements(${bind(JSON.stringify(property.config.options || []))}::jsonb) option WHERE (${record}.values->${id}) ? (option->>'id'))`;
  if (property.type === "Person") return `(${record}.values->${id})`;
  return raw;
}
function calculatedField(
  property: Property,
  properties: Property[],
  bind: (value: unknown) => string,
  actor: string,
  page = "p",
  record = "r",
): string {
  if (property.type === "Formula")
    return formulaSql(property.config.expression!, properties, bind, (p) =>
      calculatedField(p, properties, bind, actor, page, record),
    ).sql;
  if (property.type === "Rollup")
    return rollupSql(property, properties, bind, actor, (target, targets) =>
      calculatedField(
        target,
        targets,
        bind,
        actor,
        "rollup_page",
        "rollup_record",
      ),
    );
  return formulaBaseField(property, bind, actor, page, record);
}
export function querySql(
  properties: Property[],
  config: ViewConfig,
  input: QueryInput,
  uid: string,
  id: string,
) {
  const params: any[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return "$" + params.length;
  };
  const find = (id: string) =>
    properties.find((p) => p.id === id) || fail(400, "Unknown query property");
  const actor = bind(uid);
  function baseField(property: Property) {
    if (property.type === "Title") return "p.title";
    if (property.type === "Relation")
      return `orvyn_record_relation_values(p.id,${bind(property.id)}::uuid,${bind(uid)}::uuid)`;
    if (property.type === "Files")
      return `orvyn_record_file_values(p.id,${bind(property.id)}::uuid)`;
    if (property.type === "CreatedTime") return "p.created_at";
    if (property.type === "LastEditedTime") return "p.updated_at";
    if (property.type === "CreatedBy") return "p.created_by::text";
    if (property.type === "LastEditedBy") return "p.last_edited_by::text";
    if (["MultiSelect", "Person", "Files", "Relation"].includes(property.type))
      return `(r.values->${bind(property.id)})`;
    const raw = `(r.values->>${bind(property.id)})`;
    if (property.type === "Number") return `(${raw})::numeric`;
    if (property.type === "Checkbox") return `(${raw})::boolean`;
    return raw;
  }
  const formulaField = (property: Property) =>
    calculatedField(property, properties, bind, actor);
  const field = (property: Property) =>
    property.type === "Formula" || property.type === "Rollup"
      ? formulaField(property)
      : baseField(property);
  const conditions = [
    `r.database_id=${bind(id)}`,
    `orvyn_page_role(p.id,${actor})>=10`,
    `strpos(lower(p.title),lower(${bind(input.search)}))>0`,
  ];
  for (const filter of input.filters || config.filters) {
    const original = find(filter.propertyId),
      property = formulaFilterProperty(original),
      expression = field(original),
      op = filter.operator;
    if (op === "empty" || op === "notEmpty") {
      const empty =
        property.type === "Number" ||
        property.type === "Checkbox" ||
        property.type.endsWith("Time")
          ? `${expression} IS NULL`
          : `(${expression} IS NULL OR ${expression}::text='' OR ${expression}::text='[]')`;
      conditions.push(op === "empty" ? `(${empty})` : `NOT (${empty})`);
      continue;
    }
    if (op === "contains") {
      if (
        ["MultiSelect", "Person", "Files", "Relation"].includes(property.type)
      ) {
        if (
          typeof filter.value !== "string" ||
          (["Person", "Files", "Relation"].includes(property.type)
            ? !z.uuid().safeParse(filter.value).success
            : !property.config.options?.some((o) => o.id === filter.value))
        )
          fail(400, "Invalid option filter");
        conditions.push(
          `${expression} ? ${bind(["Person", "Files", "Relation"].includes(property.type) ? (filter.value as string).toLowerCase() : filter.value)}`,
        );
      } else {
        if (
          !["Title", "Text", "URL", "Email", "Phone"].includes(property.type) ||
          typeof filter.value !== "string"
        )
          fail(400, "Contains requires a text property");
        conditions.push(
          `strpos(lower(coalesce(${expression},'')),lower(${bind(filter.value)}))>0`,
        );
      }
      continue;
    }
    if (op === "in") {
      if (
        !["Select", "Status"].includes(property.type) ||
        !Array.isArray(filter.value) ||
        filter.value.length > 50
      )
        fail(400, "Invalid option filter");
      const values = (filter.value as unknown[]).map((v) =>
        valueFor(property, v, true),
      );
      conditions.push(`${expression}=ANY(${bind(values)}::text[])`);
      continue;
    }
    const value = valueFor(property, filter.value, true);
    if (
      ["MultiSelect", "Person", "Files", "Relation"].includes(property.type)
    ) {
      if (!["eq", "neq"].includes(op)) fail(400, "Invalid list comparison");
      conditions.push(
        `coalesce(${expression},'null'::jsonb) ${op === "eq" ? "=" : "<>"} ${bind(JSON.stringify(value))}::jsonb`,
      );
      continue;
    }
    const cast =
      property.type === "Number"
        ? "::numeric"
        : property.type === "Checkbox"
          ? "::boolean"
          : property.type.endsWith("Time")
            ? "::timestamptz"
            : "::text";
    if (op === "eq" || op === "neq") {
      conditions.push(
        `${expression} IS ${op === "eq" ? "NOT " : ""}DISTINCT FROM ${bind(value)}${cast}`,
      );
      continue;
    }
    if (
      !["Number", "Date", "CreatedTime", "LastEditedTime"].includes(
        property.type,
      ) ||
      value === null
    )
      fail(400, "Comparison requires a number or date");
    const operators = { gt: ">", gte: ">=", lt: "<", lte: "<=" };
    conditions.push(
      `${expression}${operators[op as keyof typeof operators]}${bind(value)}${cast}`,
    );
  }
  if (input.rangeStart || input.rangeEnd) {
    if (!config.dateProperty)
      return fail(400, "Date range requires a calendar property");
    const property = find(config.dateProperty),
      expression = field(property);
    if (input.rangeStart)
      conditions.push(
        `${expression}>=${bind(valueFor(property, input.rangeStart, true))}`,
      );
    if (input.rangeEnd)
      conditions.push(
        `${expression}<=${bind(valueFor(property, input.rangeEnd, true))}`,
      );
  }
  const sorts = (input.sorts || config.sorts).map((sort) => {
    const property = find(sort.propertyId);
    if (["MultiSelect", "Person", "Files", "Relation"].includes(property.type))
      fail(400, "List property sorting is not supported");
    let expression = field(property);
    if (["Select", "Status"].includes(property.type))
      expression = `array_position(${bind(property.config.options?.map((o) => o.id) || [])}::text[],${expression})`;
    return `${expression} ${sort.direction === "asc" ? "ASC" : "DESC"} NULLS LAST`;
  });
  if (!sorts.length) sorts.push("p.title ASC");
  sorts.push("p.id ASC");
  const limit = bind(input.limit + 1),
    offset = bind(input.offset);
  const sql = `SELECT ${recordColumns(bind(uid), properties, bind)} ${recordFrom} WHERE ${conditions.join(" AND ")} ORDER BY ${sorts.join(",")} LIMIT ${limit} OFFSET ${offset}`;
  return { sql, params };
}

export const recordFrom =
  "FROM database_records r JOIN pages p ON p.id=r.page_id LEFT JOIN users creator ON creator.id=p.created_by LEFT JOIN users editor ON editor.id=p.last_edited_by";
export function recordColumns(
  actor: string,
  properties: Property[],
  bind: (value: unknown) => string,
) {
  const computed = properties
    .filter((p) => p.type === "Formula" || p.type === "Rollup")
    .flatMap((property) => [
      `${bind(property.id)}::text`,
      `to_jsonb(${calculatedField(property, properties, bind, actor)})`,
    ]);
  const formulas = `${computed.length ? `jsonb_build_object(${computed.join(",")})` : "'{}'::jsonb"} AS formula_values`;
  const files = `(SELECT coalesce(jsonb_object_agg(dp.id,orvyn_record_file_values(p.id,dp.id)),'{}'::jsonb) FROM database_properties dp WHERE dp.database_id=r.database_id AND dp.type='Files' AND dp.deleted_at IS NULL) AS file_values,(SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'filename',f.filename,'mediaType',f.media_type,'size',f.size) ORDER BY f.created_at),'[]'::jsonb) FROM files f WHERE f.page_id=p.id AND f.state='ready' AND EXISTS(SELECT 1 FROM database_properties dp WHERE dp.database_id=r.database_id AND dp.type='Files' AND dp.deleted_at IS NULL)) AS file_choices`;
  const relations = `(SELECT coalesce(jsonb_object_agg(dp.id,orvyn_record_relation_values(p.id,dp.id,${actor}::uuid)),'{}'::jsonb) FROM database_properties dp WHERE dp.database_id=r.database_id AND dp.type='Relation' AND dp.deleted_at IS NULL) AS relation_values,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',item.id,'title',item.title,'icon',item.icon,'revision',item.revision) ORDER BY item.title,item.id),'[]'::jsonb) FROM (
      SELECT DISTINCT target.id,target.title,target.icon,concat_ws(':',target.version,target.title_version,target.appearance_version,tr.version,target_database.schema_version) AS revision FROM record_relations rr JOIN database_properties dp ON dp.id=rr.property_id AND dp.database_id=r.database_id AND dp.type='Relation' AND dp.deleted_at IS NULL JOIN database_records tr ON tr.page_id=rr.target_id AND tr.database_id::text=dp.config->>'databaseId' JOIN databases target_database ON target_database.page_id=tr.database_id JOIN pages target ON target.id=tr.page_id AND target.space_id=p.space_id WHERE rr.source_id=p.id AND orvyn_page_role(p.id,${actor}::uuid)>=10 AND orvyn_page_role(target.id,${actor}::uuid)>=10
    ) item) AS relation_choices`;
  return `${files},${relations},${formulas},p.id,p.title,p.icon,p.cover_preset,p.title_version,p.created_at,p.updated_at,p.created_by,p.last_edited_by,creator.email AS creator_email,editor.email AS editor_email,r.values,r.version,orvyn_page_role(p.id,${actor}) AS access_rank,CASE WHEN p.appearance_version=1 THEN (SELECT id FROM files WHERE page_id=p.id AND state='ready' AND media_type IN ('image/png','image/jpeg','image/gif','image/webp') ORDER BY created_at LIMIT 1) ELSE (SELECT id FROM files WHERE id=p.cover_file_id AND page_id=p.id AND state='ready' AND media_type IN ('image/png','image/jpeg','image/gif','image/webp')) END AS cover_file_id`;
}
export function recordDTO(row: any, properties: Property[]) {
  const values: Record<string, unknown> = {};
  for (const property of properties) {
    switch (property.type) {
      case "Formula":
      case "Rollup":
        values[property.id] = row.formula_values?.[property.id] ?? null;
        break;
      case "Relation":
        values[property.id] = row.relation_values?.[property.id] || [];
        break;
      case "Files":
        values[property.id] = row.file_values?.[property.id] || [];
        break;
      case "Title":
        values[property.id] = row.title;
        break;
      case "CreatedTime":
        values[property.id] = new Date(row.created_at).toISOString();
        break;
      case "LastEditedTime":
        values[property.id] = new Date(row.updated_at).toISOString();
        break;
      case "CreatedBy":
        values[property.id] = row.created_by;
        break;
      case "LastEditedBy":
        values[property.id] = row.last_edited_by;
        break;
      default:
        values[property.id] = row.values[property.id] ?? null;
    }
  }
  const visibleRelations = new Set(
    properties
      .filter((p) => p.type === "Relation")
      .flatMap((p) => row.relation_values?.[p.id] || []),
  );
  return {
    pageId: row.id,
    title: row.title,
    titleVersion: row.title_version,
    version: row.version,
    values,
    accessRank: row.access_rank,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    createdBy: row.created_by
      ? { id: row.created_by, email: row.creator_email }
      : null,
    lastEditedBy: row.last_edited_by
      ? { id: row.last_edited_by, email: row.editor_email }
      : null,
    coverFileId: row.cover_file_id || null,
    icon: row.icon || null,
    coverPreset: row.cover_preset || null,
    ...(properties.some((p) => p.type === "Relation")
      ? {
          relations: (row.relation_choices || []).filter((record: any) =>
            visibleRelations.has(record.id),
          ),
        }
      : {}),
    ...(properties.some((p) => p.type === "Files")
      ? { files: row.file_choices || [] }
      : {}),
  };
}
export async function recordSnapshot(
  c: Pool | PoolClient,
  uid: string,
  id: string,
  pageId: string,
  properties: Property[],
) {
  const params: unknown[] = [pageId, uid, id],
    bind = (value: unknown) => {
      params.push(value);
      return "$" + params.length;
    };
  const r = await c.query(
    `SELECT ${recordColumns("$2", properties, bind)} ${recordFrom} WHERE r.page_id::text=$1 AND r.database_id=$3 AND orvyn_page_role(p.id,$2)>=10`,
    params,
  );
  if (!r.rowCount) return fail(404, "Record not found");
  return recordDTO(r.rows[0], properties);
}

// Callers must authorize the space/page before resolving this directory.
export async function personDirectory(
  c: Pool | PoolClient,
  spaceId: string,
): Promise<{ id: string; email: string }[]> {
  return (
    await c.query(
      "SELECT u.id,u.email FROM users u JOIN spaces s ON s.id=$1 LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=u.id WHERE u.id=s.owner_id OR m.user_id=u.id ORDER BY u.email",
      [spaceId],
    )
  ).rows;
}
export async function checkPeople(
  c: PoolClient,
  spaceId: string,
  properties: Property[],
  values: Record<string, unknown>,
  previous: Record<string, unknown> = {},
) {
  const ids = new Set<string>();
  for (const property of properties.filter((p) => p.type === "Person")) {
    const before = Array.isArray(previous[property.id])
      ? (previous[property.id] as string[])
      : [];
    for (const id of (values[property.id] as string[] | null | undefined) || [])
      if (!before.includes(id)) ids.add(id);
  }
  if (!ids.size) return;
  const allowed = (
    await c.query(
      "SELECT u.id FROM users u JOIN spaces s ON s.id=$1 LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=u.id WHERE u.id=ANY($2::uuid[]) AND (u.id=s.owner_id OR m.user_id=u.id)",
      [spaceId, [...ids]],
    )
  ).rows;
  if (allowed.length !== ids.size)
    fail(400, "New person assignments must be current members of this space");
}

export async function checkFiles(
  c: PoolClient,
  pageId: string | null,
  properties: Property[],
  values: Record<string, unknown>,
) {
  const ids = new Set(
    properties
      .filter((p) => p.type === "Files")
      .flatMap((p) => (values[p.id] as string[] | null | undefined) || []),
  );
  if (!ids.size) return;
  if (!pageId)
    return fail(
      400,
      "Create the record first, then upload and select its attachments",
    );
  const ready = (
    await c.query(
      "SELECT id FROM files WHERE page_id=$1 AND id=ANY($2::uuid[]) AND state='ready'",
      [pageId, [...ids]],
    )
  ).rows;
  if (ready.length !== ids.size)
    fail(400, "Select ready attachments belonging to this record");
}

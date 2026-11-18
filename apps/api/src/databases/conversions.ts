import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import {
  z,
  convertiblePropertyTypes,
  formulaType,
  databaseColumnMinWidth,
  type ConvertiblePropertyType,
  type Property,
  type ViewConfig,
} from "@orvyn/shared";
import { fail } from "../runtime.js";
import { encryptionKey } from "../auth/security.js";
import { database, checkedView } from "./model.js";
import { validatePropertySet } from "./properties.js";
import {
  convertPropertyCell,
  emptyPropertyCell,
  samePropertyCell,
  type StoredPropertyCell,
} from "./conversion-values.js";

export const conversionChoice = z.union([
  z.object({ toType: z.enum(convertiblePropertyTypes) }).strict(),
  z.object({ historyId: z.uuid() }).strict(),
]);
export type ConversionChoice = z.infer<typeof conversionChoice>;
const tokenShape = z
  .object({
    version: z.literal(1),
    actor: z.uuid(),
    database: z.uuid(),
    property: z.uuid(),
    toType: z.enum(convertiblePropertyTypes),
    historyId: z.uuid().nullable(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    expires: z.number().int().positive(),
  })
  .strict();
export type ConversionToken = z.infer<typeof tokenShape>;
const previewKey = () =>
  createHmac("sha256", encryptionKey())
    .update("orvyn:property-conversion:v1")
    .digest();
export function signConversionToken(payload: ConversionToken) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", previewKey())
    .update(encoded)
    .digest("base64url");
  return encoded + "." + signature;
}
export function decodeConversionToken(value: string): ConversionToken {
  try {
    const parts = value.split(".");
    const [encoded, signature] = parts;
    if (
      !encoded ||
      !signature ||
      parts.length !== 2 ||
      !/^[A-Za-z0-9_-]+$/.test(encoded + signature)
    )
      throw Error();
    const expected = createHmac("sha256", previewKey())
      .update(encoded)
      .digest();
    const supplied = Buffer.from(signature, "base64url");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw Error();
    return tokenShape.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
  } catch {
    return fail(400, "Invalid conversion preview");
  }
}
export async function conversionContext(
  c: PoolClient,
  uid: string,
  id: string,
  propertyId: string,
  write = false,
) {
  if (!write)
    await c.query(
      "SELECT s.id FROM spaces s JOIN pages p ON p.space_id=s.id WHERE p.id::text=$1 FOR SHARE OF s",
      [id],
    );
  const context = await database(c, uid, id, 50, write);
  const property =
    context.properties.find((p) => p.id === propertyId) ||
    fail(404, "Property not found");
  if (!(convertiblePropertyTypes as readonly string[]).includes(property.type))
    fail(400, "This property type cannot be converted here");
  return { ...context, property };
}
type Context = Awaited<ReturnType<typeof conversionContext>>;
interface ConversionRow {
  id: string;
  title: string;
  title_version: number;
  version: number;
  deleted_at: string | null;
  present: boolean;
  value: unknown;
}
interface PlanRow {
  row: ConversionRow;
  before: StoredPropertyCell;
  after: StoredPropertyCell;
  restored: boolean;
}
function compatible(
  properties: Property[],
  property: Property,
  target: Property,
) {
  const next = properties.map((p) => (p.id === property.id ? target : p));
  validatePropertySet(next);
  for (const field of next.filter((p) => p.type === "Formula")) {
    if (formulaType(field.config.expression!, next) !== field.config.resultType)
      fail(
        409,
        "Update formulas that depend on this property's result type first",
      );
  }
  return next;
}
function repairedView(view: any, property: Property, properties: Property[]) {
  const config: ViewConfig = {
    ...view.config,
    filters: view.config.filters.filter(
      (filter: any) => filter.propertyId !== property.id,
    ),
    sorts: view.config.sorts.filter(
      (sort: any) => sort.propertyId !== property.id,
    ),
    groupBy: view.config.groupBy === property.id ? null : view.config.groupBy,
    dateProperty:
      view.config.dateProperty === property.id && property.type !== "Date"
        ? null
        : view.config.dateProperty,
  };
  if (config.propertyWidths?.[property.id] !== undefined)
    config.propertyWidths = {
      ...config.propertyWidths,
      [property.id]: Math.max(
        config.propertyWidths[property.id]!,
        databaseColumnMinWidth(property),
      ),
    };
  const type =
    (view.type === "Calendar" && !config.dateProperty) ||
    (view.type === "Board" && !config.groupBy)
      ? "Table"
      : view.type;
  checkedView(properties, type, config);
  return { ...view, type, config };
}
export async function planConversion(
  c: PoolClient,
  context: Context,
  choice: ConversionChoice,
  lock = false,
) {
  let history: any;
  const originals = new Map<string, any>();
  if ("historyId" in choice) {
    history =
      (
        await c.query(
          "SELECT * FROM database_property_changes WHERE id=$1 AND property_id=$2",
          [choice.historyId, context.property.id],
        )
      ).rows[0] || fail(404, "Conversion history not found");
    if (history.to_type !== context.property.type)
      fail(
        409,
        "The field type changed. Review a conversion from its current type first.",
      );
    for (const item of (
      await c.query(
        "SELECT * FROM database_property_change_values WHERE change_id=$1",
        [history.id],
      )
    ).rows)
      originals.set(item.page_id, item);
  }
  const toType: ConvertiblePropertyType =
    history?.from_type ||
    (choice as { toType: ConvertiblePropertyType }).toType;
  if (!history && toType === context.property.type)
    fail(400, "Choose a different property type");
  const target: Property = {
    ...context.property,
    type: toType,
    config: history?.from_config || {},
  };
  const properties = compatible(context.properties, context.property, target);
  const rows: ConversionRow[] = (
    await c.query(
      `SELECT p.id,p.title,p.title_version,p.deleted_at,r.version,r.values ? $2 AS present,coalesce(r.values->$2,'null'::jsonb) AS value
     FROM database_records r JOIN pages p ON p.id=r.page_id WHERE r.database_id=$1 ORDER BY p.id LIMIT 5001 ${lock ? "FOR UPDATE OF r" : ""}`,
      [context.page.id, context.property.id],
    )
  ).rows;
  if (rows.length > 5000)
    fail(
      413,
      "Changing the type is currently supported for databases with up to 5,000 records.",
    );
  const items: PlanRow[] = rows.map((row) => {
    const before: StoredPropertyCell = {
      present: row.present,
      value: row.value,
    };
    const original = originals.get(row.id);
    const restored =
      !!original &&
      JSON.stringify(context.property.config) ===
        JSON.stringify(history.to_config) &&
      samePropertyCell(before, {
        present: original.converted_present,
        value: original.converted_value,
      });
    const after = restored
      ? { present: original.original_present, value: original.original_value }
      : convertPropertyCell(before, context.property, toType);
    return { row, before, after, restored };
  });
  const views = context.views.map((view) =>
    repairedView(view, target, properties),
  );
  const changedViews = views.filter(
    (view, i) =>
      view.type !== context.views[i]!.type ||
      JSON.stringify(view.config) !== JSON.stringify(context.views[i]!.config),
  );
  const changed = items.filter(
    (item) => !samePropertyCell(item.before, item.after),
  );
  const cleared = changed.filter(
    (item) => !emptyPropertyCell(item.before) && emptyPropertyCell(item.after),
  );
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: context.schemaVersion,
        property: context.property,
        toType,
        toConfig: target.config,
        historyId: history?.id || null,
        rows: items.map((item) => [
          item.row.id,
          item.row.version,
          item.row.title_version,
          item.row.deleted_at,
          item.before,
          item.after,
        ]),
        views: context.views.slice().sort((a, b) => a.id.localeCompare(b.id)),
      }),
    )
    .digest("hex");
  return {
    target,
    items,
    changed,
    cleared,
    changedViews,
    digest,
    historyId: history?.id || null,
  };
}
function display(value: StoredPropertyCell) {
  if (!value.present || value.value === null || value.value === "") return null;
  const text =
    typeof value.value === "string" ? value.value : JSON.stringify(value.value);
  return text.length > 300 ? text.slice(0, 300) + "…" : text;
}
export function conversionPreview(
  context: Context,
  plan: Awaited<ReturnType<typeof planConversion>>,
  uid: string,
) {
  const changedIds = new Set(plan.changed.map((item) => item.row.id));
  const samples = [
    ...plan.changed,
    ...plan.items.filter((item) => !changedIds.has(item.row.id)),
  ].slice(0, 20);
  return {
    property: {
      id: context.property.id,
      name: context.property.name,
      type: context.property.type,
    },
    toType: plan.target.type,
    totalRecords: plan.items.length,
    changedValues: plan.changed.length,
    clearedValues: plan.cleared.length,
    archivedRecords: plan.items.filter((item) => item.row.deleted_at).length,
    restoredValues: plan.items.filter((item) => item.restored).length,
    affectedViews: plan.changedViews.map((view) => ({
      id: view.id,
      name: view.name,
      type: view.type,
    })),
    samples: samples.map((item) => ({
      id: item.row.id,
      title: item.row.title,
      archived: !!item.row.deleted_at,
      before: display(item.before),
      after: display(item.after),
      restored: item.restored,
    })),
    previewToken: signConversionToken({
      version: 1,
      actor: uid,
      database: context.page.id,
      property: context.property.id,
      toType: plan.target.type as ConvertiblePropertyType,
      historyId: plan.historyId,
      digest: plan.digest,
      expires: Date.now() + 10 * 60_000,
    }),
  };
}

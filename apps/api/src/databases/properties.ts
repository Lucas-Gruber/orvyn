import type { PoolClient } from "pg";
import {
  z,
  formulaType,
  type Property,
  type ViewConfig,
  type FormulaNode,
} from "@orvyn/shared";
import { randomUUID } from "node:crypto";
import { fail } from "../runtime.js";

export const optionChanges = z
  .array(
    z
      .object({
        id: z.uuid().optional(),
        label: z.string().trim().min(1).max(80),
        color: z.enum(["neutral", "violet", "green", "blue", "amber"]),
      })
      .strict(),
  )
  .max(50);

export async function updateOptions(
  c: PoolClient,
  databaseId: string,
  property: Property,
  input: z.infer<typeof optionChanges>,
  confirm: boolean,
  views: any[],
) {
  if (!["Select", "MultiSelect", "Status"].includes(property.type))
    fail(400, "Only selection properties accept options.");
  if (
    new Set(input.map((item) => item.label.toLowerCase())).size !== input.length
  )
    fail(400, "Option names must be unique.");
  const archived = (
    await c.query(
      "SELECT option_id AS id,label,color FROM database_deleted_options WHERE property_id=$1",
      [property.id],
    )
  ).rows;
  const known = new Set(
    [...(property.config.options || []), ...archived].map((item) => item.id),
  );
  if (input.some((item) => item.id && !known.has(item.id)))
    fail(400, "Unknown option.");
  const next = input.map((item) => ({ ...item, id: item.id || randomUUID() }));
  if (new Set(next.map((item) => item.id)).size !== next.length)
    fail(400, "Duplicate option.");
  const removed = (property.config.options || []).filter(
    (item) => !next.some((value) => value.id === item.id),
  );
  if (removed.length && !confirm)
    fail(
      400,
      "Confirm option removal and the removal of filters that use those options.",
    );
  for (const item of removed) {
    await c.query(
      `INSERT INTO database_deleted_options(property_id,option_id,label,color,position) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(property_id,option_id) DO UPDATE SET label=excluded.label,color=excluded.color,position=excluded.position,deleted_at=now()`,
      [
        property.id,
        item.id,
        item.label,
        item.color,
        property.config.options!.findIndex((value) => value.id === item.id),
      ],
    );
  }
  await c.query(
    "DELETE FROM database_deleted_options WHERE property_id=$1 AND option_id=ANY($2::uuid[])",
    [property.id, next.map((item) => item.id)],
  );
  if (removed.length)
    await cleanViews(
      c,
      databaseId,
      views,
      property.id,
      new Set(removed.map((item) => item.id)),
    );
  return { ...property.config, options: next };
}

export function validatePropertySet(properties: Property[]) {
  try {
    const ids = new Set(properties.map((item) => item.id));
    function references(node: FormulaNode) {
      if (node.kind === "property" && !ids.has(node.id))
        throw Error("Missing formula property");
      if (node.kind === "binary") {
        references(node.left);
        references(node.right);
      }
      if (node.kind === "unary") references(node.arg);
      if (node.kind === "call") node.args.forEach(references);
    }
    for (const property of properties) {
      if (property.type === "Formula") {
        references(property.config.expression!);
        formulaType(property.config.expression!, properties);
      }
      if (
        property.type === "Rollup" &&
        !properties.some(
          (item) =>
            item.id === property.config.rollup?.relationId &&
            item.type === "Relation",
        )
      )
        throw Error("Missing relation");
    }
  } catch {
    fail(
      409,
      "Update the formulas and rollups that depend on this property first.",
    );
  }
}

export async function cleanViews(
  c: PoolClient,
  databaseId: string,
  views: any[],
  propertyId: string,
  removedOptions?: Set<string>,
) {
  for (const view of views) {
    const previous: ViewConfig = view.config;
    const config: ViewConfig = {
      ...previous,
      filters: previous.filters.filter(
        (filter) =>
          filter.propertyId !== propertyId ||
          (removedOptions &&
            ![filter.value]
              .flat()
              .some((value) => removedOptions.has(String(value)))),
      ),
      sorts: removedOptions
        ? previous.sorts
        : previous.sorts.filter((sort) => sort.propertyId !== propertyId),
      visibleProperties: removedOptions
        ? previous.visibleProperties
        : previous.visibleProperties.filter((id) => id !== propertyId),
      groupBy:
        !removedOptions && previous.groupBy === propertyId
          ? null
          : previous.groupBy,
      dateProperty:
        !removedOptions && previous.dateProperty === propertyId
          ? null
          : previous.dateProperty,
    };
    const type =
      (view.type === "Board" && !config.groupBy) ||
      (view.type === "Calendar" && !config.dateProperty)
        ? "Table"
        : view.type;
    if (
      JSON.stringify(config) !== JSON.stringify(previous) ||
      type !== view.type
    )
      await c.query(
        "UPDATE database_views SET config=$1,type=$2,version=version+1 WHERE database_id=$3 AND id=$4",
        [config, type, databaseId, view.id],
      );
  }
}

import type { Property } from "./index.js";

export const databaseColumnMaxWidth = 960;
export function databaseColumnMinWidth(property: Pick<Property, "type">) {
  if (property.type === "Title") return 200;
  if (["Number", "Rollup", "Checkbox"].includes(property.type)) return 100;
  if (["CreatedTime", "LastEditedTime"].includes(property.type)) return 200;
  if (["Relation", "Files", "Email"].includes(property.type)) return 180;
  if (["Date", "Person", "MultiSelect", "URL", "Phone"].includes(property.type))
    return 160;
  return 140;
}
export function databaseColumnDefaultWidth(property: Pick<Property, "type">) {
  const widths: Partial<Record<Property["type"], number>> = {
    Title: 280,
    Text: 240,
    Number: 140,
    Select: 180,
    MultiSelect: 220,
    Status: 180,
    Date: 180,
    Checkbox: 120,
    URL: 260,
    Email: 240,
    Phone: 200,
    Person: 220,
    Files: 240,
    Relation: 260,
    Formula: 180,
    Rollup: 150,
    CreatedTime: 210,
    LastEditedTime: 210,
    CreatedBy: 220,
    LastEditedBy: 220,
  };
  return widths[property.type] || 180;
}
export function clampDatabaseColumnWidth(
  property: Pick<Property, "type">,
  width: number,
) {
  return Number.isFinite(width)
    ? Math.max(
        databaseColumnMinWidth(property),
        Math.min(databaseColumnMaxWidth, Math.round(width)),
      )
    : databaseColumnDefaultWidth(property);
}
export function databaseColumnWidth(
  property: Pick<Property, "id" | "type">,
  widths?: Readonly<Record<string, number>>,
) {
  const width = widths?.[property.id];
  return width === undefined
    ? databaseColumnDefaultWidth(property)
    : clampDatabaseColumnWidth(property, width);
}

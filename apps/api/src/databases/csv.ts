import { parse as parseCsv } from "csv-parse/sync";
import { createHash, randomUUID } from "node:crypto";
import {
  z,
  writablePropertyTypes,
  computedPropertyTypes,
  type Property,
} from "@orvyn/shared";
import { fail } from "../runtime.js";
import { valueFor } from "./model.js";
export const csvMapping = z
  .object({
    column: z.number().int().min(0).max(49),
    propertyId: z.uuid().optional(),
    name: z.string().trim().min(1).max(80).optional(),
    type: z.enum(writablePropertyTypes).optional(),
    skip: z.boolean().default(false),
  })
  .strict();
export const csvSettings = z
  .object({
    mapping: z.array(csvMapping).max(50).optional(),
    allowNewOptions: z.boolean().default(true),
  })
  .strict();
export type CsvMapping = z.infer<typeof csvMapping>;
export interface CsvPlan {
  schemaVersion: number;
  fields: { column: number; propertyId: string }[];
  mapping: CsvMapping[];
  newProperties: Property[];
  optionUpdates: Record<string, Property["config"]>;
}
export function decodeCsv(buffer: Buffer) {
  if (buffer.length > 1024 * 1024) fail(413, "CSV imports support up to 1 MiB");
  let parsed: string[][];
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    parsed = parseCsv(text, {
      bom: true,
      skip_empty_lines: true,
      max_record_size: 100000,
      relax_column_count: false,
    }) as string[][];
  } catch {
    return fail(
      400,
      "Use a valid UTF-8 CSV file with consistent columns and quoted multiline fields",
    );
  }
  if (!parsed.length || parsed[0].length < 1 || parsed[0].length > 50)
    fail(400, "CSV requires a header row with at most 50 columns");
  const headers = parsed[0].map((h, i) => h.trim() || "Column " + (i + 1));
  if (headers.some((h) => h.length > 80))
    fail(400, "CSV headers must contain at most 80 characters");
  const rows = parsed
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ""));
  if (rows.length > 1000) fail(413, "CSV imports support at most 1000 records");
  return {
    headers,
    rows,
    blankRowsSkipped: parsed.length - 1 - rows.length,
    digest: createHash("sha256").update(buffer).digest("hex"),
  };
}
export function suggest(properties: Property[], headers: string[]) {
  const used = new Set<string>(),
    names = new Set(properties.map((p) => p.name.toLowerCase()));
  const mapping: CsvMapping[] = headers.map((header, column) => {
    const property = properties.find(
      (p) => p.name.toLowerCase() === header.toLowerCase() && !used.has(p.id),
    );
    if (property) {
      used.add(property.id);
      return (computedPropertyTypes as readonly string[]).includes(
        property.type,
      )
        ? { column, skip: true }
        : { column, propertyId: property.id, skip: false };
    }
    let name = header,
      i = 2;
    while (names.has(name.toLowerCase()))
      name = header.slice(0, 72) + " (" + i++ + ")";
    names.add(name.toLowerCase());
    return { column, name, type: "Text", skip: false };
  });
  const title = properties.find((p) => p.type === "Title")!;
  if (!mapping.some((m) => m.propertyId === title.id)) {
    const index = headers.findIndex((h) =>
      ["name", "title"].includes(h.toLowerCase()),
    );
    mapping[index >= 0 ? index : 0] = {
      column: index >= 0 ? index : 0,
      propertyId: title.id,
      skip: false,
    };
  }
  return mapping;
}
function labels(value: string, type: string): string[] {
  if (!value.trim()) return [];
  if (type !== "MultiSelect") return [value.trim()];
  if (value.trim().startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      return fail(
        400,
        "Multi-select values must be JSON arrays or semicolon-separated labels",
      );
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((x) => typeof x !== "string") ||
      parsed.length > 50
    )
      fail(400, "Invalid multi-select labels");
    return parsed.map((s: string) => s.trim()).filter(Boolean);
  }
  return value
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}
export function buildCsvPlan(
  properties: Property[],
  schemaVersion: number,
  csv: ReturnType<typeof decodeCsv>,
  settings: z.infer<typeof csvSettings>,
) {
  const mapping = settings.mapping || suggest(properties, csv.headers);
  if (
    mapping.length !== csv.headers.length ||
    new Set(mapping.map((m) => m.column)).size !== mapping.length ||
    mapping.some((m) => m.column >= csv.headers.length)
  )
    fail(400, "Map every CSV column exactly once");
  const plan: CsvPlan = {
    schemaVersion,
    fields: [],
    mapping,
    newProperties: [],
    optionUpdates: {},
  };
  const used = new Set<string>(),
    names = new Set(properties.map((p) => p.name.toLowerCase()));
  for (const item of mapping) {
    if (item.skip) continue;
    let property: Property | undefined;
    if (item.propertyId) {
      property = properties.find((p) => p.id === item.propertyId);
      if (!property) fail(400, "Unknown target property");
      if ((computedPropertyTypes as readonly string[]).includes(property!.type))
        fail(400, "Metadata properties cannot be imported");
    } else {
      if (!item.name || !item.type)
        fail(400, "Choose a property or a new property name/type");
      if (names.has(item.name!.toLowerCase()))
        fail(400, "New property names must be unique");
      names.add(item.name!.toLowerCase());
      property = {
        id: randomUUID(),
        name: item.name!,
        type: item.type!,
        config: {},
        position:
          Math.max(-1, ...properties.map((p) => p.position)) +
          1 +
          plan.newProperties.length,
      };
      plan.newProperties.push(property);
    }
    if (used.has(property!.id)) fail(400, "A property can only be mapped once");
    used.add(property!.id);
    plan.fields.push({ column: item.column, propertyId: property!.id });
    if (["Select", "Status", "MultiSelect"].includes(property!.type)) {
      const existing = property!.config.options || [],
        options = [...existing],
        seen = new Set(existing.map((o) => o.label.toLowerCase()));
      for (const row of csv.rows)
        for (const label of labels(row[item.column], property!.type)) {
          if (label.length > 80)
            fail(400, "Select option names may contain at most 80 characters");
          if (seen.has(label.toLowerCase())) continue;
          if (item.propertyId && !settings.allowNewOptions)
            fail(
              400,
              "CSV contains new select options; enable option creation or change the mapping",
            );
          if (options.length >= 50)
            fail(400, "A select property supports at most 50 options");
          seen.add(label.toLowerCase());
          options.push({
            id: randomUUID(),
            label,
            color: ["neutral", "violet", "green", "blue", "amber"][
              options.length % 5
            ],
          });
        }
      if (!options.length)
        fail(
          400,
          "No options were found for the new select property; choose another type",
        );
      const config = { options };
      if (item.propertyId && options.length !== existing.length)
        plan.optionUpdates[property!.id] = config;
      else if (!item.propertyId) property!.config = config;
    }
  }
  const virtual = virtualProperties(properties, plan);
  if (virtual.length > 50)
    fail(400, "The import would exceed 50 active properties");
  if (
    !plan.fields.some(
      (f) => virtual.find((p) => p.id === f.propertyId)?.type === "Title",
    )
  )
    fail(400, "Map one column to the title property");
  return plan;
}
export function virtualProperties(
  properties: Property[],
  plan: CsvPlan,
): Property[] {
  return [
    ...properties.map((p) =>
      plan.optionUpdates[p.id] ? { ...p, config: plan.optionUpdates[p.id] } : p,
    ),
    ...plan.newProperties,
  ];
}
function fromCell(property: Property, cell: string): unknown {
  if (property.type === "Title") return cell.trim();
  if (property.type === "Text") return cell;
  if (cell.trim() === "") return null;
  if (property.type === "Number") {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(cell.trim()))
      fail(400, "Use a canonical number");
    return Number(cell);
  }
  if (property.type === "Checkbox") {
    const normalized = cell.trim().toLowerCase();
    if (["true", "yes", "1", "checked"].includes(normalized)) return true;
    if (["false", "no", "0", "unchecked"].includes(normalized)) return false;
    return fail(400, "Use true/false, yes/no or 1/0");
  }
  if (["Select", "Status", "MultiSelect"].includes(property.type)) {
    const ids = labels(cell, property.type).map(
      (label) =>
        property.config.options?.find(
          (o) => o.label.toLowerCase() === label.toLowerCase(),
        )?.id || fail(400, "Unknown select option"),
    );
    return property.type === "MultiSelect" ? ids : (ids[0] ?? null);
  }
  return cell.trim();
}
export function convertCsv(
  properties: Property[],
  plan: CsvPlan,
  rows: string[][],
) {
  const output: { title: string; values: Record<string, unknown> }[] = [],
    errors: { row: number; column: string; message: string }[] = [];
  for (const [index, row] of rows.entries()) {
    let title = "";
    const values: Record<string, unknown> = {};
    for (const field of plan.fields) {
      const property = properties.find((p) => p.id === field.propertyId)!;
      try {
        const value = fromCell(property, row[field.column]);
        if (property.type === "Title") {
          if (typeof value !== "string" || !value || value.length > 300)
            fail(400, "A non-empty title up to 300 characters is required");
          title = value as string;
        } else values[property.id] = valueFor(property, value);
      } catch (e: any) {
        if (errors.length < 20)
          errors.push({
            row: index + 2,
            column: property.name,
            message:
              typeof e.getResponse?.().message === "string"
                ? e.getResponse().message
                : "Invalid value",
          });
      }
    }
    output.push({ title, values });
  }
  return { records: output, errors };
}

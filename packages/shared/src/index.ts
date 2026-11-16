import { z } from "zod";
export const propertyTypes = [
  "Title",
  "Text",
  "Number",
  "Select",
  "MultiSelect",
  "Status",
  "Date",
  "Checkbox",
  "URL",
  "Email",
  "Phone",
  "Person",
  "Files",
  "Relation",
  "Formula",
  "Rollup",
  "CreatedTime",
  "CreatedBy",
  "LastEditedTime",
  "LastEditedBy",
] as const;
export const writablePropertyTypes = [
  "Text",
  "Number",
  "Select",
  "MultiSelect",
  "Status",
  "Date",
  "Checkbox",
  "URL",
  "Email",
  "Phone",
  "Person",
  "Files",
] as const;
export const computedPropertyTypes = [
  "CreatedTime",
  "CreatedBy",
  "LastEditedTime",
  "LastEditedBy",
] as const;
export type PropertyType = (typeof propertyTypes)[number];
export const viewTypes = [
  "Table",
  "Board",
  "List",
  "Calendar",
  "Gallery",
] as const;
export type ViewType = (typeof viewTypes)[number];
export const propertyInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    type: z.enum([...writablePropertyTypes, ...computedPropertyTypes]),
    options: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  })
  .strict();
export const filterInput = z
  .object({
    propertyId: z.uuid(),
    operator: z.enum([
      "eq",
      "neq",
      "contains",
      "gt",
      "gte",
      "lt",
      "lte",
      "empty",
      "notEmpty",
      "in",
    ]),
    value: z.json().optional(),
  })
  .strict();
export const sortInput = z
  .object({ propertyId: z.uuid(), direction: z.enum(["asc", "desc"]) })
  .strict();
export const viewConfigInput = z
  .object({
    filters: z.array(filterInput).max(20).default([]),
    sorts: z.array(sortInput).max(3).default([]),
    visibleProperties: z.array(z.uuid()).max(50).default([]),
    groupBy: z.uuid().nullable().default(null),
    dateProperty: z.uuid().nullable().default(null),
  })
  .strict();
export const viewInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    type: z.enum(viewTypes),
    config: viewConfigInput.default({
      filters: [],
      sorts: [],
      visibleProperties: [],
      groupBy: null,
      dateProperty: null,
    }),
  })
  .strict();
export const queryInput = z
  .object({
    viewId: z.uuid().optional(),
    offset: z.number().int().min(0).max(1000000).default(0),
    limit: z.number().int().min(1).max(200).default(100),
    search: z.string().max(200).default(""),
    filters: z.array(filterInput).max(20).optional(),
    sorts: z.array(sortInput).max(3).optional(),
    rangeStart: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    rangeEnd: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();
export type ViewConfig = z.infer<typeof viewConfigInput>;
export type QueryInput = z.infer<typeof queryInput>;
export interface Property {
  id: string;
  name: string;
  type: PropertyType;
  config: { options?: { id: string; label: string; color: string }[] };
  position: number;
}
export interface DatabaseRecord {
  pageId: string;
  title: string;
  titleVersion: number;
  version: number;
  values: Record<string, unknown>;
  accessRank: number;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; email: string } | null;
  lastEditedBy: { id: string; email: string } | null;
  coverFileId: string | null;
  icon: string | null;
  coverPreset: string | null;
  files?: { id: string; filename: string; mediaType: string; size: number }[];
}
export { z };
export {
  appearanceInput,
  coverIds,
  covers,
  coverBackground,
  emojiChoices,
  validEmoji,
} from "./appearance.js";

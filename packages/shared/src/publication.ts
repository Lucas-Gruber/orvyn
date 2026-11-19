import { z } from "zod";

export const publicationLimits = {
  pages: 100,
  databases: 20,
  records: 500,
  files: 250,
  snapshotBytes: 10 * 1024 * 1024,
  attachmentBytes: 100 * 1024 * 1024,
} as const;
const ids = (max: number) =>
  z
    .array(z.uuid())
    .max(max)
    .refine(
      (values) => new Set(values).size === values.length,
      "Choose each item once",
    );
export const publicationDatabaseInput = z.strictObject({
  databaseId: z.uuid(),
  viewId: z.uuid(),
  recordIds: ids(publicationLimits.records),
  propertyIds: ids(50),
});
export const publicationScopeInput = z
  .strictObject({
    pageIds: ids(publicationLimits.pages),
    databases: z
      .array(publicationDatabaseInput)
      .max(publicationLimits.databases),
    extraFileIds: ids(publicationLimits.files).default([]),
  })
  .superRefine((value, context) => {
    if (
      new Set(value.databases.map((database) => database.databaseId)).size !==
      value.databases.length
    )
      context.addIssue({
        code: "custom",
        path: ["databases"],
        message: "Choose one view per published database",
      });
    const records = value.databases.flatMap((database) => database.recordIds);
    if (records.length > publicationLimits.records)
      context.addIssue({
        code: "custom",
        path: ["databases"],
        message: "Choose at most 500 records for this publication",
      });
  });
export const publicationSettingsInput = z.strictObject({
  label: z.string().trim().min(1).max(100),
  expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
  password: z.string().min(8).max(256).optional(),
  passwordProtected: z.boolean().default(false),
  indexable: z.boolean().default(false),
});
export const publicationPreviewInput = z
  .strictObject({
    scope: publicationScopeInput,
    settings: publicationSettingsInput,
    target: z
      .strictObject({
        id: z.uuid(),
        version: z.number().int().min(1).max(2147483647),
      })
      .nullable()
      .default(null),
  })
  .superRefine((value, context) => {
    if (value.settings.passwordProtected && value.settings.indexable)
      context.addIssue({
        code: "custom",
        path: ["settings", "indexable"],
        message: "Password-protected publications cannot be indexed",
      });
    if (value.settings.password && !value.settings.passwordProtected)
      context.addIssue({
        code: "custom",
        path: ["settings", "password"],
        message: "Enable password protection to set a password",
      });
  });
export const publicationCommitInput = z.strictObject({
  requestId: z.uuid(),
  previewToken: z.string().min(50).max(8192),
  input: publicationPreviewInput,
});
export const publicationChangeInput = z.strictObject({
  version: z.number().int().min(1).max(2147483647),
  enabled: z.boolean(),
});
export type PublicationScope = z.infer<typeof publicationScopeInput>;
export type PublicationInput = z.infer<typeof publicationPreviewInput>;

export type PublicValue = string | number | boolean | null | string[];
export interface PublicProperty {
  id: string;
  name: string;
  type: string;
  options?: { id: string; label: string; color?: string }[];
}
export interface PublicRecord {
  pageId: string;
  title: string;
  values: Record<string, PublicValue>;
}
export interface PublicDatabase {
  properties: PublicProperty[];
  records: PublicRecord[];
  view: {
    name: string;
    type: "Table" | "Board" | "List" | "Calendar" | "Gallery";
    groupBy?: string;
    dateProperty?: string;
    propertyWidths?: Record<string, number>;
  };
}
export interface PublicPage {
  id: string;
  order: number;
  title: string;
  kind: "page" | "folder" | "database" | "record" | "whiteboard";
  parentId: string | null;
  icon: string | null;
  coverPreset: string | null;
  coverFileId: string | null;
  document: Record<string, unknown>;
  whiteboard?: {
    elements: (Record<string, unknown> & {
      id: string;
      type: string;
      version: number;
      versionNonce: number;
      isDeleted: boolean;
    })[];
    backgroundColor: string;
    gridSize: number | null;
  };
  database?: PublicDatabase;
  record?: {
    properties: PublicProperty[];
    values: Record<string, PublicValue>;
  };
}
export interface PublicFile {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
}
export interface PublicationSnapshot {
  version: 1;
  rootId: string;
  pages: PublicPage[];
  files: PublicFile[];
  attachmentIds: string[];
}

import type { PoolClient } from "pg";
import {
  writablePropertyTypes,
  type Property,
  type PropertyType,
  type ViewConfig,
  type ViewType,
} from "@orvyn/shared";
import { documentSchemaVersion, normalizeDocument } from "@orvyn/editor";
import { documentAssets } from "@orvyn/editor/links";
import { fail } from "../../runtime.js";
import { pageWrite } from "../../permissions/access.js";
import {
  database,
  recordSnapshot,
  personDirectory,
  valueFor,
} from "../model.js";

export interface DatabaseTemplateSnapshot {
  kind: "database";
  schemaVersion: number;
  properties: Property[];
  views: { id: string; name: string; type: ViewType; config: ViewConfig }[];
  icon: string | null;
  coverPreset: string | null;
  coverFileId: string | null;
  explicitCover: boolean;
  files: string[];
}
export interface RecordTemplateSnapshot {
  kind: "record";
  schemaVersion: number;
  title: string;
  values: Record<string, unknown>;
  types: Record<string, PropertyType>;
  document: any;
  files: string[];
  icon: string | null;
  coverPreset: string | null;
  coverFileId: string | null;
  explicitCover: boolean;
}
export type TemplateSnapshot =
  DatabaseTemplateSnapshot | RecordTemplateSnapshot;
type Context = Awaited<ReturnType<typeof database>>;
const writable = (p: Property) =>
  (writablePropertyTypes as readonly string[]).includes(p.type);

export async function readableTemplateFiles(
  c: PoolClient,
  uid: string,
  ids: string[],
) {
  if (ids.length > 50) fail(400, "A template supports up to 50 attachments.");
  const rows = ids.length
    ? (
        await c.query(
          "SELECT f.id,f.page_id,p.space_id,f.object_key,f.filename,f.media_type,f.size FROM files f JOIN pages p ON p.id=f.page_id WHERE f.id=ANY($1::uuid[]) AND f.state='ready' AND orvyn_page_role(f.page_id,$2)>=10 ORDER BY f.id",
          [ids, uid],
        )
      ).rows
    : [];
  if (rows.length !== ids.length)
    fail(
      409,
      "Some template attachments are unavailable. Refresh the template from its source.",
    );
  if (
    rows.reduce((sum, file) => sum + Number(file.size), 0) >
    100 * 1024 * 1024
  )
    fail(400, "Template attachments support up to 100 MiB in total.");
  return rows;
}

export async function takeTemplateSnapshot(
  c: PoolClient,
  uid: string,
  context: Context,
  sourceRecordId?: string,
): Promise<TemplateSnapshot> {
  if (!sourceRecordId) {
    const files = context.page.cover_file_id
      ? [context.page.cover_file_id]
      : [];
    await readableTemplateFiles(c, uid, files);
    return {
      kind: "database",
      schemaVersion: context.schemaVersion,
      properties: structuredClone(context.properties),
      views: structuredClone(context.views),
      icon: context.page.icon,
      coverPreset: context.page.cover_preset,
      coverFileId: context.page.cover_file_id,
      explicitCover: context.page.appearance_version > 1,
      files,
    };
  }
  const page = await pageWrite(c, uid, sourceRecordId, 30),
    existing = await c.query(
      "SELECT 1 FROM database_records WHERE page_id=$1 AND database_id=$2",
      [page.id, context.page.id],
    );
  if (!existing.rowCount) fail(404, "Record not found");
  if (page.document_schema_version > documentSchemaVersion)
    fail(409, "Document format requires a newer server.");
  const record = await recordSnapshot(
      c,
      uid,
      context.page.id,
      page.id,
      context.properties,
    ),
    fields = context.properties.filter(writable),
    values: Record<string, unknown> = {};
  for (const p of fields) values[p.id] = record.values[p.id] ?? null;
  const files = [
    ...new Set<string>([
      ...(
        await c.query(
          "SELECT id FROM files WHERE page_id=$1 AND state='ready' ORDER BY id",
          [page.id],
        )
      ).rows.map((f) => f.id),
      ...documentAssets(page.document).map((f) => f.fileId),
      ...fields
        .filter((p) => p.type === "Files")
        .flatMap((p) =>
          Array.isArray(values[p.id]) ? (values[p.id] as string[]) : [],
        ),
      ...(page.cover_file_id ? [page.cover_file_id] : []),
    ]),
  ].sort();
  await readableTemplateFiles(c, uid, files);
  const snapshot: RecordTemplateSnapshot = {
    kind: "record",
    schemaVersion: context.schemaVersion,
    title: page.title,
    values,
    types: Object.fromEntries(fields.map((p) => [p.id, p.type])),
    document: normalizeDocument(page.document),
    files,
    icon: page.icon,
    coverPreset: page.cover_preset,
    coverFileId: page.cover_file_id,
    explicitCover: page.appearance_version > 1,
  };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 2 * 1024 * 1024)
    fail(413, "This record is too large for a template.");
  return snapshot;
}

// Defaults are resolved against today's schema and permissions. A template is
// never a way to add an inaccessible relation or a former member assignment.
export async function templateDefaults(
  c: PoolClient,
  uid: string,
  context: Context,
  snapshot: RecordTemplateSnapshot,
) {
  const values: Record<string, unknown> = {},
    people = new Set(
      (await personDirectory(c, context.page.space_id)).map((p) => p.id),
    );
  let omitted = 0;
  for (const [id, original] of Object.entries(snapshot.values)) {
    const p = context.properties.find(
      (p) => p.id === id && p.type === snapshot.types[id] && writable(p),
    );
    if (!p) {
      if (original !== null) omitted++;
      continue;
    }
    let value: unknown = original;
    if (p.type === "Person" && Array.isArray(value))
      value = value.filter((id) => people.has(id));
    if (p.type === "Select" || p.type === "Status") {
      if (value !== null && !p.config.options?.some((o) => o.id === value))
        value = null;
    }
    if (p.type === "MultiSelect" && Array.isArray(value))
      value = value.filter((id) => p.config.options?.some((o) => o.id === id));
    if (p.type === "Relation" && Array.isArray(value) && value.length) {
      value = (
        await c.query(
          "SELECT p.id FROM database_records r JOIN pages p ON p.id=r.page_id WHERE r.database_id=$1 AND p.space_id=$2 AND p.id=ANY($3::uuid[]) AND orvyn_page_role(p.id,$4)>=10 ORDER BY p.id",
          [p.config.databaseId, context.page.space_id, value, uid],
        )
      ).rows.map((r) => r.id);
    }
    if (JSON.stringify(original) !== JSON.stringify(value)) omitted++;
    values[id] = valueFor(p, value);
  }
  return { values, omitted };
}

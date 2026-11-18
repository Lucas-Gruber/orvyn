import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { cloneDatabaseSchema, formulaType, z } from "@orvyn/shared";
import { documentSchemaVersion } from "@orvyn/editor";
import { documentPeople } from "@orvyn/editor/mentions";
import { documentAssets, documentReferences } from "@orvyn/editor/links";
import { transaction, audit } from "../../auth/security.js";
import { fail } from "../../runtime.js";
import {
  spaceAccess,
  pageAccess,
  newPageParent,
  roleRanks,
} from "../../permissions/access.js";
import {
  database,
  valuesFor,
  checkPeople,
  checkedView,
  querySql,
  recordSnapshot,
} from "../model.js";
import { checkRelations, checkRelationTarget } from "../relations.js";
import { rollupConfig } from "../rollup.js";
import { cloneTemplateDocument } from "./document.js";
import {
  copyTemplateFiles,
  removeTemplateCopies,
  type CopiedTemplateFile,
} from "./files.js";
import {
  templateSpaces,
  templateRow,
  lockTemplateSpaces,
  type TemplateRow,
} from "./model.js";
import { readableTemplateFiles, templateDefaults } from "./snapshot.js";

export const applyTemplateInput = z
  .object({
    requestId: z.uuid(),
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(300),
    parentId: z.uuid().nullable().optional(),
    visibility: z.enum(["space", "restricted"]).default("space"),
    values: z.record(z.string(), z.json()).default({}),
    schemaVersion: z.number().int().positive().optional(),
  })
  .strict();
type Input = z.infer<typeof applyTemplateInput>;
const hash = (id: string, input: Input) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        id,
        input.version,
        input.title,
        input.parentId || null,
        input.visibility,
        input.schemaVersion || null,
        Object.entries(input.values).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");

async function replay(
  c: PoolClient,
  uid: string,
  t: TemplateRow,
  input: Input,
  fingerprint: string,
) {
  const existing = (
    await c.query(
      "SELECT * FROM template_applications WHERE user_id=$1 AND request_id=$2",
      [uid, input.requestId],
    )
  ).rows[0];
  if (!existing) return null;
  if (existing.template_id !== t.id || existing.request_hash !== fingerprint)
    fail(409, "This creation request changed. Start a new request.");
  const page = await pageAccess(c, uid, existing.page_id);
  if (t.kind === "database")
    return {
      pageId: page.id,
      kind: "database" as const,
      replayed: true,
      omittedDefaults: 0,
    };
  const context = await database(c, uid, t.database_id);
  return {
    pageId: page.id,
    kind: "record" as const,
    record: await recordSnapshot(
      c,
      uid,
      context.page.id,
      page.id,
      context.properties,
    ),
    replayed: true,
    omittedDefaults: 0,
  };
}
async function destination(
  c: PoolClient,
  uid: string,
  t: TemplateRow,
  input: Input,
) {
  if (t.kind === "database") {
    const space = await spaceAccess(c, uid, t.space_id, 30);
    if (input.title.length > 120 || Object.keys(input.values).length)
      fail(
        400,
        "Use a database name up to 120 characters and no record values.",
      );
    await newPageParent(c, uid, space.id, input.parentId, 1, "database");
    return null;
  }
  if (input.parentId !== undefined && input.parentId !== t.database_id)
    fail(400, "Record templates belong to their database.");
  const context = await database(c, uid, t.database_id, 30, true);
  if (
    input.schemaVersion !== undefined &&
    input.schemaVersion !== context.schemaVersion
  )
    fail(409, "Database schema changed; reload before creating the record.");
  await newPageParent(c, uid, t.space_id, context.page.id, 0, "record");
  return context;
}
async function defaults(
  c: PoolClient,
  uid: string,
  t: TemplateRow,
  input: Input,
  context: NonNullable<Awaited<ReturnType<typeof destination>>>,
) {
  if (t.payload.kind !== "record")
    return fail(409, "Template format is invalid.");
  const preset = await templateDefaults(c, uid, context, t.payload),
    values = valuesFor(context.properties, {
      ...preset.values,
      ...input.values,
    }),
    files = new Set(t.payload.files);
  for (const p of context.properties.filter((p) => p.type === "Files"))
    if (((values[p.id] as string[] | null) || []).some((id) => !files.has(id)))
      fail(400, "Choose attachments included in this template.");
  await checkPeople(c, t.space_id, context.properties, values);
  await checkRelations(c, uid, context.properties, values);
  return { values, omitted: preset.omitted };
}
async function insertPage(
  c: PoolClient,
  uid: string,
  t: TemplateRow,
  input: Input,
  id: string,
) {
  const space = await spaceAccess(
      c,
      uid,
      t.space_id,
      t.kind === "database" ? 30 : 10,
    ),
    p = (
      await c.query(
        "INSERT INTO pages(id,space_id,parent_id,title,kind,visibility,created_by,last_edited_by,icon,cover_preset,appearance_version) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10) RETURNING *",
        [
          id,
          t.space_id,
          t.kind === "record" ? t.database_id : input.parentId || null,
          input.title,
          t.kind,
          input.visibility,
          uid,
          t.payload.icon,
          t.payload.coverPreset,
          t.payload.explicitCover ? 2 : 1,
        ],
      )
    ).rows[0];
  if (input.visibility === "restricted" && space.owner_id !== uid)
    await c.query("INSERT INTO page_permissions VALUES($1,$2,$3)", [
      id,
      uid,
      roleRanks[space.role as keyof typeof roleRanks] >= 40
        ? "Admin"
        : "Editor",
    ]);
  return p;
}
async function insertFiles(
  c: PoolClient,
  uid: string,
  pageId: string,
  files: CopiedTemplateFile[],
) {
  for (const f of files)
    await c.query(
      "INSERT INTO files(id,page_id,object_key,filename,media_type,size,uploaded_by,state) VALUES($1,$2,$3,$4,$5,$6,$7,'ready')",
      [f.id, pageId, f.object_key, f.filename, f.media_type, f.size, uid],
    );
}
async function cloneSchema(
  c: PoolClient,
  uid: string,
  t: TemplateRow,
  pageId: string,
) {
  if (t.payload.kind !== "database") fail(409, "Template format is invalid.");
  const payload = t.payload;
  if (payload.kind !== "database")
    return fail(409, "Template format is invalid.");
  const schema = cloneDatabaseSchema(
    t.database_id,
    pageId,
    payload.properties,
    payload.views,
  );
  await c.query("INSERT INTO databases(page_id) VALUES($1)", [pageId]);
  for (const p of schema.properties) {
    if (p.type === "Relation")
      await checkRelationTarget(c, uid, p.config.databaseId!);
    await c.query(
      "INSERT INTO database_properties(id,database_id,name,type,config,position) VALUES($1,$2,$3,$4,$5,$6)",
      [p.id, pageId, p.name, p.type, p.config, p.position],
    );
  }
  const context = await database(c, uid, pageId, 30);
  for (const p of context.properties) {
    if (p.type === "Formula")
      formulaType(p.config.expression!, context.properties);
    if (p.type === "Rollup")
      await rollupConfig(c, uid, context.properties, p.config.rollup!);
  }
  for (const v of schema.views) {
    checkedView(context.properties, v.type, v.config);
    querySql(
      context.properties,
      v.config,
      { offset: 0, limit: 1, search: "" },
      uid,
      pageId,
    );
    await c.query(
      "INSERT INTO database_views(id,database_id,name,type,config,position) VALUES($1,$2,$3,$4,$5,$6)",
      [v.id, pageId, v.name, v.type, v.config, v.position],
    );
  }
}

export async function applyTemplate(
  uid: string,
  templateId: string,
  input: Input,
) {
  const fingerprint = hash(templateId, input),
    pageId = randomUUID();
  const plan = await transaction(async (c) => {
    const scope = await templateSpaces(c, uid, templateId);
    await lockTemplateSpaces(c, scope.spaces);
    const t = await templateRow(c, uid, templateId),
      previous = await replay(c, uid, t, input, fingerprint);
    if (previous) return { previous };
    if (t.version !== input.version)
      fail(409, "Template changed; select it again.");
    const context = await destination(c, uid, t, input);
    if (context) await defaults(c, uid, t, input, context);
    const files = await readableTemplateFiles(c, uid, t.payload.files);
    if (files.some((f) => !scope.spaces.includes(f.space_id)))
      fail(409, "Template attachments changed; try again.");
    if (t.payload.kind === "record") {
      try {
        cloneTemplateDocument(
          t.payload.document,
          t.source_page_id,
          pageId,
          new Map(t.payload.files.map((id) => [id, id])),
          new Set(documentPeople(t.payload.document)),
          process.env.ORVYN_ORIGIN!,
        );
      } catch {
        fail(
          409,
          "Template content can no longer be copied. Refresh the template from its source.",
        );
      }
    }
    return {
      previous: null,
      spaces: scope.spaces,
      template: t,
      files,
      schemaVersion: context?.schemaVersion,
    };
  });
  if (plan.previous) return plan.previous;
  let copies: CopiedTemplateFile[] = [];
  try {
    try {
      copies = await copyTemplateFiles(plan.files!);
    } catch {
      return fail(503, "Template attachments could not be copied. Try again.");
    }
    const result = await transaction(async (c) => {
      await lockTemplateSpaces(c, plan.spaces!);
      const t = await templateRow(c, uid, templateId),
        previous = await replay(c, uid, t, input, fingerprint);
      if (previous) return previous;
      if (t.version !== input.version)
        fail(409, "Template changed; select it again.");
      const context = await destination(c, uid, t, input);
      if (context && context.schemaVersion !== plan.schemaVersion)
        fail(
          409,
          "Database schema changed; reload before creating the record.",
        );
      const currentFiles = await readableTemplateFiles(c, uid, t.payload.files),
        originalFiles = new Map(plan.files!.map((f) => [f.id, f.object_key]));
      if (
        currentFiles.some(
          (f) =>
            originalFiles.get(f.id) !== f.object_key ||
            !plan.spaces!.includes(f.space_id),
        )
      )
        fail(409, "Template attachments changed; try again.");
      const preset = context ? await defaults(c, uid, t, input, context) : null,
        p = await insertPage(c, uid, t, input, pageId),
        fileIds = new Map(copies.map((f) => [f.sourceId, f.id]));
      await insertFiles(c, uid, pageId, copies);
      if (t.payload.coverFileId)
        await c.query("UPDATE pages SET cover_file_id=$2 WHERE id=$1", [
          pageId,
          fileIds.get(t.payload.coverFileId),
        ]);
      let omitted = preset?.omitted || 0;
      if (t.payload.kind === "database") {
        await cloneSchema(c, uid, t, pageId);
      } else {
        const people = documentPeople(t.payload.document),
          eligible = people.length
            ? (
                await c.query(
                  "SELECT person AS id FROM unnest($2::uuid[]) person WHERE orvyn_document_people_allowed($1,ARRAY[person])",
                  [pageId, people],
                )
              ).rows.map((r) => r.id)
            : [],
          cloned = cloneTemplateDocument(
            t.payload.document,
            t.source_page_id,
            pageId,
            fileIds,
            new Set(eligible),
            process.env.ORVYN_ORIGIN!,
          );
        omitted += cloned.omittedPeople;
        const values = { ...preset!.values };
        for (const property of context!.properties.filter(
          (p) => p.type === "Files",
        ))
          if (Array.isArray(values[property.id]))
            values[property.id] = (values[property.id] as string[]).map((id) =>
              fileIds.get(id)!,
            );
        await c.query(
          "UPDATE pages SET document=$2,document_schema_version=$3 WHERE id=$1",
          [pageId, cloned.document, documentSchemaVersion],
        );
        if (
          !(
            await c.query(
              "SELECT orvyn_editor_assets_allowed($1,$2::jsonb) AS allowed",
              [uid, JSON.stringify(documentAssets(cloned.document))],
            )
          ).rows[0].allowed
        )
          fail(409, "A template attachment could not be attached.");
        await c.query(
          "INSERT INTO database_records(page_id,database_id,values) VALUES($1,$2,$3)",
          [pageId, t.database_id, values],
        );
        await c.query("SELECT orvyn_replace_record_relations($1)", [pageId]);
        await c.query("SELECT orvyn_replace_page_references($1,$2::jsonb)", [
          pageId,
          JSON.stringify(
            documentReferences(cloned.document, process.env.ORVYN_ORIGIN!),
          ),
        ]);
        await c.query("SELECT orvyn_sync_document_people($1,$2,$3::uuid[])", [
          pageId,
          uid,
          documentPeople(cloned.document),
        ]);
      }
      await c.query(
        "INSERT INTO page_revisions(page_id,version,title,document,author_id) SELECT id,version,title,document,$2 FROM pages WHERE id=$1",
        [pageId, uid],
      );
      await c.query(
        "INSERT INTO template_applications(user_id,request_id,template_id,request_hash,page_id) VALUES($1,$2,$3,$4,$5)",
        [uid, input.requestId, t.id, fingerprint, pageId],
      );
      await audit(
        c,
        uid,
        t.kind === "database"
          ? "database.created_from_template"
          : "database.record_created_from_template",
        { pageId },
      );
      return {
        pageId,
        kind: t.kind,
        ...(context
          ? {
              record: await recordSnapshot(
                c,
                uid,
                context.page.id,
                pageId,
                context.properties,
              ),
            }
          : {}),
        replayed: false,
        omittedDefaults: omitted,
      };
    });
    if (result.pageId !== pageId) await removeTemplateCopies(copies);
    return result;
  } catch (error) {
    await removeTemplateCopies(copies).catch(() => {});
    throw error;
  }
}

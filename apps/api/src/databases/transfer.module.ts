import {
  Module,
  Controller,
  Post,
  Get,
  Req,
  Res,
  Param,
  Body,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Injectable,
  CanActivate,
  ExecutionContext,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { stringify as stringifyCsv } from "csv-stringify/sync";
import { randomBytes } from "node:crypto";
import { z, queryInput, type Property } from "@orvyn/shared";
import { db, fail, user, hash } from "../runtime.js";
import { transaction, audit, origin, rateLimit } from "../auth/security.js";
import { newPageParent } from "../permissions/access.js";
import { database, parse, querySql, recordDTO } from "./model.js";
import {
  decodeCsv,
  csvSettings,
  buildCsvPlan,
  convertCsv,
  virtualProperties,
  suggest,
  type CsvPlan,
} from "./csv.js";
@Injectable()
class CsvGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    if (req.headers.origin !== origin()) fail(403, "Invalid origin");
    if (!req.is("multipart/form-data"))
      fail(415, "Multipart CSV upload required");
    const uid = await user(req);
    await database(db, uid, req.params.id, 30);
    await rateLimit("csv:" + uid, 100);
    return true;
  }
}
const interceptor = () =>
  FileInterceptor("file", {
    limits: { fileSize: 1024 * 1024, files: 1, fields: 1, fieldSize: 100000 },
  });
function settings(input: unknown) {
  try {
    return JSON.parse(typeof input === "string" ? input : "{}");
  } catch {
    return fail(400, "Invalid import settings");
  }
}
function fileInput(file: Express.Multer.File | undefined) {
  if (!file?.buffer) return fail(400, "Choose a CSV file");
  return decodeCsv(file.buffer);
}
function safeCell(value: unknown, safe: boolean) {
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = value === null || value === undefined ? "" : String(value);
  return safe && /^[=+\-@\t\r\n]/.test(text) ? "'" + text : text;
}
function csvValue(row: any, property: Property) {
  const value = row.values[property.id];
  if (value === null || value === undefined) return "";
  if (["Select", "Status"].includes(property.type))
    return property.config.options?.find((o) => o.id === value)?.label || "";
  if (property.type === "MultiSelect")
    return JSON.stringify(
      (value as string[]).map(
        (id) => property.config.options?.find((o) => o.id === id)?.label || "",
      ),
    );
  if (property.type === "CreatedBy") return row.createdBy?.email || "";
  if (property.type === "LastEditedBy") return row.lastEditedBy?.email || "";
  return value;
}
@Controller("api/v1/databases")
class TransferController {
  @Post(":id/import/csv/preview")
  @UseGuards(CsvGuard)
  @UseInterceptors(interceptor())
  async preview(
    @Req() req: any,
    @Param("id") id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: any,
  ) {
    const uid = await user(req),
      csv = fileInput(file),
      input = parse<z.infer<typeof csvSettings>>(
        csvSettings,
        settings(body?.settings),
      ),
      context = await database(db, uid, id, 30);
    let plan: CsvPlan;
    try {
      plan = buildCsvPlan(
        context.properties,
        context.schemaVersion,
        csv,
        input,
      );
    } catch (e: any) {
      if (e.getStatus?.() !== 400) throw e;
      return {
        headers: csv.headers,
        rows: csv.rows.slice(0, 20),
        totalRows: csv.rows.length,
        blankRowsSkipped: csv.blankRowsSkipped,
        mapping: input.mapping || suggest(context.properties, csv.headers),
        newProperties: [],
        optionAdditions: [],
        errors: [
          { row: 0, column: "Mapping", message: e.getResponse().message },
        ],
        token: null,
        canImport: false,
        schemaVersion: context.schemaVersion,
      };
    }
    const properties = virtualProperties(context.properties, plan),
      converted = convertCsv(properties, plan, csv.rows);
    let token: string | null = null;
    if (!converted.errors.length) {
      token = randomBytes(32).toString("hex");
      await db.query(
        "INSERT INTO csv_import_previews(token_hash,database_id,user_id,file_digest,plan) VALUES($1,$2,$3,$4,$5)",
        [hash(token), context.page.id, uid, csv.digest, plan],
      );
    }
    const additions = Object.entries(plan.optionUpdates).map(
      ([id, config]) => ({
        propertyId: id,
        propertyName: properties.find((p) => p.id === id)!.name,
        labels: config
          .options!.slice(
            context.properties.find((p) => p.id === id)!.config.options!.length,
          )
          .map((o) => o.label),
      }),
    );
    return {
      headers: csv.headers,
      rows: csv.rows.slice(0, 20),
      totalRows: csv.rows.length,
      blankRowsSkipped: csv.blankRowsSkipped,
      mapping: plan.mapping,
      newProperties: plan.newProperties,
      optionAdditions: additions,
      errors: converted.errors,
      token,
      canImport: !converted.errors.length,
      schemaVersion: context.schemaVersion,
    };
  }
  @Post(":id/import/csv/confirm")
  @UseGuards(CsvGuard)
  @UseInterceptors(interceptor())
  async confirm(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
    @Param("id") id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: any,
  ) {
    const uid = await user(req),
      csv = fileInput(file),
      input = parse<{ token: string }>(
        z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
        settings(body?.settings),
      );
    const result = await transaction(async (c) => {
      const context = await database(c, uid, id, 30, true),
        preview = (
          await c.query(
            "SELECT * FROM csv_import_previews WHERE token_hash=$1 AND database_id=$2 AND user_id=$3 FOR UPDATE",
            [hash(input.token), context.page.id, uid],
          )
        ).rows[0];
      if (!preview || new Date(preview.expires_at).getTime() <= Date.now())
        fail(400, "Preview expired; upload and review the CSV again");
      if (preview.file_digest !== csv.digest)
        fail(400, "CSV changed; preview it again");
      if (preview.result) return { ...preview.result, replayed: true };
      const plan = preview.plan as CsvPlan;
      if (context.schemaVersion !== plan.schemaVersion)
        fail(409, "Database schema changed; preview the import again");
      const properties = virtualProperties(context.properties, plan),
        converted = convertCsv(properties, plan, csv.rows);
      if (converted.errors.length)
        fail(400, "CSV contains invalid values; preview it again");
      await newPageParent(c, uid, context.page.space_id, context.page.id);
      await c.query("SELECT set_config('orvyn.bulk_database',$1,true)", [
        context.page.id,
      ]);
      for (const property of plan.newProperties)
        await c.query(
          "INSERT INTO database_properties(id,database_id,name,type,config,position) VALUES($1,$2,$3,$4,$5,$6)",
          [
            property.id,
            context.page.id,
            property.name,
            property.type,
            property.config,
            property.position,
          ],
        );
      for (const [propertyId, config] of Object.entries(plan.optionUpdates))
        await c.query(
          "UPDATE database_properties SET config=$1 WHERE id=$2 AND database_id=$3",
          [config, propertyId, context.page.id],
        );
      const ids: string[] = [];
      for (const row of converted.records) {
        const p = (
          await c.query(
            "INSERT INTO pages(space_id,parent_id,title,kind,created_by,last_edited_by) VALUES($1,$2,$3,'record',$4,$4) RETURNING *",
            [context.page.space_id, context.page.id, row.title, uid],
          )
        ).rows[0];
        ids.push(p.id);
        await c.query(
          "INSERT INTO database_records(page_id,database_id,values) VALUES($1,$2,$3)",
          [p.id, context.page.id, row.values],
        );
        await c.query(
          "INSERT INTO page_revisions(page_id,version,title,document,author_id) VALUES($1,$2,$3,$4,$5)",
          [p.id, p.version, p.title, p.document, uid],
        );
      }
      const outcome = {
        createdRecords: ids.length,
        createdProperties: plan.newProperties.length,
        recordIds: ids,
      };
      await c.query(
        "UPDATE csv_import_previews SET result=$1,expires_at=now()+interval '24 hours' WHERE token_hash=$2",
        [outcome, hash(input.token)],
      );
      await c.query("SELECT pg_notify('orvyn_database_changed',$1)", [
        JSON.stringify({ databaseId: context.page.id, recordId: null }),
      ]);
      await audit(c, uid, "database.csv_imported");
      return { ...outcome, replayed: false };
    });
    if (result.replayed) res.status(200);
    return result;
  }
  private async exportData(
    uid: string,
    id: string,
    viewId: unknown,
    format: "csv" | "json",
    safe: boolean,
  ) {
    return transaction(async (c) => {
      await c.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const context = await database(c, uid, id);
      let view: any;
      if (viewId !== undefined) {
        if (typeof viewId !== "string" || !z.uuid().safeParse(viewId).success)
          fail(400, "Invalid view");
        view = context.views.find((v) => v.id === viewId);
        if (!view) fail(404, "View not found");
      }
      const config = view?.config || {
        filters: [],
        sorts: [],
        visibleProperties: [],
        groupBy: null,
        dateProperty: null,
      };
      const visible = config.visibleProperties.length
        ? new Set([
            ...config.visibleProperties,
            ...context.properties
              .filter((p) => p.type === "Title")
              .map((p) => p.id),
            ...(config.groupBy ? [config.groupBy] : []),
            ...(config.dateProperty ? [config.dateProperty] : []),
          ])
        : null;
      const properties = visible
        ? context.properties.filter((p) => visible.has(p.id))
        : context.properties;
      const records: any[] = [];
      let offset = 0,
        size = 0;
      for (;;) {
        const query = querySql(
            context.properties,
            config,
            queryInput.parse({ offset, limit: 200 }),
            uid,
            context.page.id,
          ),
          rows = (await c.query(query.sql, query.params)).rows,
          more = rows.length > 200;
        if (more) rows.pop();
        for (const row of rows) {
          const dto: any = recordDTO(row, properties);
          if (format === "json") {
            const page = (
              await c.query(
                "SELECT document,document_schema_version FROM pages WHERE id=$1",
                [row.id],
              )
            ).rows[0];
            dto.document = page.document;
            dto.documentSchemaVersion = page.document_schema_version;
            dto.attachments = (
              await c.query(
                "SELECT id,filename,media_type,size FROM files WHERE page_id=$1 AND state='ready' ORDER BY created_at",
                [row.id],
              )
            ).rows;
          }
          size += Buffer.byteLength(JSON.stringify(dto));
          if (size > 10 * 1024 * 1024 || records.length >= 10000)
            fail(413, "Export is too large; choose a more specific view");
          records.push(dto);
        }
        if (!more) break;
        offset += 200;
      }
      if (format === "json")
        return {
          title: context.page.title,
          body: JSON.stringify({
            format: "orvyn.database",
            version: 1,
            database: {
              sourceId: context.page.id,
              title: context.page.title,
              properties,
              views: view ? [view] : context.views,
            },
            records,
          }),
        };
      const rows = [
        properties.map((p) => safeCell(p.name, safe)),
        ...records.map((record) =>
          properties.map((p) => safeCell(csvValue(record, p), safe)),
        ),
      ];
      return {
        title: context.page.title,
        body: stringifyCsv(rows, { record_delimiter: "\r\n" }),
      };
    });
  }
  @Get(":id/export.csv") async csv(
    @Req() req: any,
    @Res() res: any,
    @Param("id") id: string,
    @Query("viewId") view: unknown,
    @Query("spreadsheetSafe") safety = "true",
  ) {
    if (!["true", "false"].includes(safety))
      fail(400, "Invalid CSV safety option");
    const data = await this.exportData(
      await user(req),
      id,
      view,
      "csv",
      safety === "true",
    );
    return this.send(res, data, "csv", "text/csv; charset=utf-8");
  }
  @Get(":id/export.json") async json(
    @Req() req: any,
    @Res() res: any,
    @Param("id") id: string,
    @Query("viewId") view: unknown,
  ) {
    const data = await this.exportData(
      await user(req),
      id,
      view,
      "json",
      false,
    );
    return this.send(res, data, "json", "application/json; charset=utf-8");
  }
  private send(
    res: any,
    data: { title: string; body: string },
    extension: string,
    type: string,
  ) {
    const name =
      (data.title.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 100) ||
        "database") +
      "." +
      extension;
    const encoded = encodeURIComponent(name).replace(
      /['()*]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    );
    res.setHeader("Content-Type", type);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="database.${extension}"; filename*=UTF-8''${encoded}`,
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(data.body);
  }
}
@Module({ controllers: [TransferController], providers: [CsvGuard] })
export class DatabaseTransferModule {}

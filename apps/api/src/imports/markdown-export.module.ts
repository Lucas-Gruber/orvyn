import {
  Controller,
  Get,
  Module,
  Param,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { z } from "@orvyn/shared";
import { exportMarkdown } from "@orvyn/editor/markdown-export";
import { documentSchemaVersion } from "@orvyn/editor";
import {
  documentAssets,
  documentReferences,
  pageLink,
  validHeadingId,
} from "@orvyn/editor/links";
import { documentPeople } from "@orvyn/editor/mentions";
import { readSnapshot, origin } from "../auth/security.js";
import { pageAccess } from "../permissions/access.js";
import { fail, hash, user } from "../runtime.js";

const options = z.strictObject({
  includePeopleNames: z.enum(["true", "false"]).default("false"),
  review: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
function filename(title: string) {
  const clean = title
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");
  let value = "";
  for (const character of clean) {
    if (
      value.length + character.length > 120 ||
      Buffer.byteLength(value + character) > 240
    )
      break;
    value += character;
  }
  value = value.replace(/[. ]+$/g, "") || "page";
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?: *\.|$)/i.test(value))
    value = "_" + value;
  return value + ".md";
}
async function prepare(actor: string, id: string, query: unknown) {
  const parsed = options.safeParse(query);
  if (!parsed.success)
    return fail(400, "Choose valid Markdown export options.");
  const input = parsed.data;
  return readSnapshot(async (c) => {
    const source = await pageAccess(c, actor, id);
    if (!["page", "record"].includes(source.kind))
      return fail(400, "Choose a document or record page for Markdown export.");
    if (source.document_schema_version > documentSchemaVersion)
      return fail(409, "This document requires a newer application.");
    const pages = new Set(
      documentReferences(source.document, origin()).map(
        (reference) => reference.pageId,
      ),
    );
    function collect(node: any) {
      if (node.type === "orvynDatabase") pages.add(node.attrs.databaseId);
      node.content?.forEach(collect);
    }
    collect(source.document);
    const linked = (
        await c.query(
          "SELECT p.id,p.title FROM pages p WHERE p.id=ANY($1::uuid[]) AND orvyn_page_role(p.id,$2)>=10",
          [[...pages], actor],
        )
      ).rows,
      pageMap = new Map(linked.map((page) => [page.id, page])),
      fileIds = documentAssets(source.document).map((asset) => asset.fileId),
      files = (
        await c.query(
          "SELECT f.id,f.filename,f.media_type FROM files f WHERE f.id=ANY($1::uuid[]) AND f.state='ready' AND orvyn_page_role(f.page_id,$2)>=10",
          [fileIds, actor],
        )
      ).rows,
      fileMap = new Map(files.map((file) => [file.id, file]));
    const people =
        input.includePeopleNames === "true"
          ? (
              await c.query(
                `SELECT u.id,u.display_name FROM users u JOIN spaces s ON s.id=$1
      WHERE u.id=ANY($2::uuid[]) AND (u.id=s.owner_id OR EXISTS(SELECT 1 FROM space_members m WHERE m.space_id=s.id AND m.user_id=u.id))
        AND orvyn_page_role($3,u.id)>=10`,
                [source.space_id, documentPeople(source.document), source.id],
              )
            ).rows
          : [],
      names = new Map(people.map((person) => [person.id, person.display_name]));
    let result;
    try {
      result = exportMarkdown(source.document, {
        title: source.title,
        pageUrl: new URL(pageLink(source.id), origin()).toString(),
        includePeopleNames: input.includePeopleNames === "true",
        person: (id) => names.get(id),
        page: (id, headingId) => {
          const target = pageMap.get(id);
          return target
            ? {
                title: target.title,
                href: new URL(
                  pageLink(id, validHeadingId(headingId) ? headingId : ""),
                  origin(),
                ).toString(),
              }
            : undefined;
        },
        file: (id, image) => {
          const file = fileMap.get(id);
          return file && (!image || imageTypes.has(file.media_type))
            ? {
                label: file.filename,
                href: new URL(
                  "/api/v1/files/" + id + "/download",
                  origin(),
                ).toString(),
              }
            : undefined;
        },
      });
    } catch {
      return fail(
        400,
        "This page cannot be represented within the Markdown export limits.",
      );
    }
    const file = filename(source.title),
      digest = hash(
        JSON.stringify({
          ...result,
          filename: file,
          page: source.id,
          people: input.includePeopleNames,
        }),
      );
    if (input.review && input.review !== digest)
      return fail(
        409,
        "The saved page or linked access changed. Refresh the export before downloading.",
      );
    return { ...result, filename: file, title: source.title, digest };
  });
}
@Controller("api/v1/pages/:id")
class MarkdownExports {
  @Get("export/markdown") async preview(
    @Req() req: any,
    @Param("id") id: string,
    @Query() query: unknown,
  ) {
    return prepare(await user(req), id, query);
  }
  @Get("export.md") async download(
    @Req() req: any,
    @Param("id") id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: any,
  ) {
    const result = await prepare(await user(req), id, query);
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="page.md"; filename*=UTF-8''${encodeURIComponent(result.filename).replace(/['()*]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase())}`,
    );
    res.setHeader("Cache-Control", "private, no-store");
    return result.markdown;
  }
}
@Module({ controllers: [MarkdownExports] })
export class MarkdownExportsModule {}

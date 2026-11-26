import {
  Module,
  Controller,
  Post,
  Req,
  Param,
  Body,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  z,
  markdownImportInput,
  markdownImportCommitInput,
  type MarkdownImportInput,
} from "@orvyn/shared";
import {
  importMarkdown,
  bindMarkdownDocument,
  markdownImportPreviewId,
} from "@orvyn/editor/markdown";
import { documentSchemaVersion, DocumentLimitError } from "@orvyn/editor";
import { documentReferences } from "@orvyn/editor/links";
import { user, hash, fail } from "../runtime.js";
import {
  MarkdownImportGuard,
  markdownFileInterceptor,
  markdownRequestBody,
} from "./markdown-upload.js";
import {
  transaction,
  readSnapshot,
  audit,
  encryptionKey,
} from "../auth/security.js";
import {
  spaceAccess,
  newPageParent,
  pageAccess,
} from "../permissions/access.js";

const claims = z.strictObject({
  actor: z.uuid(),
  space: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  expires: z.number().int().positive(),
});
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  return result.success
    ? result.data
    : fail(400, result.error.issues[0]?.message || "Invalid import");
}
const signature = (value: string) =>
  createHmac("sha256", encryptionKey())
    .update("orvyn:markdown-import:v1:" + value)
    .digest();
function sign(value: z.infer<typeof claims>) {
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  return encoded + "." + signature(encoded).toString("base64url");
}
function decode(token: string) {
  try {
    const [encoded, raw, extra] = token.split(".");
    if (
      !encoded ||
      !raw ||
      extra ||
      !/^[A-Za-z0-9_-]+$/.test(encoded) ||
      !/^[A-Za-z0-9_-]+$/.test(raw)
    )
      throw Error();
    const actual = Buffer.from(raw, "base64url"),
      expected = signature(encoded);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw Error();
    return claims.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
  } catch {
    return fail(400, "Invalid import review. Preview the file again.");
  }
}
async function plan(
  c: PoolClient,
  actor: string,
  spaceId: string,
  input: MarkdownImportInput,
  write = false,
) {
  const space = await spaceAccess(c, actor, spaceId, 30, write),
    parent = await newPageParent(c, actor, space.id, input.parentId);
  let content;
  try {
    content = importMarkdown(input.markdown, input);
  } catch (error) {
    return fail(
      400,
      error instanceof Error &&
        (error instanceof DocumentLimitError ||
          /^(Choose a |The Markdown contains)/.test(error.message))
        ? error.message
        : "This Markdown could not be converted into an editable page. Check its block structure and links, then preview it again.",
    );
  }
  const ancestry = (
      await c.query(
        `WITH RECURSIVE ancestor AS (
    SELECT id,parent_id,title,visibility,deleted_at,0 AS depth FROM pages WHERE id=$1
    UNION ALL SELECT p.id,p.parent_id,p.title,p.visibility,p.deleted_at,a.depth+1 FROM pages p JOIN ancestor a ON p.id=a.parent_id WHERE a.depth<63)
    SELECT a.id,a.parent_id,a.title,a.visibility,a.deleted_at,
      coalesce((SELECT jsonb_agg(jsonb_build_array(pp.user_id,pp.role) ORDER BY pp.user_id) FROM page_permissions pp WHERE pp.page_id=a.id),'[]'::jsonb) AS permissions
    FROM ancestor a ORDER BY a.id`,
        [parent],
      )
    ).rows,
    members = (
      await c.query(
        "SELECT user_id,role FROM space_members WHERE space_id=$1 ORDER BY user_id",
        [space.id],
      )
    ).rows,
    destination = {
      spaceId: space.id,
      spaceName: space.name,
      parentId: parent,
      parentTitle: ancestry.find((page) => page.id === parent)?.title || null,
      kind: space.kind,
    },
    policy = {
      space: [space.id, space.name, space.kind, space.owner_id],
      members,
      ancestry,
    },
    digest = hash(
      JSON.stringify({
        input,
        ...content,
        policy,
        schema: documentSchemaVersion,
      }),
    );
  return { ...content, destination, digest };
}

@Controller("api/v1/spaces/:space/imports/markdown")
@UseGuards(MarkdownImportGuard)
class MarkdownImports {
  @Post("preview")
  @UseInterceptors(markdownFileInterceptor())
  async preview(
    @Req() req: any,
    @Param("space") spaceId: string,
    @Body() body: unknown,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const actor = await user(req),
      input = parse(markdownImportInput, markdownRequestBody(req, body, file));
    return readSnapshot(async (c) => {
      const result = await plan(c, actor, spaceId, input);
      return {
        title: result.title,
        previewPageId: markdownImportPreviewId,
        document: result.document,
        warnings: result.warnings,
        destination: result.destination,
        previewToken: sign({
          actor,
          space: result.destination.spaceId,
          digest: result.digest,
          expires: Date.now() + 10 * 60 * 1000,
        }),
      };
    });
  }
  @Post()
  @UseInterceptors(markdownFileInterceptor())
  async commit(
    @Req() req: any,
    @Param("space") spaceId: string,
    @Body() body: unknown,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const actor = await user(req),
      request = parse(
        markdownImportCommitInput,
        markdownRequestBody(req, body, file, true),
      ),
      token = decode(request.previewToken);
    if (token.actor !== actor || token.space !== spaceId.toLowerCase())
      return fail(400, "The review belongs to another importer or space.");
    const fingerprint = hash(
      JSON.stringify({ spaceId: spaceId.toLowerCase(), input: request.input }),
    );
    return transaction(async (c) => {
      const space = await spaceAccess(c, actor, spaceId, 30, true);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        actor + ":markdown-import:" + request.requestId,
      ]);
      const previous = (
        await c.query(
          "SELECT * FROM page_import_requests WHERE actor_id=$1 AND request_id=$2",
          [actor, request.requestId],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.request_hash !== fingerprint ||
          previous.space_id !== space.id
        )
          return fail(
            409,
            "This import request was already used for different content.",
          );
        if (!previous.page_id)
          return fail(
            409,
            "The imported page was deleted. Review a new import.",
          );
        return {
          ...(await pageAccess(c, actor, previous.page_id)),
          replayed: true,
        };
      }
      if (token.expires <= Date.now())
        return fail(409, "The import review expired. Preview the file again.");
      const result = await plan(c, actor, space.id, request.input, true);
      if (result.digest !== token.digest)
        return fail(
          409,
          "The content or destination access changed. Preview the file again.",
        );
      const pageId = randomUUID(),
        document = bindMarkdownDocument(result.document, pageId);
      const page = (
        await c.query(
          `INSERT INTO pages(space_id,parent_id,title,kind,document,document_schema_version,created_by,last_edited_by,id)
        VALUES($1,$2,$3,'page',$4,$5,$6,$6,$7) RETURNING *`,
          [
            space.id,
            result.destination.parentId,
            result.title,
            document,
            documentSchemaVersion,
            actor,
            pageId,
          ],
        )
      ).rows[0];
      await c.query("SELECT orvyn_replace_page_references($1,$2::jsonb)", [
        page.id,
        JSON.stringify(documentReferences(document, process.env.ORVYN_ORIGIN!)),
      ]);
      await c.query(
        "INSERT INTO page_revisions(page_id,version,title,document,author_id) VALUES($1,$2,$3,$4,$5)",
        [page.id, page.version, page.title, page.document, actor],
      );
      await c.query(
        "INSERT INTO page_import_requests(actor_id,request_id,space_id,page_id,request_hash) VALUES($1,$2,$3,$4,$5)",
        [actor, request.requestId, space.id, page.id, fingerprint],
      );
      await audit(c, actor, "page.created", {
        pageId: page.id,
      });
      return { ...(await pageAccess(c, actor, page.id)), replayed: false };
    });
  }
}
@Module({ controllers: [MarkdownImports], providers: [MarkdownImportGuard] })
export class MarkdownImportsModule {}

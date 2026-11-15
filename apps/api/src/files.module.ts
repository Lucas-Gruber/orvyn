import {
  Module,
  Controller,
  Get,
  Post,
  Delete,
  Req,
  Res,
  Param,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  Injectable,
  CanActivate,
  ExecutionContext,
  StreamableFile,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { db, fail, mutation, user } from "./runtime.js";
import { pageAccess, pageWrite } from "./permissions/access.js";
import { transaction, audit, origin, rateLimit } from "./auth/security.js";
import {
  storage,
  bucket,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "./files/storage.js";
const maxBytes = Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024);
if (
  !Number.isSafeInteger(maxBytes) ||
  maxBytes < 1 ||
  maxBytes > 100 * 1024 * 1024
)
  throw Error("MAX_UPLOAD_BYTES must be between 1 byte and 100 MiB");
@Injectable()
class UploadGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    if (req.headers.origin !== origin()) fail(403, "Invalid origin");
    if (!req.is("multipart/form-data")) fail(415, "Multipart upload required");
    const uid = await user(req);
    await pageAccess(db, uid, req.params.id, 30);
    await rateLimit("upload:" + uid, 50);
    return true;
  }
}
export function mediaType(bytes: Buffer) {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
  )
    return "image/png";
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString("hex") === "ffd8ff")
    return "image/jpeg";
  if (
    bytes.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())
  )
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  return "application/octet-stream";
}
@Controller("api/v1")
class FilesController {
  @Get("files/limits") async limits(@Req() req: any) {
    await user(req);
    return { maxUploadBytes: maxBytes };
  }
  @Get("pages/:id/files") async list(@Req() req: any, @Param("id") id: string) {
    const uid = await user(req),
      p = await pageAccess(db, uid, id);
    return (
      await db.query(
        "SELECT id,filename,media_type,size,created_at FROM files WHERE page_id=$1 AND state='ready' ORDER BY created_at DESC LIMIT 200",
        [p.id],
      )
    ).rows;
  }
  @Post("pages/:id/files")
  @UseGuards(UploadGuard)
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: maxBytes, files: 1, fields: 0 },
    }),
  )
  async upload(
    @Req() req: any,
    @Param("id") id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    const uid = await user(req);
    if (!file?.buffer || !file.size || file.size > maxBytes)
      return fail(
        400,
        "A non-empty file within the configured size limit is required",
      );
    let original = file.originalname;
    try {
      if ([...original].every((c) => c.charCodeAt(0) <= 255))
        original = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(original, "latin1"),
        );
    } catch {}
    const filename =
        original.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 250) ||
        "attachment",
      type = mediaType(file.buffer),
      key = "attachments/" + randomUUID();
    const row = await transaction(async (c) => {
      const p = await pageWrite(c, uid, id);
      return (
        await c.query(
          "INSERT INTO files(page_id,object_key,filename,media_type,size,uploaded_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
          [p.id, key, filename, type, file.size, uid],
        )
      ).rows[0];
    });
    try {
      await storage().send(
        new PutObjectCommand({
          Bucket: bucket(),
          Key: key,
          Body: file.buffer,
          ContentType: type,
          ContentMD5: createHash("md5").update(file.buffer).digest("base64"),
        }),
      );
      return await transaction(async (c) => {
        await pageWrite(c, uid, id);
        const r = await c.query(
          "UPDATE files SET state='ready' WHERE id=$1 AND state='pending' RETURNING id,filename,media_type,size,created_at",
          [row.id],
        );
        if (!r.rowCount) fail(409, "Upload could not be completed");
        await audit(c, uid, "file.uploaded");
        return r.rows[0];
      });
    } catch (error) {
      try {
        await storage().send(
          new DeleteObjectCommand({ Bucket: bucket(), Key: key }),
        );
        await db.query("DELETE FROM files WHERE id=$1 AND state='pending'", [
          row.id,
        ]);
      } catch {}
      if (error instanceof Error && "getStatus" in error) throw error;
      return fail(503, "Upload could not be completed");
    }
  }
  @Get("files/:id/download") async download(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
    @Param("id") id: string,
  ) {
    return this.read(req, res, id, false);
  }
  @Get("files/:id/preview") async preview(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
    @Param("id") id: string,
  ) {
    return this.read(req, res, id, true);
  }
  private async read(req: any, res: any, id: string, preview: boolean) {
    const uid = await user(req);
    const file = (
      await db.query(
        "SELECT f.*,orvyn_page_role(p.id,$2) AS rank FROM files f JOIN pages p ON p.id=f.page_id WHERE f.id::text=$1 AND f.state='ready'",
        [id, uid],
      )
    ).rows[0];
    if (!file || file.rank < 10) return fail(404, "File not found");
    if (
      preview &&
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        file.media_type,
      )
    )
      return fail(415, "Inline preview is not supported for this file");
    let object;
    try {
      object = await storage().send(
        new GetObjectCommand({ Bucket: bucket(), Key: file.object_key }),
      );
    } catch {
      return fail(503, "File storage unavailable");
    }
    if (!(object.Body instanceof Readable))
      return fail(503, "File could not be read");
    res.setHeader(
      "Content-Type",
      preview ? file.media_type : "application/octet-stream",
    );
    res.setHeader("Content-Length", String(file.size));
    res.setHeader(
      "Content-Disposition",
      `${preview ? "inline" : "attachment"}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`,
    );
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    return new StreamableFile(object.Body);
  }
  @Delete("files/:id") async remove(@Req() req: any, @Param("id") id: string) {
    mutation(req);
    const uid = await user(req);
    return transaction(async (c) => {
      const file = (
        await c.query(
          "SELECT * FROM files WHERE id::text=$1 AND state='ready'",
          [id],
        )
      ).rows[0];
      if (!file) fail(404, "File not found");
      await pageWrite(c, uid, file.page_id);
      await c.query(
        "UPDATE files SET state='deleted',deleted_at=now() WHERE id=$1",
        [file.id],
      );
      await audit(c, uid, "file.deleted");
      return { ok: true };
    });
  }
}
@Module({ controllers: [FilesController], providers: [UploadGuard] })
export class FilesModule {}

import {
  Controller,
  Get,
  Post,
  Module,
  Param,
  Req,
  Res,
  Body,
  StreamableFile,
} from "@nestjs/common";
import { Readable } from "node:stream";
import { zipSync, strToU8, type Zippable } from "fflate";
import { markdownBundleInput, markdownBundleDownload, z } from "@orvyn/shared";
import { readSnapshot, rateLimit } from "../auth/security.js";
import { fail, mutation, user } from "../runtime.js";
import { storage, bucket, GetObjectCommand } from "../files/storage.js";
import { bundleTree, bundlePlan } from "./markdown-bundle-plan.js";

function parse<T>(schema: z.ZodType<T>, body: unknown) {
  const value = schema.safeParse(body);
  return value.success
    ? value.data
    : fail(
        400,
        value.error.issues[0]?.message ||
          "Choose valid Markdown bundle options.",
      );
}
let activeDownloads = 0;
@Controller("api/v1/pages/:id/export")
class MarkdownBundles {
  @Get("tree") async tree(@Req() req: any, @Param("id") id: string) {
    const actor = await user(req);
    return readSnapshot((c) => bundleTree(c, actor, id));
  }
  @Post("bundle/preview") async preview(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    const actor = await user(req),
      input = parse(markdownBundleInput, body);
    await rateLimit("markdown-bundle-preview:" + actor, 60);
    return (await bundlePlan(actor, id, input)).preview;
  }
  @Post("bundle") async download(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: any,
  ) {
    mutation(req);
    const actor = await user(req),
      { review, ...input } = parse(markdownBundleDownload, body);
    await rateLimit("markdown-bundle-download:" + actor, 30);
    if (activeDownloads >= 2)
      fail(
        503,
        "Other bundles are being prepared. Retry this download shortly.",
      );
    activeDownloads++;
    const disconnected = new AbortController(),
      abort = () => {
        if (!res.writableEnded) disconnected.abort();
      },
      signal = AbortSignal.any([
        disconnected.signal,
        AbortSignal.timeout(90000),
      ]);
    res.once("close", abort);
    try {
      const plan = await bundlePlan(actor, id, input);
      if (review !== plan.preview.digest)
        fail(
          409,
          "The selected content or access changed. Refresh the export before downloading.",
        );
      const archive: Zippable = Object.create(null);
      for (const [path, text] of plan.entries) archive[path] = strToU8(text);
      for (const file of plan.files) {
        let body: Readable | undefined;
        const cancel = () =>
          body?.destroy(new Error("Attachment read aborted"));
        try {
          const object = await storage().send(
            new GetObjectCommand({ Bucket: bucket(), Key: file.object_key }),
            { abortSignal: signal },
          );
          const stream = object.Body;
          if (!(stream instanceof Readable))
            return fail(
              503,
              "An attachment could not be copied. No bundle was downloaded.",
            );
          body = stream;
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
          if (object.ContentLength !== Number(file.size))
            throw Error("Attachment size changed");
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of stream) {
            if (signal.aborted) throw Error("Aborted");
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > Number(file.size))
              throw Error("Attachment size changed");
            chunks.push(buffer);
          }
          if (bytes !== Number(file.size)) throw Error("Attachment incomplete");
          archive[file.path] = Buffer.concat(chunks, bytes);
        } catch {
          fail(
            503,
            "An attachment could not be copied. No bundle was downloaded; retry after refreshing.",
          );
        } finally {
          signal.removeEventListener("abort", cancel);
          body?.destroy();
        }
      }
      // Fetches happen outside a database transaction. A fresh check after them
      // prevents a slow object store from extending the earlier read snapshot.
      if (
        (await user(req)) !== actor ||
        (await bundlePlan(actor, id, input)).preview.digest !== review
      )
        fail(
          409,
          "The selected content or access changed. Refresh the export before downloading.",
        );
      if (signal.aborted)
        fail(
          503,
          "The bundle took too long to prepare. Choose fewer attachments and retry.",
        );
      const bytes = zipSync(archive, { level: 0, mtime: new Date(2000, 0, 1) });
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="pages.zip"; filename*=UTF-8''${encodeURIComponent(plan.preview.filename).replace(/['()*]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase())}`,
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Length", String(bytes.length));
      return new StreamableFile(
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      );
    } finally {
      activeDownloads--;
      res.off("close", abort);
    }
  }
}
@Module({ controllers: [MarkdownBundles] })
export class MarkdownBundlesModule {}

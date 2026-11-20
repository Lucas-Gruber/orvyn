import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  markdownImportInput,
  markdownImportCommitInput,
  markdownImportMaxBytes,
  z,
} from "@orvyn/shared";
import { db, user, fail } from "../runtime.js";
import { origin, rateLimit } from "../auth/security.js";
import { spaceAccess } from "../permissions/access.js";

@Injectable()
export class MarkdownImportGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    if (req.headers.origin !== origin()) return fail(403, "Invalid origin");
    if (!req.is("application/json") && !req.is("multipart/form-data"))
      return fail(415, "Choose JSON or a Markdown file upload.");
    const actor = await user(req);
    await spaceAccess(db, actor, req.params.space, 30);
    await rateLimit("markdown-import:" + actor, 100);
    return true;
  }
}
export const markdownFileInterceptor = () =>
  FileInterceptor("file", {
    limits: {
      fileSize: markdownImportMaxBytes,
      files: 1,
      fields: 1,
      fieldSize: 12 * 1024,
    },
  });
const metadata = markdownImportInput.omit({ markdown: true });
const commitMetadata = markdownImportCommitInput.extend({ input: metadata });
function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value);
  return result.success
    ? result.data
    : fail(
        400,
        result.error.issues[0]?.message || "Invalid Markdown import settings.",
      );
}
export function markdownRequestBody(
  req: any,
  body: unknown,
  file: Express.Multer.File | undefined,
  commit = false,
): unknown {
  if (req.is("application/json")) return body;
  if (!file?.buffer) return fail(400, "Choose a Markdown file.");
  if (file.buffer.byteLength > markdownImportMaxBytes)
    return fail(413, "The Markdown file is too large.");
  let settings: unknown, markdown: string;
  const rawSettings = (body as any)?.settings;
  if (typeof rawSettings !== "string")
    return fail(400, "Choose valid Markdown import settings.");
  try {
    settings = JSON.parse(rawSettings);
  } catch {
    return fail(400, "Choose valid Markdown import settings.");
  }
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(file.buffer);
  } catch {
    return fail(400, "Choose a UTF-8 Markdown text file.");
  }
  if (commit) {
    const value = parse(commitMetadata, settings);
    return { ...value, input: { ...value.input, markdown } };
  }
  return { ...parse(metadata, settings), markdown };
}

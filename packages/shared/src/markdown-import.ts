import { z } from "zod";
export const markdownImportInput = z.strictObject({
  filename: z.string().trim().min(1).max(160),
  markdown: z.string().min(1).max(32768),
  title: z.string().trim().min(1).max(300).optional(),
  titleFromHeading: z.boolean().default(true),
  parentId: z
    .uuid()
    .transform((id) => id.toLowerCase())
    .nullable()
    .default(null),
});
export const markdownImportCommitInput = z.strictObject({
  requestId: z.uuid(),
  previewToken: z.string().min(80).max(4096),
  input: markdownImportInput,
});
export type MarkdownImportInput = z.infer<typeof markdownImportInput>;

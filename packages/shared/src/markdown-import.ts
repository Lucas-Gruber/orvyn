import { z } from "zod";
import { markdownImportMaxBytes } from "./markdown-limits.js";
const utf8 = (value: string) =>
  !/[\uD800-\uDFFF]/u.test(value) && !value.includes("\0");
export const markdownImportInput = z.strictObject({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .refine(utf8, "Choose a valid UTF-8 filename."),
  markdown: z.string().min(1).max(markdownImportMaxBytes),
  title: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .refine(utf8, "Choose a valid UTF-8 page title.")
    .optional(),
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

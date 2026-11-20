import { z } from "zod";

export const markdownBundleLimits = {
  pages: 100,
  candidates: 500,
  files: 100,
  bytes: 32 * 1024 * 1024,
} as const;
export const markdownBundleInput = z.strictObject({
  pageIds: z
    .array(z.uuid())
    .min(1)
    .max(markdownBundleLimits.pages)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Choose each page once.",
    ),
  includeAttachments: z.boolean().default(false),
  includePeopleNames: z.boolean().default(false),
});
export const markdownBundleDownload = markdownBundleInput.extend({
  review: z.string().regex(/^[a-f0-9]{64}$/),
});
export type MarkdownBundleInput = z.infer<typeof markdownBundleInput>;
export interface MarkdownBundleTree {
  pages: {
    id: string;
    parentId: string | null;
    title: string;
    kind: string;
    depth: number;
  }[];
  truncated: boolean;
}
export interface MarkdownBundlePreview {
  title: string;
  filename: string;
  digest: string;
  pages: {
    id: string;
    title: string;
    path: string;
    bytes: number;
    warnings: string[];
  }[];
  files: { path: string; filename: string; bytes: number }[];
  bytes: number;
  warnings: string[];
}

import type { MarkdownImportInput } from "@orvyn/shared";

export function markdownUpload(
  input: MarkdownImportInput,
  receipt?: { requestId: string; previewToken: string },
) {
  const { markdown, ...metadata } = input;
  const body = new FormData();
  body.append(
    "file",
    new Blob([markdown], { type: "text/markdown" }),
    "document.md",
  );
  body.append(
    "settings",
    JSON.stringify(receipt ? { ...receipt, input: metadata } : metadata),
  );
  return body;
}

import { DatabaseBlock } from "./database-node.js";
import { HeadingIdentity, validHeadingId } from "./heading-links.js";
import { getSchema, type AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { TableKit } from "@tiptap/extension-table";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import {
  CalloutBlock,
  ToggleBlock,
  ToggleSummary,
  ToggleContent,
  TableOfContentsBlock,
  calloutTones,
} from "./content-blocks.js";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
const lowlight = createLowlight(common);
export const documentSchemaVersion = 4;
export function editorExtensions(collaborative = false): AnyExtension[] {
  return [
    StarterKit.configure({
      undoRedo: collaborative ? false : undefined,
      trailingNode: false,
      codeBlock: false,
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, defaultProtocol: "https" },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    DatabaseBlock,
    HeadingIdentity,
    CalloutBlock,
    ToggleBlock,
    ToggleSummary,
    ToggleContent,
    TableOfContentsBlock,
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: "plaintext" }),
  ];
}
export const schema: ReturnType<typeof getSchema> =
  getSchema(editorExtensions());
export function validateDocument(input: unknown) {
  if (
    !input ||
    typeof input !== "object" ||
    JSON.stringify(input).length > 100000
  )
    throw Error("Invalid document size");
  const node = schema.nodeFromJSON(input);
  if (node.type.name !== "doc") throw Error("Document root required");
  node.check();
  let nodes = 0;
  const bounded = (n: any, depth: number) => {
    if (++nodes > 3000 || depth > 64)
      throw Error("Document structure limit exceeded");
    if (n.type.name === "orvynDatabase") {
      const uuid =
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
      if (
        typeof n.attrs.databaseId !== "string" ||
        !uuid.test(n.attrs.databaseId) ||
        (n.attrs.viewId !== null &&
          (typeof n.attrs.viewId !== "string" || !uuid.test(n.attrs.viewId)))
      )
        throw Error("Invalid database block reference");
    }
    if (n.type.name === "heading" && ![1, 2, 3].includes(n.attrs.level))
      throw Error("Invalid heading level");
    if (n.type.name === "orvynCallout" && !calloutTones.includes(n.attrs.tone))
      throw Error("Invalid callout tone");
    if (
      n.type.name === "heading" &&
      n.attrs.id !== null &&
      !validHeadingId(n.attrs.id)
    )
      throw Error("Invalid heading anchor");
    if (
      n.type.name === "codeBlock" &&
      n.attrs.language !== null &&
      (typeof n.attrs.language !== "string" ||
        !/^[a-zA-Z0-9+#._-]{1,40}$/.test(n.attrs.language))
    )
      throw Error("Invalid code language");
    if (n.type.name === "taskItem" && typeof n.attrs.checked !== "boolean")
      throw Error("Invalid task state");
    if (
      n.type.name === "orderedList" &&
      (!Number.isSafeInteger(n.attrs.start) ||
        n.attrs.start < 1 ||
        n.attrs.start > 1000000)
    )
      throw Error("Invalid list start");
    if (["tableCell", "tableHeader"].includes(n.type.name)) {
      for (const key of ["rowspan", "colspan"])
        if (
          !Number.isInteger(n.attrs[key]) ||
          n.attrs[key] < 1 ||
          n.attrs[key] > 100
        )
          throw Error("Invalid table span");
      if (
        n.attrs.colwidth !== null &&
        (!Array.isArray(n.attrs.colwidth) ||
          n.attrs.colwidth.length > 100 ||
          n.attrs.colwidth.some(
            (v: any) => !Number.isInteger(v) || v < 1 || v > 2000,
          ))
      )
        throw Error("Invalid column width");
    }
    n.forEach((child: any) => bounded(child, depth + 1));
  };
  bounded(node, 0);
  node.descendants((n) => {
    for (const mark of n.marks)
      if (mark.type.name === "link") {
        const href = mark.attrs.href;
        if (typeof href !== "string" || href.length > 4000)
          throw Error("Invalid link");
        if (![null, "_blank", "_self"].includes(mark.attrs.target))
          throw Error("Invalid link target");
        if (
          mark.attrs.target === "_blank" &&
          (!/\bnoopener\b/.test(mark.attrs.rel || "") ||
            !/\bnoreferrer\b/.test(mark.attrs.rel || ""))
        )
          throw Error("Unsafe external link");
        const url = new URL(href, "https://orvyn.invalid");
        if (!["https:", "http:", "mailto:", "tel:"].includes(url.protocol))
          throw Error("Unsafe link protocol");
      }
  });
  return node.toJSON();
}
export function normalizeDocument(input: any) {
  if (input?.type === "doc" && Array.isArray(input.content)) {
    const content = input.content.length
      ? input.content.map((n: any) =>
          n?.type === "paragraph" && typeof n.text === "string"
            ? {
                type: "paragraph",
                ...(n.text
                  ? { content: [{ type: "text", text: n.text }] }
                  : {}),
              }
            : n,
        )
      : [{ type: "paragraph" }];
    return validateDocument({ type: "doc", content });
  }
  throw Error("Invalid document");
}
export function documentToYDoc(json: unknown) {
  return prosemirrorJSONToYDoc(schema, validateDocument(json), "default");
}
export function yDocToDocument(doc: Y.Doc) {
  if ([...doc.share.keys()].some((k) => k !== "default"))
    throw Error("Unsupported shared document field");
  return validateDocument(yDocToProsemirrorJSON(doc, "default"));
}
// Keep command type augmentation visible to consumers of the shared package.
export { default as StarterKit } from "@tiptap/starter-kit";
export { default as TaskList } from "@tiptap/extension-task-list";
export { default as TaskItem } from "@tiptap/extension-task-item";
export { TableKit } from "@tiptap/extension-table";

export { DatabaseBlock } from "./database-node.js";
export {
  CalloutBlock,
  ToggleBlock,
  ToggleSummary,
  ToggleContent,
  TableOfContentsBlock,
} from "./content-blocks.js";
export {
  HeadingIdentity,
  documentHeadings,
  validHeadingId,
  headingFromHash,
  pageLink,
} from "./heading-links.js";

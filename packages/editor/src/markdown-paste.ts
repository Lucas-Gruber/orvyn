import { Extension } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { parseMarkdown } from "./markdown-parser.js";

export const MarkdownPaste = Extension.create<{
  normalizeDocument: null | ((document: unknown) => unknown);
  pageId: null | (() => string);
}>({
  name: "orvynMarkdownPaste",
  addOptions() {
    return { normalizeDocument: null, pageId: null };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        props: {
          // ProseMirror calls this only for text pastes. Rich HTML keeps its
          // existing formatting; code blocks bypass it altogether. `plain`
          // also preserves the native Ctrl/Cmd+Shift+V escape hatch.
          clipboardTextParser(text, $context, plain, view) {
            const { schema } = view.state;
            if (!plain && view.editable && options.normalizeDocument) {
              try {
                const parsed = parseMarkdown(
                  text,
                  { filename: "Clipboard.md", titleFromHeading: false },
                  {
                    headingId: () => globalThis.crypto.randomUUID(),
                    pageId: options.pageId?.(),
                  },
                );
                const document = schema.nodeFromJSON(
                  options.normalizeDocument(parsed.document),
                );
                let formatted = false;
                document.descendants((node) => {
                  if (
                    !["paragraph", "text", "hardBreak"].includes(
                      node.type.name,
                    ) ||
                    node.marks.length
                  )
                    formatted = true;
                });
                if (formatted) return Slice.maxOpen(document.content);
              } catch {
                // Unsupported/oversized input remains editable plain text.
                // Clipboard content must never be logged or silently dropped.
              }
            }
            const marks = $context.marks();
            return Slice.maxOpen(
              Fragment.fromArray(
                text
                  .split(/(?:\r\n?|\n)+/)
                  .map((line) =>
                    schema.nodes.paragraph!.create(
                      null,
                      line ? schema.text(line, marks) : undefined,
                    ),
                  ),
              ),
            );
          },
        },
      }),
    ];
  },
});

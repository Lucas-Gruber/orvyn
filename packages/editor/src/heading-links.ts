import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { documentHeadings, validHeadingId } from "./links.js";
export {
  documentHeadings,
  validHeadingId,
  headingFromHash,
  pageLink,
} from "./links.js";
export const HeadingIdentity = Extension.create<{
  onCopy: null | ((id: string) => void);
  activeHeading: null | (() => string);
}>({
  name: "headingIdentity",
  addOptions() {
    return { onCopy: null, activeHeading: null };
  },
  addGlobalAttributes() {
    return [
      {
        types: ["heading"],
        attributes: {
          id: {
            default: null,
            // Pasted headings must get fresh identities instead of stealing a target.
            parseHTML: () => null,
            renderHTML: (attrs) =>
              validHeadingId(attrs.id) ? { id: "h-" + attrs.id } : {},
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    const editor = this.editor,
      copy = this.options.onCopy,
      activeHeading = this.options.activeHeading;
    return [
      new Plugin({
        appendTransaction(_transactions, _old, state) {
          if (!editor.isEditable) return null;
          const seen = new Set<string>(),
            tr = state.tr;
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "heading") return;
            let id = node.attrs.id;
            if (!validHeadingId(id) || seen.has(id)) {
              id = globalThis.crypto.randomUUID();
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, id });
            }
            seen.add(id);
          });
          return tr.docChanged ? tr : null;
        },
        props: {
          decorations(state) {
            const targets = documentHeadings(state.doc.toJSON()),
              decorations: Decoration[] = [];
            let i = 0;
            state.doc.descendants((node, pos) => {
              if (node.type.name !== "heading") return;
              const target = targets[i++];
              decorations.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  id: "h-" + target.id,
                  tabindex: "-1",
                  "aria-label": target.text,
                  ...(activeHeading?.() === target.id
                    ? { "data-link-target": "true" }
                    : {}),
                }),
              );
              if (copy)
                decorations.push(
                  Decoration.widget(
                    pos + node.nodeSize - 1,
                    () => {
                      const button = window.document.createElement("button");
                      button.type = "button";
                      button.className = "heading-permalink";
                      button.contentEditable = "false";
                      button.setAttribute(
                        "aria-label",
                        "Copy link to heading " + target.text,
                      );
                      button.title = "Copy link to this heading";
                      button.textContent = "#";
                      button.addEventListener("click", (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        copy(target.id);
                      });
                      return button;
                    },
                    {
                      key: "heading-link-" + target.id + ":" + target.text,
                      side: 1,
                      stopEvent: () => true,
                    },
                  ),
                );
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

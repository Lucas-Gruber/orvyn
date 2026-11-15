import { Node, mergeAttributes } from "@tiptap/core";
export const DatabaseBlock = Node.create({
  name: "orvynDatabase",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      databaseId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-orvyn-database"),
        renderHTML: (attrs) => ({ "data-orvyn-database": attrs.databaseId }),
      },
      viewId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-orvyn-view"),
        renderHTML: (attrs) =>
          attrs.viewId ? { "data-orvyn-view": attrs.viewId } : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-orvyn-database]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes)];
  },
});

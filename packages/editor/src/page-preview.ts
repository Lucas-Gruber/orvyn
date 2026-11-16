import { Node, mergeAttributes } from "@tiptap/core";
export const PagePreviewBlock = Node.create({
  name: "orvynPagePreview",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      pageId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-orvyn-page"),
        renderHTML: (attrs) => ({ "data-orvyn-page": attrs.pageId }),
      },
      headingId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-orvyn-heading"),
        renderHTML: (attrs) =>
          attrs.headingId ? { "data-orvyn-heading": attrs.headingId } : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: "article[data-orvyn-page]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["article", mergeAttributes(HTMLAttributes)];
  },
});

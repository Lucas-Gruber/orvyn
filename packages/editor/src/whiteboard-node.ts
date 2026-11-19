import { Node, mergeAttributes } from "@tiptap/core";
export const WhiteboardBlock = Node.create({
  name: "orvynWhiteboard",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      pageId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-orvyn-whiteboard"),
        renderHTML: (attrs) => ({ "data-orvyn-whiteboard": attrs.pageId }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-orvyn-whiteboard]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes)];
  },
});

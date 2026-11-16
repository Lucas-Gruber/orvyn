import { Node, mergeAttributes } from "@tiptap/core";
export const VideoEmbedBlock = Node.create({
  name: "orvynVideo",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      provider: {
        default: "youtube",
        parseHTML: (el) => el.getAttribute("data-orvyn-video"),
        renderHTML: (a) => ({ "data-orvyn-video": a.provider }),
      },
      resourceId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-resource-id"),
        renderHTML: (a) => ({ "data-resource-id": a.resourceId }),
      },
      title: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-title") || "",
        renderHTML: (a) => ({ "data-title": a.title }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "figure[data-orvyn-video][data-resource-id]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["figure", mergeAttributes(HTMLAttributes)];
  },
});

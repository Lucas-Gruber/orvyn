import { Node, mergeAttributes } from "@tiptap/core";
function asset(name: string, image: boolean) {
  return Node.create({
    name,
    group: "block",
    atom: true,
    selectable: true,
    addAttributes() {
      return {
        fileId: {
          default: null,
          parseHTML: (element) => element.getAttribute("data-file-id"),
          renderHTML: (attrs) => ({ "data-file-id": attrs.fileId }),
        },
        label: {
          default: "",
          parseHTML: (element) => element.getAttribute("data-label") || "",
          renderHTML: (attrs) => ({ "data-label": attrs.label }),
        },
      };
    },
    parseHTML() {
      return [
        {
          tag: `${image ? "figure" : "div"}[data-orvyn-${image ? "image" : "file"}][data-file-id]`,
        },
      ];
    },
    renderHTML({ HTMLAttributes }) {
      return [
        image ? "figure" : "div",
        mergeAttributes(HTMLAttributes, {
          [image ? "data-orvyn-image" : "data-orvyn-file"]: "",
        }),
      ];
    },
  });
}
export const ImageBlock = asset("orvynImage", true),
  FileBlock = asset("orvynFile", false);

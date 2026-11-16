import { Node, mergeAttributes } from "@tiptap/core";
export const PersonMention = Node.create({
  name: "orvynPerson",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      userId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-orvyn-person"),
        renderHTML: (attrs) => ({ "data-orvyn-person": attrs.userId }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-orvyn-person]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), "@Person"];
  },
  renderText() {
    return "@Person";
  },
});

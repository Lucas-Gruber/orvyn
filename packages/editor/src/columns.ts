import { Node } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { exitStructuredBlock } from "./content-blocks.js";
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    orvynColumns: { insertColumns: (count: 2 | 3) => ReturnType };
  }
}
export const ColumnBlock = Node.create({
  name: "orvynColumn",
  content: "block+",
  defining: true,
  parseHTML() {
    return [{ tag: "div[data-orvyn-column]" }];
  },
  renderHTML() {
    return ["div", { "data-orvyn-column": "" }, 0];
  },
});
export const ColumnsBlock = Node.create({
  name: "orvynColumns",
  group: "block",
  content: "orvynColumn{2,3}",
  defining: true,
  parseHTML() {
    return [{ tag: "div[data-orvyn-columns]" }];
  },
  renderHTML() {
    return ["div", { "data-orvyn-columns": "" }, 0];
  },
  addCommands() {
    return {
      insertColumns:
        (count) =>
        ({ chain }) => {
          if (count !== 2 && count !== 3) return false;
          return chain()
            .insertContent({
              type: this.name,
              content: Array.from({ length: count }, () => ({
                type: "orvynColumn",
                content: [{ type: "paragraph" }],
              })),
            })
            .command(({ tr }) => {
              const { $from } = tr.selection;
              for (let depth = $from.depth; depth > 0; depth--)
                if ($from.node(depth).type.name === this.name) {
                  tr.setSelection(
                    TextSelection.create(tr.doc, $from.before(depth) + 3),
                  );
                  return true;
                }
              return false;
            })
            .run();
        },
    };
  },
  addKeyboardShortcuts() {
    return { "Mod-Enter": () => exitStructuredBlock(this.editor, this.name) };
  },
});

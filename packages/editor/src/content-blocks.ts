import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    orvynBlocks: { insertToggle: () => ReturnType };
  }
}
export function exitStructuredBlock(editor: Editor, name: string) {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const type = $from.node(depth).type.name;
    if (["orvynCallout", "orvynToggle", "orvynColumns"].includes(type))
      return (
        type === name &&
        editor
          .chain()
          .insertContentAt($from.after(depth), { type: "paragraph" })
          .focus()
          .run()
      );
  }
  return false;
}
export const calloutTones = [
  "info",
  "neutral",
  "success",
  "warning",
  "danger",
] as const;
export const CalloutBlock = Node.create({
  name: "orvynCallout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      tone: {
        default: "info",
        parseHTML: (element) => element.getAttribute("data-tone") || "info",
        renderHTML: (attrs) => ({ "data-tone": attrs.tone }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "aside[data-orvyn-callout]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "aside",
      mergeAttributes(HTMLAttributes, { "data-orvyn-callout": "" }),
      0,
    ];
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Enter": () => exitStructuredBlock(this.editor, this.name),
    };
  },
});
export const ToggleSummary = Node.create({
  name: "orvynToggleSummary",
  content: "inline*",
  defining: true,
  isolating: true,
  parseHTML() {
    return [{ tag: "div[data-orvyn-toggle-summary]" }];
  },
  renderHTML() {
    return ["div", { "data-orvyn-toggle-summary": "" }, 0];
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { $from } = this.editor.state.selection;
        if ($from.parent.type.name !== this.name) return false;
        const toggle = $from.node($from.depth - 1),
          start = $from.before($from.depth - 1);
        return this.editor.commands.setTextSelection(
          start + toggle.firstChild!.nodeSize + 3,
        );
      },
      Backspace: () => {
        const { selection } = this.editor.state,
          { $from } = selection;
        if (
          $from.parent.type.name !== this.name ||
          !selection.empty ||
          $from.parent.content.size
        )
          return false;
        const toggle = $from.node($from.depth - 1),
          start = $from.before($from.depth - 1);
        return this.editor.commands.insertContentAt(
          { from: start, to: start + toggle.nodeSize },
          toggle.lastChild!.content.toJSON(),
        );
      },
    };
  },
});
export const ToggleContent = Node.create({
  name: "orvynToggleContent",
  content: "block+",
  defining: true,
  parseHTML() {
    return [{ tag: "div[data-orvyn-toggle-content]" }];
  },
  renderHTML() {
    return ["div", { "data-orvyn-toggle-content": "" }, 0];
  },
});
export const ToggleBlock = Node.create({
  name: "orvynToggle",
  group: "block",
  content: "orvynToggleSummary orvynToggleContent",
  defining: true,
  addCommands() {
    return {
      insertToggle:
        () =>
        ({ chain }) =>
          chain()
            .insertContent({
              type: this.name,
              content: [
                { type: "orvynToggleSummary" },
                {
                  type: "orvynToggleContent",
                  content: [{ type: "paragraph" }],
                },
              ],
            })
            .command(({ tr }) => {
              const { $from } = tr.selection;
              for (let depth = $from.depth; depth > 0; depth--)
                if ($from.node(depth).type.name === this.name) {
                  tr.setSelection(
                    TextSelection.create(tr.doc, $from.before(depth) + 2),
                  );
                  return true;
                }
              return false;
            })
            .run(),
    };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Enter": () => exitStructuredBlock(this.editor, this.name),
    };
  },
  parseHTML() {
    return [{ tag: "div[data-orvyn-toggle]" }];
  },
  renderHTML() {
    return ["div", { "data-orvyn-toggle": "" }, 0];
  },
});
export const TableOfContentsBlock = Node.create({
  name: "orvynToc",
  group: "block",
  atom: true,
  selectable: true,
  parseHTML() {
    return [{ tag: "nav[data-orvyn-toc]" }];
  },
  renderHTML() {
    return ["nav", { "data-orvyn-toc": "", "aria-label": "Table of contents" }];
  },
});

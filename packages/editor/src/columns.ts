import { Node, mergeAttributes } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { exitStructuredBlock } from "./content-blocks.js";

export const minimumColumnWidth = 1500;
export function validColumnWidths(
  value: unknown,
  count: number,
): value is number[] {
  return (
    (count === 2 || count === 3) &&
    Array.isArray(value) &&
    value.length === count &&
    value.every(
      (width) =>
        Number.isInteger(width) &&
        width >= minimumColumnWidth &&
        width <= 10000,
    ) &&
    value.reduce((sum, width) => sum + width, 0) === 10000
  );
}
export function columnWidths(value: unknown, count: number): number[] {
  if (validColumnWidths(value, count)) return [...value];
  return Array.from(
    { length: count },
    (_, index) =>
      Math.round(((index + 1) * 10000) / count) -
      Math.round((index * 10000) / count),
  );
}
export function resizeColumnPair(
  widths: number[],
  index: number,
  left: number,
) {
  const next = [...widths];
  if (
    !validColumnWidths(widths, widths.length) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= widths.length - 1 ||
    !Number.isFinite(left)
  )
    return next;
  const total = widths[index]! + widths[index + 1]!;
  next[index] = Math.max(
    minimumColumnWidth,
    Math.min(total - minimumColumnWidth, Math.round(left)),
  );
  next[index + 1] = total - next[index]!;
  return next;
}
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    orvynColumns: {
      insertColumns: (count: 2 | 3) => ReturnType;
      setColumnWidths: (
        position: number,
        widths: number[],
        expected: string,
      ) => ReturnType;
    };
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
  addAttributes() {
    return {
      widths: {
        default: null,
        parseHTML: (element) => {
          try {
            const widths = JSON.parse(
              element.getAttribute("data-column-widths") || "null",
            );
            return validColumnWidths(
              widths,
              element.querySelectorAll(":scope > [data-orvyn-column]").length,
            )
              ? widths
              : null;
          } catch {
            return null;
          }
        },
        renderHTML: ({ widths }) =>
          validColumnWidths(widths, widths?.length)
            ? { "data-column-widths": JSON.stringify(widths) }
            : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-orvyn-columns]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-orvyn-columns": "" }),
      0,
    ];
  },
  addCommands() {
    return {
      setColumnWidths:
        (position, widths, expected) =>
        ({ state, tr, dispatch }) => {
          if (
            !this.editor.isEditable ||
            !Number.isInteger(position) ||
            position < 0 ||
            position >= state.doc.content.size
          )
            return false;
          const current = state.doc.nodeAt(position);
          if (
            current?.type.name !== this.name ||
            !validColumnWidths(widths, current.childCount) ||
            JSON.stringify(current.attrs.widths) !== expected
          )
            return false;
          if (
            JSON.stringify(
              columnWidths(current.attrs.widths, current.childCount),
            ) === JSON.stringify(widths)
          )
            return true;
          if (dispatch)
            closeHistory(
              tr.setNodeMarkup(position, undefined, {
                ...current.attrs,
                widths,
              }),
            ).setMeta("orvyn-block-action", true);
          return true;
        },
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

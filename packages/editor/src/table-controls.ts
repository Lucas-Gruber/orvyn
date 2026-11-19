import { Extension, type Editor, type ChainedCommands } from "@tiptap/core";
import { Plugin, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  cellAround,
  columnResizing,
  columnResizingPluginKey,
  TableMap,
  updateColumnsOnResize,
} from "@tiptap/pm/tables";
import { validateDocument } from "./index.js";

export const editorTableMinWidth = 96;
export const editorTableMaxWidth = 2000;
export function tableSelectionContext(state: EditorState) {
  let cell = cellAround(state.selection.$from);
  if (!cell && state.selection.$from.nodeAfter?.type.name === "table") {
    const table = state.selection.$from.nodeAfter;
    if (!table.firstChild?.firstChild) return undefined;
    cell = cellAround(state.doc.resolve(state.selection.from + 4));
  }
  if (!cell) return undefined;
  const table = cell.node(-1),
    start = cell.start(-1);
  if (table.type.name !== "table") return undefined;
  const map = TableMap.get(table),
    rect = map.findCell(cell.pos - start);
  return {
    table,
    map,
    start,
    position: start - 1,
    cellPosition: cell.pos,
    row: rect.top,
    column: rect.left,
    rows: map.height,
    columns: map.width,
    headerRow:
      !!table.firstChild &&
      Array.from({ length: table.firstChild.childCount }, (_, i) =>
        table.firstChild!.child(i),
      ).every((node) => node.type.name === "tableHeader"),
    headerColumn: Array.from(
      { length: map.height },
      (_, row) => table.nodeAt(map.map[row * map.width]!)?.type.name,
    ).every((type) => type === "tableHeader"),
  };
}
function normalizeWidths(tr: Transaction) {
  tr.doc.descendants((node, pos) => {
    if (
      !["tableCell", "tableHeader"].includes(node.type.name) ||
      !Array.isArray(node.attrs.colwidth)
    )
      return;
    const widths = Array.from({ length: node.attrs.colspan }, (_, index) => {
      const width = node.attrs.colwidth[index];
      // ProseMirror uses zero for an unspecified width inside a merged cell.
      return !Number.isFinite(width) || width < 0
        ? 0
        : Math.max(0, Math.min(editorTableMaxWidth, Math.round(width)));
    });
    if (JSON.stringify(widths) !== JSON.stringify(node.attrs.colwidth))
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, colwidth: widths });
  });
}
function restoreWidths(view: EditorView) {
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== "table") return;
    const root = view.nodeDOM(pos) as HTMLElement | null;
    const table =
      root?.tagName === "TABLE"
        ? (root as HTMLTableElement)
        : root?.querySelector("table");
    const group = table?.querySelector("colgroup");
    if (table && group)
      updateColumnsOnResize(node, group, table, editorTableMinWidth);
  });
}
function cancelResize(view: EditorView) {
  if (view.isDestroyed) return;
  const current = columnResizingPluginKey.getState(view.state);
  if (current && (current.activeHandle >= 0 || current.dragging)) {
    view.dispatch(
      view.state.tr.setMeta(columnResizingPluginKey, { setHandle: -1 }),
    );
    restoreWidths(view);
  }
}
export function cancelEditorTableResize(editor: Editor) {
  if (!editor.isDestroyed) cancelResize(editor.view);
}
export const EditorTables = Extension.create({
  name: "orvynEditorTables",
  addKeyboardShortcuts() {
    return {
      "Mod-Enter": () =>
        !this.editor.isActive("codeBlock") &&
        runEditorTableAction(this.editor, "exit"),
    };
  },
  addProseMirrorPlugins() {
    let rejectedResize = false;
    return [
      // The editor starts read-only until authentication completes. Install this
      // once; the native handlers check the current view.editable on every drag.
      columnResizing({
        cellMinWidth: editorTableMinWidth,
        defaultCellMinWidth: editorTableMinWidth,
        handleWidth: 6,
        View: null,
      }),
      new Plugin({
        filterTransaction(transaction, state) {
          if (
            !transaction.docChanged ||
            !columnResizingPluginKey.getState(state)?.dragging
          )
            return true;
          const check = state.tr.replaceWith(
            0,
            state.doc.content.size,
            transaction.doc.content,
          );
          normalizeWidths(check);
          try {
            validateDocument(check.doc.toJSON());
            return true;
          } catch {
            rejectedResize = true;
            return false;
          }
        },
        appendTransaction(transactions, _old, state) {
          if (!transactions.some((transaction) => transaction.docChanged))
            return null;
          const tr = state.tr;
          normalizeWidths(tr);
          return tr.steps.length ? tr : null;
        },
        view(view) {
          const win = view.dom.ownerDocument.defaultView;
          let stopped = false;
          function escape(event: KeyboardEvent) {
            if (
              event.key !== "Escape" ||
              !columnResizingPluginKey.getState(view.state)?.dragging
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            cancelResize(view);
          }
          const blur = () => cancelResize(view);
          win?.addEventListener("keydown", escape, true);
          win?.addEventListener("blur", blur);
          return {
            update() {
              if (rejectedResize) {
                rejectedResize = false;
                restoreWidths(view);
              }
              const resizing = columnResizingPluginKey.getState(view.state);
              if (
                !view.editable &&
                resizing &&
                (resizing.dragging || resizing.activeHandle >= 0)
              )
                queueMicrotask(() => {
                  if (!stopped && !view.isDestroyed && !view.editable)
                    cancelResize(view);
                });
            },
            destroy() {
              stopped = true;
              win?.removeEventListener("keydown", escape, true);
              win?.removeEventListener("blur", blur);
            },
          };
        },
      }),
    ];
  },
});

export type EditorTableAction =
  | "addRowBefore"
  | "addRowAfter"
  | "deleteRow"
  | "addColumnBefore"
  | "addColumnAfter"
  | "deleteColumn"
  | "toggleHeaderRow"
  | "toggleHeaderColumn"
  | "mergeCells"
  | "splitCell"
  | "deleteTable"
  | "resetWidths"
  | "exit";
function command(chain: ChainedCommands, action: EditorTableAction) {
  if (action === "resetWidths")
    return chain.command(({ tr, state }) => {
      const context = tableSelectionContext(state);
      if (!context) return false;
      context.table.descendants((node, pos) => {
        if (node.type.name === "table") return false;
        if (
          ["tableCell", "tableHeader"].includes(node.type.name) &&
          node.attrs.colwidth
        )
          tr.setNodeMarkup(context.start + pos, undefined, {
            ...node.attrs,
            colwidth: null,
          });
      });
      return true;
    });
  if (action === "exit")
    return chain.command(({ tr, state, commands }) => {
      const context = tableSelectionContext(state);
      if (!context) return false;
      const end = context.position + context.table.nodeSize;
      if (!tr.doc.nodeAt(end)?.isTextblock)
        tr.insert(end, state.schema.nodes.paragraph!.create());
      return commands.setTextSelection(end + 1);
    });
  return chain[action]();
}
function valid(tr: Transaction) {
  normalizeWidths(tr);
  try {
    validateDocument(tr.doc.toJSON());
    return true;
  } catch {
    return false;
  }
}
export function canRunEditorTableAction(
  editor: Editor,
  action: EditorTableAction,
) {
  if (!editor.isEditable || !tableSelectionContext(editor.state)) return false;
  return command(editor.can().chain(), action)
    .command(({ tr }) => valid(tr))
    .run();
}
export function runEditorTableAction(
  editor: Editor,
  action: EditorTableAction,
) {
  if (!canRunEditorTableAction(editor, action)) return false;
  return command(editor.chain().focus(), action)
    .command(({ tr }) => valid(tr))
    .run();
}
export function setEditorTableColumnWidth(editor: Editor, value: number) {
  if (!editor.isEditable || !Number.isFinite(value)) return false;
  const width = Math.max(
    editorTableMinWidth,
    Math.min(editorTableMaxWidth, Math.round(value)),
  );
  const apply = ({ tr, state }: { tr: Transaction; state: EditorState }) => {
    const context = tableSelectionContext(state);
    if (!context) return false;
    const offsets = new Set(
      Array.from(
        { length: context.rows },
        (_, row) => context.map.map[row * context.columns + context.column]!,
      ),
    );
    for (const offset of offsets) {
      const node = context.table.nodeAt(offset)!;
      const index = context.column - context.map.findCell(offset).left;
      const widths = Array.from(
        { length: node.attrs.colspan },
        (_, i) => node.attrs.colwidth?.[i] || editorTableMinWidth,
      );
      widths[index] = width;
      tr.setNodeMarkup(context.start + offset, undefined, {
        ...node.attrs,
        colwidth: widths,
      });
    }
    return valid(tr);
  };
  if (!editor.can().chain().command(apply).run()) return false;
  return editor.chain().focus().command(apply).run();
}

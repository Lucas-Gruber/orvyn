import { Extension } from "@tiptap/core";
import type { Node, ResolvedPos } from "@tiptap/pm/model";
import { Slice } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  Selection,
  type EditorState,
  type SelectionBookmark,
} from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import { closeHistory } from "@tiptap/pm/history";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { yUndoPluginKey } from "@tiptap/y-tiptap";

export interface BlockRange {
  from: number;
  to: number;
}
export type BlockAction = "up" | "down" | "out" | "duplicate" | "delete";

function isBlockContainer(node: Node) {
  return [
    "doc",
    "orvynColumn",
    "orvynCallout",
    "orvynToggleContent",
    "blockquote",
  ].includes(node.type.name);
}
// A range contains whole siblings in the nearest editable block container.
export function blockRange(
  doc: Node,
  from: number,
  to = from,
): BlockRange | null {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < from ||
    to > doc.content.size
  )
    return null;
  const $from = doc.resolve(from);
  let depth = $from.depth;
  while (
    depth > 0 &&
    (!isBlockContainer($from.node(depth)) || to > $from.end(depth))
  )
    depth--;
  const parent = $from.node(depth),
    start = $from.start(depth);
  let first = -1,
    last = -1;
  parent.forEach((node, offset) => {
    const pos = start + offset;
    const end = pos + node.nodeSize;
    if (
      from === to
        ? from >= pos && (from < end || end === $from.end(depth))
        : from < end && to > pos
    ) {
      if (first < 0) first = pos;
      last = end;
    }
  });
  return first < 0 ? null : { from: first, to: last };
}
function exactRange(doc: Node, range: BlockRange) {
  const normalized = blockRange(doc, range.from, range.to);
  return normalized?.from === range.from && normalized.to === range.to;
}
function mappedRange(
  doc: Node,
  range: BlockRange,
  mapping: Mappable,
): BlockRange | null {
  const from = mapping.mapResult(range.from, 1),
    to = mapping.mapResult(range.to, -1),
    mapped = { from: from.pos, to: to.pos };
  return !(from.deletedAcross && to.deletedAcross) && exactRange(doc, mapped)
    ? mapped
    : null;
}
class BlockBookmark implements SelectionBookmark {
  constructor(
    readonly from: number,
    readonly to: number,
  ) {}
  map(mapping: Mappable) {
    return new BlockBookmark(
      mapping.map(this.from, 1),
      mapping.map(this.to, -1),
    );
  }
  resolve(doc: Node): Selection {
    return exactRange(doc, this)
      ? BlockSelection.create(doc, this)
      : Selection.near(
          doc.resolve(Math.max(0, Math.min(this.from, doc.content.size))),
        );
  }
}
export class BlockSelection extends Selection {
  constructor($from: ResolvedPos, $to: ResolvedPos) {
    super($from, $to);
    this.visible = false;
  }
  static create(doc: Node, range: BlockRange) {
    if (!exactRange(doc, range))
      throw new RangeError("Whole sibling blocks required");
    return new BlockSelection(doc.resolve(range.from), doc.resolve(range.to));
  }
  eq(other: Selection) {
    return (
      other instanceof BlockSelection &&
      other.from === this.from &&
      other.to === this.to
    );
  }
  map(doc: Node, mapping: Mappable): Selection {
    const range = mappedRange(doc, this, mapping);
    return range
      ? BlockSelection.create(doc, range)
      : Selection.near(
          doc.resolve(Math.min(mapping.map(this.from), doc.content.size)),
        );
  }
  content() {
    return new Slice(this.$from.doc.slice(this.from, this.to).content, 0, 0);
  }
  toJSON() {
    return { type: "orvynBlocks", from: this.from, to: this.to };
  }
  static fromJSON(doc: Node, json: BlockRange) {
    return BlockSelection.create(doc, json);
  }
  getBookmark() {
    return new BlockBookmark(this.from, this.to);
  }
}
Selection.jsonID("orvynBlocks", BlockSelection);

export function selectedBlocks(state: EditorState) {
  return blockRange(state.doc, state.selection.from, state.selection.to);
}
export function moveBlocks(
  state: EditorState,
  range: BlockRange,
  destination: number,
) {
  const { doc } = state;
  if (
    !exactRange(doc, range) ||
    !Number.isInteger(destination) ||
    destination < 0 ||
    destination > doc.content.size ||
    (destination >= range.from && destination <= range.to)
  )
    return null;
  const target = doc.resolve(destination),
    source = doc.resolve(range.from),
    fragment = doc.slice(range.from, range.to).content;
  if (
    !isBlockContainer(target.parent) ||
    !target.parent.canReplace(target.index(), target.index(), fragment)
  )
    return null;
  const tr = state.tr.insert(destination, fragment);
  const fromSource = tr.mapping.map(range.from, 1),
    toSource = tr.mapping.map(range.to, -1);
  if (range.from === source.start() && range.to === source.end())
    tr.replaceWith(
      fromSource,
      toSource,
      state.schema.nodes.paragraph!.create(),
    );
  else tr.delete(fromSource, toSource);
  const from = tr.mapping.map(destination, -1);
  return closeHistory(tr)
    .setMeta("orvyn-block-action", true)
    .setSelection(
      BlockSelection.create(tr.doc, { from, to: from + fragment.size }),
    )
    .scrollIntoView();
}
export function blockAction(state: EditorState, action: BlockAction) {
  const range = selectedBlocks(state);
  if (!range) return null;
  if (action === "out") {
    const source = state.doc.resolve(range.from);
    for (let depth = source.depth; depth > 0; depth--)
      if (isBlockContainer(source.node(depth - 1)))
        return moveBlocks(state, range, source.after(depth));
    return null;
  }
  if (action === "up" || action === "down") {
    const boundary = state.doc.resolve(action === "up" ? range.from : range.to),
      index = boundary.index(),
      parent = boundary.parent;
    if (action === "up" ? index === 0 : index === parent.childCount)
      return null;
    const destination =
      action === "up"
        ? range.from - parent.child(index - 1).nodeSize
        : range.to + parent.child(index).nodeSize;
    return moveBlocks(state, range, destination);
  }
  const tr = state.tr;
  if (action === "duplicate") {
    tr.insert(range.to, state.doc.slice(range.from, range.to).content);
    tr.setSelection(
      BlockSelection.create(tr.doc, {
        from: range.to,
        to: range.to + range.to - range.from,
      }),
    );
  } else {
    const source = state.doc.resolve(range.from);
    if (range.from === source.start() && range.to === source.end())
      tr.replaceWith(
        range.from,
        range.to,
        state.schema.nodes.paragraph!.create(),
      );
    else tr.delete(range.from, range.to);
    tr.setSelection(
      Selection.near(tr.doc.resolve(Math.min(range.from, tr.doc.content.size))),
    );
  }
  return closeHistory(tr).setMeta("orvyn-block-action", true).scrollIntoView();
}

export function blockMoveTargets(state: EditorState) {
  const range = selectedBlocks(state);
  if (!range) return [];
  const fragment = state.doc.slice(range.from, range.to).content;
  const targets: { position: number; label: string }[] = [];
  function add(node: Node, position: number, label: string) {
    if (
      !(position >= range!.from && position <= range!.to) &&
      node.canReplace(node.childCount, node.childCount, fragment)
    )
      targets.push({ position, label });
  }
  add(state.doc, state.doc.content.size, "Page · after all blocks");
  state.doc.descendants((node, position, parent, index) => {
    if (!isBlockContainer(node)) return;
    const name =
      node.type.name === "orvynColumn"
        ? `Column ${index + 1}`
        : node.type.name === "orvynCallout"
          ? "Callout"
          : node.type.name === "blockquote"
            ? "Quote"
            : "Toggle";
    const text = (
      node.type.name === "orvynToggleContent"
        ? parent?.firstChild?.textContent
        : node.firstChild?.textContent
    )
      ?.replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    add(node, position + node.nodeSize - 1, `${name} · ${text || "Empty"}`);
  });
  return targets;
}

interface DragState {
  range: BlockRange | null;
  destination: number | null;
}
const dragKey = new PluginKey<DragState>("orvynBlockDrag");
const dragType = "application/x-orvyn-blocks";
function dropBoundary(view: EditorView, x: number, y: number) {
  const rect = view.dom.getBoundingClientRect();
  if (x < rect.left - 40 || x > rect.right + 40) return null;
  let parent = view.state.doc,
    start = 0;
  view.state.doc.descendants((node, position) => {
    if (!isBlockContainer(node)) return;
    const dom = view.nodeDOM(position);
    if (!(dom instanceof HTMLElement)) return;
    const box = dom.getBoundingClientRect();
    if (
      box.width &&
      box.height &&
      x >= box.left &&
      x <= box.right &&
      y >= box.top &&
      y <= box.bottom
    ) {
      parent = node;
      start = position + 1;
    }
  });
  let boundary = start + parent.content.size,
    found = false;
  parent.forEach((node, offset) => {
    if (found) return;
    const pos = start + offset;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;
    const block = dom.getBoundingClientRect();
    if (y < block.top + block.height / 2) {
      boundary = pos;
      found = true;
    } else boundary = pos + node.nodeSize;
  });
  return boundary;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    orvynBlockControls: {
      selectBlocks: (range?: BlockRange, extend?: boolean) => ReturnType;
      blockAction: (action: BlockAction) => ReturnType;
      moveBlocksTo: (position: number) => ReturnType;
    };
  }
}
export const BlockControls = Extension.create<{
  onMenu: null | ((rect: DOMRect) => void);
}>({
  name: "orvynBlockControls",
  addOptions() {
    return { onMenu: null };
  },
  addCommands() {
    return {
      selectBlocks:
        (range, extend = false) =>
        ({ state, tr, dispatch }) => {
          if (!this.editor.isEditable) return false;
          let next = range || selectedBlocks(state);
          if (!next || !exactRange(state.doc, next)) return false;
          if (extend && state.selection instanceof BlockSelection)
            next = blockRange(
              state.doc,
              Math.min(next.from, state.selection.from),
              Math.max(next.to, state.selection.to),
            );
          if (!next) return false;
          if (dispatch) tr.setSelection(BlockSelection.create(tr.doc, next));
          return true;
        },
      blockAction:
        (action) =>
        ({ state, dispatch }) => {
          if (!this.editor.isEditable) return false;
          const tr = blockAction(state, action);
          if (!tr) return false;
          if (dispatch) dispatch(tr);
          return true;
        },
      moveBlocksTo:
        (position) =>
        ({ state, dispatch }) => {
          if (!this.editor.isEditable) return false;
          const range = selectedBlocks(state),
            tr = range && moveBlocks(state, range, position);
          if (!tr) return false;
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },
  addKeyboardShortcuts() {
    const selected = () =>
      this.editor.state.selection instanceof BlockSelection;
    return {
      "Mod-Shift-Space": () => this.editor.commands.selectBlocks(),
      "Alt-Shift-ArrowUp": () => this.editor.commands.blockAction("up"),
      "Alt-Shift-ArrowDown": () => this.editor.commands.blockAction("down"),
      "Alt-Shift-ArrowLeft": () => this.editor.commands.blockAction("out"),
      Backspace: () => selected() && this.editor.commands.blockAction("delete"),
      Delete: () => selected() && this.editor.commands.blockAction("delete"),
      Enter: () => {
        if (!selected() || !this.editor.isEditable) return false;
        const { state, view } = this.editor,
          tr = state.tr;
        tr.insert(state.selection.to, state.schema.nodes.paragraph!.create());
        tr.setSelection(Selection.near(tr.doc.resolve(state.selection.to + 1)));
        view.dispatch(tr.scrollIntoView());
        return true;
      },
      Escape: () => {
        if (!selected()) return false;
        const { state, view } = this.editor;
        view.dispatch(
          state.tr.setSelection(
            Selection.near(state.doc.resolve(state.selection.from)),
          ),
        );
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor,
      onMenu = this.options.onMenu,
      token = globalThis.crypto.randomUUID();
    return [
      new Plugin<DragState>({
        key: dragKey,
        filterTransaction(tr, state) {
          if (tr.getMeta("orvyn-block-action")) {
            const manager = yUndoPluginKey.getState(state)?.undoManager;
            manager?.stopCapturing();
            queueMicrotask(() => manager?.stopCapturing());
          }
          return true;
        },
        state: {
          init: () => ({ range: null, destination: null }),
          apply(tr, current) {
            const meta = tr.getMeta(dragKey) as Partial<DragState> | undefined;
            if (meta) return { ...current, ...meta };
            if (!tr.docChanged) return current;
            return {
              range: current.range
                ? mappedRange(tr.doc, current.range, tr.mapping)
                : null,
              destination:
                current.destination === null
                  ? null
                  : tr.mapping.map(current.destination),
            };
          },
        },
        props: {
          decorations(state) {
            if (!editor.isEditable) return DecorationSet.empty;
            const decorations: Decoration[] = [],
              selection = state.selection;
            state.doc.descendants((node, pos, parent) => {
              if (!parent || !isBlockContainer(parent)) return;
              const active =
                selection instanceof BlockSelection &&
                selection.$from.parent === parent &&
                pos >= selection.from &&
                pos < selection.to;
              if (active)
                decorations.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    class: "orvyn-block-selected",
                  }),
                );
              decorations.push(
                Decoration.widget(
                  pos,
                  (view, getPos) => {
                    const anchor = document.createElement("span"),
                      grip = document.createElement("button");
                    anchor.className = "block-handle-anchor";
                    grip.type = "button";
                    grip.className = "block-handle";
                    grip.draggable = true;
                    grip.setAttribute("aria-label", "Block actions");
                    grip.setAttribute("aria-haspopup", "menu");
                    grip.title =
                      "Drag to move · Click for actions · Shift-click to select several blocks";
                    const icon = document.createElementNS(
                      "http://www.w3.org/2000/svg",
                      "svg",
                    );
                    icon.setAttribute("viewBox", "0 0 16 20");
                    icon.setAttribute("width", "16");
                    icon.setAttribute("height", "20");
                    icon.setAttribute("aria-hidden", "true");
                    for (const x of [5, 11])
                      for (const y of [4, 10, 16]) {
                        const dot = document.createElementNS(
                          "http://www.w3.org/2000/svg",
                          "circle",
                        );
                        dot.setAttribute("cx", String(x));
                        dot.setAttribute("cy", String(y));
                        dot.setAttribute("r", "1.35");
                        dot.setAttribute("fill", "currentColor");
                        icon.append(dot);
                      }
                    grip.append(icon);
                    grip.addEventListener("click", (event) => {
                      const at = getPos();
                      if (at === undefined || !editor.isEditable) return;
                      const range = blockRange(view.state.doc, at);
                      if (!range) return;
                      // Clicking any selected handle retains the complete selection.
                      if (!(
                        view.state.selection instanceof BlockSelection &&
                        at >= view.state.selection.from &&
                        at < view.state.selection.to
                      ))
                        editor.commands.selectBlocks(range, event.shiftKey);
                      if (!event.shiftKey)
                        onMenu?.(grip.getBoundingClientRect());
                      else view.focus();
                    });
                    grip.addEventListener("dragstart", (event) => {
                      const at = getPos(),
                        transfer = event.dataTransfer;
                      if (at === undefined || !transfer || !editor.isEditable) {
                        event.preventDefault();
                        return;
                      }
                      const selection = view.state.selection,
                        range =
                          selection instanceof BlockSelection &&
                          at >= selection.from &&
                          at < selection.to
                            ? { from: selection.from, to: selection.to }
                            : blockRange(view.state.doc, at);
                      if (!range) {
                        event.preventDefault();
                        return;
                      }
                      view.dispatch(
                        view.state.tr
                          .setSelection(
                            BlockSelection.create(view.state.doc, range),
                          )
                          .setMeta(dragKey, { range, destination: null }),
                      );
                      transfer.effectAllowed = "move";
                      transfer.setData(dragType, token);
                      transfer.setData(
                        "text/plain",
                        view.state.doc.textBetween(range.from, range.to, "\n"),
                      );
                    });
                    grip.addEventListener("dragend", () => {
                      if (!view.isDestroyed)
                        view.dispatch(
                          view.state.tr.setMeta(dragKey, {
                            range: null,
                            destination: null,
                          }),
                        );
                    });
                    anchor.append(grip);
                    return anchor;
                  },
                  {
                    side: -1,
                    key: "block-handle-" + pos,
                    stopEvent: () => true,
                  },
                ),
              );
            });
            const drag = dragKey.getState(state);
            if (
              drag?.range &&
              drag.destination !== null &&
              (drag.destination < drag.range.from ||
                drag.destination > drag.range.to)
            )
              decorations.push(
                Decoration.widget(
                  drag.destination,
                  () => {
                    const line = document.createElement("span");
                    line.className = "block-drop-line";
                    return line;
                  },
                  { side: -2, key: "block-drop-line" },
                ),
              );
            return DecorationSet.create(state.doc, decorations);
          },
          handleDOMEvents: {
            dragover(view, event) {
              if (
                !editor.isEditable ||
                !dragKey.getState(view.state)?.range ||
                !event.dataTransfer?.types.includes(dragType)
              )
                return false;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const destination = dropBoundary(
                view,
                event.clientX,
                event.clientY,
              );
              if (destination !== dragKey.getState(view.state)?.destination)
                view.dispatch(view.state.tr.setMeta(dragKey, { destination }));
              return true;
            },
            dragleave(view, event) {
              if (
                event.relatedTarget instanceof globalThis.Node &&
                view.dom.contains(event.relatedTarget)
              )
                return false;
              if (dragKey.getState(view.state)?.destination !== null)
                view.dispatch(
                  view.state.tr.setMeta(dragKey, { destination: null }),
                );
              return false;
            },
          },
          handleDrop(view, event) {
            if (event.dataTransfer?.getData(dragType) !== token) return false;
            event.preventDefault();
            const range = dragKey.getState(view.state)?.range,
              destination = dropBoundary(view, event.clientX, event.clientY);
            const tr =
              editor.isEditable && range && destination !== null
                ? moveBlocks(view.state, range, destination)
                : null;
            view.dispatch(
              (tr || view.state.tr).setMeta(dragKey, {
                range: null,
                destination: null,
              }),
            );
            view.focus();
            return true;
          },
        },
      }),
    ];
  },
});

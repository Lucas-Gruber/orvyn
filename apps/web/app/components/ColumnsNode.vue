<script setup lang="ts">
import {
  NodeViewWrapper,
  NodeViewContent,
  type NodeViewProps,
} from "@tiptap/vue-3";
import { columnWidths, resizeColumnPair } from "@orvyn/editor";

const props = defineProps<NodeViewProps>();
const preview = ref<number[] | null>(null);
const editable = ref(props.editor.isEditable);
const widths = computed(
  () =>
    preview.value ||
    columnWidths(props.node.attrs.widths, props.node.childCount),
);
const grid = computed(() =>
  widths.value.map((width) => `minmax(0, ${width}fr)`).join(" "),
);
let drag: {
  index: number;
  pointer: number;
  target: HTMLElement;
  x: number;
  available: number;
  initial: number[];
  stored: string;
  count: number;
} | null = null;

function boundary(index: number) {
  const fraction =
    widths.value.slice(0, index + 1).reduce((sum, width) => sum + width, 0) /
    10000;
  return `calc(${fraction * 100}% + ${24 * (index + 0.5) - fraction * 24 * (widths.value.length - 1)}px)`;
}
function cancel() {
  const active = drag;
  drag = null;
  preview.value = null;
  if (active?.target.hasPointerCapture(active.pointer))
    active.target.releasePointerCapture(active.pointer);
}
function reconcile() {
  editable.value = props.editor.isEditable;
  if (
    drag &&
    (!editable.value ||
      props.node.childCount !== drag.count ||
      JSON.stringify(props.node.attrs.widths) !== drag.stored)
  )
    cancel();
}
function commit(
  next: number[],
  expected = JSON.stringify(props.node.attrs.widths),
) {
  if (!props.editor.isEditable) return;
  const pos = props.getPos();
  if (pos === undefined) return;
  props.editor.commands.setColumnWidths(pos, next, expected);
}
function start(event: PointerEvent, index: number) {
  if (event.button !== 0 || !props.editor.isEditable) return;
  const element = (event.currentTarget as HTMLElement).closest<HTMLElement>(
    ".columns-block",
  );
  if (!element) return;
  cancel();
  event.preventDefault();
  const target = event.currentTarget as HTMLElement;
  target.focus({ preventScroll: true });
  drag = {
    index,
    pointer: event.pointerId,
    target,
    x: event.clientX,
    available: Math.max(
      1,
      element.clientWidth - 24 * (props.node.childCount - 1),
    ),
    initial: columnWidths(props.node.attrs.widths, props.node.childCount),
    stored: JSON.stringify(props.node.attrs.widths),
    count: props.node.childCount,
  };
  target.setPointerCapture(event.pointerId);
  preview.value = [...drag.initial];
}
function move(event: PointerEvent) {
  if (!drag || drag.pointer !== event.pointerId) return;
  preview.value = resizeColumnPair(
    drag.initial,
    drag.index,
    drag.initial[drag.index]! +
      ((event.clientX - drag.x) / drag.available) * 10000,
  );
}
function finish(event: PointerEvent) {
  if (!drag || drag.pointer !== event.pointerId) return;
  const next = preview.value,
    expected = drag.stored;
  cancel();
  if (next) commit(next, expected);
}
function keys(event: KeyboardEvent, index: number) {
  if (event.key === "Escape" && drag) {
    event.preventDefault();
    event.stopPropagation();
    cancel();
    return;
  }
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  cancel();
  const current = columnWidths(props.node.attrs.widths, props.node.childCount);
  const left =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? 10000
        : current[index]! +
          (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 1000 : 200);
  commit(resizeColumnPair(current, index, left));
}
function equalize() {
  cancel();
  commit(columnWidths(null, props.node.childCount));
}
onMounted(() => props.editor.on("transaction", reconcile));
onBeforeUnmount(() => {
  cancel();
  props.editor.off("transaction", reconcile);
});
</script>
<template>
  <NodeViewWrapper class="columns-block" :class="{ 'is-resizing': preview }">
    <NodeViewContent
      class="columns-content"
      :style="{ gridTemplateColumns: grid }"
    />
    <div v-if="editable" class="column-resize-controls" contenteditable="false">
      <div
        v-for="(_, index) in widths.slice(0, -1)"
        :key="index"
        class="column-resize-handle"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        :aria-label="`Resize columns ${index + 1} and ${index + 2}`"
        :aria-valuenow="widths[index]! / 100"
        :aria-valuemin="15"
        :aria-valuemax="(widths[index]! + widths[index + 1]!) / 100 - 15"
        :aria-valuetext="`Column ${index + 1}: ${Math.round(widths[index]! / 100)} percent`"
        title="Drag to resize · Arrow keys adjust · Double-click for equal widths"
        :style="{ left: boundary(index) }"
        @pointerdown="start($event, index)"
        @pointermove="move"
        @pointerup="finish"
        @pointercancel="cancel"
        @lostpointercapture="cancel"
        @keydown="keys($event, index)"
        @dblclick.prevent="equalize"
      >
        <span class="column-resize-line" />
        <span class="column-width-hint"
          >{{ Math.round(widths[index]! / 100) }}%</span
        >
      </div>
      <button
        type="button"
        class="column-equalize"
        aria-label="Equalize column widths"
        title="Equalize column widths"
        @click="equalize"
      >
        Equal widths
      </button>
    </div>
  </NodeViewWrapper>
</template>
<style>
.columns-block {
  position: relative;
  margin: 18px 0;
}
.columns-content {
  display: grid;
  gap: 24px;
}
[data-orvyn-column] {
  min-width: 0;
  min-height: 36px;
  padding: 4px 0;
}
.block-editor
  .tiptap
  [data-orvyn-column]
  > p:only-child:has(> br:only-child):before {
  content: "Write here…";
}
.column-resize-controls {
  user-select: none;
}
.column-resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 20px;
  transform: translateX(-50%);
  cursor: col-resize;
  touch-action: none;
  outline: none;
}
.column-resize-line {
  position: absolute;
  inset: 0 auto 0 9px;
  width: 1px;
  background: var(--line-soft);
  transition: background 0.12s;
}
.column-resize-handle:hover .column-resize-line,
.column-resize-handle:focus-visible .column-resize-line,
.is-resizing .column-resize-line {
  width: 3px;
  left: 8px;
  background: var(--accent);
  border-radius: 3px;
}
.column-width-hint {
  display: none;
  position: absolute;
  top: -25px;
  left: 50%;
  transform: translateX(-50%);
  padding: 3px 7px;
  border-radius: 4px;
  color: var(--text);
  background: var(--surface-raised, var(--surface));
  box-shadow: 0 1px 6px #0002;
  font-size: 11px;
  white-space: nowrap;
}
.column-resize-handle:focus-visible .column-width-hint,
.is-resizing .column-width-hint {
  display: block;
}
.column-equalize {
  position: absolute;
  right: 0;
  bottom: -19px;
  opacity: 0;
  pointer-events: none;
  padding: 1px 4px;
  border: 0;
  background: var(--surface);
  color: var(--muted);
  font-size: 10px;
  border-radius: 3px;
}
.columns-block:hover .column-equalize,
.columns-block:focus-within .column-equalize {
  opacity: 1;
  pointer-events: auto;
}
.column-equalize:hover,
.column-equalize:focus-visible {
  background: var(--surface-hover);
  color: var(--text);
}
.is-resizing {
  cursor: col-resize;
}
@media (max-width: 760px) {
  .columns-content {
    grid-template-columns: 1fr !important;
    gap: 12px;
  }
  [data-orvyn-column] + [data-orvyn-column] {
    border-top: 1px solid var(--line-soft);
    padding: 14px 0 0;
  }
  .column-resize-controls {
    display: none;
  }
}
</style>

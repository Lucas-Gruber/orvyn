<script setup lang="ts">
import {
  clampDatabaseColumnWidth,
  databaseColumnDefaultWidth,
  databaseColumnMaxWidth,
  databaseColumnMinWidth,
  type Property,
} from "@orvyn/shared";
const props = defineProps<{
  property: Property;
  width: number;
  revision: string;
  disabled: boolean;
}>();
const emit = defineEmits<{
  preview: [width: number | null];
  commit: [width: number, revision: string];
}>();
const active = ref(false);
let gesture:
  | {
      pointer: number;
      x: number;
      width: number;
      revision: string;
      element: HTMLElement;
      cursor: string;
      selection: string;
    }
  | undefined;
function cleanup() {
  const current = gesture;
  if (!current) return;
  gesture = undefined;
  active.value = false;
  window.removeEventListener("pointermove", move);
  window.removeEventListener("pointerup", finish);
  window.removeEventListener("pointercancel", cancelPointer);
  window.removeEventListener("keydown", escape, true);
  document.documentElement.style.cursor = current.cursor;
  document.documentElement.style.userSelect = current.selection;
  if (current.element.hasPointerCapture(current.pointer))
    current.element.releasePointerCapture(current.pointer);
}
function cancel() {
  if (!gesture) return;
  cleanup();
  emit("preview", null);
}
function start(event: PointerEvent) {
  if (props.disabled || gesture || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const element = event.currentTarget as HTMLElement;
  element.focus({ preventScroll: true });
  element.setPointerCapture(event.pointerId);
  gesture = {
    pointer: event.pointerId,
    x: event.clientX,
    width: props.width,
    revision: props.revision,
    element,
    cursor: document.documentElement.style.cursor,
    selection: document.documentElement.style.userSelect,
  };
  active.value = true;
  document.documentElement.style.cursor = "col-resize";
  document.documentElement.style.userSelect = "none";
  emit("preview", props.width);
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", cancelPointer);
  window.addEventListener("keydown", escape, true);
}
function move(event: PointerEvent) {
  if (!gesture || gesture.pointer !== event.pointerId) return;
  event.preventDefault();
  emit(
    "preview",
    clampDatabaseColumnWidth(
      props.property,
      gesture.width + event.clientX - gesture.x,
    ),
  );
}
function finish(event: PointerEvent) {
  const current = gesture;
  if (!current || current.pointer !== event.pointerId) return;
  const width = clampDatabaseColumnWidth(
    props.property,
    current.width + event.clientX - current.x,
  );
  cleanup();
  if (width === current.width) emit("preview", null);
  else {
    emit("preview", width);
    emit("commit", width, current.revision);
  }
}
function cancelPointer(event: PointerEvent) {
  if (gesture?.pointer === event.pointerId) cancel();
}
function escape(event: KeyboardEvent) {
  if (event.key !== "Escape" || !gesture) return;
  event.preventDefault();
  event.stopPropagation();
  cancel();
}
function commit(width: number) {
  if (props.disabled || gesture || width === props.width) return;
  emit("preview", width);
  emit("commit", width, props.revision);
}
function keys(event: KeyboardEvent) {
  if (props.disabled || event.altKey || event.metaKey || event.ctrlKey) return;
  const step = event.shiftKey ? 50 : 10;
  let width: number;
  switch (event.key) {
    case "ArrowLeft":
      width = clampDatabaseColumnWidth(props.property, props.width - step);
      break;
    case "ArrowRight":
      width = clampDatabaseColumnWidth(props.property, props.width + step);
      break;
    case "Home":
      width = databaseColumnMinWidth(props.property);
      break;
    case "End":
      width = databaseColumnMaxWidth;
      break;
    case "Enter":
      width = databaseColumnDefaultWidth(props.property);
      break;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
  commit(width);
}
watch(
  () => [props.revision, props.disabled],
  () => cancel(),
);
onBeforeUnmount(cancel);
</script>
<template>
  <span
    role="separator"
    aria-orientation="vertical"
    class="database-column-resizer"
    :class="{ active }"
    :tabindex="disabled ? -1 : 0"
    :aria-label="'Resize ' + property.name + ' column'"
    :aria-disabled="disabled"
    :aria-valuemin="databaseColumnMinWidth(property)"
    :aria-valuemax="databaseColumnMaxWidth"
    :aria-valuenow="width"
    :aria-valuetext="width + ' pixels'"
    title="Drag to resize · Left/Right 10 px · Shift 50 px · Enter or double-click resets"
    @pointerdown="start"
    @keydown="keys"
    @dblclick.stop.prevent="commit(databaseColumnDefaultWidth(property))"
    @click.stop
    @lostpointercapture="cancel"
  />
</template>
<style scoped>
.database-column-resizer {
  position: absolute;
  z-index: 2;
  top: 0;
  bottom: 0;
  right: 0;
  width: 8px;
  cursor: col-resize;
  touch-action: none;
  outline: none;
}
.database-column-resizer::after {
  content: "";
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--accent);
  opacity: 0;
}
.database-column-resizer:hover::after,
.database-column-resizer:focus-visible::after,
.database-column-resizer.active::after {
  opacity: 1;
}
.database-column-resizer[aria-disabled="true"] {
  cursor: default;
  pointer-events: none;
}
</style>

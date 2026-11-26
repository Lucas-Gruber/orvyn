<script setup lang="ts">
import { sidebarMinWidth } from "../utils/sidebarWidth";
const props = defineProps<{ width: number; max: number }>();
const emit = defineEmits<{
  preview: [width: number | null];
  commit: [width: number | null];
}>();
const active = ref(false);
let gesture:
  | {
      pointer: number;
      x: number;
      width: number;
      element: HTMLElement;
      cursor: string;
      selection: string;
    }
  | undefined;
const clamp = (width: number) =>
  Math.round(Math.max(sidebarMinWidth, Math.min(props.max, width)));
function cleanup() {
  const current = gesture;
  if (!current) return;
  gesture = undefined;
  active.value = false;
  window.removeEventListener("pointermove", move);
  window.removeEventListener("pointerup", finish);
  window.removeEventListener("pointercancel", cancelPointer);
  window.removeEventListener("keydown", escape, true);
  window.removeEventListener("blur", cancel);
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
  if (gesture || event.button !== 0 || !event.isPrimary) return;
  event.preventDefault();
  event.stopPropagation();
  const element = event.currentTarget as HTMLElement;
  element.focus({ preventScroll: true });
  element.setPointerCapture(event.pointerId);
  gesture = {
    pointer: event.pointerId,
    x: event.clientX,
    width: props.width,
    element,
    cursor: document.documentElement.style.cursor,
    selection: document.documentElement.style.userSelect,
  };
  active.value = true;
  document.documentElement.style.cursor = "col-resize";
  document.documentElement.style.userSelect = "none";
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", cancelPointer);
  window.addEventListener("keydown", escape, true);
  window.addEventListener("blur", cancel);
}
function move(event: PointerEvent) {
  if (!gesture || event.pointerId !== gesture.pointer) return;
  event.preventDefault();
  emit("preview", clamp(gesture.width + event.clientX - gesture.x));
}
function finish(event: PointerEvent) {
  const current = gesture;
  if (!current || event.pointerId !== current.pointer) return;
  const width = clamp(current.width + event.clientX - current.x);
  cleanup();
  if (width !== current.width) emit("commit", width);
  emit("preview", null);
}
function cancelPointer(event: PointerEvent) {
  if (event.pointerId === gesture?.pointer) cancel();
}
function escape(event: KeyboardEvent) {
  if (event.key !== "Escape" || !gesture) return;
  event.preventDefault();
  event.stopPropagation();
  cancel();
}
function keys(event: KeyboardEvent) {
  if (gesture || event.altKey || event.ctrlKey || event.metaKey) return;
  const step = event.shiftKey ? 50 : 10;
  let width: number | null;
  switch (event.key) {
    case "ArrowLeft":
      width = clamp(props.width - step);
      break;
    case "ArrowRight":
      width = clamp(props.width + step);
      break;
    case "Home":
      width = sidebarMinWidth;
      break;
    case "End":
      width = props.max;
      break;
    case "Enter":
      width = null;
      break;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
  emit("commit", width);
}
onMounted(() => window.addEventListener("resize", cancel));
onBeforeUnmount(() => {
  cancel();
  window.removeEventListener("resize", cancel);
});
</script>
<template>
  <span
    role="separator"
    tabindex="0"
    aria-label="Resize sidebar"
    aria-orientation="vertical"
    aria-controls="workspace-sidebar"
    :aria-valuemin="sidebarMinWidth"
    :aria-valuemax="max"
    :aria-valuenow="width"
    :aria-valuetext="width + ' pixels'"
    class="sidebar-resizer"
    :class="{ active }"
    title="Drag to resize · Left/Right 10 px · Shift 50 px · Enter or double-click resets"
    @pointerdown="start"
    @keydown="keys"
    @lostpointercapture="cancel"
    @dblclick.stop.prevent="emit('commit', null)"
    @click.stop
  />
</template>
<style scoped>
.sidebar-resizer {
  position: absolute;
  z-index: 1;
  top: 0;
  bottom: 0;
  right: -4px;
  width: 9px;
  cursor: col-resize;
  touch-action: none;
  outline: none;
}
.sidebar-resizer::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 4px;
  width: 2px;
  background: var(--accent);
  opacity: 0;
  transition: opacity 0.12s;
}
.sidebar-resizer:hover::after,
.sidebar-resizer:focus-visible::after,
.sidebar-resizer.active::after {
  opacity: 1;
}
</style>

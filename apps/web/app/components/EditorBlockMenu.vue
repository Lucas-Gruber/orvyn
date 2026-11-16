<script setup lang="ts">
import type { NodeViewProps } from "@tiptap/vue-3";
import { selectedBlocks } from "@orvyn/editor";
const props = defineProps<{
    editor: NodeViewProps["editor"];
    position?: { left: number; top: number };
  }>(),
  emit = defineEmits<{ close: [] }>(),
  panel = ref<HTMLElement>(),
  tick = ref(0);
const range = computed(() => {
    void tick.value;
    return selectedBlocks(props.editor.state);
  }),
  count = computed(() =>
    range.value
      ? props.editor.state.doc.resolve(range.value.to).index(0) -
        props.editor.state.doc.resolve(range.value.from).index(0)
      : 0,
  ),
  style = computed(() => ({
    left:
      Math.max(
        8,
        Math.min(props.position?.left || 0, window.innerWidth - 256),
      ) + "px",
    top:
      Math.max(
        8,
        Math.min(props.position?.top || 0, window.innerHeight - 256),
      ) + "px",
  }));
function refresh() {
  tick.value++;
  if (!props.editor.isEditable) emit("close");
}
function close(focus = false) {
  emit("close");
  if (focus) props.editor.view.focus();
}
function action(value: "up" | "down" | "duplicate" | "delete") {
  props.editor.commands.blockAction(value);
  close(true);
}
function keys(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (event.key === "Tab") close();
  else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const items = [
        ...(panel.value?.querySelectorAll<HTMLButtonElement>(
          "[role=menuitem]:not(:disabled)",
        ) || []),
      ],
      index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length
    ]?.focus();
  }
}
function outside(event: Event) {
  if (
    props.position &&
    !panel.value?.contains(event.target as Node) &&
    !(event.target as HTMLElement).closest?.(".block-handle")
  )
    close();
}
watch(
  () => props.position,
  async (position) => {
    if (!position) return;
    await nextTick();
    panel.value
      ?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")
      ?.focus();
  },
);
onMounted(() => {
  props.editor.on("transaction", refresh);
  document.addEventListener("pointerdown", outside);
  document.addEventListener("focusin", outside);
  window.addEventListener("resize", closeOnScroll);
  window.addEventListener("scroll", closeOnScroll, true);
});
function closeOnScroll() {
  if (props.position) close();
}
onBeforeUnmount(() => {
  props.editor.off("transaction", refresh);
  document.removeEventListener("pointerdown", outside);
  document.removeEventListener("focusin", outside);
  window.removeEventListener("resize", closeOnScroll);
  window.removeEventListener("scroll", closeOnScroll, true);
});
</script>
<template>
  <Teleport to="body">
    <div
      v-if="position && editor.isEditable"
      ref="panel"
      class="block-actions-menu menu-popover"
      :style="style"
      role="menu"
      aria-label="Block actions"
      @keydown="keys"
    >
      <div class="block-actions-heading">
        {{ count }} {{ count === 1 ? "block" : "blocks" }} selected
      </div>
      <button
        role="menuitem"
        :disabled="!editor.can().blockAction('up')"
        @click="action('up')"
      >
        Move up <kbd>Alt ⇧ ↑</kbd>
      </button>
      <button
        role="menuitem"
        :disabled="!editor.can().blockAction('down')"
        @click="action('down')"
      >
        Move down <kbd>Alt ⇧ ↓</kbd>
      </button>
      <button role="menuitem" @click="action('duplicate')">Duplicate</button>
      <button role="menuitem" class="danger-text" @click="action('delete')">
        Delete
      </button>
      <p>Shift-click handles to select several blocks.</p>
    </div>
  </Teleport>
</template>
<style>
.block-actions-menu.menu-popover {
  position: fixed;
  right: auto;
  width: 240px;
  z-index: 90;
}
.block-actions-heading {
  font-size: 0.76rem;
  color: var(--muted);
  padding: 6px 8px;
}
.block-actions-menu button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.block-actions-menu kbd {
  font-size: 0.7rem;
  color: var(--muted);
}
.block-actions-menu p {
  font-size: 0.7rem;
  color: var(--muted);
  padding: 4px 8px;
  margin: 4px 0;
}
.block-handle-anchor {
  display: block;
  position: relative;
  height: 0;
  user-select: none;
}
.block-handle {
  display: grid;
  place-items: center;
  position: absolute;
  left: -30px;
  top: 3px;
  width: 26px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: grab;
  opacity: 0;
  font-size: 23px;
  line-height: 1;
}
.block-handle:active {
  cursor: grabbing;
}
.block-handle-anchor:has(+ :hover) .block-handle,
.block-handle:hover,
.block-handle:focus-visible,
.block-handle-anchor:has(+ .orvyn-block-selected) .block-handle {
  opacity: 1;
}
.block-handle:hover,
.block-handle:focus-visible {
  background: var(--surface-hover);
}
.orvyn-block-selected {
  background: var(--accent-soft);
  border-radius: 4px;
  outline: 1px solid color-mix(in srgb, var(--accent) 24%, transparent);
}
.block-drop-line {
  display: block;
  height: 0;
  position: relative;
  pointer-events: none;
}
.block-drop-line::after {
  content: "";
  position: absolute;
  height: 3px;
  left: 0;
  right: 0;
  top: -2px;
  border-radius: 2px;
  background: var(--accent);
  z-index: 10;
}
@media (max-width: 760px) {
  .block-handle {
    left: -25px;
    width: 22px;
    opacity: 0.5;
  }
}
</style>

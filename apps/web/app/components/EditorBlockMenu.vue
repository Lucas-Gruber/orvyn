<script setup lang="ts">
import type { NodeViewProps } from "@tiptap/vue-3";
import { selectedBlocks, blockMoveTargets } from "@orvyn/editor";
const props = defineProps<{
    editor: NodeViewProps["editor"];
    position?: { left: number; top: number };
  }>(),
  emit = defineEmits<{ close: [] }>(),
  panel = ref<HTMLElement>(),
  tick = ref(0),
  moving = ref(false),
  query = ref(""),
  moveError = ref("");
const targets = computed(() => {
  void tick.value;
  return blockMoveTargets(props.editor.state).filter((target) =>
    target.label
      .toLocaleLowerCase()
      .includes(query.value.trim().toLocaleLowerCase()),
  );
});
const range = computed(() => {
    void tick.value;
    return selectedBlocks(props.editor.state);
  }),
  count = computed(() =>
    range.value
      ? props.editor.state.doc.resolve(range.value.to).index() -
        props.editor.state.doc.resolve(range.value.from).index()
      : 0,
  ),
  style = computed(() => ({
    left:
      Math.max(
        8,
        Math.min(props.position?.left || 0, window.innerWidth - 296),
      ) + "px",
    top:
      Math.max(
        8,
        Math.min(
          props.position?.top || 0,
          window.innerHeight - (moving.value ? 420 : 310),
        ),
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
function action(value: "up" | "down" | "out" | "duplicate" | "delete") {
  props.editor.commands.blockAction(value);
  close(true);
}
async function chooseContainer() {
  moving.value = true;
  query.value = "";
  moveError.value = "";
  await nextTick();
  panel.value?.querySelector<HTMLInputElement>("input")?.focus();
}
async function back() {
  moving.value = false;
  await nextTick();
  panel.value?.querySelector<HTMLButtonElement>("[data-move-blocks]")?.focus();
}
function move(position: number) {
  if (props.editor.commands.moveBlocksTo(position)) close(true);
  else
    moveError.value = "This destination changed. Choose a destination again.";
}
function keys(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (moving.value) void back();
    else close(true);
  } else if (event.key === "Tab") close();
  else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    if (
      event.target instanceof HTMLInputElement &&
      ["Home", "End"].includes(event.key)
    )
      return;
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
    moving.value = false;
    query.value = "";
    moveError.value = "";
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
function closeOnScroll(event: Event) {
  if (event.target instanceof Node && panel.value?.contains(event.target))
    return;
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
      :aria-label="moving ? 'Move blocks to' : 'Block actions'"
      @keydown="keys"
    >
      <div class="block-actions-heading">
        {{ count }} {{ count === 1 ? "block" : "blocks" }} selected
      </div>
      <template v-if="moving">
        <button
          class="block-move-back"
          aria-label="Back to block actions"
          @click="back"
        >
          <AppIcon name="back" :size="16" />Move to
        </button>
        <div class="block-move-search">
          <AppIcon name="search" :size="15" /><input
            v-model="query"
            aria-label="Find a block destination"
            placeholder="Find a column, callout or toggle…"
          />
        </div>
        <div class="block-move-destinations">
          <button
            v-for="target in targets"
            :key="target.position"
            role="menuitem"
            @click="move(target.position)"
          >
            <AppIcon name="arrowRight" :size="16" /><span>{{
              target.label
            }}</span>
          </button>
          <p v-if="!targets.length">No matching destinations.</p>
        </div>
        <p v-if="moveError" role="status">{{ moveError }}</p>
      </template>
      <template v-else>
        <button
          role="menuitem"
          :disabled="!editor.can().blockAction('up')"
          @click="action('up')"
        >
          <AppIcon name="chevronUp" :size="16" /><span>Move up</span>
          <kbd>Alt ⇧ ↑</kbd>
        </button>
        <button
          role="menuitem"
          :disabled="!editor.can().blockAction('down')"
          @click="action('down')"
        >
          <AppIcon name="chevronDown" :size="16" /><span>Move down</span>
          <kbd>Alt ⇧ ↓</kbd>
        </button>
        <button
          role="menuitem"
          :disabled="!editor.can().blockAction('out')"
          @click="action('out')"
        >
          <AppIcon name="back" :size="16" /><span>Move outside container</span
          ><kbd>Alt ⇧ ←</kbd>
        </button>
        <button role="menuitem" data-move-blocks @click="chooseContainer">
          <AppIcon name="arrowRight" :size="16" /><span>Move to…</span
          ><AppIcon name="chevronRight" :size="15" />
        </button>
        <div role="separator" class="menu-divider" />
        <button role="menuitem" @click="action('duplicate')">
          <AppIcon name="copy" :size="16" /><span>Duplicate</span>
        </button>
        <button role="menuitem" class="danger-text" @click="action('delete')">
          <AppIcon name="trash" :size="16" /><span>Delete</span>
        </button>
        <p>Shift-click handles to select several blocks.</p>
      </template>
    </div>
  </Teleport>
</template>
<style>
.block-actions-menu.menu-popover {
  position: fixed;
  right: auto;
  width: min(280px, calc(100vw - 16px));
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
  gap: 9px;
  width: 100%;
}
.block-actions-menu button > span {
  flex: 1;
  text-align: left;
}
.block-actions-menu button > svg {
  flex: none;
  color: var(--muted);
}
.block-move-search {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 4px 6px 8px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--muted);
}
.block-move-search input {
  min-width: 0;
  width: 100%;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  min-height: 20px;
  border-radius: 0;
  box-shadow: none;
}
.block-move-search input:focus {
  outline: none;
  box-shadow: none;
}
.block-move-search:focus-within {
  border-color: var(--accent);
}
.block-move-destinations {
  max-height: min(280px, calc(100vh - 180px));
  overflow: auto;
}
.block-move-destinations button {
  min-height: 34px;
}
.block-move-destinations button > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.block-actions-menu .block-move-back {
  justify-content: flex-start;
  font-weight: 550;
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
.block-handle-anchor:has(+ :hover .block-handle-anchor + :hover)
  > .block-handle:not(:focus-visible) {
  opacity: 0;
}
.columns-content .block-handle {
  left: -20px;
  width: 18px;
  z-index: 2;
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

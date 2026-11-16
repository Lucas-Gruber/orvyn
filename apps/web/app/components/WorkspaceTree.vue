<script setup lang="ts">
import { pageOrder, pageContains, visiblePageTree } from "../utils/pageTree";
const props = defineProps<{
    pages: any[];
    activeId?: string;
    canCreate: boolean;
    expanded: string[];
    moving?: boolean;
  }>(),
  emit = defineEmits<{
    open: [id: string];
    create: [parentId: string];
    toggle: [id: string];
    move: [
      move: {
        id: string;
        placement: "before" | "after" | "inside" | "root";
        targetId: string | null;
        targetParentId?: string | null;
      },
    ];
  }>();
const tree = ref<HTMLElement>();
const visible = computed(() => visiblePageTree(props.pages, props.expanded)),
  byId = computed(() => new Map(props.pages.map((page) => [page.id, page]))),
  dragging = ref<string>(),
  cue = ref<{ id: string; placement: "before" | "after" | "inside" }>();
let expandTimer: ReturnType<typeof setTimeout> | undefined;
const canMove = (page: any) =>
  props.canCreate &&
  !props.moving &&
  page.access_rank >= 30 &&
  page.kind !== "record";
function clearCue() {
  cue.value = undefined;
  clearTimeout(expandTimer);
}
function endDrag() {
  dragging.value = undefined;
  clearCue();
}
function leave(event: DragEvent) {
  if (
    !(event.relatedTarget instanceof Node) ||
    !tree.value?.contains(event.relatedTarget)
  )
    clearCue();
}
function start(event: DragEvent, page: any) {
  if (!canMove(page) || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  dragging.value = page.id;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-orvyn-page", page.id);
  event.dataTransfer.setData("text/plain", page.title);
}
function over(event: DragEvent, page: any) {
  if (
    !dragging.value ||
    props.moving ||
    page.kind === "record" ||
    pageContains(byId.value, dragging.value, page.id) ||
    !event.dataTransfer?.types.includes("application/x-orvyn-page")
  ) {
    clearCue();
    return;
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(),
    ratio = (event.clientY - rect.top) / rect.height;
  const placement =
    ratio < 0.25
      ? "before"
      : ratio > 0.75
        ? "after"
        : ["page", "folder"].includes(page.kind) && page.access_rank >= 30
          ? "inside"
          : ratio < 0.5
            ? "before"
            : "after";
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  if (
    cue.value &&
    cue.value.id === page.id &&
    cue.value.placement === placement
  )
    return;
  clearCue();
  cue.value = { id: page.id, placement };
  if (
    placement === "inside" &&
    page.children &&
    !props.expanded.includes(page.id)
  )
    expandTimer = setTimeout(() => {
      if (dragging.value) emit("toggle", page.id);
    }, 600);
}
function drop(event: DragEvent, page: any) {
  if (
    !dragging.value ||
    !cue.value ||
    cue.value.id !== page.id ||
    event.dataTransfer?.getData("application/x-orvyn-page") !== dragging.value
  )
    return;
  event.preventDefault();
  const value = {
    id: dragging.value,
    placement: cue.value.placement,
    targetId: page.id,
    targetParentId: page.parent_id || null,
  };
  endDrag();
  emit("move", value);
}
function rootDrop(event: DragEvent) {
  if (
    !dragging.value ||
    event.dataTransfer?.getData("application/x-orvyn-page") !== dragging.value
  )
    return;
  event.preventDefault();
  const id = dragging.value;
  endDrag();
  emit("move", { id, placement: "root", targetId: null });
}
onBeforeUnmount(endDrag);
function keys(event: KeyboardEvent, page: any) {
  if (
    event.altKey &&
    event.shiftKey &&
    ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) &&
    canMove(page)
  ) {
    event.preventDefault();
    const siblings = props.pages
        .filter((p) => p.parent_id === page.parent_id)
        .sort(pageOrder),
      index = siblings.findIndex((p) => p.id === page.id),
      target =
        event.key === "ArrowUp"
          ? siblings[index - 1]
          : event.key === "ArrowDown"
            ? siblings[index + 1]
            : event.key === "ArrowLeft"
              ? byId.value.get(page.parent_id)
              : siblings[index - 1],
      placement =
        event.key === "ArrowUp"
          ? "before"
          : event.key === "ArrowRight"
            ? "inside"
            : "after";
    if (
      target &&
      target.kind !== "record" &&
      (placement !== "inside" ||
        (["page", "folder"].includes(target.kind) && target.access_rank >= 30))
    )
      emit("move", {
        id: page.id,
        placement,
        targetId: target.id,
        targetParentId: target.parent_id || null,
      });
    return;
  }
  const buttons = [
      ...(tree.value?.querySelectorAll<HTMLButtonElement>(".tree-page") || []),
    ],
    index = buttons.indexOf(event.currentTarget as HTMLButtonElement);
  if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : Math.max(
              0,
              Math.min(
                buttons.length - 1,
                index + (event.key === "ArrowDown" ? 1 : -1),
              ),
            );
    buttons[next]?.focus();
  } else if (
    event.key === "ArrowRight" &&
    page.children &&
    !props.expanded.includes(page.id)
  ) {
    event.preventDefault();
    emit("toggle", page.id);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (props.expanded.includes(page.id)) emit("toggle", page.id);
    else buttons.find((b) => b.dataset.page === page.parent_id)?.focus();
  }
}
</script>
<template>
  <nav
    ref="tree"
    class="workspace-tree"
    aria-label="Pages"
    @dragend="endDrag"
    @dragleave="leave"
  >
    <div
      v-for="page in visible"
      :key="page.id"
      class="tree-row"
      :class="{ selected: activeId === page.id }"
      :draggable="canMove(page)"
      :data-drop-position="cue?.id === page.id ? cue?.placement : undefined"
      :data-dragging="dragging === page.id || undefined"
      :style="{ '--depth': Math.min(page.depth, 8) }"
      @dragstart="start($event, page)"
      @dragover="over($event, page)"
      @drop="drop($event, page)"
    >
      <button
        v-if="page.children"
        class="tree-caret"
        :aria-label="'Toggle subpages of ' + page.title"
        :aria-expanded="expanded.includes(page.id)"
        @click="emit('toggle', page.id)"
      >
        <AppIcon
          :name="expanded.includes(page.id) ? 'chevronDown' : 'chevronRight'"
          :size="14"
        /></button
      ><span v-else class="tree-caret spacer" /><button
        class="tree-page"
        :data-page="page.id"
        :aria-current="activeId === page.id ? 'page' : undefined"
        :title="
          canMove(page)
            ? 'Drag to move · Alt+Shift+arrow keys to reorder or nest'
            : undefined
        "
        @click="emit('open', page.id)"
        @keydown="keys($event, page)"
      >
        <PageSymbol :icon="page.icon" :kind="page.kind" :size="16" /><span>{{
          page.title
        }}</span
        ><AppIcon
          v-if="page.visibility === 'restricted'"
          name="lock"
          :size="12"
        /></button
      ><button
        v-if="canCreate && page.access_rank >= 30 && page.kind !== 'database'"
        class="tree-add"
        :aria-label="'Add subpage to ' + page.title"
        @click="emit('create', page.id)"
      >
        <AppIcon name="plus" :size="15" />
      </button>
    </div>
    <p v-if="!pages.length" class="tree-empty">Your pages will appear here.</p>
    <div
      v-if="dragging"
      class="tree-root-drop"
      @dragover.prevent="clearCue"
      @drop="rootDrop"
    >
      Move to top level
    </div>
  </nav>
</template>
<style scoped>
.tree-row {
  position: relative;
}
.tree-row[data-dragging] {
  opacity: 0.45;
}
.tree-row[data-drop-position="inside"] {
  background: var(--accent-soft);
  outline: 1px solid var(--accent);
}
.tree-row[data-drop-position="before"]::before,
.tree-row[data-drop-position="after"]::after {
  content: "";
  position: absolute;
  left: 4px;
  right: 4px;
  height: 2px;
  background: var(--accent);
  pointer-events: none;
  z-index: 2;
}
.tree-row[data-drop-position="before"]::before {
  top: -1px;
}
.tree-row[data-drop-position="after"]::after {
  bottom: -1px;
}
.tree-root-drop {
  padding: 12px;
  margin: 8px 4px;
  border: 1px dashed var(--accent);
  border-radius: 6px;
  font-size: 0.76rem;
  color: var(--accent);
  text-align: center;
}
</style>

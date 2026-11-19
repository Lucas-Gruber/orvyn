<script setup lang="ts">
import type { DatabaseRecord, Property, RecordOpenMode } from "@orvyn/shared";
import { propertyIcon } from "../utils/databaseFields";
const props = defineProps<{
  databaseId: string;
  viewId: string;
  groups: {
    id: string | null;
    label: string;
    color?: string;
    records: DatabaseRecord[];
  }[];
  columns: Property[];
  groupProperty: Property;
  canEdit: boolean;
  busy: boolean;
  format: (record: DatabaseRecord, property: Property) => string;
}>();
const emit = defineEmits<{
  open: [id: string, mode?: RecordOpenMode];
  context: [event: MouseEvent | KeyboardEvent, record: DatabaseRecord];
  keys: [event: KeyboardEvent, record: DatabaseRecord];
  move: [record: DatabaseRecord, values: Record<string, unknown>];
  create: [group: string | null];
}>();
const board = ref<HTMLElement>(),
  moveMenu = ref<{ open: (event: MouseEvent | KeyboardEvent) => void }>();
const moving = ref<DatabaseRecord>(),
  announcement = ref("");
const drag = ref<{ id: string; property: string; group: unknown }>();
const over = ref<string | null | undefined>();
const failedImages = reactive(new Set<string>());
const mime = "application/x-orvyn-board-card";
let scrollFrame = 0,
  pointer = { x: 0, y: 0 };
const fields = computed(() =>
  props.columns.filter(
    (p) => p.type !== "Title" && p.id !== props.groupProperty.id,
  ),
);
const moveOptions = computed(() =>
  props.groups.map((group) => ({
    id: group.id || "unassigned",
    label: group.label,
    icon: "board",
    disabled:
      !moving.value ||
      !editable(moving.value) ||
      (moving.value.values[props.groupProperty.id] ?? null) === group.id,
  })),
);
function editable(record: DatabaseRecord) {
  return props.canEdit && record.accessRank >= 30 && !props.busy;
}
function image(record: DatabaseRecord) {
  const id = record.previewFileId;
  return id && !failedImages.has(id) ? id : undefined;
}
function move(
  record: DatabaseRecord,
  group: string | null,
  restoreFocus = false,
) {
  const current = props.groups
    .flatMap((g) => g.records)
    .find((r) => r.pageId === record.pageId);
  if (
    !current ||
    !editable(current) ||
    !props.groups.some((g) => g.id === group)
  )
    return;
  if ((current.values[props.groupProperty.id] ?? null) === group) return;
  emit("move", current, { [props.groupProperty.id]: group });
  announcement.value = `${current.title} moved to ${props.groups.find((g) => g.id === group)?.label}.`;
  if (restoreFocus)
    void nextTick(() => {
      const button = board.value?.querySelector<HTMLButtonElement>(
        `[data-record-id="${CSS.escape(current.pageId)}"] .board-card-open`,
      );
      button?.focus({ preventScroll: true });
      button?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
}
function openMove(event: MouseEvent | KeyboardEvent, record: DatabaseRecord) {
  if (!editable(record)) return;
  moving.value = record;
  void moveMenu.value?.open(event);
}
function chooseMove(id: string) {
  if (moving.value) move(moving.value, id === "unassigned" ? null : id, true);
}
function keys(event: KeyboardEvent, record: DatabaseRecord) {
  if (
    event.altKey &&
    event.shiftKey &&
    ["ArrowLeft", "ArrowRight"].includes(event.key)
  ) {
    event.preventDefault();
    event.stopPropagation();
    const index = props.groups.findIndex(
      (g) => g.id === (record.values[props.groupProperty.id] ?? null),
    );
    const next = props.groups[index + (event.key === "ArrowRight" ? 1 : -1)];
    if (next) move(record, next.id, true);
  } else emit("keys", event, record);
}
function finish() {
  drag.value = undefined;
  over.value = undefined;
  cancelAnimationFrame(scrollFrame);
  scrollFrame = 0;
}
function start(event: DragEvent, record: DatabaseRecord) {
  if (!editable(record) || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  finish();
  drag.value = {
    id: record.pageId,
    property: props.groupProperty.id,
    group: record.values[props.groupProperty.id] ?? null,
  };
  event.dataTransfer.setData(
    mime,
    JSON.stringify({
      databaseId: props.databaseId,
      viewId: props.viewId,
      id: record.pageId,
    }),
  );
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", record.title);
  const card = (event.currentTarget as HTMLElement).closest<HTMLElement>(
    "article",
  );
  if (card) {
    const bounds = card.getBoundingClientRect();
    event.dataTransfer.setDragImage(
      card,
      Math.max(0, event.clientX - bounds.left),
      Math.max(0, event.clientY - bounds.top),
    );
  }
  announcement.value = `Moving ${record.title}. Drop in another group, or press Escape to cancel.`;
}
function accepts(event: DragEvent) {
  return (
    !!drag.value &&
    props.canEdit &&
    !props.busy &&
    drag.value.property === props.groupProperty.id &&
    !!event.dataTransfer?.types.includes(mime)
  );
}
function autoScroll() {
  if (!drag.value || !board.value) {
    scrollFrame = 0;
    return;
  }
  const rect = board.value.getBoundingClientRect(),
    edge = 48;
  const delta = (value: number, start: number, end: number) =>
    value < start + edge
      ? -Math.ceil((start + edge - value) / 4)
      : value > end - edge
        ? Math.ceil((value - end + edge) / 4)
        : 0;
  board.value.scrollLeft += Math.max(
    -18,
    Math.min(18, delta(pointer.x, rect.left, rect.right)),
  );
  window.scrollBy(
    0,
    Math.max(-18, Math.min(18, delta(pointer.y, 0, innerHeight))),
  );
  scrollFrame = requestAnimationFrame(autoScroll);
}
function hover(event: DragEvent, group: string | null) {
  if (!accepts(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  over.value = group;
  pointer = { x: event.clientX, y: event.clientY };
  if (!scrollFrame) scrollFrame = requestAnimationFrame(autoScroll);
}
function leave(event: DragEvent) {
  if (
    (event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)
  )
    return;
  over.value = undefined;
  cancelAnimationFrame(scrollFrame);
  scrollFrame = 0;
}
function drop(event: DragEvent, group: string | null) {
  if (!accepts(event)) return;
  event.preventDefault();
  try {
    const payload = JSON.parse(event.dataTransfer!.getData(mime));
    const current = props.groups
      .flatMap((g) => g.records)
      .find((r) => r.pageId === drag.value!.id);
    if (
      payload.databaseId !== props.databaseId ||
      payload.viewId !== props.viewId ||
      payload.id !== drag.value!.id ||
      !current
    )
      return;
    if (
      (current.values[props.groupProperty.id] ?? null) !== drag.value!.group
    ) {
      announcement.value =
        "This card moved elsewhere. Start a new move from its current group.";
      return;
    }
    move(current, group);
  } catch {
    /* Ignore foreign drag payloads. */
  } finally {
    finish();
  }
}
function cancel(event: KeyboardEvent) {
  if (event.key === "Escape" && drag.value) {
    finish();
    announcement.value = "Card move cancelled.";
  }
}
watch(
  [
    () => props.viewId,
    () => props.groupProperty.id,
    () => props.canEdit,
    () => props.busy,
  ],
  finish,
);
watch(
  () => props.groups,
  () => {
    if (
      drag.value &&
      !props.groups.some((g) =>
        g.records.some((r) => r.pageId === drag.value!.id && editable(r)),
      )
    )
      finish();
  },
);
onMounted(() => {
  window.addEventListener("keydown", cancel, true);
  window.addEventListener("blur", finish);
});
onBeforeUnmount(() => {
  finish();
  window.removeEventListener("keydown", cancel, true);
  window.removeEventListener("blur", finish);
});
</script>
<template>
  <div>
    <div ref="board" class="database-board" :class="{ 'is-dragging': drag }">
      <section
        v-for="group in groups"
        :key="group.id || 'unassigned'"
        class="board-column"
        :class="{
          'is-drop-target':
            drag && over === group.id && drag.group !== group.id,
        }"
        :aria-label="group.label"
        @dragenter="hover($event, group.id)"
        @dragover="hover($event, group.id)"
        @dragleave="leave"
        @drop="drop($event, group.id)"
      >
        <header class="board-group-header">
          <h2>
            <span class="board-group-label" :data-color="group.color"
              ><span class="group-dot" />{{ group.label }}</span
            ><small
              :aria-label="group.records.length + ' records on this page'"
              >{{ group.records.length }}</small
            >
          </h2>
          <button
            v-if="canEdit"
            class="board-group-add"
            :aria-label="'New record in ' + group.label"
            :disabled="busy"
            @click="emit('create', group.id)"
          >
            <AppIcon name="plus" :size="15" />
          </button>
        </header>
        <div class="board-cards">
          <article
            v-for="record in group.records"
            :key="record.pageId"
            class="board-card"
            :data-record-id="record.pageId"
            :class="{ 'is-drag-source': drag?.id === record.pageId }"
            :draggable="editable(record)"
            @dragstart="start($event, record)"
            @dragend="finish"
            @contextmenu="emit('context', $event, record)"
          >
            <button
              class="board-card-open"
              :aria-label="record.title"
              @click="emit('open', record.pageId)"
              @keydown="keys($event, record)"
            >
              <CoverBanner
                v-if="record.coverPreset"
                :preset="record.coverPreset"
                compact
              />
              <img
                v-else-if="image(record)"
                class="board-card-cover"
                :src="'/api/v1/files/' + image(record) + '/preview'"
                alt=""
                loading="lazy"
                draggable="false"
                @error="failedImages.add(image(record)!)"
              />
              <span class="board-card-body"
                ><span class="board-card-title"
                  ><PageSymbol
                    v-if="record.icon"
                    :icon="record.icon"
                    :size="17"
                  />{{ record.title }}</span
                >
                <span
                  v-for="property in fields.filter(
                    (p) =>
                      record.values[p.id] !== null &&
                      record.values[p.id] !== undefined &&
                      record.values[p.id] !== '' &&
                      (!Array.isArray(record.values[p.id]) ||
                        (record.values[p.id] as unknown[]).length),
                  )"
                  :key="property.id"
                  class="board-card-property"
                  ><AppIcon :name="propertyIcon(property)" :size="13" /><span
                    class="sr-only"
                    >{{ property.name }}: </span
                  ><span>{{ format(record, property) }}</span></span
                >
              </span>
            </button>
            <button
              v-if="canEdit && record.accessRank >= 30"
              class="card-drag-handle"
              :aria-label="'Move ' + record.title"
              title="Drag to another group, or click to choose"
              :draggable="!busy"
              :disabled="busy"
              @dragstart.stop="start($event, record)"
              @dragend="finish"
              @click="openMove($event, record)"
              @keydown="keys($event, record)"
            >
              <AppIcon name="grip" :size="16" />
            </button>
          </article>
          <div
            v-if="drag && over === group.id && drag.group !== group.id"
            class="board-drop-placeholder"
            aria-hidden="true"
          >
            <AppIcon name="arrowRight" :size="15" />Move to {{ group.label }}
          </div>
          <button
            v-else-if="canEdit"
            class="board-add-card"
            :disabled="busy"
            @click="emit('create', group.id)"
          >
            <AppIcon name="plus" :size="14" />New page
          </button>
          <p v-else-if="!group.records.length" class="board-empty">
            No records
          </p>
        </div>
      </section>
    </div>
    <p v-if="canEdit" class="board-hint">
      Drag cards between groups · <kbd>Alt Shift ← →</kbd> to move the focused
      card
    </p>
    <p class="sr-only" role="status" aria-live="polite">{{ announcement }}</p>
    <UiContextMenu
      ref="moveMenu"
      label="Move record to"
      :items="moveOptions"
      @select="chooseMove"
    />
  </div>
</template>
<style scoped>
.database-board {
  display: flex;
  gap: 20px;
  overflow: auto;
  align-items: stretch;
  padding: 6px 2px 20px;
  min-height: 220px;
}
.board-column {
  flex: 1 0 255px;
  min-width: 255px;
  max-width: 340px;
  padding: 0 5px 9px;
  border-radius: 7px;
  border: 1px solid transparent;
  transition:
    background 120ms,
    border-color 120ms;
}
.board-column.is-drop-target {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.board-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 36px;
  padding: 0 3px 8px;
}
.board-group-header h2 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 0.78rem;
  font-weight: 550;
}
.board-group-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--surface);
  border-radius: 4px;
  padding: 3px 7px;
}
.group-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--faint);
}
[data-color="blue"] .group-dot {
  background: #659bd0;
}
[data-color="green"] .group-dot {
  background: #6ba486;
}
[data-color="yellow"] .group-dot {
  background: #cba445;
}
[data-color="red"] .group-dot {
  background: #d2817d;
}
[data-color="purple"] .group-dot {
  background: #9c82c3;
}
.board-group-header small {
  color: var(--faint);
  font-size: 0.72rem;
  font-weight: 400;
}
.board-group-add {
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--muted);
  padding: 3px;
  min-height: 26px;
}
.board-cards {
  min-height: 120px;
}
.board-card {
  position: relative;
  overflow: hidden;
  margin: 0 0 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg);
  box-shadow: 0 1px 2px #0000000d;
  transition:
    box-shadow 120ms,
    opacity 120ms;
}
.board-card:hover {
  box-shadow: 0 2px 7px #00000014;
}
.board-card.is-drag-source {
  opacity: 0.35;
}
.board-card-open {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text);
  text-align: left;
  font-weight: 400;
}
.board-card-open:hover {
  background: var(--surface-hover);
}
.board-card-open:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.board-card-cover {
  width: 100%;
  height: 135px;
  display: block;
  object-fit: cover;
  border-bottom: 1px solid var(--line-soft);
}
.board-card-open :deep(.cover-banner.compact) {
  height: 135px;
  border-radius: 0;
  margin: 0;
}
.board-card-body {
  display: block;
  padding: 12px 13px;
}
.board-card-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 12px;
  line-height: 1.5;
  font-size: 0.85rem;
  font-weight: 550;
  overflow-wrap: anywhere;
}
.board-card-property {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  margin-top: 7px;
  font-size: 0.73rem;
  line-height: 1.45;
}
.board-card-property > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.board-card-property .app-icon {
  flex-shrink: 0;
  color: var(--faint);
}
.card-drag-handle {
  position: absolute;
  top: 6px;
  right: 5px;
  display: grid;
  place-items: center;
  padding: 3px;
  min-height: 26px;
  width: 24px;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  background: var(--bg);
  color: var(--muted);
  cursor: grab;
  opacity: 0;
}
.board-card:hover .card-drag-handle,
.card-drag-handle:focus-visible {
  opacity: 1;
}
.is-dragging .card-drag-handle {
  cursor: grabbing;
}
.board-add-card {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 7px;
  min-height: 32px;
  border: 0;
  background: transparent;
  color: var(--faint);
  padding: 7px 10px;
  font-size: 0.77rem;
}
.board-add-card:hover {
  color: var(--text);
  background: var(--surface-hover);
}
.board-drop-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 76px;
  border: 1px dashed var(--accent);
  border-radius: 6px;
  background: var(--bg);
  color: var(--accent);
  font-size: 0.75rem;
}
.board-hint {
  margin: 0 0 12px;
  color: var(--faint);
  font-size: 0.7rem;
}
.board-hint kbd {
  font: inherit;
}
.board-empty {
  font-size: 0.75rem;
  color: var(--faint);
  padding: 8px;
}
@media (hover: none) {
  .card-drag-handle {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .board-column,
  .board-card {
    transition: none;
  }
}
</style>

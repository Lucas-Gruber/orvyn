<script setup lang="ts">
import {
  orderedViewProperties,
  reorderPropertyIds,
  type Property,
  type ViewConfig,
} from "@orvyn/shared";
import { propertyIcon } from "../utils/databaseFields";
const props = defineProps<{
  databaseId: string;
  beforeChange: (allowDrafts?: boolean) => Promise<void>;
}>();
const emit = defineEmits<{ changed: []; error: [message: string] }>();
const visible = ref(false),
  loading = ref(false),
  saving = ref(false),
  error = ref("");
const metadata = ref<any>(),
  view = ref<any>(),
  order = ref<Property[]>([]),
  shown = ref<string[]>([]),
  original = ref("");
const dragging = ref<string | null>(null),
  dropTarget = ref<{ id: string; after: boolean } | null>(null);
const token = useId(),
  transferType = "application/x-orvyn-property-layout";
let generation = 0;
const snapshot = () =>
  JSON.stringify([
    order.value.map((property) => property.id),
    [...shown.value].sort(),
  ]);
const dirty = computed(() => snapshot() !== original.value);
function required(property: Property) {
  return (
    property.type === "Title" ||
    property.id === view.value?.config.groupBy ||
    property.id === view.value?.config.dateProperty
  );
}
async function api(path = "", method = "GET", body?: unknown) {
  return $fetch<any>(`/api/v1/databases/${props.databaseId}${path}`, {
    method: method as any,
    body: body as any,
  });
}
function clearUnavailable(e: any) {
  if (![401, 404].includes(e.statusCode || e.status)) return;
  metadata.value = undefined;
  view.value = undefined;
  order.value = [];
  shown.value = [];
  original.value = snapshot();
}
async function load(id: string) {
  const request = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const meta = await api();
    if (request !== generation) return;
    const saved = meta.views.find((item: any) => item.id === id);
    if (meta.accessRank < 30 || !saved)
      throw Object.assign(
        new Error("This view is no longer available for editing."),
        { statusCode: 404 },
      );
    metadata.value = meta;
    view.value = structuredClone(saved);
    order.value = orderedViewProperties(meta.properties, saved.config, false);
    shown.value = orderedViewProperties(meta.properties, saved.config).map(
      (property) => property.id,
    );
    original.value = snapshot();
  } catch (e: any) {
    if (request !== generation) return;
    clearUnavailable(e);
    error.value =
      e.data?.message || e.message || "Properties could not be loaded.";
  } finally {
    if (request === generation) loading.value = false;
  }
}
async function open(id: string) {
  try {
    await props.beforeChange(true);
    view.value = undefined;
    metadata.value = undefined;
    order.value = [];
    shown.value = [];
    original.value = snapshot();
    visible.value = true;
    await load(id);
  } catch (e: any) {
    emit(
      "error",
      e.data?.message || e.message || "Properties could not be opened.",
    );
  }
}
function close() {
  if (!saving.value) {
    generation++;
    visible.value = false;
    dragging.value = null;
    dropTarget.value = null;
  }
}
function toggle(property: Property, checked: boolean) {
  if (required(property)) return;
  shown.value = checked
    ? [...new Set([...shown.value, property.id])]
    : shown.value.filter((id) => id !== property.id);
}
function move(id: string, destination: number) {
  const index = order.value.findIndex((property) => property.id === id);
  if (
    index < 0 ||
    order.value[index]!.type === "Title" ||
    destination <= 0 ||
    destination >= order.value.length
  )
    return;
  const next = [...order.value],
    [property] = next.splice(index, 1);
  const focused =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  next.splice(destination, 0, property!);
  order.value = next;
  void nextTick(() => {
    if (focused?.isConnected) focused.focus({ preventScroll: true });
  });
}
function dragStart(event: DragEvent, property: Property) {
  if (property.type === "Title" || !event.dataTransfer || saving.value) {
    event.preventDefault();
    return;
  }
  dragging.value = property.id;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(transferType, token);
}
function dragOver(event: DragEvent, property: Property) {
  if (
    !dragging.value ||
    property.type === "Title" ||
    !event.dataTransfer?.types.includes(transferType)
  )
    return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dropTarget.value = {
    id: property.id,
    after: event.clientY > box.top + box.height / 2,
  };
}
function drop(event: DragEvent, property: Property) {
  if (
    event.dataTransfer?.getData(transferType) !== token ||
    !dragging.value ||
    property.type === "Title"
  )
    return;
  event.preventDefault();
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const ids = reorderPropertyIds(
    order.value.map((item) => item.id),
    dragging.value,
    property.id,
    event.clientY > box.top + box.height / 2,
  );
  const properties = new Map(order.value.map((item) => [item.id, item]));
  order.value = ids.map((id) => properties.get(id)!);
  dragging.value = null;
  dropTarget.value = null;
}
function reset() {
  order.value = [...metadata.value.properties];
  shown.value = order.value.map((property) => property.id);
}
async function save() {
  if (!view.value || saving.value || !dirty.value) return;
  saving.value = true;
  error.value = "";
  try {
    await props.beforeChange(true);
    const config: ViewConfig = {
      ...view.value.config,
      propertyOrder: order.value.map((property) => property.id),
      visibleProperties:
        shown.value.length === order.value.length ? [] : [...shown.value],
    };
    await api(`/views/${view.value.id}`, "PATCH", {
      name: view.value.name,
      type: view.value.type,
      version: view.value.version,
      config,
    });
    emit("changed");
    visible.value = false;
  } catch (e: any) {
    clearUnavailable(e);
    error.value =
      (e.statusCode || e.status) === 409
        ? "This view changed in another window. Reload the saved layout before editing it again."
        : e.data?.message ||
          "The layout could not be saved. Your changes are still here.";
  } finally {
    saving.value = false;
  }
}
defineExpose({ open });
</script>
<template>
  <UiDialog :open="visible" title="View properties" @close="close">
    <form class="view-layout-form" @submit.prevent="save">
      <p class="view-layout-description">
        Choose what appears in this view. Drag properties to arrange them.
      </p>
      <p v-if="loading" role="status">Loading properties…</p>
      <div v-if="error" class="view-layout-error" role="alert">
        <p>{{ error }}</p>
        <button v-if="view && !saving" type="button" @click="load(view.id)">
          Reload saved layout
        </button>
      </div>
      <template v-if="view && !loading">
        <div class="view-layout-context">
          <AppIcon name="table" :size="15" /><span>{{ view.name }}</span
          ><span>{{ shown.length }} of {{ order.length }} shown</span>
        </div>
        <div
          class="view-layout-list"
          role="list"
          aria-label="Properties in display order"
          :aria-busy="saving"
          @dragend="
            dragging = null;
            dropTarget = null;
          "
        >
          <div
            v-for="(property, index) in order"
            :key="property.id"
            class="view-layout-row"
            :class="{
              'is-drop-target': dropTarget?.id === property.id,
              'drop-after': dropTarget?.id === property.id && dropTarget.after,
              'is-dragging': dragging === property.id,
            }"
            role="listitem"
            @dragover="dragOver($event, property)"
            @drop="drop($event, property)"
          >
            <button
              type="button"
              class="view-layout-grip"
              :draggable="property.type !== 'Title' && !saving"
              :disabled="property.type === 'Title' || saving"
              :aria-label="'Reorder ' + property.name"
              title="Drag to reorder · Alt Shift Up/Down"
              @dragstart="dragStart($event, property)"
              @keydown.alt.shift.up.prevent="move(property.id, index - 1)"
              @keydown.alt.shift.down.prevent="move(property.id, index + 1)"
            >
              <AppIcon name="grip" :size="16" />
            </button>
            <AppIcon :name="propertyIcon(property)" :size="16" /><span
              class="view-layout-name"
              >{{ property.name
              }}<small v-if="required(property)">{{
                property.type === "Title"
                  ? "Always shown first"
                  : "Used by this view"
              }}</small></span
            >
            <button
              type="button"
              class="view-layout-step"
              :aria-label="'Move ' + property.name + ' up'"
              :disabled="index <= 1 || saving"
              @click="move(property.id, index - 1)"
            >
              <AppIcon name="chevronUp" :size="14" /></button
            ><button
              type="button"
              class="view-layout-step"
              :aria-label="'Move ' + property.name + ' down'"
              :disabled="index === 0 || index === order.length - 1 || saving"
              @click="move(property.id, index + 1)"
            >
              <AppIcon name="chevronDown" :size="14" />
            </button>
            <input
              type="checkbox"
              :checked="shown.includes(property.id)"
              :disabled="required(property) || saving"
              :aria-label="'Show ' + property.name + ' in view'"
              @change="
                toggle(property, ($event.target as HTMLInputElement).checked)
              "
            />
          </div>
        </div>
        <div class="view-layout-footer">
          <button type="button" :disabled="saving" @click="reset">
            Reset layout</button
          ><span /><button type="button" :disabled="saving" @click="close">
            Cancel</button
          ><button class="primary" :disabled="saving || !dirty">
            {{ saving ? "Saving…" : "Save layout" }}
          </button>
        </div>
      </template>
      <button v-else-if="!loading" type="button" @click="close">Close</button>
    </form>
  </UiDialog>
</template>
<style>
.view-layout-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.view-layout-description {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
}
.view-layout-context {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
  padding: 0 2px;
}
.view-layout-context > span:last-child {
  margin-left: auto;
}
.view-layout-list {
  max-height: min(420px, 55vh);
  overflow: auto;
  border-top: 1px solid var(--line-soft);
  border-bottom: 1px solid var(--line-soft);
  padding: 5px 0;
}
.view-layout-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 2px;
  border-radius: 4px;
  min-height: 46px;
  position: relative;
}
.view-layout-row:hover {
  background: var(--surface-hover);
}
.view-layout-row + .view-layout-row {
  border-top: 1px solid var(--line-soft);
}
.view-layout-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.view-layout-name small {
  display: block;
  font-size: 10px;
  color: var(--muted);
  margin-top: 2px;
}
.view-layout-row > svg {
  flex: none;
  color: var(--muted);
}
.view-layout-row input[type="checkbox"] {
  width: 15px;
  height: 15px;
  min-height: 0;
  margin: 0 7px;
  accent-color: var(--accent);
  flex: none;
}
.view-layout-row button {
  width: 24px;
  height: 26px;
  min-height: 0;
  padding: 0;
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--muted);
  box-shadow: none;
  flex: none;
}
.view-layout-row button:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text);
}
.view-layout-row button:disabled {
  opacity: 0.25;
}
.view-layout-grip {
  cursor: grab;
  font-size: 20px;
}
.view-layout-grip:active {
  cursor: grabbing;
}
.view-layout-row.is-dragging {
  opacity: 0.45;
}
.view-layout-row.is-drop-target::before {
  content: "";
  position: absolute;
  top: -2px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--accent);
}
.view-layout-row.is-drop-target.drop-after::before {
  top: auto;
  bottom: -2px;
}
.view-layout-footer {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-top: 2px;
}
.view-layout-footer > span {
  flex: 1;
}
.view-layout-footer button {
  font-size: 12px;
}
.view-layout-error {
  padding: 10px 12px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 5px;
  font-size: 13px;
}
.view-layout-error p {
  margin: 0 0 8px;
}
</style>

<script setup lang="ts">
import { convertiblePropertyTypes, type Property } from "@orvyn/shared";
import { propertyIcon } from "../utils/databaseFields";
type Option = { id?: string; label: string; color: string };
const props = defineProps<{
  databaseId: string;
  beforeChange: (allowDrafts?: boolean) => Promise<void>;
}>();
const emit = defineEmits<{
  changed: [];
  create: [];
  formula: [property: Property];
  rollup: [property: Property];
  error: [message: string];
}>();
const visible = ref(false),
  loading = ref(false),
  saving = ref(false),
  error = ref(""),
  conflict = ref(false);
const metadata = ref<any>(),
  deleted = ref<any[]>([]),
  selected = ref<Property>(),
  selectedDeleted = ref<any>();
const name = ref(""),
  options = ref<Option[]>([]),
  archived = ref<Option[]>([]),
  original = ref(""),
  confirmRemoval = ref(false),
  deleting = ref(false);
const uid = useId();
const conversion = ref<{ open: (id: string) => Promise<void> }>();
let conversionField = "";
let generation = 0;
function clearUnavailable(e: any) {
  if (![401, 404].includes(e.status || e.statusCode)) return;
  metadata.value = undefined;
  selected.value = undefined;
  selectedDeleted.value = undefined;
  deleted.value = [];
  options.value = [];
  archived.value = [];
  original.value = "";
}
const isSelection = computed(() =>
  ["Select", "MultiSelect", "Status"].includes(selected.value?.type || ""),
);
const dirty = computed(
  () =>
    !!selected.value &&
    JSON.stringify([name.value, options.value]) !== original.value,
);
const removed = computed(() =>
  (selected.value?.config.options || []).filter(
    (item) => !options.value.some((option) => option.id === item.id),
  ),
);
const activeOptions = computed(() =>
  archived.value.filter(
    (item) => !options.value.some((option) => option.id === item.id),
  ),
);
async function api(path = "", method = "GET", body?: unknown) {
  return $fetch<any>(`/api/v1/databases/${props.databaseId}${path}`, {
    method: method as any,
    body: body as any,
  });
}
async function load() {
  const [meta, trash] = await Promise.all([api(), api("/deleted-properties")]);
  metadata.value = meta;
  deleted.value = trash;
}
async function select(property: Property, force = false) {
  if (saving.value) return;
  if (dirty.value && !force) {
    error.value =
      "Save or discard your changes before selecting another property.";
    return;
  }
  const token = ++generation;
  selected.value = property;
  selectedDeleted.value = undefined;
  name.value = property.name;
  options.value = (property.config.options || []).map((item) => ({ ...item }));
  original.value = JSON.stringify([name.value, options.value]);
  archived.value = [];
  error.value = "";
  conflict.value = false;
  confirmRemoval.value = false;
  if (isSelection.value) {
    try {
      const list = await api(`/properties/${property.id}/deleted-options`);
      if (token === generation)
        archived.value = list.map(({ id, label, color }: Option) => ({
          id,
          label,
          color,
        }));
    } catch (e: any) {
      if (token === generation)
        error.value = e.data?.message || "Deleted options could not be loaded.";
    }
  }
}
async function open(id?: string) {
  try {
    await props.beforeChange(true);
    visible.value = true;
    loading.value = true;
    error.value = "";
    await load();
    await select(
      metadata.value.properties.find((item: Property) => item.id === id) ||
        metadata.value.properties[0],
      true,
    );
  } catch (e: any) {
    clearUnavailable(e);
    error.value =
      e.data?.message || e.message || "Properties could not be loaded.";
    emit("error", error.value);
  } finally {
    loading.value = false;
  }
}
function close() {
  if (saving.value) return;
  if (dirty.value) {
    error.value = "Save or discard your changes before closing.";
    return;
  }
  visible.value = false;
}
async function reset() {
  const id = selected.value?.id || selectedDeleted.value?.id;
  if (!id) return;
  loading.value = true;
  try {
    await load();
    const active = metadata.value.properties.find(
      (item: Property) => item.id === id,
    );
    const archivedProperty = deleted.value.find((item) => item.id === id);
    if (active) await select(active, true);
    else if (archivedProperty) {
      selected.value = undefined;
      selectDeleted(archivedProperty);
    } else await select(metadata.value.properties[0], true);
  } catch (e: any) {
    clearUnavailable(e);
    error.value = e.data?.message || "Properties could not be loaded.";
  } finally {
    loading.value = false;
  }
}
async function save() {
  if (!selected.value || saving.value) return;
  saving.value = true;
  error.value = "";
  const id = selected.value.id;
  try {
    await props.beforeChange(!removed.value.length);
    await api(`/properties/${id}`, "PATCH", {
      name: name.value,
      schemaVersion: metadata.value.schemaVersion,
      ...(isSelection.value
        ? { options: options.value, confirmOptionRemoval: confirmRemoval.value }
        : {}),
    });
    await load();
    saving.value = false;
    await select(
      metadata.value.properties.find((item: Property) => item.id === id),
      true,
    );
    emit("changed");
  } catch (e: any) {
    clearUnavailable(e);
    conflict.value = e.status === 409;
    error.value =
      e.data?.message ||
      e.message ||
      "The property could not be saved. Your changes are still here.";
  } finally {
    saving.value = false;
  }
}
async function remove() {
  if (!selected.value || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await props.beforeChange();
    await api(`/properties/${selected.value.id}`, "DELETE", {
      schemaVersion: metadata.value.schemaVersion,
    });
    deleting.value = false;
    await load();
    saving.value = false;
    await select(metadata.value.properties[0], true);
    emit("changed");
  } catch (e: any) {
    clearUnavailable(e);
    conflict.value = e.status === 409;
    error.value =
      e.data?.message || e.message || "The property could not be deleted.";
  } finally {
    saving.value = false;
  }
}
async function restore() {
  if (!selectedDeleted.value || saving.value) return;
  saving.value = true;
  error.value = "";
  const id = selectedDeleted.value.id;
  try {
    await props.beforeChange(true);
    await api(`/properties/${id}/restore`, "POST", {
      schemaVersion: metadata.value.schemaVersion,
    });
    await load();
    saving.value = false;
    await select(
      metadata.value.properties.find((item: Property) => item.id === id),
      true,
    );
    emit("changed");
  } catch (e: any) {
    clearUnavailable(e);
    conflict.value = e.status === 409;
    error.value =
      e.data?.message || e.message || "The property could not be restored.";
  } finally {
    saving.value = false;
  }
}
function selectDeleted(item: any) {
  if (dirty.value) {
    error.value =
      "Save or discard your changes before selecting another property.";
    return;
  }
  generation++;
  selected.value = undefined;
  selectedDeleted.value = item;
  error.value = "";
  conflict.value = false;
}
function move(index: number, delta: number) {
  const next = index + delta;
  if (next < 0 || next >= options.value.length) return;
  const [item] = options.value.splice(index, 1);
  options.value.splice(next, 0, item!);
}
function create() {
  if (dirty.value) {
    error.value =
      "Save or discard your changes before adding another property.";
    return;
  }
  visible.value = false;
  emit("create");
}
async function changeType() {
  if (!selected.value || dirty.value || saving.value) return;
  try {
    await props.beforeChange();
    conversionField = selected.value.id;
    visible.value = false;
    await nextTick();
    await conversion.value?.open(conversionField);
  } catch (e: any) {
    visible.value = true;
    error.value =
      e.data?.message ||
      e.message ||
      "Save or discard pending changes before changing the field type.";
  }
}
function conversionClosed() {
  void open(conversionField);
}
defineExpose({ open });
</script>
<template>
  <UiDialog
    :open="visible"
    title="Database properties"
    wide
    class="property-manager"
    @close="close"
  >
    <p v-if="loading" role="status" class="hint">Loading properties…</p>
    <p v-if="error" class="property-error" role="alert">{{ error }}</p>
    <button
      v-if="conflict && !selected && selectedDeleted"
      type="button"
      class="ghost"
      :disabled="loading || saving"
      @click="reset"
    >
      Reload properties
    </button>
    <div v-if="metadata" class="property-manager-layout">
      <nav aria-label="Properties" class="property-navigation">
        <span>Properties</span>
        <button
          v-for="property in metadata.properties"
          :key="property.id"
          type="button"
          :aria-current="selected?.id === property.id ? 'true' : undefined"
          :disabled="saving || loading"
          @click="select(property)"
        >
          <AppIcon :name="propertyIcon(property)" :size="15" /><span>{{
            property.name
          }}</span>
        </button>
        <button
          type="button"
          class="add-property-action"
          :disabled="saving"
          @click="create"
        >
          <AppIcon name="plus" :size="15" />New property
        </button>
        <template v-if="deleted.length"
          ><span>Deleted properties</span
          ><button
            v-for="property in deleted"
            :key="property.id"
            type="button"
            :aria-current="
              selectedDeleted?.id === property.id ? 'true' : undefined
            "
            :disabled="saving || loading"
            @click="selectDeleted(property)"
          >
            <AppIcon name="trash" :size="15" /><span>{{ property.name }}</span>
          </button></template
        >
      </nav>
      <div class="property-details">
        <form v-if="selected" @submit.prevent="save">
          <fieldset :disabled="saving || loading">
            <label :for="uid + '-name'">Property name</label
            ><input
              :id="uid + '-name'"
              v-model="name"
              maxlength="80"
              required
            />
            <p class="property-type">
              <AppIcon :name="propertyIcon(selected)" :size="15" />{{
                selected.type
              }}
            </p>
            <button
              v-if="
                metadata.accessRank >= 50 &&
                (convertiblePropertyTypes as readonly string[]).includes(
                  selected.type,
                )
              "
              type="button"
              class="ghost"
              :disabled="dirty"
              @click="changeType"
            >
              <AppIcon name="refresh" :size="14" />Change type…
            </button>
            <p
              v-else-if="
                (convertiblePropertyTypes as readonly string[]).includes(
                  selected.type,
                )
              "
              class="hint"
            >
              The space owner can change this field's type.
            </p>
            <p v-if="selected.config.reciprocalPropertyId" class="hint">
              This is a two-way relation. Adding or removing links in either
              database updates the matching property.
            </p>
            <template v-if="isSelection">
              <div class="options-heading">
                <h3>Options</h3>
                <button
                  type="button"
                  class="ghost"
                  :disabled="options.length >= 50"
                  @click="options.push({ label: '', color: 'neutral' })"
                >
                  <AppIcon name="plus" :size="14" />Add option
                </button>
              </div>
              <div
                v-for="(option, index) in options"
                :key="option.id || 'new-' + index"
                role="group"
                :aria-label="'Option ' + (index + 1)"
                class="property-option"
              >
                <input
                  v-model="option.label"
                  aria-label="Option name"
                  maxlength="80"
                  required
                  placeholder="Option name"
                />
                <select v-model="option.color" aria-label="Option color">
                  <option
                    v-for="color in [
                      'neutral',
                      'violet',
                      'green',
                      'blue',
                      'amber',
                    ]"
                    :key="color"
                    :value="color"
                  >
                    {{ color }}
                  </option>
                </select>
                <div class="option-actions">
                  <button
                    type="button"
                    class="icon-button"
                    aria-label="Move option up"
                    :disabled="index === 0"
                    @click="move(index, -1)"
                  >
                    <AppIcon name="chevronUp" :size="14" /></button
                  ><button
                    type="button"
                    class="icon-button"
                    aria-label="Move option down"
                    :disabled="index === options.length - 1"
                    @click="move(index, 1)"
                  >
                    <AppIcon name="chevronDown" :size="14" /></button
                  ><button
                    type="button"
                    class="icon-button"
                    aria-label="Remove option"
                    @click="options.splice(index, 1)"
                  >
                    <AppIcon name="x" :size="14" />
                  </button>
                </div>
              </div>
              <p v-if="!options.length" class="hint">
                No options. Add one to start choosing values.
              </p>
              <label v-if="removed.length" class="option-removal"
                ><input
                  v-model="confirmRemoval"
                  type="checkbox"
                  required
                />Remove these options and filters that use them. Saved record
                values remain available if the options are restored.</label
              >
              <details v-if="activeOptions.length" class="deleted-options">
                <summary>Deleted options ({{ activeOptions.length }})</summary>
                <div v-for="option in activeOptions" :key="option.id">
                  <span>{{ option.label }}</span><button
                    type="button"
                    class="ghost"
                    :disabled="options.length >= 50"
                    :aria-label="'Restore option ' + option.label"
                    @click="options.push({ ...option })"
                  >
                    <AppIcon name="history" :size="14" />Restore
                  </button>
                </div>
              </details>
            </template>
            <button
              v-if="selected.type === 'Formula'"
              class="ghost"
              type="button"
              :disabled="dirty"
              @click="
                visible = false;
                emit('formula', selected);
              "
            >
              Edit formula
            </button>
            <button
              v-if="selected.type === 'Rollup'"
              class="ghost"
              type="button"
              :disabled="dirty"
              @click="
                visible = false;
                emit('rollup', selected);
              "
            >
              Edit rollup
            </button>
            <div class="property-save-actions">
              <button
                class="primary"
                type="submit"
                :disabled="!dirty || conflict"
              >
                Save property</button
              ><button
                v-if="dirty || conflict"
                type="button"
                class="ghost"
                @click="reset"
              >
                {{ conflict ? "Use saved property" : "Discard changes" }}
              </button>
            </div>
            <div v-if="selected.type !== 'Title'" class="property-danger-zone">
              <button
                type="button"
                class="ghost danger"
                :disabled="dirty"
                @click="deleting = true"
              >
                <AppIcon name="trash" :size="14" />Delete property
              </button>
            </div>
          </fieldset>
        </form>
        <section v-else-if="selectedDeleted" class="deleted-property">
          <AppIcon name="trash" :size="28" />
          <h3>{{ selectedDeleted.name }}</h3>
          <p>
            Restore this property with its original type and saved record
            values. Existing views keep their current settings.
          </p>
          <button
            type="button"
            class="primary"
            :disabled="saving || loading"
            @click="restore"
          >
            <AppIcon name="history" :size="15" />Restore property
          </button>
        </section>
      </div>
    </div>
    <UiDialog
      :open="deleting"
      title="Delete property"
      :error="error"
      @close="!saving && (deleting = false)"
      ><p>
        Delete <strong>{{ selected?.name }}</strong> from this database?
      </p>
      <p class="hint">
        Saved record values are kept for restoration. Filters, sorting and view
        references to this property will be removed. Boards or calendars that
        require it become table views. Restoring the property will keep those
        view settings.
      </p>
      <p v-if="selected?.config.reciprocalPropertyId" class="hint">
        Deleting this property disconnects the two-way relation. The matching
        property keeps its values as an independent one-way relation. Restoring
        this property does not reconnect the pair.
      </p>
      <div class="actions">
        <button
          class="ghost"
          type="button"
          :disabled="saving"
          @click="deleting = false"
        >
          Cancel</button
        ><button
          class="danger"
          type="button"
          :disabled="saving"
          @click="remove"
        >
          Delete property
        </button>
      </div></UiDialog
    >
  </UiDialog>
  <DatabasePropertyConversion
    ref="conversion"
    :database-id="databaseId"
    :before-change="beforeChange"
    @changed="emit('changed')"
    @closed="conversionClosed"
  />
</template>
<style scoped>
.property-manager-layout {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  gap: 28px;
  min-height: 360px;
}
.property-navigation {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-right: 1px solid var(--line);
  padding-right: 16px;
}
.property-navigation > span {
  color: var(--faint);
  font-size: 12px;
  padding: 8px;
}
.property-navigation > span:not(:first-child) {
  margin-top: 16px;
}
.property-navigation > button {
  justify-content: flex-start;
  text-align: left;
  border: 0;
  background: transparent;
  font-size: 13px;
  padding: 7px 8px;
}
.property-navigation > button > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.property-navigation > button:hover,
.property-navigation > button[aria-current] {
  background: var(--surface-hover);
}
.property-navigation .add-property-action {
  color: var(--muted);
  margin-top: 6px;
}
.property-details {
  min-width: 0;
  padding-top: 8px;
}
.property-details fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.property-details label {
  display: block;
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 8px;
}
.property-details input,
.property-details select {
  font-size: 14px;
}
.property-type {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  color: var(--muted);
  margin: 12px 0 28px;
}
.options-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.options-heading h3 {
  margin: 0;
  font-size: 14px;
}
.options-heading button {
  font-size: 12px;
  min-height: 28px;
}
.property-option {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 90px auto;
  gap: 8px;
  margin-block: 7px;
}
.property-option input,
.property-option select {
  margin: 0;
  min-width: 0;
}
.option-actions {
  display: flex;
  gap: 0;
  align-items: center;
}
.option-actions .icon-button {
  width: 26px;
}
.property-details .option-removal {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  line-height: 1.6;
  margin-top: 16px;
}
.option-removal input {
  width: 14px;
  flex-shrink: 0;
  margin-top: 4px;
}
.deleted-options {
  border-top: 1px solid var(--line);
  margin-top: 20px;
  padding-top: 14px;
  font-size: 13px;
  color: var(--muted);
}
.deleted-options summary {
  cursor: pointer;
}
.deleted-options > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-block: 5px;
}
.deleted-options button {
  font-size: 12px;
}
.property-save-actions {
  display: flex;
  gap: 8px;
  margin-top: 24px;
  flex-wrap: wrap;
}
.property-save-actions button {
  font-size: 13px;
}
.property-danger-zone {
  border-top: 1px solid var(--line);
  margin-top: 24px;
  padding-top: 14px;
}
.property-danger-zone button {
  font-size: 13px;
}
.property-error {
  color: var(--warning);
  padding: 10px 12px;
  background: var(--surface);
  border-radius: 5px;
  font-size: 13px;
}
.deleted-property {
  padding: 20px 0;
}
.deleted-property > .app-icon {
  color: var(--muted);
}
.deleted-property h3 {
  margin-top: 20px;
}
.deleted-property p {
  color: var(--muted);
  line-height: 1.6;
  font-size: 14px;
}
@media (max-width: 600px) {
  .property-manager-layout {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  .property-navigation {
    max-height: 160px;
    overflow-y: auto;
    border-right: 0;
    border-bottom: 1px solid var(--line);
    padding: 0 0 12px;
  }
  .property-option {
    grid-template-columns: minmax(0, 1fr) 90px auto;
    gap: 4px;
  }
}
</style>

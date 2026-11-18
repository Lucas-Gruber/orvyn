<script setup lang="ts">
import {
  writablePropertyTypes,
  type DatabaseRecord,
  type Property,
} from "@orvyn/shared";
import { propertyIcon, formatDatabaseValue } from "../utils/databaseFields";
const props = defineProps<{
    databaseId: string;
    recordId: string;
    editable: boolean;
  }>(),
  emit = defineEmits<{
    snapshot: [record: DatabaseRecord];
    denied: [id: string];
    changed: [];
    manage: [];
    templateAccess: [canEdit: boolean];
    database: [value: { id: string; title: string }];
  }>(),
  record = ref<DatabaseRecord>(),
  properties = ref<Property[]>([]),
  people = ref<any[]>([]),
  dirty = reactive<Record<string, unknown>>({}),
  baseline = new Map<string, unknown>(),
  error = ref(""),
  loading = ref(false),
  saving = ref(false),
  denied = ref(false);
let disposed = false,
  pollTimer: ReturnType<typeof setInterval> | undefined,
  generation = 0,
  job: Promise<void> | undefined;
const displayed = computed(() =>
    record.value
      ? { ...record.value, values: { ...record.value.values, ...dirty } }
      : undefined,
  ),
  fields = computed(() => properties.value.filter((p) => p.type !== "Title"));
async function fetchRecord() {
  return $fetch<any>(
    `/api/v1/databases/${props.databaseId}/records/${props.recordId}`,
  );
}
async function load() {
  if (saving.value || disposed) return;
  const token = ++generation;
  loading.value = true;
  try {
    const data = await fetchRecord();
    if (disposed || token !== generation) return;
    record.value = data.record;
    properties.value = data.properties;
    denied.value = false;
    emit("snapshot", data.record);
    emit("database", data.database);
    emit(
      "templateAccess",
      data.database.accessRank >= 30 && data.record.accessRank >= 30,
    );
    events.watchRecords([props.recordId], {
      relationProperties: data.relationProperties,
      fingerprint: data.fingerprint,
      requiresPolling: data.requiresPolling,
    });
    const directory = await $fetch<any[]>(
      `/api/v1/spaces/${data.database.spaceId}/directory`,
    );
    if (disposed || token !== generation) return;
    people.value = directory;
    if (!Object.keys(dirty).length) error.value = "";
  } catch (e: any) {
    if (disposed || token !== generation) return;
    if ([401, 404].includes(e.status)) {
      denied.value = true;
      record.value = undefined;
      properties.value = [];
      emit("denied", props.recordId);
    }
    error.value = e.data?.message || "Properties could not be loaded.";
  } finally {
    if (token === generation) loading.value = false;
  }
}
const events = useDatabaseEvents(props.databaseId, () => {
  if (!saving.value) void load();
});
function edit(p: Property, value: unknown) {
  if (!record.value || !props.editable) return;
  if (!Object.hasOwn(dirty, p.id))
    baseline.set(p.id, record.value.values[p.id]);
  dirty[p.id] = value;
  error.value = "";
  void drain();
}
async function drain() {
  if (job) return job;
  job = (async () => {
    saving.value = true;
    let retries = 0;
    try {
      while (!disposed && Object.keys(dirty).length && record.value) {
        const values = { ...dirty },
          version = record.value.version;
        let updated: DatabaseRecord;
        try {
          updated = await $fetch<DatabaseRecord>(
            `/api/v1/databases/${props.databaseId}/records/${props.recordId}`,
            { method: "PATCH", body: { version, values } },
          );
        } catch (e: any) {
          if (e.status === 409 && retries++ < 2) {
            const latest = await fetchRecord();
            if (
              Object.keys(values).every(
                (id) =>
                  JSON.stringify(latest.record.values[id]) ===
                  JSON.stringify(baseline.get(id)),
              )
            ) {
              record.value = latest.record;
              continue;
            }
          }
          throw e;
        }
        if (disposed) return;
        record.value = updated;
        retries = 0;
        for (const [id, value] of Object.entries(values)) {
          if (JSON.stringify(dirty[id]) === JSON.stringify(value)) {
            delete dirty[id];
            baseline.delete(id);
          } else baseline.set(id, updated.values[id]);
        }
        emit("snapshot", updated);
        emit("changed");
      }
    } catch (e: any) {
      if ([401, 404].includes(e.status)) {
        denied.value = true;
        record.value = undefined;
        emit("denied", props.recordId);
      }
      error.value =
        e.status === 409
          ? "This record changed elsewhere. Review your draft before saving it again."
          : e.data?.message ||
            "Properties could not be saved. Your draft is still here.";
    } finally {
      saving.value = false;
      job = undefined;
    }
  })();
  return job;
}
async function retry() {
  try {
    const latest = await fetchRecord();
    record.value = latest.record;
    for (const id of Object.keys(dirty))
      baseline.set(id, latest.record.values[id]);
    error.value = "";
    await drain();
  } catch (e: any) {
    error.value =
      e.data?.message ||
      "Properties could not be saved. Your draft is still here.";
  }
}
async function discard() {
  for (const id of Object.keys(dirty)) delete dirty[id];
  baseline.clear();
  error.value = "";
  await load();
}
async function flush() {
  if (denied.value) return;
  await job;
  if (Object.keys(dirty).length)
    throw new Error(
      error.value || "Some property changes have not been saved.",
    );
}
usePendingWrites(flush);
function beforeUnload(event: BeforeUnloadEvent) {
  if (job || Object.keys(dirty).length) {
    event.preventDefault();
    event.returnValue = "";
  }
}
onMounted(() => {
  void load();
  window.addEventListener("beforeunload", beforeUnload);
  pollTimer = setInterval(() => {
    if (events.polling.value && !saving.value && !loading.value && !disposed)
      void load();
  }, 5000);
});
onBeforeUnmount(() => {
  clearInterval(pollTimer);
  disposed = true;
  generation++;
  window.removeEventListener("beforeunload", beforeUnload);
});
defineExpose({ flush, reload: load });
</script>
<template>
  <section
    class="record-properties"
    aria-label="Record properties"
    :aria-busy="loading || saving"
  >
    <h2 class="sr-only">Properties</h2>
    <small v-if="saving" role="status" class="property-save-status"
      >Saving properties…</small
    >
    <div v-if="error" class="property-save-error" role="alert">
      <p>{{ error }}</p>
      <div v-if="!denied && Object.keys(dirty).length" class="actions">
        <button :disabled="saving" @click="retry">Save my draft</button
        ><button class="ghost" :disabled="saving" @click="discard">
          Discard draft
        </button>
      </div>
    </div>
    <p v-if="loading && !record" class="hint">Loading properties…</p>
    <div
      v-for="property in fields"
      :key="property.id"
      class="record-property-row"
      :data-dirty="Object.hasOwn(dirty, property.id) || undefined"
    >
      <span class="record-property-label"
        ><AppIcon :name="propertyIcon(property)" :size="15" />{{
          property.name
        }}</span
      >
      <div v-if="displayed" class="record-property-value">
        <DatabaseRelationField
          v-if="property.type === 'Relation'"
          :property="property"
          :database-id="databaseId"
          :model-value="displayed.values[property.id]"
          :records="record?.relations || []"
          :can-edit="editable && (record?.accessRank || 0) >= 30"
          @update:model-value="edit(property, $event)"
        />
        <DatabaseFilesField
          v-else-if="property.type === 'Files'"
          :name="property.name"
          :files="record?.files || []"
          :model-value="displayed.values[property.id]"
          :can-edit="editable && (record?.accessRank || 0) >= 30"
          @update:model-value="edit(property, $event)"
          @manage="emit('manage')"
        />
        <DatabaseFieldInput
          v-else-if="
            editable &&
            (record?.accessRank || 0) >= 30 &&
            (writablePropertyTypes as readonly string[]).includes(property.type)
          "
          :database-id="databaseId"
          empty-label="Empty"
          :property="property"
          :model-value="displayed.values[property.id]"
          :people="people"
          @update:model-value="edit(property, $event)"
        />
        <span v-else class="record-property-readonly">{{
          formatDatabaseValue(displayed, property, people) || "Empty"
        }}</span>
      </div>
    </div>
  </section>
</template>
<style scoped>
.record-properties {
  position: relative;
  padding-block: 0 22px;
  margin-bottom: 24px;
  border-bottom: 1px solid var(--line);
}
.property-save-status {
  position: absolute;
  right: 0;
  bottom: 3px;
  color: var(--muted);
  font-size: 11px;
}
.record-property-row {
  display: grid;
  grid-template-columns: minmax(110px, 160px) minmax(0, 1fr);
  align-items: start;
  gap: 12px;
  min-height: 36px;
  padding: 1px 0;
}
.record-property-label {
  display: flex;
  gap: 9px;
  align-items: center;
  color: var(--muted);
  font-size: 14px;
  padding-top: 8px;
  overflow-wrap: anywhere;
}
.record-property-label .app-icon {
  flex-shrink: 0;
  color: var(--faint);
}
.record-property-value {
  min-width: 0;
  border-radius: 5px;
}
.record-property-row[data-dirty] .record-property-value {
  box-shadow: inset 2px 0 var(--accent);
}
.record-property-value :deep(input),
.record-property-value :deep(select) {
  background: transparent;
  border: 1px solid transparent;
  padding: 6px 8px;
  min-height: 32px;
  font-size: 14px;
}
.record-property-value :deep(input:hover),
.record-property-value :deep(select:hover) {
  background: var(--surface-hover);
}
.record-property-value :deep(input:focus),
.record-property-value :deep(select:focus) {
  border-color: var(--accent);
}
.record-property-readonly {
  display: block;
  padding: 8px;
  color: var(--muted);
  font-size: 14px;
}
.property-save-error {
  padding: 10px 12px;
  margin-bottom: 12px;
  border-radius: 6px;
  background: var(--surface);
  font-size: 0.8rem;
  color: var(--danger);
}
@media (max-width: 520px) {
  .record-property-row {
    grid-template-columns: 100px minmax(0, 1fr);
    gap: 8px;
  }
}
</style>

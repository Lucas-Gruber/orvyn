<script setup lang="ts">
import {
  convertiblePropertyTypes,
  type ConvertiblePropertyType,
  type Property,
} from "@orvyn/shared";
import { pageLink } from "@orvyn/editor/links";
import { propertyIcon } from "../utils/databaseFields";
const props = defineProps<{
  databaseId: string;
  beforeChange: (allowDrafts?: boolean) => Promise<void>;
}>();
const emit = defineEmits<{ changed: []; closed: [] }>();
const visible = ref(false),
  loading = ref(false),
  reviewing = ref(false),
  saving = ref(false);
const property = ref<Property>(),
  propertyId = ref("");
const toType = ref<ConvertiblePropertyType | "">("");
const history = ref<any[]>([]),
  restoreId = ref<string | null>(null),
  preview = ref<any>();
const acceptEmpty = ref(false),
  error = ref(""),
  notice = ref("");
const id = useId();
let generation = 0,
  disposed = false,
  requestId = "";
const busy = computed(() => loading.value || reviewing.value || saving.value);
const ready = computed(
  () => !!preview.value && (!preview.value.clearedValues || acceptEmpty.value),
);
async function api(path: string, method = "GET", body?: unknown) {
  return $fetch<any>(`/api/v1/databases/${props.databaseId}${path}`, {
    method: method as any,
    body: body as any,
  });
}
function unavailable(e: any) {
  if (![401, 404].includes(e.statusCode || e.status)) return;
  property.value = undefined;
  history.value = [];
  preview.value = undefined;
}
async function load() {
  const token = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const [meta, changes] = await Promise.all([
      api(""),
      api(`/properties/${propertyId.value}/type-history`),
    ]);
    if (disposed || token !== generation || !visible.value) return;
    const field = meta.properties.find(
      (candidate: Property) => candidate.id === propertyId.value,
    );
    if (!field || meta.accessRank < 50)
      throw {
        statusCode: 404,
        data: { message: "This field is unavailable." },
      };
    property.value = field;
    history.value = changes;
  } catch (e: any) {
    if (token === generation && !disposed) {
      unavailable(e);
      error.value = e.data?.message || "Field details could not be loaded.";
    }
  } finally {
    if (token === generation) loading.value = false;
  }
}
async function open(fieldId: string) {
  await props.beforeChange();
  propertyId.value = fieldId;
  property.value = undefined;
  history.value = [];
  preview.value = undefined;
  toType.value = "";
  restoreId.value = null;
  acceptEmpty.value = false;
  error.value = "";
  notice.value = "";
  requestId = "";
  visible.value = true;
  reviewing.value = false;
  await load();
}
function close() {
  if (saving.value) return;
  generation++;
  visible.value = false;
  loading.value = false;
  reviewing.value = false;
  property.value = undefined;
  history.value = [];
  preview.value = undefined;
  emit("closed");
}
function choose(event: Event) {
  toType.value = (event.target as HTMLSelectElement)
    .value as ConvertiblePropertyType;
  restoreId.value = null;
  preview.value = undefined;
  acceptEmpty.value = false;
  error.value = "";
  notice.value = "";
  requestId = "";
}
async function review(change?: any) {
  if (busy.value || !property.value) return;
  if (change) {
    restoreId.value = change.id;
    toType.value = change.fromType;
  }
  if (!toType.value) return;
  const token = ++generation;
  reviewing.value = true;
  error.value = "";
  notice.value = "";
  preview.value = undefined;
  acceptEmpty.value = false;
  try {
    await props.beforeChange();
    const data = await api(
      `/properties/${propertyId.value}/conversion-preview`,
      "POST",
      restoreId.value
        ? { historyId: restoreId.value }
        : { toType: toType.value },
    );
    if (!disposed && visible.value && token === generation) {
      preview.value = data;
      requestId = crypto.randomUUID();
    }
  } catch (e: any) {
    if (!disposed && token === generation) {
      unavailable(e);
      error.value =
        e.data?.message || e.message || "The conversion could not be reviewed.";
    }
  } finally {
    if (token === generation) reviewing.value = false;
  }
}
async function apply() {
  if (!ready.value || busy.value) return;
  saving.value = true;
  error.value = "";
  let applied = false;
  try {
    await props.beforeChange();
    await api(`/properties/${propertyId.value}/convert`, "POST", {
      previewToken: preview.value.previewToken,
      requestId,
      confirm: true,
      acceptEmpty: acceptEmpty.value,
    });
    applied = true;
    if (property.value)
      property.value = {
        ...property.value,
        type: preview.value.toType,
        config: {},
      };
    preview.value = undefined;
    toType.value = "";
    restoreId.value = null;
    requestId = "";
    emit("changed");
    notice.value = "Field type changed. Original values were kept.";
    await load();
  } catch (e: any) {
    unavailable(e);
    if ((e.statusCode || e.status) === 409) {
      preview.value = undefined;
      requestId = "";
    }
    error.value = applied
      ? "The change was saved. Reload to see the current field details."
      : e.data?.message ||
        e.message ||
        "The change could not be confirmed. Try again.";
  } finally {
    saving.value = false;
  }
}
function submit() {
  if (preview.value) void apply();
  else void review();
}
function another() {
  if (busy.value) return;
  restoreId.value = null;
  toType.value = "";
  preview.value = undefined;
  acceptEmpty.value = false;
  error.value = "";
  notice.value = "";
}
onBeforeUnmount(() => {
  disposed = true;
  generation++;
});
defineExpose({ open });
</script>
<template>
  <UiDialog
    :open="visible"
    title="Change field type"
    wide
    class="property-conversion"
    @close="close"
  >
    <p v-if="loading || reviewing" role="status" class="conversion-status">
      {{ reviewing ? "Reviewing current values…" : "Loading field…" }}
    </p>
    <p v-if="error" role="alert" class="conversion-error">{{ error }}</p>
    <p v-if="notice" role="status" class="conversion-notice">
      <AppIcon name="check" :size="16" />{{ notice }}
    </p>
    <button
      v-if="error"
      type="button"
      class="ghost"
      :disabled="busy"
      @click="load"
    >
      <AppIcon name="refresh" :size="14" />Reload field
    </button>
    <form v-if="property" class="conversion-form" @submit.prevent="submit">
      <div class="conversion-field">
        <AppIcon :name="propertyIcon(property)" :size="18" /><strong>{{
          property.name
        }}</strong
        ><span>{{ property.type }}</span>
      </div>
      <p class="conversion-help">
        Changes apply to every record in this database, including archived
        records. Original values stay available in type history.
      </p>
      <template v-if="!restoreId">
        <label :for="id + '-type'">New field type</label>
        <select
          :id="id + '-type'"
          :value="toType"
          required
          :disabled="busy"
          @change="choose"
        >
          <option value="" disabled>Choose a type</option>
          <option
            v-for="type in convertiblePropertyTypes.filter(
              (type) => type !== property?.type,
            )"
            :key="type"
            :value="type"
          >
            {{ type }}
          </option>
        </select>
      </template>
      <div v-else class="conversion-restore">
        <AppIcon name="history" :size="18" />
        <div>
          <strong>Restore previous type: {{ toType }}</strong>
          <p>
            Unchanged values are restored exactly. Newer edits and new records
            are converted from their current values.
          </p>
        </div>
        <button type="button" class="ghost" :disabled="busy" @click="another">
          Choose another type
        </button>
      </div>
      <template v-if="preview">
        <div class="conversion-summary" aria-label="Conversion summary">
          <div>
            <strong>{{ preview.totalRecords }}</strong><span>Records</span>
          </div>
          <div>
            <strong>{{ preview.changedValues }}</strong><span
              >Values to change</span
            >
          </div>
          <div :class="{ warning: preview.clearedValues }">
            <strong>{{ preview.clearedValues }}</strong><span
              >Will become empty</span
            >
          </div>
        </div>
        <p v-if="preview.archivedRecords" class="conversion-help">
          Includes {{ preview.archivedRecords }} archived
          {{ preview.archivedRecords === 1 ? "record" : "records" }}.
        </p>
        <div v-if="preview.affectedViews.length" class="conversion-adjustments">
          <AppIcon name="info" :size="16" />
          <div>
            <strong>View adjustments</strong>
            <p>
              Filters and sorting for this field will be removed. Calendars
              using it switch to a table. Column widths adjust if needed.
            </p>
            <p>
              {{
                preview.affectedViews.map((view: any) => view.name).join(" · ")
              }}
            </p>
          </div>
        </div>
        <div class="conversion-samples">
          <table>
            <caption>
              Preview ·
              {{
                preview.property.type
              }}
              →
              {{
                preview.toType
              }}<span v-if="preview.totalRecords > preview.samples.length">
                · first {{ preview.samples.length }} examples</span
              >
            </caption>
            <thead>
              <tr>
                <th>Record</th>
                <th>Current value</th>
                <th>New value</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="sample in preview.samples" :key="sample.id">
                <th>
                  <span v-if="sample.archived"
                    >{{ sample.title }}<small>Archived</small></span
                  ><a
                    v-else
                    :href="pageLink(sample.id)"
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open record in a new tab"
                    >{{ sample.title }}</a
                  >
                </th>
                <td>
                  <span v-if="sample.before !== null">{{
                    sample.before
                  }}</span><span v-else class="conversion-empty">Empty</span>
                </td>
                <td>
                  <span v-if="sample.after !== null">{{
                    sample.after
                  }}</span><span v-else class="conversion-empty">Empty</span
                  ><small v-if="restoreId && sample.restored"
                    >From original</small
                  >
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <label v-if="preview.clearedValues" class="conversion-confirm"
          ><input
            v-model="acceptEmpty"
            type="checkbox"
            required
            :disabled="busy"
          />I understand that {{ preview.clearedValues }} incompatible
          {{ preview.clearedValues === 1 ? "value will" : "values will" }}
          become empty.</label
        >
      </template>
      <div class="conversion-actions">
        <button type="button" class="ghost" :disabled="saving" @click="close">
          Cancel
        </button>
        <button
          v-if="preview"
          type="button"
          class="ghost"
          :disabled="busy"
          @click="review()"
        >
          Review again
        </button>
        <button
          class="primary"
          type="submit"
          :disabled="busy || (!preview && !toType) || (!!preview && !ready)"
        >
          {{
            saving
              ? "Saving…"
              : preview
                ? "Apply type change"
                : "Review conversion"
          }}
        </button>
      </div>
    </form>
    <details v-if="property && history.length" class="conversion-history">
      <summary>
        <AppIcon name="history" :size="15" />Recent type changes<AppIcon
          name="chevronDown"
          :size="14"
          class="history-chevron"
        />
      </summary>
      <ol>
        <li v-for="change in history" :key="change.id">
          <div>
            <strong
              >{{ change.fromType }} <span aria-hidden="true">→</span>
              {{ change.toType }}</strong
            ><small>{{ new Date(change.createdAt).toLocaleString() }}</small>
          </div>
          <button
            v-if="change.canReviewRestore"
            type="button"
            class="ghost"
            :disabled="busy"
            @click="review(change)"
          >
            Review restore
          </button>
        </li>
      </ol>
    </details>
  </UiDialog>
</template>
<style scoped>
.conversion-form {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.conversion-field {
  display: flex;
  align-items: center;
  gap: 9px;
}
.conversion-field > span {
  margin-left: auto;
  color: var(--muted);
  font-size: 13px;
}
.conversion-help,
.conversion-status {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.65;
  margin: 0;
}
.conversion-form label {
  margin: 0;
}
.conversion-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 18px 0;
  border-block: 1px solid var(--line);
}
.conversion-summary > div {
  display: grid;
  gap: 4px;
}
.conversion-summary strong {
  font-size: 24px;
}
.conversion-summary span {
  font-size: 12px;
  color: var(--muted);
}
.conversion-summary .warning strong {
  color: var(--warning);
}
.conversion-adjustments,
.conversion-restore {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 7px;
}
.conversion-adjustments > .app-icon,
.conversion-restore > .app-icon {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--muted);
}
.conversion-adjustments p,
.conversion-restore p {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted);
}
.conversion-adjustments strong,
.conversion-restore strong {
  font-size: 13px;
}
.conversion-restore {
  flex-wrap: wrap;
}
.conversion-restore > div {
  flex: 1;
  min-width: 160px;
}
.conversion-samples {
  overflow: auto;
  max-height: 300px;
  border: 1px solid var(--line);
  border-radius: 7px;
}
.conversion-samples table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 12px;
}
.conversion-samples caption {
  text-align: left;
  padding: 11px 12px;
  font-weight: 500;
  color: var(--muted);
}
.conversion-samples th,
.conversion-samples td {
  border-top: 1px solid var(--line);
  padding: 10px 12px;
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}
.conversion-samples thead {
  color: var(--muted);
  background: var(--surface);
}
.conversion-samples tbody th {
  font-weight: 500;
}
.conversion-samples a {
  color: inherit;
  text-decoration: none;
}
.conversion-samples a:hover {
  text-decoration: underline;
}
.conversion-samples small {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 10px;
}
.conversion-empty {
  color: var(--faint);
}
.conversion-confirm {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  font-size: 13px;
  line-height: 1.6;
}
.conversion-confirm input {
  flex: 0 0 auto;
  width: auto;
  margin-top: 4px;
}
.conversion-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding-top: 6px;
  flex-wrap: wrap;
}
.conversion-history {
  border-top: 1px solid var(--line);
  padding-top: 14px;
  margin-top: 18px;
}
.conversion-history summary {
  display: flex;
  gap: 8px;
  align-items: center;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
}
.history-chevron {
  margin-left: auto;
}
.conversion-history[open] .history-chevron {
  transform: rotate(180deg);
}
.conversion-history ol {
  padding: 0;
  margin: 12px 0 0;
  list-style: none;
}
.conversion-history li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-top: 1px solid var(--line-soft);
}
.conversion-history strong {
  font-size: 12px;
  font-weight: 500;
}
.conversion-history small {
  display: block;
  color: var(--muted);
  font-size: 11px;
  margin-top: 3px;
}
.conversion-error {
  color: var(--warning);
  font-size: 13px;
}
.conversion-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--muted);
}
@media (max-width: 600px) {
  .conversion-summary {
    gap: 8px;
  }
  .conversion-summary strong {
    font-size: 21px;
  }
  .conversion-summary span {
    font-size: 11px;
  }
  .conversion-samples th,
  .conversion-samples td {
    padding: 8px;
  }
}
</style>

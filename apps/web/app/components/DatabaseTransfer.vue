<script setup lang="ts">
import { writablePropertyTypes, type Property } from "@orvyn/shared";
const props = defineProps<{
    databaseId: string;
    viewId: string;
    properties: Property[];
    canEdit: boolean;
    hideTrigger?: boolean;
  }>(),
  emit = defineEmits<{ imported: [] }>();
const domId = useId(),
  opened = ref(false),
  file = ref<File>(),
  fileInput = ref<HTMLInputElement>(),
  preview = ref<any>(),
  mapping = ref<any[]>([]),
  allowNewOptions = ref(true),
  dirty = ref(false),
  busy = ref(false),
  error = ref(""),
  notice = ref("");
const exportBase = computed(() => "/api/v1/databases/" + props.databaseId);
function choose(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0];
  preview.value = undefined;
  mapping.value = [];
  error.value = "";
  notice.value = "";
  dirty.value = true;
}
function target(item: any) {
  return item.skip ? "skip" : item.propertyId || "new";
}
function mapTarget(item: any, value: string) {
  delete item.propertyId;
  delete item.name;
  delete item.type;
  item.skip = value === "skip";
  if (value === "new") {
    item.name = preview.value.headers[item.column];
    item.type = "Text";
  } else if (value !== "skip") item.propertyId = value;
  dirty.value = true;
}
async function upload(confirm = false) {
  if (!file.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const body = new FormData();
    body.append("file", file.value);
    body.append(
      "settings",
      JSON.stringify(
        confirm
          ? { token: preview.value.token }
          : {
              ...(mapping.value.length ? { mapping: mapping.value } : {}),
              allowNewOptions: allowNewOptions.value,
            },
      ),
    );
    const result = await $fetch<any>(
      exportBase.value + "/import/csv/" + (confirm ? "confirm" : "preview"),
      { method: "POST", body },
    );
    if (confirm) {
      notice.value = `Imported ${result.createdRecords} records and ${result.createdProperties} properties.`;
      preview.value = undefined;
      mapping.value = [];
      file.value = undefined;
      if (fileInput.value) fileInput.value.value = "";
      emit("imported");
    } else {
      preview.value = result;
      mapping.value = structuredClone(result.mapping);
      dirty.value = false;
    }
  } catch (e: any) {
    error.value =
      e.data?.message || "Transfer failed. Review your file and try again.";
  } finally {
    busy.value = false;
  }
}
defineExpose({ open: () => (opened.value = true) });
</script>
<template>
  <section class="database-transfer">
    <button v-if="!hideTrigger" @click="opened = !opened">
      Import / export
    </button>
    <UiDialog
      :open="opened"
      title="Import / export database"
      wide
      @close="opened = false"
    >
      <p>
        Exports include records you can access. Current-view exports use its
        saved filters and columns; the search box and calendar month do not
        limit an export.
      </p>
      <div class="actions">
        <a :href="exportBase + '/export.csv?viewId=' + viewId"
          >Export current view as CSV</a
        ><a :href="exportBase + '/export.json?viewId=' + viewId"
          >Export current view as JSON</a
        ><a :href="exportBase + '/export.csv'"
          >Export all accessible records as CSV</a
        ><a :href="exportBase + '/export.json'"
          >Export all accessible records as JSON</a
        >
      </div>
      <p>
        CSV uses spreadsheet-safe text by default. JSON preserves exact values
        and page notes; attachment metadata is included, attachment files are
        not.
      </p>
      <template v-if="canEdit">
        <h3>Import CSV</h3>
        <p>
          UTF-8, up to 1 MiB, 1,000 records and 50 columns. Import creates new
          records; it does not update existing ones. Preview changes nothing in
          your database.
        </p>
        <label :for="domId + '-csv'">CSV file</label
        ><input
          :id="domId + '-csv'"
          ref="fileInput"
          type="file"
          accept=".csv,text/csv"
          :disabled="busy"
          @change="choose"
        />
        <label
          ><input
            v-model="allowNewOptions"
            type="checkbox"
            :disabled="busy"
            @change="dirty = true"
          />
          Allow new select/status options</label
        >
        <button :disabled="!file || busy" @click="upload()">
          {{ preview ? "Update preview" : "Preview CSV" }}
        </button>
        <template v-if="preview">
          <p>
            {{ preview.totalRows }} records;
            {{ preview.blankRowsSkipped }} blank rows skipped. First
            {{ preview.rows.length }} rows shown.
          </p>
          <div class="table-scroll">
            <table>
              <caption>
                Column mapping
              </caption>
              <thead>
                <tr>
                  <th>CSV column</th>
                  <th>Target property</th>
                  <th>New property</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in mapping" :key="item.column">
                  <th>{{ preview.headers[item.column] }}</th>
                  <td>
                    <select
                      :aria-label="'Map ' + preview.headers[item.column]"
                      :value="target(item)"
                      :disabled="busy"
                      @change="
                        mapTarget(
                          item,
                          ($event.target as HTMLSelectElement).value,
                        )
                      "
                    >
                      <option value="skip">Skip column</option>
                      <option
                        v-for="property in properties.filter(
                          (p) =>
                            p.type !== 'Files' &&
                            (p.type === 'Title' ||
                              (
                                writablePropertyTypes as readonly string[]
                              ).includes(p.type)),
                        )"
                        :key="property.id"
                        :value="property.id"
                      >
                        {{ property.name }} ({{ property.type }})
                      </option>
                      <option value="new">Create property</option>
                    </select>
                  </td>
                  <td v-if="target(item) === 'new'">
                    <input
                      v-model="item.name"
                      :aria-label="
                        'New name for ' + preview.headers[item.column]
                      "
                      maxlength="80"
                      :disabled="busy"
                      @input="dirty = true"
                    /><select
                      v-model="item.type"
                      :aria-label="'Type for ' + preview.headers[item.column]"
                      :disabled="busy"
                      @change="dirty = true"
                    >
                      <option
                        v-for="type in writablePropertyTypes.filter(
                          (t) => t !== 'Files',
                        )"
                        :key="type"
                      >
                        {{ type }}
                      </option>
                    </select>
                  </td>
                  <td v-else>—</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="table-scroll">
            <table>
              <caption>
                File preview
              </caption>
              <thead>
                <tr>
                  <th v-for="(header, index) in preview.headers" :key="index">
                    {{ header }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, index) in preview.rows" :key="index">
                  <td
                    v-for="(cell, col) in row"
                    :key="col"
                    style="white-space: pre-wrap"
                  >
                    {{ cell }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-for="property in preview.newProperties" :key="property.id">
            New property: {{ property.name }} ({{ property.type }})
          </p>
          <p
            v-for="addition in preview.optionAdditions"
            :key="addition.propertyId"
          >
            New options for {{ addition.propertyName }}:
            {{ addition.labels.join(", ") }}
          </p>
          <p v-for="(issue, index) in preview.errors" :key="index" role="alert">
            {{ issue.row ? "Row " + issue.row + ": " : "" }}{{ issue.column }} —
            {{ issue.message }}
          </p>
          <p v-if="dirty">
            Mapping changed. Update the preview before importing.
          </p>
          <button
            :disabled="dirty || !preview.canImport || busy"
            @click="upload(true)"
          >
            Confirm import of {{ preview.totalRows }} records
          </button>
        </template>
      </template>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
    </UiDialog>
  </section>
</template>

<script setup lang="ts">
import {
  writablePropertyTypes,
  computedPropertyTypes,
  viewTypes,
  type Property,
  type DatabaseRecord,
  type ViewConfig,
} from "@orvyn/shared";
const props = defineProps<{ databaseId: string }>(),
  emit = defineEmits<{ open: [pageId: string]; changed: [] }>();
const directory = ref<any[]>([]),
  restrictedRecord = ref(false),
  showPermissions = ref(false);
const metadata = ref<any>(),
  records = ref<DatabaseRecord[]>([]),
  columns = ref<Property[]>([]),
  viewId = ref(""),
  offset = ref(0),
  nextOffset = ref<number | null>(null),
  search = ref(""),
  error = ref(""),
  notice = ref(""),
  busy = ref(false),
  loading = ref(false),
  showCreate = ref(false),
  showSettings = ref(false),
  newView = ref(false);
const title = ref(""),
  draft = reactive<Record<string, unknown>>({}),
  propertyName = ref(""),
  propertyType = ref<string>("Text"),
  optionNames = ref("");
const month = ref(new Date().toISOString().slice(0, 7)),
  viewDraft = ref<any>();
let generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  interval: ReturnType<typeof setInterval> | undefined,
  disposed = false;
const currentView = computed(() =>
    metadata.value?.views.find((v: any) => v.id === viewId.value),
  ),
  canEdit = computed(() => metadata.value?.accessRank >= 30);
const editableProperties = computed<Property[]>(
  () =>
    metadata.value?.properties.filter((p: Property) =>
      (writablePropertyTypes as readonly string[]).includes(p.type),
    ) || [],
);
const groupProperty = computed<Property | undefined>(() =>
  metadata.value?.properties.find(
    (p: Property) => p.id === currentView.value?.config.groupBy,
  ),
);
const calendarCells = computed(() => {
  const [year, m] = month.value.split("-").map(Number);
  if (!year || !m) return [];
  const first = new Date(Date.UTC(year, m - 1, 1)),
    shift = (first.getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(Date.UTC(year, m - 1, 1 - shift + i)),
      iso = date.toISOString().slice(0, 10);
    return {
      iso,
      day: date.getUTCDate(),
      outside: date.getUTCMonth() !== m - 1,
    };
  });
});
const monthLabel = computed(() => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(month.value + "-01T00:00:00Z"));
  } catch {
    return "Choose a month";
  }
});
const boardGroups = computed(() =>
  [
    { id: null, label: "Unassigned" },
    ...(groupProperty.value?.config.options || []),
  ].map((option) => ({
    ...option,
    records: records.value.filter(
      (record) =>
        (record.values[groupProperty.value!.id] ?? null) === option.id,
    ),
  })),
);
const recordGroups = computed(() =>
  groupProperty.value
    ? boardGroups.value
    : [{ id: "all", label: "", records: records.value }],
);
async function api(path: string, method = "GET", body?: unknown) {
  return $fetch<any>("/api/v1/databases/" + props.databaseId + path, {
    method: method as any,
    body: body as any,
  });
}
async function load() {
  const request = ++generation;
  loading.value = true;
  try {
    const meta = await api("");
    if (disposed || request !== generation) return;
    metadata.value = meta;
    if (!meta.views.some((v: any) => v.id === viewId.value))
      viewId.value = meta.views[0]?.id || "";
    const query: any = {
      viewId: viewId.value,
      offset: offset.value,
      limit: 100,
      search: search.value,
    };
    const view = meta.views.find((v: any) => v.id === viewId.value);
    if (view?.type === "Calendar" && calendarCells.value.length) {
      query.rangeStart = calendarCells.value[0]!.iso;
      query.rangeEnd = calendarCells.value.at(-1)!.iso;
    }
    const [result, people] = await Promise.all([
      api("/query", "POST", query),
      $fetch<any[]>("/api/v1/spaces/" + meta.spaceId + "/directory"),
    ]);
    if (disposed || request !== generation) return;
    directory.value = people;
    records.value = result.records;
    columns.value = result.properties;
    nextOffset.value = result.nextOffset;
    events.watchRecords(records.value.map((r) => r.pageId));
  } catch (e: any) {
    if (request === generation) {
      error.value = e.data?.message || "Database could not be loaded";
      if (e.status === 404 || e.status === 401) {
        metadata.value = null;
        records.value = [];
      }
    }
  } finally {
    if (request === generation) loading.value = false;
  }
}
function schedule() {
  if (disposed) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!disposed) void load();
  }, 100);
}
const events = useDatabaseEvents(props.databaseId, schedule);
async function mutate(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  generation++;
  try {
    await fn();
  } catch (e: any) {
    error.value = e.data?.message || "Change could not be saved";
    await load();
  } finally {
    busy.value = false;
  }
}
async function createRecord() {
  await mutate(async () => {
    await api("/records", "POST", {
      title: title.value,
      values: { ...draft },
      visibility: restrictedRecord.value ? "restricted" : "space",
    });
    title.value = "";
    for (const key of Object.keys(draft)) delete draft[key];
    showCreate.value = false;
    restrictedRecord.value = false;
    await load();
    notice.value = "Record created";
  });
}
async function patchRecord(
  record: DatabaseRecord,
  values: Record<string, unknown>,
) {
  const previous = { ...record.values };
  await mutate(async () => {
    Object.assign(record.values, values);
    try {
      const saved = await api("/records/" + record.pageId, "PATCH", {
        version: record.version,
        values,
      });
      Object.assign(record, saved);
    } catch (e) {
      record.values = previous;
      throw e;
    }
  });
}
function drop(event: DragEvent, option: string | null) {
  const id = event.dataTransfer?.getData("text/plain"),
    record = records.value.find((r) => r.pageId === id);
  if (!record || record.accessRank < 30 || !groupProperty.value) return;
  void patchRecord(record, { [groupProperty.value.id]: option });
}
function startDrag(event: DragEvent, record: DatabaseRecord) {
  if (!canEdit.value || record.accessRank < 30 || busy.value) return;
  event.dataTransfer?.setData("text/plain", record.pageId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}
function focusStatus(event: MouseEvent) {
  (event.currentTarget as HTMLElement)
    .closest("article")
    ?.querySelector("select")
    ?.focus();
}
async function chooseView(id: string) {
  viewId.value = id;
  offset.value = 0;
  showSettings.value = false;
  await load();
}
function beginRecord(date?: string) {
  showCreate.value = true;
  if (date && currentView.value.config.dateProperty)
    draft[currentView.value.config.dateProperty] = date;
}
function format(record: DatabaseRecord, property: Property) {
  const value = record.values[property.id];
  if (value === null || value === undefined) return "—";
  if (property.type === "Title") return record.title;
  if (property.type === "CreatedBy") return record.createdBy?.email || "—";
  if (property.type === "LastEditedBy")
    return record.lastEditedBy?.email || "—";
  if (property.type === "Checkbox") return value ? "Yes" : "No";
  if (property.type === "Number")
    return Intl.NumberFormat().format(Number(value));
  if (["Select", "Status"].includes(property.type))
    return (
      property.config.options?.find((o) => o.id === value)?.label ||
      "Unknown option"
    );
  if (property.type === "MultiSelect")
    return (value as string[])
      .map(
        (id) =>
          property.config.options?.find((o) => o.id === id)?.label ||
          "Unknown option",
      )
      .join(", ");
  if (property.type.endsWith("Time"))
    return new Date(String(value)).toLocaleString();
  return String(value);
}
function openSettings(create = false) {
  newView.value = create;
  viewDraft.value = create
    ? {
        name: "",
        type: "Table",
        config: {
          filters: [],
          sorts: [],
          visibleProperties: [],
          groupBy: null,
          dateProperty: null,
        },
      }
    : JSON.parse(JSON.stringify(currentView.value));
  showSettings.value = true;
}
function propertyById(id: string): Property | undefined {
  return metadata.value?.properties.find((p: Property) => p.id === id);
}
function filterOperators(filter: any) {
  const type = propertyById(filter.propertyId)?.type,
    operators = ["eq", "neq", "empty", "notEmpty"];
  if (
    ["Title", "Text", "URL", "Email", "Phone", "MultiSelect"].includes(
      type || "",
    )
  )
    operators.push("contains");
  if (["Number", "Date", "CreatedTime", "LastEditedTime"].includes(type || ""))
    operators.push("gt", "gte", "lt", "lte");
  if (["Select", "Status"].includes(type || "")) operators.push("in");
  return operators;
}
function filterProperty(filter: any): Property | undefined {
  const property = propertyById(filter.propertyId);
  if (!property) return;
  if (filter.operator === "in") return { ...property, type: "MultiSelect" };
  if (property.type === "MultiSelect" && filter.operator === "contains")
    return { ...property, type: "Select" };
  return property;
}
async function saveView() {
  await mutate(async () => {
    const payload = {
      name: viewDraft.value.name,
      type: viewDraft.value.type,
      config: {
        ...viewDraft.value.config,
        groupBy:
          viewDraft.value.type === "Calendar"
            ? null
            : viewDraft.value.config.groupBy,
      },
    };
    if (newView.value) {
      const view = await api("/views", "POST", payload);
      viewId.value = view.id;
    } else
      await api("/views/" + viewDraft.value.id, "PATCH", {
        ...payload,
        version: viewDraft.value.version,
      });
    showSettings.value = false;
    offset.value = 0;
    await load();
    notice.value = "View saved";
  });
}
async function addProperty() {
  await mutate(async () => {
    await api("/properties", "POST", {
      name: propertyName.value,
      type: propertyType.value,
      options: ["Select", "MultiSelect", "Status"].includes(propertyType.value)
        ? optionNames.value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    });
    propertyName.value = "";
    optionNames.value = "";
    await load();
    notice.value = "Property created";
  });
}
const operatorNames: Record<string, string> = {
  eq: "Is",
  neq: "Is not",
  contains: "Contains",
  gt: "Greater than / after",
  gte: "At least / on or after",
  lt: "Less than / before",
  lte: "At most / on or before",
  empty: "Is empty",
  notEmpty: "Is not empty",
  in: "Is one of",
};
const propertyTypeNames: Record<string, string> = {
  MultiSelect: "Multi-select",
  CreatedTime: "Created time",
  CreatedBy: "Created by",
  LastEditedTime: "Last edited time",
  LastEditedBy: "Last edited by",
};
const rename = ref(""),
  showRename = ref(false);
async function renameDatabase() {
  await mutate(async () => {
    await $fetch("/api/v1/pages/" + props.databaseId + "/title", {
      method: "PATCH",
      body: { title: rename.value, titleVersion: metadata.value.titleVersion },
    });
    showRename.value = false;
    await load();
    emit("changed");
  });
}
function shiftMonth(delta: number) {
  const [year, m] = month.value.split("-").map(Number);
  month.value = new Date(Date.UTC(year!, m! - 1 + delta, 1))
    .toISOString()
    .slice(0, 7);
  offset.value = 0;
  void load();
}
onMounted(() => {
  void load();
  interval = setInterval(() => {
    if (!events.live.value && !disposed) void load();
  }, 5000);
});
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  clearTimeout(timer);
  clearInterval(interval);
});
</script>
<template>
  <div class="database-workspace">
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="metadata"
      ><div class="database-heading">
        <h1>{{ metadata.title }}</h1>
        <small>{{
          events.live.value
            ? "Live updates connected"
            : "Live updates reconnecting"
        }}</small>
      </div>
      <div role="tablist" aria-label="Database views" class="database-tabs">
        <button
          v-for="view in metadata.views"
          :key="view.id"
          role="tab"
          :aria-selected="viewId === view.id"
          @click="chooseView(view.id)"
        >
          {{ view.name }}
        </button>
      </div>
      <div class="actions">
        <form
          class="database-search"
          @submit.prevent="
            offset = 0;
            load();
          "
        >
          <label :for="'db-search-' + databaseId">Search records</label
          ><input
            :id="'db-search-' + databaseId"
            v-model="search"
            type="search"
            maxlength="200"
          /><button>Search records</button>
        </form>
        <button v-if="canEdit" @click="beginRecord()">New record</button
        ><button
          v-if="canEdit"
          @click="
            rename = metadata.title;
            showRename = !showRename;
          "
        >
          Rename database</button
        ><button v-if="canEdit" @click="openSettings()">View settings</button
        ><button v-if="canEdit" @click="openSettings(true)">New view</button
        ><button
          v-if="metadata.accessRank >= 40"
          @click="showPermissions = !showPermissions"
        >
          Database access</button
        ><button @click="load()">Refresh records</button>
      </div>
      <form
        v-if="showRename && canEdit"
        class="database-form"
        @submit.prevent="renameDatabase"
      >
        <label :for="'database-title-' + databaseId">Database title</label
        ><input
          :id="'database-title-' + databaseId"
          v-model="rename"
          required
          maxlength="300"
        /><button :disabled="busy">Save database title</button>
      </form>
      <PagePermissions
        v-if="showPermissions && metadata.accessRank >= 40"
        :page="{
          id: databaseId,
          space_id: metadata.spaceId,
          version: metadata.pageVersion,
        }"
        @changed="
          showPermissions = false;
          load();
        "
      />
      <form
        v-if="showCreate && canEdit"
        class="database-form"
        @submit.prevent="createRecord"
      >
        <h2>New record</h2>
        <label :for="'record-title-' + databaseId">Record name</label
        ><input
          :id="'record-title-' + databaseId"
          v-model="title"
          required
          maxlength="300"
        /><template v-for="property in editableProperties" :key="property.id"
          ><label :for="'record-value-' + property.id">{{
            property.name
          }}</label
          ><DatabaseFieldInput
            :id="'record-value-' + property.id"
            :property="property"
            :model-value="draft[property.id]"
            @update:model-value="draft[property.id] = $event"
        /></template>
        <label
          ><input
            v-model="restrictedRecord"
            type="checkbox"
            style="width: auto"
          />Restrict this record to you and the space owner</label
        >
        <div class="actions">
          <button :disabled="busy">Create record</button
          ><button type="button" @click="showCreate = false">Cancel</button>
        </div>
      </form>
      <div v-if="currentView?.type === 'Table'" class="database-table">
        <table>
          <thead>
            <tr>
              <th v-for="property in columns" :key="property.id">
                {{ property.name }}
              </th>
            </tr>
          </thead>
          <tbody v-for="group in recordGroups" :key="group.id || 'unassigned'">
            <tr v-if="group.label">
              <th :colspan="columns.length">{{ group.label }}</th>
            </tr>
            <tr v-for="record in group.records" :key="record.pageId">
              <td v-for="property in columns" :key="property.id">
                <button
                  v-if="property.type === 'Title'"
                  @click="emit('open', record.pageId)"
                >
                  {{ record.title }}</button><DatabaseFieldInput
                  v-else-if="
                    (writablePropertyTypes as readonly string[]).includes(
                      property.type,
                    ) &&
                    canEdit &&
                    record.accessRank >= 30
                  "
                  :property="property"
                  :model-value="record.values[property.id]"
                  :disabled="busy"
                  @update:model-value="
                    patchRecord(record, { [property.id]: $event })
                  "
                /><span v-else>{{ format(record, property) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div
        v-else-if="currentView?.type === 'Board' && groupProperty"
        class="database-board"
      >
        <section
          v-for="group in boardGroups"
          :key="group.id || 'unassigned'"
          class="board-column"
          :aria-label="group.label"
          @dragover.prevent
          @drop.prevent="drop($event, group.id)"
        >
          <h2>
            {{ group.label }}
            <small>{{ group.records.length }} on this page</small>
          </h2>
          <article
            v-for="record in group.records"
            :key="record.pageId"
            :draggable="canEdit && record.accessRank >= 30 && !busy"
            @dragstart="startDrag($event, record)"
          >
            <button
              v-if="canEdit && record.accessRank >= 30"
              class="card-drag-handle"
              :aria-label="'Move ' + record.title"
              :draggable="!busy"
              :disabled="busy"
              @dragstart.stop="startDrag($event, record)"
              @click="focusStatus"
            >
              ↕
            </button>
            <button @click="emit('open', record.pageId)">
              {{ record.title }}</button><DatabaseFieldInput
              v-if="canEdit && record.accessRank >= 30"
              :property="groupProperty"
              :model-value="record.values[groupProperty.id]"
              :disabled="busy"
              @update:model-value="
                patchRecord(record, { [groupProperty!.id]: $event })
              "
            />
            <p
              v-for="property in columns.filter(
                (p) => p.type !== 'Title' && p.id !== groupProperty?.id,
              )"
              :key="property.id"
            >
              {{ property.name }}: {{ format(record, property) }}
            </p>
          </article>
        </section>
      </div>
      <div
        v-else-if="currentView?.type === 'Calendar'"
        class="database-calendar"
      >
        <div class="actions">
          <button aria-label="Previous month" @click="shiftMonth(-1)">
            Previous
          </button>
          <h2>{{ monthLabel }}</h2>
          <button aria-label="Next month" @click="shiftMonth(1)">Next</button
          ><label :for="'calendar-month-' + databaseId">Month</label
          ><input
            :id="'calendar-month-' + databaseId"
            v-model="month"
            type="month"
            @change="
              offset = 0;
              load();
            "
          />
        </div>
        <div class="calendar-grid" role="grid" aria-label="Records by date">
          <div
            v-for="day in calendarCells"
            :key="day.iso"
            role="gridcell"
            :aria-label="day.iso"
            :class="{ outside: day.outside }"
          >
            <strong>{{ day.day }}</strong><button
              v-if="canEdit"
              :aria-label="'Add record on ' + day.iso"
              @click="beginRecord(day.iso)"
            >
              +</button
            ><button
              v-for="record in records.filter(
                (r) => r.values[currentView.config.dateProperty] === day.iso,
              )"
              :key="record.pageId"
              class="calendar-record"
              @click="emit('open', record.pageId)"
            >
              {{ record.title }}
            </button>
          </div>
        </div>
      </div>
      <div v-else-if="currentView?.type === 'Gallery'" class="database-gallery">
        <template v-for="group in recordGroups" :key="group.id || 'unassigned'"
          ><h2 v-if="group.label" class="gallery-group-heading">
            {{ group.label }}
          </h2>
          <article v-for="record in group.records" :key="record.pageId">
            <img
              v-if="record.coverFileId"
              :src="'/api/v1/files/' + record.coverFileId + '/preview'"
              :alt="record.title"
              loading="lazy"
            /><button @click="emit('open', record.pageId)">
              {{ record.title }}
            </button>
            <p
              v-for="property in columns.filter((p) => p.type !== 'Title')"
              :key="property.id"
            >
              {{ property.name }}: {{ format(record, property) }}
            </p>
          </article></template
        >
      </div>
      <ul v-else class="database-list">
        <template v-for="group in recordGroups" :key="group.id || 'unassigned'"
          ><li v-if="group.label">
            <h2>{{ group.label }}</h2>
          </li>
          <li v-for="record in group.records" :key="record.pageId">
            <button @click="emit('open', record.pageId)">
              {{ record.title }}</button><span
              v-for="property in columns.filter((p) => p.type !== 'Title')"
              :key="property.id"
              >{{ property.name }}: {{ format(record, property) }}</span
            >
          </li></template
        >
      </ul>
      <p v-if="!records.length && !loading">No records match this view.</p>
      <div class="actions">
        <button
          :disabled="offset === 0 || loading"
          @click="
            offset = Math.max(0, offset - 100);
            load();
          "
        >
          Previous records</button
        ><span
          >{{ records.length ? offset + 1 : 0 }}–{{
            offset + records.length
          }}
          shown</span
        ><button
          :disabled="nextOffset === null || loading"
          @click="
            offset = nextOffset || 0;
            load();
          "
        >
          Next records</button
        ><span v-if="loading" role="status">Loading records…</span>
      </div>
      <details v-if="canEdit" class="database-form">
        <summary>Add a property</summary>
        <form @submit.prevent="addProperty">
          <label :for="'property-name-' + databaseId">Property name</label
          ><input
            :id="'property-name-' + databaseId"
            v-model="propertyName"
            required
            maxlength="80"
          /><label :for="'property-type-' + databaseId">Property type</label
          ><select :id="'property-type-' + databaseId" v-model="propertyType">
            <option
              v-for="type in [
                ...writablePropertyTypes,
                ...computedPropertyTypes,
              ]"
              :key="type"
              :value="type"
            >
              {{ propertyTypeNames[type] || type }}
            </option></select
          ><template
            v-if="['Select', 'MultiSelect', 'Status'].includes(propertyType)"
            ><label :for="'property-options-' + databaseId"
              >Options, separated by commas</label
            ><input
              :id="'property-options-' + databaseId"
              v-model="optionNames"
              required /></template
          ><button :disabled="busy">Add property</button>
        </form>
      </details>
      <form
        v-if="showSettings && viewDraft && canEdit"
        class="database-form"
        @submit.prevent="saveView"
      >
        <h2>{{ newView ? "Create view" : "View settings" }}</h2>
        <label for="view-name">View name</label
        ><input
          id="view-name"
          v-model="viewDraft.name"
          required
          maxlength="80"
        /><label for="view-type">View type</label
        ><select id="view-type" v-model="viewDraft.type">
          <option v-for="type in viewTypes" :key="type">
            {{ type }}
          </option></select
        ><label for="view-group">Group by</label
        ><select
          id="view-group"
          v-model="viewDraft.config.groupBy"
          :disabled="viewDraft.type === 'Calendar'"
        >
          <option :value="null">No grouping</option>
          <option
            v-for="property in metadata.properties.filter((p: Property) =>
              ['Status', 'Select'].includes(p.type),
            )"
            :key="property.id"
            :value="property.id"
          >
            {{ property.name }}
          </option></select
        ><label for="view-date">Calendar date property</label
        ><select id="view-date" v-model="viewDraft.config.dateProperty">
          <option :value="null">No date property</option>
          <option
            v-for="property in metadata.properties.filter(
              (p: Property) => p.type === 'Date',
            )"
            :key="property.id"
            :value="property.id"
          >
            {{ property.name }}
          </option>
        </select>
        <fieldset>
          <legend>Visible properties · empty selection means all</legend>
          <label
            v-for="property in metadata.properties.filter(
              (p: Property) => p.type !== 'Title',
            )"
            :key="property.id"
            ><input
              v-model="viewDraft.config.visibleProperties"
              type="checkbox"
              :value="property.id"
            />{{ property.name }}</label
          >
        </fieldset>
        <h3>Filters</h3>
        <div
          v-for="(filter, index) in viewDraft.config.filters"
          :key="index"
          class="database-filter"
        >
          <select
            v-model="filter.propertyId"
            aria-label="Filter property"
            @change="
              filter.value = null;
              filter.operator = 'eq';
            "
          >
            <option
              v-for="property in metadata.properties"
              :key="property.id"
              :value="property.id"
            >
              {{ property.name }}
            </option></select
          ><select v-model="filter.operator" aria-label="Filter comparison">
            <option
              v-for="operator in filterOperators(filter)"
              :key="operator"
              :value="operator"
            >
              {{ operatorNames[operator] }}
            </option></select
          ><select
            v-if="
              propertyById(filter.propertyId)?.type.endsWith('By') &&
              !['empty', 'notEmpty'].includes(filter.operator)
            "
            v-model="filter.value"
            aria-label="Filter account"
          >
            <option :value="null">No account</option>
            <option
              v-for="person in directory"
              :key="person.id"
              :value="person.id"
            >
              {{ person.email }}
            </option></select
          ><DatabaseFieldInput
            v-if="
              !propertyById(filter.propertyId)?.type.endsWith('By') &&
              !['empty', 'notEmpty'].includes(filter.operator) &&
              filterProperty(filter)
            "
            :property="filterProperty(filter)!"
            :model-value="filter.value"
            @update:model-value="filter.value = $event"
          /><button
            type="button"
            @click="viewDraft.config.filters.splice(index, 1)"
          >
            Remove filter
          </button>
        </div>
        <button
          type="button"
          :disabled="viewDraft.config.filters.length >= 20"
          @click="
            viewDraft.config.filters.push({
              propertyId: metadata.properties[0].id,
              operator: 'eq',
              value: '',
            })
          "
        >
          Add filter
        </button>
        <h3>Sort</h3>
        <div
          v-for="(sort, index) in viewDraft.config.sorts"
          :key="index"
          class="database-filter"
        >
          <select v-model="sort.propertyId" aria-label="Sort property">
            <option
              v-for="property in metadata.properties.filter(
                (p: Property) => p.type !== 'MultiSelect',
              )"
              :key="property.id"
              :value="property.id"
            >
              {{ property.name }}
            </option></select
          ><select v-model="sort.direction" aria-label="Sort direction">
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option></select
          ><button
            type="button"
            @click="viewDraft.config.sorts.splice(index, 1)"
          >
            Remove sort
          </button>
        </div>
        <button
          type="button"
          :disabled="viewDraft.config.sorts.length >= 3"
          @click="
            viewDraft.config.sorts.push({
              propertyId: metadata.properties[0].id,
              direction: 'asc',
            })
          "
        >
          Add sort
        </button>
        <div class="actions">
          <button :disabled="busy">Save view</button
          ><button type="button" @click="showSettings = false">Cancel</button>
        </div>
      </form>
    </template>
    <p v-else-if="loading">Loading database…</p>
  </div>
</template>
<style scoped>
.database-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.database-heading h1 {
  font-size: 2.4rem;
}
.database-tabs {
  display: flex;
  gap: 0.4rem;
  border-bottom: 1px solid var(--line);
  padding-bottom: 1rem;
  overflow: auto;
}
.database-tabs button[aria-selected="true"] {
  border-color: var(--accent);
  color: var(--accent);
}
.database-search {
  max-width: 280px;
}
.database-form {
  margin: 1.5rem 0;
  padding: 1.5rem;
  border: 1px solid var(--line);
  border-radius: 0.6rem;
  max-width: 800px;
}
.database-form form {
  margin-top: 1rem;
}
.database-form fieldset {
  border: 1px solid var(--line);
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}
.database-form fieldset input {
  width: auto;
}
.database-table {
  overflow: auto;
}
.database-table table {
  border-collapse: collapse;
  width: 100%;
}
.database-table th,
.database-table td {
  border-bottom: 1px solid var(--line);
  padding: 0.6rem;
  text-align: left;
  min-width: 140px;
}
.database-table input,
.database-table select {
  min-width: 120px;
}
.database-table input[type="checkbox"] {
  width: auto;
  min-width: 0;
}
.database-board {
  display: flex;
  gap: 1rem;
  overflow: auto;
  align-items: flex-start;
}
.board-column {
  min-width: 250px;
  flex: 1;
  background: var(--panel);
  padding: 1rem;
  border-radius: 0.5rem;
  margin: 0;
}
.board-column h2 {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}
.board-column h2 small {
  font-size: 0.75rem;
}
.board-column article,
.database-gallery article {
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  margin: 1rem 0;
  background: var(--bg);
}
.board-column article p,
.database-gallery p {
  font-size: 0.85rem;
}
.board-column article select {
  margin-top: 0.8rem;
  max-width: 100%;
}
.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(100px, 1fr));
  overflow: auto;
}
.calendar-grid > div {
  min-height: 120px;
  padding: 0.5rem;
  border: 1px solid var(--line);
}
.calendar-grid .outside {
  color: var(--muted);
}
.calendar-grid strong {
  margin-right: 0.5rem;
}
.calendar-record {
  display: block;
  width: 100%;
  text-align: left;
  font-size: 0.8rem;
  margin: 0.4rem 0;
  overflow-wrap: anywhere;
}
.database-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 1rem;
}
.database-gallery img {
  width: 100%;
  max-height: 160px;
  object-fit: contain;
  margin-bottom: 1rem;
}
.database-list {
  padding: 0;
  list-style: none;
}
.database-list li {
  display: flex;
  gap: 1.5rem;
  align-items: center;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--line);
  padding: 1rem 0;
}
.database-list span {
  font-size: 0.85rem;
  color: var(--muted);
}
.database-filter {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.database-filter > * {
  max-width: 250px;
}
select {
  font: inherit;
  background: var(--panel);
  color: var(--text);
  padding: 0.6rem;
  border: 1px solid var(--line);
  border-radius: 0.4rem;
}
small {
  color: var(--muted);
}
@media (max-width: 700px) {
  .database-heading {
    display: block;
  }
  .database-heading h1 {
    font-size: 1.8rem;
  }
}
.gallery-group-heading {
  grid-column: 1/-1;
}
.card-drag-handle {
  cursor: grab;
  float: right;
}
</style>

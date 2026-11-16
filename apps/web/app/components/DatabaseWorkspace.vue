<script setup lang="ts">
import {
  writablePropertyTypes,
  computedPropertyTypes,
  viewTypes,
  type Property,
  type DatabaseRecord,
  type ViewConfig,
  formatFormula,
  formulaPropertyType,
} from "@orvyn/shared";
const props = defineProps<{
    databaseId: string;
    initialViewId?: string;
    initialTitle?: string;
    appearance?: any;
  }>(),
  emit = defineEmits<{ open: [pageId: string]; changed: [] }>();
const transfer = ref<{ open: () => void }>();
const viewIcons: Record<string, string> = {
  Table: "table",
  Board: "board",
  List: "list",
  Calendar: "calendar",
  Gallery: "gallery",
};
function tabKeys(event: KeyboardEvent, index: number) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const views = metadata.value.views,
    next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? views.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + views.length) %
            views.length;
  void chooseView(views[next].id);
  (event.currentTarget as HTMLElement).parentElement
    ?.querySelectorAll<HTMLButtonElement>("[role=tab]")
    [next]?.focus();
}
const domId = useId();
const directory = ref<any[]>([]),
  restrictedRecord = ref(false),
  showPermissions = ref(false);
const metadata = ref<any>(),
  records = ref<DatabaseRecord[]>([]),
  columns = ref<Property[]>([]),
  viewId = ref(props.initialViewId || ""),
  offset = ref(0),
  nextOffset = ref<number | null>(null),
  search = ref(""),
  error = ref(""),
  loadError = ref(""),
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
  optionNames = ref(""),
  relationDatabaseId = ref(""),
  relationDatabases = ref<any[]>([]);
const formulaSource = ref(""),
  editingFormula = ref<Property | null>(null),
  formulaDraft = ref(""),
  formulaName = ref(""),
  formulaVersion = ref(0);
function editFormula(property: Property) {
  editingFormula.value = property;
  formulaDraft.value = property.config.expression
    ? formatFormula(property.config.expression, metadata.value.properties)
    : property.config.formula || "";
  formulaName.value = property.name;
  formulaVersion.value = metadata.value.schemaVersion;
}
async function saveFormula() {
  if (!editingFormula.value) return;
  const id = editingFormula.value.id;
  await mutate(async () => {
    await api("/properties/" + id, "PATCH", {
      name: formulaName.value,
      formula: formulaDraft.value,
      schemaVersion: formulaVersion.value,
    });
    editingFormula.value = null;
    await load();
    notice.value = "Formula saved";
  });
}
const month = ref(new Date().toISOString().slice(0, 7)),
  viewDraft = ref<any>();
let generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  noticeTimer: ReturnType<typeof setTimeout> | undefined,
  searchTimer: ReturnType<typeof setTimeout> | undefined,
  interval: ReturnType<typeof setInterval> | undefined,
  disposed = false;
const currentView = computed(() =>
    metadata.value?.views.find((v: any) => v.id === viewId.value),
  ),
  canEdit = computed(() => metadata.value?.accessRank >= 30);
const editableProperties = computed<Property[]>(
  () =>
    metadata.value?.properties.filter(
      (p: Property) =>
        (writablePropertyTypes as readonly string[]).includes(p.type) &&
        p.type !== "Files",
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
    loadError.value = "";
    if (events.denied.value) events.reconnect();
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
    events.watchRecords(
      records.value.map((r) => r.pageId),
      result.fingerprint
        ? {
            relationProperties: result.relationProperties || [],
            fingerprint: result.fingerprint,
          }
        : undefined,
    );
  } catch (e: any) {
    if (request === generation) {
      loadError.value =
        e.status === 404
          ? "This database is unavailable or you do not have access."
          : e.status === 401
            ? "Sign in to view this database."
            : "Database could not be loaded. Try refreshing.";
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
  if (
    property.type === "Checkbox" ||
    (property.type === "Formula" && formulaPropertyType(property) === "boolean")
  )
    return value ? "Yes" : "No";
  if (
    property.type === "Number" ||
    (property.type === "Formula" && formulaPropertyType(property) === "number")
  )
    return Intl.NumberFormat().format(Number(value));
  if (["Select", "Status"].includes(property.type))
    return (
      property.config.options?.find((o) => o.id === value)?.label ||
      "Unknown option"
    );
  if (property.type === "Files")
    return (
      ((value as string[]) || [])
        .map((id) => record.files?.find((file) => file.id === id)?.filename)
        .filter(Boolean)
        .join(", ") || "—"
    );
  if (property.type === "Relation")
    return (
      ((value as string[]) || [])
        .map((id) => record.relations?.find((r) => r.id === id)?.title)
        .filter(Boolean)
        .join(", ") || "—"
    );
  if (property.type === "Person")
    return (
      (value as string[])
        .map(
          (id) =>
            directory.value.find((person) => person.id === id)?.email ||
            "Former member",
        )
        .join(", ") || "—"
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
  const original = propertyById(filter.propertyId),
    type =
      original?.type === "Formula"
        ? formulaPropertyType(original) === "number"
          ? "Number"
          : formulaPropertyType(original) === "boolean"
            ? "Checkbox"
            : "Text"
        : original?.type,
    operators = ["eq", "neq", "empty", "notEmpty"];
  if (type === "Files") return ["empty", "notEmpty"];
  if (type === "Relation") return ["contains", "empty", "notEmpty"];
  if (
    [
      "Title",
      "Text",
      "URL",
      "Email",
      "Phone",
      "MultiSelect",
      "Person",
    ].includes(type || "")
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
  if (property.type === "Formula")
    return {
      ...property,
      type:
        formulaPropertyType(property) === "number"
          ? "Number"
          : formulaPropertyType(property) === "boolean"
            ? "Checkbox"
            : "Text",
    };
  if (property.type === "Person" && filter.operator === "contains")
    return {
      ...property,
      type: "Select",
      config: {
        options: directory.value.map((person) => ({
          id: person.id,
          label: person.email,
          color: "neutral",
        })),
      },
    };
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
watch(propertyType, async (type) => {
  relationDatabaseId.value = "";
  relationDatabases.value = [];
  if (type !== "Relation" || !metadata.value) return;
  try {
    relationDatabases.value = await $fetch<any[]>(
      "/api/v1/spaces/" + metadata.value.spaceId + "/databases",
    );
  } catch {
    error.value = "Databases could not be loaded.";
  }
});
async function addProperty() {
  await mutate(async () => {
    await api("/properties", "POST", {
      name: propertyName.value,
      type: propertyType.value,
      ...(propertyType.value === "Relation"
        ? { relationDatabaseId: relationDatabaseId.value }
        : {}),
      ...(propertyType.value === "Formula"
        ? { formula: formulaSource.value }
        : {}),
      options: ["Select", "MultiSelect", "Status"].includes(propertyType.value)
        ? optionNames.value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    });
    propertyName.value = "";
    optionNames.value = "";
    formulaSource.value = "";
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
watch(search, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    offset.value = 0;
    void load();
  }, 250);
});
watch(notice, (value) => {
  clearTimeout(noticeTimer);
  if (value) noticeTimer = setTimeout(() => (notice.value = ""), 4000);
});
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
  clearTimeout(searchTimer);
  clearTimeout(noticeTimer);
  clearInterval(interval);
});
</script>
<template>
  <div class="database-workspace">
    <p
      v-if="error && !showCreate && !showSettings && !showRename"
      role="alert"
      class="error"
    >
      {{ error }}
    </p>
    <p v-if="loadError" role="alert" class="error">{{ loadError }}</p>
    <div v-if="notice" role="status" class="database-notice">
      <AppIcon name="check" :size="15" />{{ notice
      }}<button
        class="icon-button"
        aria-label="Dismiss notification"
        @click="notice = ''"
      >
        <AppIcon name="x" :size="13" />
      </button>
    </div>
    <template v-if="metadata"
      ><CoverBanner
        :preset="(appearance || metadata.appearance)?.cover_preset"
        :file-id="(appearance || metadata.appearance)?.cover_file_id"
      />
      <div class="database-page-symbol">
        <PageSymbol
          :icon="(appearance || metadata.appearance)?.icon"
          kind="database"
          :size="40"
        />
      </div>
      <div class="database-heading">
        <h1>{{ metadata.title }}</h1>
        <small class="database-live"
          ><span :class="{ connected: events.live.value }" />{{
            events.live.value
              ? "Live updates connected"
              : "Live updates reconnecting"
          }}</small
        >
      </div>
      <div class="database-controls">
        <div role="tablist" aria-label="Database views" class="database-tabs">
          <button
            v-for="(item, index) in metadata.views"
            :key="item.id"
            role="tab"
            :aria-selected="viewId === item.id"
            :tabindex="viewId === item.id ? 0 : -1"
            @click="chooseView(item.id)"
            @keydown="tabKeys($event, Number(index))"
          >
            <AppIcon :name="viewIcons[item.type] || 'table'" :size="15" />{{
              item.name
            }}</button
          ><button
            v-if="canEdit"
            class="icon-button add-view"
            aria-label="New view"
            title="New view"
            @click="openSettings(true)"
          >
            <AppIcon name="plus" :size="15" />
          </button>
        </div>
        <div class="database-tools">
          <button
            v-if="canEdit"
            class="ghost"
            aria-label="View settings"
            title="Filters and sorting"
            @click="openSettings()"
          >
            <AppIcon name="filter" :size="15" /><span>Filter</span
            ><span
              v-if="currentView?.config.filters.length"
              class="filter-count"
              >{{ currentView.config.filters.length }}</span
            ></button
          ><button
            class="icon-button"
            aria-label="Refresh records"
            title="Refresh records"
            @click="load()"
          >
            <AppIcon
              name="history"
              :size="15"
              :class="{ spinner: loading }"
            /></button
          ><UiMenu label="Database options"
            ><button
              v-if="canEdit"
              role="menuitem"
              @click="
                rename = metadata.title;
                showRename = true;
              "
            >
              <AppIcon name="file" :size="16" />Rename database</button
            ><button
              v-if="metadata.accessRank >= 40"
              role="menuitem"
              @click="showPermissions = true"
            >
              <AppIcon name="users" :size="16" />Database access</button
            ><button role="menuitem" @click="transfer?.open()">
              <AppIcon name="download" :size="16" />Import / export
            </button></UiMenu
          ><button v-if="canEdit" class="primary" @click="beginRecord()">
            <AppIcon name="plus" :size="15" />New record
          </button>
        </div>
      </div>
      <form
        class="database-search"
        @submit.prevent="
          offset = 0;
          load();
        "
      >
        <AppIcon name="search" :size="15" /><label
          class="sr-only"
          :for="'db-search-' + domId"
          >Search records</label
        ><input
          :id="'db-search-' + domId"
          v-model="search"
          type="search"
          maxlength="200"
          placeholder="Search this database…"
        /><button class="sr-only">Search records</button>
      </form>
      <DatabaseTransfer
        ref="transfer"
        :database-id="databaseId"
        :view-id="viewId"
        :properties="metadata.properties"
        :can-edit="canEdit"
        hide-trigger
        @imported="
          offset = 0;
          load();
        "
      />
      <UiDialog
        :open="showRename && canEdit"
        title="Rename database"
        @close="showRename = false"
      >
        <form
          v-if="showRename && canEdit"
          class="database-form"
          @submit.prevent="renameDatabase"
        >
          <p v-if="error" role="alert" class="error">{{ error }}</p>
          <label :for="'database-title-' + domId">Database title</label
          ><input
            :id="'database-title-' + domId"
            v-model="rename"
            required
            maxlength="300"
          /><button :disabled="busy">Save database title</button>
        </form>
      </UiDialog>
      <UiDialog
        :open="showPermissions && metadata.accessRank >= 40"
        title="Database access"
        drawer
        @close="showPermissions = false"
      >
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
      </UiDialog>
      <UiDialog
        :open="showCreate && canEdit"
        title="New record"
        @close="showCreate = false"
      >
        <form
          v-if="showCreate && canEdit"
          class="database-form"
          @submit.prevent="createRecord"
        >
          <p v-if="error" role="alert" class="error">{{ error }}</p>
          <label :for="'record-title-' + domId">Record name</label
          ><input
            :id="'record-title-' + domId"
            v-model="title"
            required
            maxlength="300"
          /><template v-for="property in editableProperties" :key="property.id"
            ><label :for="'record-value-' + domId + '-' + property.id">{{
              property.name
            }}</label
            ><DatabaseFieldInput
              :database-id="databaseId"
              :people="directory"
              :id="'record-value-' + domId + '-' + property.id"
              :property="property"
              :model-value="draft[property.id]"
              @update:model-value="draft[property.id] = $event"
          /></template>
          <p
            v-if="metadata.properties.some((p: Property) => p.type === 'Files')"
          >
            Create the record first, then open it to upload attachments and
            select them in its file fields.
          </p>
          <label
            ><input
              v-model="restrictedRecord"
              type="checkbox"
              style="width: auto"
            />Restrict this record to you and the space owner</label
          >
          <div class="actions">
            <button class="primary" :disabled="busy">Create record</button
            ><button type="button" @click="showCreate = false">Cancel</button>
          </div>
        </form>
      </UiDialog>
      <div
        v-if="currentView?.type === 'Table'"
        class="database-table"
        :aria-busy="loading"
      >
        <table>
          <thead>
            <tr>
              <th v-for="property in columns" :key="property.id">
                <button
                  v-if="property.type === 'Formula' && canEdit"
                  class="formula-header"
                  :aria-label="'Edit ' + property.name + ' formula'"
                  @click="editFormula(property)"
                >
                  <span aria-hidden="true">ƒ</span>{{ property.name }}
                </button>
                <template v-else>{{ property.name }}</template>
              </th>
            </tr>
          </thead>
          <tbody v-for="group in recordGroups" :key="group.id || 'unassigned'">
            <tr v-if="group.label">
              <th :colspan="columns.length">{{ group.label }}</th>
            </tr>
            <tr v-for="record in group.records" :key="record.pageId">
              <td
                v-for="property in columns"
                :key="property.id"
                :class="'property-' + property.type.toLowerCase()"
              >
                <button
                  class="record-title"
                  v-if="property.type === 'Title'"
                  @click="emit('open', record.pageId)"
                >
                  <AppIcon name="file" :size="14" />{{ record.title }}</button
                ><DatabaseFilesField
                  v-else-if="property.type === 'Files'"
                  :name="property.name"
                  :files="record.files || []"
                  :model-value="record.values[property.id]"
                  :can-edit="canEdit && record.accessRank >= 30"
                  :disabled="busy"
                  @update:model-value="
                    patchRecord(record, { [property.id]: $event })
                  "
                  @manage="emit('open', record.pageId)"
                /><DatabaseRelationField
                  v-else-if="property.type === 'Relation'"
                  :property="property"
                  :database-id="databaseId"
                  :model-value="record.values[property.id]"
                  :records="record.relations || []"
                  :can-edit="canEdit && record.accessRank >= 30"
                  :disabled="busy"
                  @update:model-value="
                    patchRecord(record, { [property.id]: $event })
                  "
                /><DatabaseFieldInput
                  :database-id="databaseId"
                  :people="directory"
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
              :database-id="databaseId"
              :people="directory"
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
          ><label :for="'calendar-month-' + domId">Month</label
          ><input
            :id="'calendar-month-' + domId"
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
            <CoverBanner
              v-if="record.coverPreset"
              :preset="record.coverPreset"
              compact
            />
            <img
              v-else-if="record.coverFileId"
              :src="'/api/v1/files/' + record.coverFileId + '/preview'"
              :alt="record.title"
              loading="lazy"
            /><button @click="emit('open', record.pageId)">
              <PageSymbol :icon="record.icon" :size="17" />
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
      <div
        v-if="
          !records.length &&
          !loading &&
          currentView?.type !== 'Board' &&
          currentView?.type !== 'Calendar'
        "
        class="database-empty"
      >
        <AppIcon :name="viewIcons[currentView?.type] || 'table'" :size="27" />
        <h2>
          {{
            search || currentView?.config.filters.length
              ? "No matching records"
              : "A place for the details"
          }}
        </h2>
        <p>
          {{
            search || currentView?.config.filters.length
              ? "Try a different search or adjust this view’s filters."
              : "Add your first record. Every entry is a page with room for notes, files and more."
          }}
        </p>
        <button
          v-if="canEdit && !search && !currentView?.config.filters.length"
          class="ghost"
          @click="beginRecord()"
        >
          <AppIcon name="plus" :size="15" />Create first record
        </button>
      </div>
      <div class="database-pagination">
        <button
          v-if="nextOffset !== null || offset > 0"
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
          v-if="nextOffset !== null || offset > 0"
          :disabled="nextOffset === null || loading"
          @click="
            offset = nextOffset || 0;
            load();
          "
        >
          Next records</button
        ><span v-if="loading" role="status">Loading records…</span>
      </div>
      <details v-if="canEdit" class="database-form property-builder">
        <summary>Add a property</summary>
        <form @submit.prevent="addProperty">
          <label :for="'property-name-' + domId">Property name</label
          ><input
            :id="'property-name-' + domId"
            v-model="propertyName"
            required
            maxlength="80"
          /><label :for="'property-type-' + domId">Property type</label
          ><select :id="'property-type-' + domId" v-model="propertyType">
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
            ><label :for="'property-options-' + domId"
              >Options, separated by commas</label
            ><input
              :id="'property-options-' + domId"
              v-model="optionNames"
              required /></template
          ><template v-if="propertyType === 'Relation'"
            ><label :for="'relation-database-' + domId">Related database</label
            ><select
              :id="'relation-database-' + domId"
              v-model="relationDatabaseId"
              required
            >
              <option value="" disabled>Choose a database in this space</option>
              <option
                v-for="database in relationDatabases"
                :key="database.id"
                :value="database.id"
              >
                {{ database.title }}
              </option>
            </select></template
          ><DatabaseFormulaEditor
            v-if="propertyType === 'Formula'"
            v-model="formulaSource"
            :properties="metadata.properties"
            :disabled="busy"
          /><button :disabled="busy">Add property</button>
        </form>
      </details>
      <UiDialog
        :open="!!editingFormula && canEdit"
        title="Edit formula"
        wide
        @close="editingFormula = null"
      >
        <form
          v-if="editingFormula && canEdit"
          class="database-form"
          @submit.prevent="saveFormula"
        >
          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <label :for="'formula-name-' + domId">Property name</label>
          <input
            :id="'formula-name-' + domId"
            v-model="formulaName"
            required
            maxlength="80"
            :disabled="busy"
          />
          <DatabaseFormulaEditor
            v-model="formulaDraft"
            :properties="
              metadata.properties.filter(
                (p: Property) => p.id !== editingFormula?.id,
              )
            "
            :disabled="busy"
          />
          <p v-if="formulaVersion !== metadata.schemaVersion" role="status">
            The schema changed while editing. Copy your expression and reopen
            this dialog before saving.
          </p>
          <div class="actions">
            <button
              class="primary"
              :disabled="busy || formulaVersion !== metadata.schemaVersion"
            >
              Save formula</button
            ><button type="button" @click="editingFormula = null">
              Cancel
            </button>
          </div>
        </form>
      </UiDialog>
      <UiDialog
        :open="showSettings && !!viewDraft && canEdit"
        :title="newView ? 'Create view' : 'View settings'"
        wide
        @close="showSettings = false"
      >
        <form
          v-if="showSettings && viewDraft && canEdit"
          class="database-form"
          @submit.prevent="saveView"
        >
          <p v-if="error" role="alert" class="error">{{ error }}</p>
          <label :for="'view-name-' + domId">View name</label
          ><input
            :id="'view-name-' + domId"
            v-model="viewDraft.name"
            required
            maxlength="80"
          /><label :for="'view-type-' + domId">View type</label
          ><select :id="'view-type-' + domId" v-model="viewDraft.type">
            <option v-for="type in viewTypes" :key="type">
              {{ type }}
            </option></select
          ><label :for="'view-group-' + domId">Group by</label
          ><select
            :id="'view-group-' + domId"
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
          ><label :for="'view-date-' + domId">Calendar date property</label
          ><select
            :id="'view-date-' + domId"
            v-model="viewDraft.config.dateProperty"
          >
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
                filter.operator =
                  propertyById(filter.propertyId)?.type === 'Files'
                    ? 'notEmpty'
                    : propertyById(filter.propertyId)?.type === 'Relation'
                      ? 'contains'
                      : 'eq';
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
            ><DatabaseRelationField
              v-if="
                propertyById(filter.propertyId)?.type === 'Relation' &&
                !['empty', 'notEmpty'].includes(filter.operator)
              "
              :property="propertyById(filter.propertyId)!"
              :database-id="databaseId"
              :model-value="
                typeof filter.value === 'string' ? [filter.value] : []
              "
              can-edit
              single
              @update:model-value="filter.value = $event[0] || null"
            /><DatabaseFieldInput
              :database-id="databaseId"
              :people="directory"
              v-if="
                propertyById(filter.propertyId)?.type !== 'Relation' &&
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
                  (p: Property) =>
                    !['MultiSelect', 'Person', 'Files', 'Relation'].includes(
                      p.type,
                    ),
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
            <button class="primary" :disabled="busy">Save view</button
            ><button type="button" @click="showSettings = false">Cancel</button>
          </div>
        </form>
      </UiDialog>
    </template>
    <div v-else-if="loading" aria-busy="true">
      <div class="database-page-symbol">
        <AppIcon name="database" :size="40" />
      </div>
      <div class="database-heading">
        <h1>{{ initialTitle || "Opening database…" }}</h1>
      </div>
      <p class="hint" role="status">Loading database…</p>
      <div class="skeleton skeleton-row" />
      <div
        v-for="i in 4"
        :key="i"
        class="skeleton skeleton-line"
        :style="{ width: 95 - i * 6 + '%' }"
      />
    </div>
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

.database-workspace {
  padding: 48px 48px 45px;
  max-width: 1600px;
  margin: auto;
  min-width: 0;
}
.database-page-symbol {
  color: var(--muted);
  height: 48px;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
}
.database-heading {
  margin-bottom: 28px;
  align-items: flex-end;
}
.database-heading h1 {
  margin: 0;
  font-size: 2.6rem;
  letter-spacing: -0.045em;
  font-weight: 650;
}
.database-live {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.7rem;
  white-space: nowrap;
  margin-bottom: 5px;
}
.database-live > span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--faint);
}
.database-live > span.connected {
  background: var(--success);
}
.database-controls {
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--line);
  min-width: 0;
}
.database-tabs {
  padding: 0;
  border: 0;
  gap: 3px;
  overflow: auto;
  margin-bottom: -1px;
  align-items: center;
}
.database-tabs button[role="tab"] {
  padding: 10px 9px;
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  white-space: nowrap;
  color: var(--muted);
  font-size: 0.82rem;
  gap: 6px;
}
.database-tabs button[role="tab"][aria-selected="true"] {
  color: var(--text);
  border-bottom-color: var(--accent);
}
.database-tabs .add-view {
  color: var(--faint);
  margin-left: 4px;
}
.database-tools {
  display: flex;
  gap: 5px;
  align-items: center;
  padding-bottom: 5px;
  flex: none;
  font-size: 0.8rem;
}
.database-tools > .ghost {
  font-size: 0.78rem;
  min-height: 29px;
  padding: 4px 6px;
  color: var(--muted);
}
.database-tools > .primary {
  font-size: 0.8rem;
  min-height: 30px;
  padding: 5px 10px;
  margin-left: 4px;
}
.filter-count {
  color: var(--accent);
  background: var(--accent-soft);
  font-size: 0.7rem;
  border-radius: 4px;
  padding: 0 4px;
}
.database-search {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 7px;
  color: var(--faint);
  margin: 12px 0 15px;
  max-width: 310px;
}
.database-search input {
  border: 0;
  background: transparent;
  padding: 5px 2px;
  min-height: 28px;
  font-size: 0.8rem;
  box-shadow: none;
}
.database-table {
  border-top: 1px solid var(--line);
  min-height: 70px;
}
.database-table th {
  font-size: 0.76rem;
  font-weight: 500;
  color: var(--muted);
  background: var(--panel);
  padding: 9px 10px;
  border-right: 1px solid var(--line-soft);
}
.database-table td {
  padding: 4px 8px;
  border-right: 1px solid var(--line-soft);
  min-width: 150px;
  height: 40px;
  font-size: 0.86rem;
}
.database-table th:last-child,
.database-table td:last-child {
  border-right: 0;
}
.database-table tbody tr:hover {
  background: var(--surface);
}
.database-table td:first-child {
  min-width: 210px;
}
.database-table .record-title {
  justify-content: flex-start;
  max-width: 100%;
  padding: 5px 2px;
  background: transparent;
  border: 0;
  gap: 8px;
  text-align: left;
  font-weight: 500;
}
.database-table .record-title > .app-icon {
  color: var(--faint);
}
.database-table input,
.database-table select {
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  font-size: 0.83rem;
  padding: 5px 4px;
  min-height: 29px;
  min-width: 90px;
  width: 100%;
  box-shadow: none;
}
.database-table input:hover,
.database-table select:hover {
  background: var(--surface-hover);
}
.database-table input:focus,
.database-table select:focus {
  border-color: var(--accent);
  background: var(--bg);
}
.database-table select:not([multiple]) {
  appearance: none;
  color: var(--muted);
}
.database-table select option {
  color: var(--text);
  background: var(--elevated);
}
.database-table .property-status select,
.database-table .property-select select {
  color: var(--accent);
  background: var(--accent-soft);
  width: auto;
  min-width: 90px;
  max-width: 100%;
  font-size: 0.76rem;
  padding: 4px 7px;
  min-height: 25px;
  border-radius: 4px;
}
.database-table input[type="checkbox"] {
  min-width: 0;
  width: 14px;
  height: 14px;
  min-height: 0;
  margin-left: 5px;
}
.database-pagination {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--faint);
  font-size: 0.72rem;
  padding: 13px 0;
}
.database-pagination button {
  font-size: 0.72rem;
  min-height: 25px;
  padding: 3px 7px;
  background: transparent;
}
.database-pagination > span[role="status"] {
  margin-left: auto;
}
.database-form {
  border: 0;
  margin: 0;
  padding: 0;
  max-width: none;
}
.property-builder {
  margin-top: 15px;
  padding-top: 10px;
  border-top: 1px solid var(--line-soft);
  font-size: 0.8rem;
  max-width: 440px;
}
.property-builder > summary {
  cursor: pointer;
  color: var(--muted);
  padding: 5px 0;
  font-size: 0.8rem;
}
.property-builder > form {
  padding: 18px 0;
}
.database-empty {
  padding: 40px 20px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  color: var(--faint);
  gap: 10px;
  border-bottom: 1px solid var(--line-soft);
}
.database-empty h2 {
  margin: 3px 0 0;
  color: var(--text);
  font-size: 1rem;
  font-weight: 550;
}
.database-empty p {
  margin: 0;
  max-width: 360px;
  font-size: 0.82rem;
}
.database-empty .ghost {
  font-size: 0.8rem;
}
.database-board {
  gap: 14px;
  padding: 3px 0 15px;
}
.board-column {
  padding: 11px;
  background: var(--surface);
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  min-width: 235px;
}
.board-column h2 {
  font-size: 0.82rem;
  font-weight: 550;
  margin: 3px 0 16px;
  color: var(--muted);
}
.board-column h2 small {
  font-size: 0.68rem;
  background: var(--bg);
  padding: 2px 5px;
  border-radius: 4px;
  color: var(--faint);
}
.board-column article,
.database-gallery article {
  border: 1px solid var(--line);
  border-radius: 7px;
  margin: 9px 0;
  padding: 13px;
  background: var(--bg);
  box-shadow: 0 2px 4px #0001;
}
.board-column article:hover,
.database-gallery article:hover {
  border-color: var(--faint);
}
.board-column article > button:not(.card-drag-handle),
.database-gallery article > button {
  background: transparent;
  border: 0;
  font-size: 0.86rem;
  font-weight: 550;
  padding: 3px 0;
  justify-content: flex-start;
  min-height: 24px;
  text-align: left;
}
.board-column article p,
.database-gallery article p {
  font-size: 0.74rem;
  margin: 9px 0 0;
  color: var(--faint);
}
.board-column article select {
  margin-top: 9px;
  padding: 3px 6px;
  min-height: 25px;
  font-size: 0.74rem;
  color: var(--accent);
  background: var(--accent-soft);
  border: 0;
}
.card-drag-handle {
  background: transparent;
  border: 0;
  padding: 0;
  min-height: 22px;
  min-width: 17px;
  opacity: 0.45;
  color: var(--muted);
}
.board-column .actions {
  margin: 14px 0 0;
}
.board-column .actions button {
  font-size: 0.74rem;
  background: transparent;
  border-color: var(--line);
  padding: 4px 6px;
}
.database-list li {
  padding: 11px 8px;
  gap: 20px;
}
.database-list li > button {
  background: transparent;
  border: 0;
  font-size: 0.9rem;
  font-weight: 500;
  justify-content: flex-start;
  padding: 2px;
  min-width: 180px;
  text-align: left;
}
.database-list li > span {
  font-size: 0.76rem;
  color: var(--faint);
}
.database-gallery {
  gap: 15px;
}
.database-gallery article {
  margin: 0;
  min-height: 150px;
}
.database-gallery img {
  border-radius: 4px;
  object-fit: cover;
  max-height: 150px;
}
.database-calendar > .actions {
  gap: 10px;
  margin: 4px 0 15px;
}
.database-calendar > .actions h2 {
  margin: 0 8px;
  font-size: 1rem;
}
.database-calendar > .actions button {
  font-size: 0.75rem;
  background: transparent;
}
.database-calendar input[type="month"] {
  max-width: 160px;
  min-height: 30px;
  font-size: 0.8rem;
}
.calendar-grid {
  border-top: 1px solid var(--line);
  border-left: 1px solid var(--line);
}
.calendar-grid > div {
  border-top: 0;
  border-left: 0;
  min-height: 115px;
  padding: 10px;
}
.calendar-grid strong {
  font-size: 0.75rem;
  color: var(--muted);
  font-weight: 500;
}
.calendar-grid > div.outside {
  background: var(--surface);
}
.calendar-grid > div > button:not(.calendar-record) {
  float: right;
  padding: 0;
  min-width: 18px;
  min-height: 18px;
  font-size: 0.9rem;
  border: 0;
  background: transparent;
  color: var(--faint);
}
.calendar-record {
  border: 0;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.72rem;
  padding: 5px 7px;
  min-height: 25px;
  margin-top: 9px;
}
@media (max-width: 1050px) {
  .database-workspace {
    padding: 40px 30px;
  }
  .database-controls {
    flex-wrap: wrap;
    gap: 4px;
  }
  .database-tools {
    margin-left: auto;
  }
  .database-live {
    display: none;
  }
}
@media (max-width: 760px) {
  .database-workspace {
    padding: 30px 20px;
  }
  .database-page-symbol {
    height: 35px;
    margin-bottom: 12px;
  }
  .database-heading {
    margin-bottom: 20px;
  }
  .database-heading h1 {
    font-size: 2rem;
  }
  .database-controls {
    gap: 7px;
  }
  .database-tabs {
    width: 100%;
    border-bottom: 1px solid var(--line);
  }
  .database-tools {
    width: 100%;
    justify-content: flex-end;
    padding-top: 6px;
  }
  .database-search {
    margin-top: 8px;
  }
  .database-tabs button[role="tab"] {
    font-size: 0.76rem;
    padding: 8px 7px;
  }
  .database-calendar > .actions label {
    display: none;
  }
}
</style>

<style scoped>
.formula-header {
  min-height: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  display: inline-flex;
  gap: 6px;
}
.formula-header span {
  color: var(--accent);
}
.database-notice {
  position: fixed;
  z-index: 60;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px 8px 14px;
  background: var(--elevated);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: var(--shadow);
  font-size: 13px;
}
</style>

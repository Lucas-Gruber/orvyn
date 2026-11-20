<script setup lang="ts">
import {
  missingPublicationInputs,
  retainPublicationFields,
} from "../../utils/publicationFields";
import type { PublicationScope } from "@orvyn/shared";
type Selection = PublicationScope["databases"][number];
const props = defineProps<{
    rootId: string;
    scope: Selection;
    recordPages: string[];
    pageCount: number;
    totalRecords: number;
    busy: boolean;
  }>(),
  emit = defineEmits<{
    change: [value: Selection];
    pages: [value: string[]];
  }>();
const catalog = ref<any>(),
  records = ref<{ id: string; title: string }[]>([]),
  cache = ref<Record<string, string>>({}),
  search = ref(""),
  offset = ref<number | null>(0),
  loading = ref(false),
  error = ref("");
let alive = true,
  epoch = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
const path = computed(
    () =>
      "/api/v1/pages/" +
      props.rootId +
      "/publications/databases/" +
      props.scope.databaseId,
  ),
  view = computed(() =>
    catalog.value?.views.find((view: any) => view.id === props.scope.viewId),
  ),
  required = computed<string[]>(() => view.value?.required || []);
function update(value: Partial<Selection>) {
  emit("change", { ...props.scope, ...value });
}
const shown = computed(() => {
  const merged = new Map(records.value.map((record) => [record.id, record]));
  for (const id of props.scope.recordIds)
    merged.set(id, {
      id,
      title: cache.value[id] || "Selected item is unavailable",
    });
  return [...merged.values()].sort(
    (a, b) =>
      Number(props.scope.recordIds.includes(b.id)) -
        Number(props.scope.recordIds.includes(a.id)) ||
      a.title.localeCompare(b.title),
  );
});
const includePages = computed(
  () =>
    props.scope.recordIds.length > 0 &&
    props.scope.recordIds.every((id) => props.recordPages.includes(id)),
);
const canIncludePages = computed(
  () =>
    props.pageCount +
      props.scope.recordIds.filter((id) => !props.recordPages.includes(id))
        .length <=
    100,
);
function chooseRecord(id: string, checked: boolean) {
  const previous = props.scope.recordIds,
    next = checked
      ? [...previous, id]
      : previous.filter((value) => value !== id);
  update({ recordIds: next });
  if (!checked && props.recordPages.includes(id))
    emit(
      "pages",
      props.recordPages.filter((value) => value !== id),
    );
}
function include(checked: boolean) {
  emit(
    "pages",
    checked
      ? [...new Set([...props.recordPages, ...props.scope.recordIds])]
      : props.recordPages.filter((id) => !props.scope.recordIds.includes(id)),
  );
}
function chooseField(id: string, checked: boolean) {
  if (required.value.includes(id)) return;
  update({
    propertyIds: retainPublicationFields(
      checked
        ? [...props.scope.propertyIds, id]
        : props.scope.propertyIds.filter((value) => value !== id),
      view.value?.properties || [],
    ),
  });
}
function chooseView(id: string) {
  const next = catalog.value?.views.find((view: any) => view.id === id);
  if (!next) return;
  emit(
    "pages",
    props.recordPages.filter((id) => !props.scope.recordIds.includes(id)),
  );
  update({ viewId: id, recordIds: [], propertyIds: [...next.required] });
}
async function load(more = false) {
  if (!view.value) return;
  const current = ++epoch;
  loading.value = true;
  error.value = "";
  try {
    const result = await $fetch<any>(path.value + "/records", {
      method: "POST",
      body: {
        viewId: props.scope.viewId,
        search: search.value,
        offset: more ? offset.value || 0 : 0,
        selectedIds: props.scope.recordIds,
      },
    });
    if (!alive || current !== epoch) return;
    records.value = more
      ? [...records.value, ...result.records]
      : result.records;
    offset.value = result.nextOffset;
    for (const record of [...result.records, ...result.selected])
      cache.value[record.id] = record.title;
  } catch (e: any) {
    if (alive && current === epoch)
      error.value = e.data?.message || "Could not load shared item choices.";
  } finally {
    if (alive && current === epoch) loading.value = false;
  }
}
watch(search, () => {
  clearTimeout(timer);
  timer = setTimeout(() => load(), 250);
});
watch(
  () => props.scope.viewId,
  () => {
    records.value = [];
    void load();
  },
);
onMounted(async () => {
  try {
    const result = await $fetch<any>(path.value);
    if (!alive) return;
    catalog.value = result;
    const current = result.views.find((v: any) => v.id === props.scope.viewId);
    if (!current) {
      const initial =
        result.views.find((v: any) => v.type === "Table") || result.views[0];
      if (initial)
        update({
          viewId: initial.id,
          recordIds: [],
          propertyIds: [...initial.required],
        });
    } else {
      const fields = retainPublicationFields(
        [
          ...new Set([
            ...props.scope.propertyIds.filter((id) =>
              current.properties.some(
                (property: any) => property.id === id && property.allowed,
              ),
            ),
            ...current.required,
          ]),
        ],
        current.properties,
      );
      if (JSON.stringify(fields) !== JSON.stringify(props.scope.propertyIds))
        update({ propertyIds: fields });
      await load();
    }
  } catch (e: any) {
    if (alive) error.value = e.data?.message || "Could not load this database.";
  }
});
onBeforeUnmount(() => {
  alive = false;
  epoch++;
  clearTimeout(timer);
});
</script>
<template>
  <section class="database-public-scope">
    <header>
      <AppIcon name="database" :size="17" /><strong>{{
        catalog?.title || "Database selection"
      }}</strong>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <label class="database-scope-view"
      >Published view<select
        aria-label="Published view"
        :value="scope.viewId"
        :disabled="busy || !catalog"
        @change="chooseView(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="item in catalog?.views" :key="item.id" :value="item.id">
          {{ item.name }} · {{ item.type }}
        </option>
      </select></label
    >
    <template v-if="view"
      ><h4>Visible properties</h4>
      <div class="database-scope-fields">
        <label
          v-for="property in view.properties"
          :key="property.id"
          :class="{ 'scope-field-unavailable': !property.allowed }"
          ><input
            type="checkbox"
            :checked="scope.propertyIds.includes(property.id)"
            :disabled="
              busy ||
              !property.allowed ||
              required.includes(property.id) ||
              missingPublicationInputs(property, scope.propertyIds).length > 0
            "
            @change="
              chooseField(
                property.id,
                ($event.target as HTMLInputElement).checked,
              )
            "
          /><span
            >{{ property.name
            }}<small v-if="!property.allowed">{{
              ["Formula", "Rollup"].includes(property.type)
                ? "Inputs kept private"
                : "Identity · Kept private"
            }}</small
            ><small
              v-else-if="
                missingPublicationInputs(property, scope.propertyIds).length
              "
              >Select
              {{
                missingPublicationInputs(property, scope.propertyIds)
                  .map((input) => input.name)
                  .join(", ")
              }}
              first</small
            ><small v-else-if="required.includes(property.id)"
              >Required by this view</small
            ></span
          ></label
        >
      </div>
      <div class="database-scope-count">
        <h4>Items to share</h4>
        <span>{{ scope.recordIds.length }} selected</span>
      </div>
      <div class="database-scope-search">
        <AppIcon name="search" :size="14" /><input
          v-model="search"
          placeholder="Find items in this view…"
          aria-label="Find items to publish"
          :disabled="busy"
        />
      </div>
      <div class="database-scope-items">
        <label v-for="record in shown" :key="record.id"
          ><input
            type="checkbox"
            :checked="scope.recordIds.includes(record.id)"
            :disabled="
              busy ||
              (!scope.recordIds.includes(record.id) && totalRecords >= 500)
            "
            @change="
              chooseRecord(
                record.id,
                ($event.target as HTMLInputElement).checked,
              )
            "
          /><span>{{ record.title }}</span></label
        >
        <p v-if="!shown.length && !loading">No matching items.</p>
        <button
          v-if="offset !== null"
          type="button"
          class="ghost"
          :disabled="busy || loading"
          @click="load(true)"
        >
          {{ loading ? "Loading…" : "Load more items" }}
        </button>
      </div>
      <p class="database-scope-hint">
        Only checked items and properties will be published. Hidden properties
        and future items stay private. Rollups use shared related items and
        require their target fields to be selected too.
      </p>
      <label class="database-scope-body"
        ><input
          type="checkbox"
          :checked="includePages"
          :disabled="
            busy ||
            !scope.recordIds.length ||
            (!includePages && !canIncludePages)
          "
          @change="include(($event.target as HTMLInputElement).checked)"
        /><span
          >Also include these items’ page text<small>{{
            canIncludePages
              ? "Includes their document blocks, icons, covers and referenced attachments."
              : "Choose fewer items to stay within the 100-page limit."
          }}</small></span
        ></label
      ></template
    >
  </section>
</template>
<style scoped>
.database-public-scope {
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 14px;
  margin: 16px 0;
  background: var(--panel);
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 14px;
}
header strong {
  font-weight: 500;
  overflow-wrap: anywhere;
}
.database-scope-view {
  display: grid;
  gap: 7px;
  font-size: 11px;
}
select {
  width: 100%;
  padding: 8px;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 5px;
  font-size: 11px;
}
h4 {
  font-size: 11px;
  font-weight: 500;
  margin: 18px 0 9px;
}
.database-scope-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}
.database-scope-fields label {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  font-size: 11px;
  padding: 5px 0;
  cursor: pointer;
}
.database-scope-fields small,
.database-scope-body small {
  display: block;
  font-size: 10px;
  color: var(--muted);
  line-height: 1.5;
  margin-top: 2px;
}
.scope-field-unavailable {
  color: var(--muted);
}
input[type="checkbox"] {
  width: 13px;
  height: 13px;
  accent-color: var(--accent);
  flex-shrink: 0;
  margin: 2px 0 0;
}
.database-scope-count {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.database-scope-count span {
  font-size: 10px;
  color: var(--muted);
  margin-top: 9px;
}
.database-scope-search {
  display: flex;
  gap: 7px;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 5px 5px 0 0;
  padding: 0 8px;
  color: var(--muted);
}
input:not([type="checkbox"]) {
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  padding: 8px 0;
  font-size: 11px;
  outline: none;
}
.database-scope-items {
  max-height: 220px;
  overflow: auto;
  border: 1px solid var(--line);
  border-top: 0;
  border-radius: 0 0 5px 5px;
  padding: 4px;
}
.database-scope-items label {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 7px;
  font-size: 11px;
  cursor: pointer;
}
.database-scope-items label span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.database-scope-items label:hover {
  background: var(--surface);
  border-radius: 3px;
}
.database-scope-items p {
  font-size: 11px;
  color: var(--muted);
  text-align: center;
}
.database-scope-items button {
  font-size: 11px;
  width: 100%;
}
.database-scope-hint {
  font-size: 10px;
  color: var(--muted);
  line-height: 1.6;
  margin: 9px 0 14px;
}
.database-scope-body {
  display: flex;
  gap: 8px;
  border-top: 1px solid var(--line);
  padding-top: 13px;
  font-size: 11px;
  cursor: pointer;
}
.error {
  font-size: 12px;
}
</style>

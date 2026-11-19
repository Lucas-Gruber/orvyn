<script setup lang="ts">
import type {
  PublicDatabase,
  PublicationSnapshot,
  PublicRecord,
  PublicProperty,
} from "@orvyn/shared";
import PublicValue from "./PublicValue.vue";
import PublicDocumentNode from "./PublicDocumentNode.vue";
const props = defineProps<{
  database: PublicDatabase;
  snapshot: PublicationSnapshot;
  fileUrl: (id: string) => string;
}>();
const selected = ref<{
  record: PublicRecord;
  properties: PublicProperty[];
} | null>(null);
function open(id: string) {
  for (const page of props.snapshot.pages) {
    const record = page.database?.records.find(
      (record) => record.pageId === id,
    );
    if (record && page.database) {
      selected.value = { record, properties: page.database.properties };
      return;
    }
  }
  const document = props.snapshot.pages.find(
    (page) => page.id === id && page.record,
  );
  if (document?.record)
    selected.value = {
      record: {
        pageId: document.id,
        title: document.title,
        values: document.record.values,
      },
      properties: document.record.properties,
    };
}
const title = computed(() =>
  props.database.properties.find((p) => p.type === "Title"),
);
const fields = computed(() =>
  props.database.properties.filter((p) => p.type !== "Title"),
);
const selectedPage = computed(() =>
  props.snapshot.pages.find(
    (page) => page.id === selected.value?.record.pageId,
  ),
);
const groupProperty = computed(() =>
  props.database.properties.find((p) => p.id === props.database.view.groupBy),
);
const groups = computed(() => {
  const property = groupProperty.value;
  if (!property) return [];
  const groups = (property.options || []).map((option) => ({
    id: option.id,
    label: option.label,
    color: option.color,
    records: props.database.records.filter(
      (record) => record.values[property.id] === option.id,
    ),
  }));
  const unassigned = props.database.records.filter(
    (record) =>
      !property.options?.some(
        (option) => option.id === record.values[property.id],
      ),
  );
  if (unassigned.length)
    groups.push({
      id: "unassigned",
      label: "No " + property.name,
      color: "neutral",
      records: unassigned,
    });
  return groups;
});
const previewImage = (record: PublicRecord) => {
  const page = props.snapshot.pages.find((p) => p.id === record.pageId);
  if (page?.coverFileId) return page.coverFileId;
  return (
    fields.value
      .filter((p) => p.type === "Files")
      .flatMap((p) =>
        Array.isArray(record.values[p.id])
          ? (record.values[p.id] as string[])
          : [],
      )
      .find((id) =>
        props.snapshot.files.some(
          (f) => f.id === id && f.mediaType.startsWith("image/"),
        ),
      ) || ""
  );
};
const firstDate = props.database.records
  .map((record) => record.values[props.database.view.dateProperty || ""])
  .find(
    (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value),
  ) as string | undefined;
const month = ref(
  firstDate
    ? firstDate.slice(0, 7) + "-01"
    : new Date().toISOString().slice(0, 7) + "-01",
);
const monthLabel = computed(() =>
  new Date(month.value + "T12:00:00Z").toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }),
);
function moveMonth(delta: number) {
  const date = new Date(month.value + "T12:00:00Z");
  date.setUTCMonth(date.getUTCMonth() + delta);
  month.value = date.toISOString().slice(0, 10);
}
const days = computed(() => {
  const first = new Date(month.value + "T12:00:00Z");
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(first);
    date.setUTCDate(date.getUTCDate() + index);
    const iso = date.toISOString().slice(0, 10);
    return {
      iso,
      day: date.getUTCDate(),
      outside: iso.slice(0, 7) !== month.value.slice(0, 7),
      records: props.database.records.filter(
        (record) =>
          record.values[props.database.view.dateProperty || ""] === iso,
      ),
    };
  });
});
const undated = computed(() =>
  props.database.records.filter(
    (record) => !record.values[props.database.view.dateProperty || ""],
  ),
);
</script>
<template>
  <section class="public-database" :aria-label="database.view.name + ' view'">
    <header class="public-database-toolbar">
      <span
        ><AppIcon
          :name="
            (
              {
                Table: 'table',
                Board: 'board',
                List: 'list',
                Calendar: 'calendar',
                Gallery: 'gallery',
              } as Record<string, string>
            )[database.view.type] || 'database'
          "
          :size="16"
        />{{ database.view.name }}</span
      ><span
        >{{ database.records.length }}
        {{
          database.records.length === 1 ? "shared item" : "shared items"
        }}</span
      >
    </header>
    <div v-if="database.view.type === 'Table'" class="public-database-table">
      <table>
        <colgroup>
          <col
            v-for="property in database.properties"
            :key="property.id"
            :style="{
              width:
                (database.view.propertyWidths?.[property.id] ||
                  (property.type === 'Title' ? 260 : 170)) + 'px',
            }"
          />
        </colgroup>
        <thead>
          <tr>
            <th v-for="property in database.properties" :key="property.id">
              {{ property.name }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="record in database.records"
            :key="record.pageId"
            :id="'r-' + record.pageId"
          >
            <td v-for="property in database.properties" :key="property.id">
              <button
                v-if="property.type === 'Title'"
                class="public-record-title"
                @click="open(record.pageId)"
              >
                <AppIcon name="file" :size="15" />{{ record.title }}</button
              ><PublicValue
                interactive
                v-else
                :property="property"
                :value="record.values[property.id]"
                :snapshot="snapshot"
                :file-url="fileUrl"
                @open="open"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div
      v-else-if="database.view.type === 'Board'"
      class="public-database-board"
    >
      <section
        v-for="group in groups"
        :key="group.id"
        class="public-database-lane"
      >
        <header>
          <span :class="'public-option-' + group.color">{{
            group.label
          }}</span><span>{{ group.records.length }}</span>
        </header>
        <div
          v-for="record in group.records"
          :key="record.pageId"
          :id="'r-' + record.pageId"
          class="public-database-card"
        >
          <button
            class="public-card-cover"
            v-if="previewImage(record)"
            :aria-label="'Open ' + record.title"
            @click="open(record.pageId)"
          >
            <img
              :src="fileUrl(previewImage(record))"
              alt="Record cover"
              loading="lazy"
            /></button
          ><button class="public-card-title" @click="open(record.pageId)">
            {{ record.title }}
          </button>
          <div
            v-for="property in fields.filter(
              (property) =>
                property.id !== database.view.groupBy &&
                record.values[property.id] !== null &&
                record.values[property.id] !== undefined,
            )"
            :key="property.id"
            class="public-card-value"
          >
            <PublicValue
              interactive
              :property="property"
              :value="record.values[property.id]"
              :snapshot="snapshot"
              :file-url="fileUrl"
              @open="open"
            />
          </div>
        </div>
      </section>
    </div>
    <template v-else-if="database.view.type === 'Calendar'"
      ><header class="public-calendar-bar">
        <h3>{{ monthLabel }}</h3>
        <button
          class="icon-button"
          aria-label="Previous month"
          @click="moveMonth(-1)"
        >
          <AppIcon name="chevronLeft" :size="16" /></button
        ><button
          class="icon-button"
          aria-label="Next month"
          @click="moveMonth(1)"
        >
          <AppIcon name="chevronRight" :size="16" />
        </button>
      </header>
      <div class="public-calendar-scroll">
        <div class="public-calendar-grid">
          <div
            v-for="day in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']"
            :key="day"
            class="public-calendar-weekday"
          >
            {{ day }}
          </div>
          <div
            v-for="day in days"
            :key="day.iso"
            class="public-calendar-day"
            :class="{ outside: day.outside }"
          >
            <span>{{ day.day }}</span><button
              v-for="record in day.records"
              :key="record.pageId"
              @click="open(record.pageId)"
            >
              {{ record.title }}
            </button>
          </div>
        </div>
      </div>
      <div v-if="undated.length" class="public-database-undated">
        <span>No date</span
        ><button
          v-for="record in undated"
          :key="record.pageId"
          @click="open(record.pageId)"
        >
          {{ record.title }}
        </button>
      </div></template
    >
    <div
      v-else-if="database.view.type === 'Gallery'"
      class="public-database-gallery"
    >
      <div
        v-for="record in database.records"
        :key="record.pageId"
        :id="'r-' + record.pageId"
        class="public-database-card"
      >
        <button
          v-if="previewImage(record)"
          class="public-card-cover"
          :aria-label="'Open ' + record.title"
          @click="open(record.pageId)"
        >
          <img
            :src="fileUrl(previewImage(record))"
            alt="Record cover"
            loading="lazy"
          /></button
        ><button class="public-card-title" @click="open(record.pageId)">
          {{ record.title }}
        </button>
        <div
          v-for="property in fields"
          :key="property.id"
          class="public-card-value"
        >
          <PublicValue
            interactive
            :property="property"
            :value="record.values[property.id]"
            :snapshot="snapshot"
            :file-url="fileUrl"
            @open="open"
          />
        </div>
      </div>
    </div>
    <div v-else class="public-database-list">
      <div
        v-for="record in database.records"
        :key="record.pageId"
        :id="'r-' + record.pageId"
        class="public-database-list-row"
      >
        <button class="public-record-title" @click="open(record.pageId)">
          <AppIcon name="file" :size="15" />{{ record.title }}
        </button>
        <div v-for="property in fields" :key="property.id">
          <PublicValue
            interactive
            :property="property"
            :value="record.values[property.id]"
            :snapshot="snapshot"
            :file-url="fileUrl"
            @open="open"
          />
        </div>
      </div>
    </div>
    <p v-if="!database.records.length" class="public-database-empty">
      No items were included in this snapshot.
    </p>
    <UiDialog
      :open="!!selected"
      :title="selected?.record.title || 'Shared item'"
      wide
      @close="selected = null"
      ><template v-if="selected"
        ><div class="public-record-properties">
          <div
            v-for="property in selected.properties.filter(
              (p) => p.type !== 'Title',
            )"
            :key="property.id"
          >
            <span>{{ property.name }}</span><PublicValue
              interactive
              :property="property"
              :value="selected.record.values[property.id]"
              :snapshot="snapshot"
              :file-url="fileUrl"
              @open="open"
            />
          </div>
        </div>
        <div v-if="selectedPage" class="publication-content public-record-body">
          <PublicDocumentNode
            :node="selectedPage.document"
            :snapshot="snapshot"
            :file-url="fileUrl"
          /><a :href="'?page=' + selectedPage.id" class="public-record-fullpage"
            ><AppIcon name="external" :size="14" />Open full page</a
          >
        </div>
        <p v-else class="public-record-scope-note">
          This publication includes the selected properties. The original page
          text is not shared.
        </p></template
      ></UiDialog
    >
  </section>
</template>
<style scoped>
.public-database {
  margin: 24px 0;
  min-width: 0;
  font-size: 13px;
}
.public-database-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--line);
  padding: 0 0 12px;
  gap: 12px;
}
.public-database-toolbar > span:first-child {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  font-weight: 500;
}
.public-database-toolbar > span + span {
  font-size: 11px;
  color: var(--muted);
}
.public-database-table {
  overflow: auto;
}
.public-database-table table {
  border-collapse: collapse;
  table-layout: fixed;
  width: max-content;
  min-width: 100%;
}
.public-database-table :is(td, th) {
  border-bottom: 1px solid var(--line);
  border-right: 1px solid var(--line);
  padding: 9px 12px;
  max-width: 300px;
  overflow-wrap: anywhere;
  vertical-align: top;
  text-align: left;
  font-size: 12px;
}
.public-database-table th {
  font-weight: 400;
  color: var(--muted);
  background: var(--surface);
  font-size: 11px;
}
.public-database-table :is(th, td):last-child {
  border-right: 0;
}
.public-record-title,
.public-card-title {
  padding: 0;
  min-height: 0;
  border: 0;
  background: none;
  border-radius: 0;
  font-weight: 500;
  font-size: 13px;
  line-height: 1.6;
  text-align: left;
  justify-content: flex-start;
  white-space: normal;
  overflow-wrap: anywhere;
  width: 100%;
  color: var(--text);
}
.public-record-title .app-icon {
  color: var(--muted);
  flex-shrink: 0;
}
.public-record-title:hover,
.public-card-title:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.public-database-board {
  display: flex;
  gap: 16px;
  overflow: auto;
  align-items: flex-start;
  padding: 18px 1px 14px;
}
.public-database-lane {
  min-width: 230px;
  max-width: 270px;
  flex: 1;
  background: var(--surface);
  border-radius: 7px;
  padding: 10px;
}
.public-database-lane > header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  margin-bottom: 12px;
}
.public-database-lane > header > span + span {
  color: var(--muted);
}
.public-database-lane > header > span:first-child {
  padding: 1px 7px;
  border-radius: 4px;
  background: var(--panel);
}
.public-database-lane > header > .public-option-violet {
  background: #eae3f4;
  color: #5f4980;
}
.public-database-lane > header > .public-option-green {
  background: #e0efe4;
  color: #356246;
}
.public-database-lane > header > .public-option-blue {
  background: #dfeaf5;
  color: #3d6182;
}
.public-database-lane > header > .public-option-amber {
  background: #f6ebd0;
  color: #78602b;
}
.public-database-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 14px;
  margin-bottom: 8px;
  overflow: hidden;
  box-shadow: 0 1px 2px #00000005;
}
.public-card-value {
  font-size: 12px;
  line-height: 1.5;
  margin-top: 7px;
  color: var(--muted);
}
.public-card-cover {
  display: block;
  padding: 0;
  margin: -14px -14px 12px;
  border: 0;
  border-radius: 0;
  width: calc(100% + 28px);
  height: 130px;
  overflow: hidden;
  background: var(--surface);
}
.public-card-cover img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.public-database-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(230px, 100%), 1fr));
  gap: 16px;
  padding-top: 18px;
}
.public-database-list-row {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
}
.public-database-list-row > .public-record-title {
  flex: 1;
  min-width: 150px;
}
.public-database-list-row > div {
  font-size: 12px;
  max-width: 200px;
}
.public-database-empty {
  text-align: center;
  color: var(--muted) !important;
  font-size: 12px;
  padding: 32px 20px;
}
.public-record-properties {
  padding-bottom: 20px;
  border-bottom: 1px solid var(--line);
}
.public-record-properties > div {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  gap: 20px;
  padding: 10px 0;
  font-size: 13px;
}
.public-record-properties > div > span {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--muted);
  font-size: 12px;
}
.public-record-scope-note {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
  padding: 20px 0 6px;
}
.public-record-body {
  padding: 24px 0 0;
}
.public-record-fullpage {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  margin-top: 28px;
  font-size: 12px;
  color: var(--muted);
}
.public-calendar-bar {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 16px 0;
}
.public-calendar-bar h3 {
  margin: 0 auto 0 0 !important;
  font-size: 14px !important;
}
.public-calendar-scroll {
  overflow: auto;
}
.public-calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(94px, 1fr));
  min-width: 680px;
  border: 1px solid var(--line);
  border-right: 0;
  border-bottom: 0;
}
.public-calendar-weekday {
  text-align: center;
  padding: 8px;
  color: var(--muted);
  font-size: 11px;
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.public-calendar-day {
  min-height: 95px;
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  padding: 6px;
  font-size: 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.public-calendar-day > span {
  padding: 0 2px;
}
.public-calendar-day.outside {
  background: var(--surface);
  color: var(--muted);
}
.public-calendar-day button,
.public-database-undated button {
  font-size: 10px;
  min-height: 0;
  padding: 4px 6px;
  text-align: left;
  justify-content: flex-start;
  white-space: normal;
  background: var(--surface);
}
.public-database-undated {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11px;
  margin-top: 14px;
  align-items: center;
}
.public-database-undated > span {
  color: var(--muted);
  margin-right: 4px;
}
@media (max-width: 600px) {
  .public-record-properties > div {
    grid-template-columns: 100px minmax(0, 1fr);
    gap: 12px;
  }
  .public-database-list-row {
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 8px;
  }
  .public-database-list-row > .public-record-title {
    flex-basis: 100%;
  }
  .public-database-lane {
    min-width: 220px;
  }
}
</style>

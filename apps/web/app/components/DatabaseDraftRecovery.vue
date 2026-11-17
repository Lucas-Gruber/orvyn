<script setup lang="ts">
import type { DatabaseRecord, Property } from "@orvyn/shared";
import type { DatabaseDraft } from "../composables/useDatabaseDrafts";
import { formatDatabaseValue, propertyIcon } from "../utils/databaseFields";
defineProps<{
  entries: DatabaseDraft[];
  properties: Property[];
  people: { id: string; email: string }[];
  databaseId: string;
}>();
const emit = defineEmits<{
  stage: [record: DatabaseRecord, values: Record<string, unknown>];
  commit: [record: DatabaseRecord, values: Record<string, unknown>];
  retry: [id: string];
  discard: [id: string];
}>();
</script>
<template>
  <section
    v-for="entry in entries"
    :key="entry.record.pageId"
    class="draft-record"
    :aria-label="'Unsaved changes for ' + entry.current.title"
    :aria-busy="entry.saving"
  >
    <header>
      <AppIcon name="file" :size="16" />
      <h3>{{ entry.current.title }}</h3>
      <span v-if="entry.saving" role="status">Saving…</span>
    </header>
    <p v-if="entry.error" role="alert">{{ entry.error }}</p>
    <div
      v-for="property in properties.filter((p) =>
        Object.hasOwn(entry.values, p.id),
      )"
      :key="property.id"
      class="draft-field"
    >
      <div class="draft-field-name">
        <AppIcon :name="propertyIcon(property)" :size="14" />{{ property.name }}
      </div>
      <div class="draft-field-value">
        <DatabaseRelationField
          v-if="property.type === 'Relation'"
          :property="property"
          :database-id="databaseId"
          :records="entry.current.relations || []"
          :model-value="entry.values[property.id]"
          :can-edit="entry.current.accessRank >= 30"
          :disabled="entry.saving"
          @update:model-value="
            emit('commit', entry.record, { [property.id]: $event })
          "
        />
        <DatabaseFilesField
          v-else-if="property.type === 'Files'"
          :name="property.name"
          :files="entry.current.files || []"
          :model-value="entry.values[property.id]"
          :can-edit="entry.current.accessRank >= 30"
          :disabled="entry.saving"
          hide-manage
          @draft="emit('stage', entry.record, { [property.id]: $event })"
          @update:model-value="
            emit('commit', entry.record, { [property.id]: $event })
          "
        />
        <DatabaseFieldInput
          v-else
          :property="property"
          :people="people"
          :database-id="databaseId"
          :model-value="entry.values[property.id]"
          :disabled="entry.saving || entry.current.accessRank < 30"
          @draft="emit('stage', entry.record, { [property.id]: $event })"
          @update:model-value="
            emit('commit', entry.record, { [property.id]: $event })
          "
        />
        <small v-if="entry.conflict"
          >Saved value:
          {{
            formatDatabaseValue(entry.current, property, people) || "Empty"
          }}</small
        >
      </div>
    </div>
    <div class="draft-actions">
      <button
        v-if="entry.current.accessRank >= 30"
        type="button"
        class="ghost"
        :disabled="entry.saving"
        @click="emit('retry', entry.record.pageId)"
      >
        <AppIcon name="check" :size="14" />{{
          entry.conflict ? "Keep my changes" : "Retry saving"
        }}
      </button>
      <button
        type="button"
        class="ghost"
        :disabled="entry.saving"
        @click="emit('discard', entry.record.pageId)"
      >
        Discard changes
      </button>
    </div>
  </section>
</template>
<style scoped>
.draft-record {
  padding: 16px;
  border-top: 1px solid var(--line);
}
.draft-field-value :deep(input:not([type="checkbox"])) {
  background: transparent;
  border: 1px solid transparent;
  min-height: 34px;
  padding: 6px 8px;
  font-size: 14px;
}
.draft-field-value :deep(input:hover) {
  background: var(--surface-hover);
}
.draft-field-value :deep(input:focus) {
  border-color: var(--accent);
}
.draft-record > header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.draft-record h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.draft-record header > span {
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
}
.draft-record > p {
  color: var(--warning);
  font-size: 13px;
  line-height: 1.6;
}
.draft-field {
  display: grid;
  grid-template-columns: 140px minmax(0, 1fr);
  gap: 12px;
  margin-block: 6px;
}
.draft-field-name {
  display: flex;
  gap: 7px;
  align-items: center;
  font-size: 13px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.draft-field-value {
  min-width: 0;
}
.draft-field-value > small {
  display: block;
  color: var(--muted);
  margin-top: 5px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.draft-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}
.draft-actions > button {
  min-height: 30px;
  font-size: 13px;
}
@media (max-width: 600px) {
  .draft-field {
    grid-template-columns: 100px minmax(0, 1fr);
    gap: 8px;
  }
}
</style>

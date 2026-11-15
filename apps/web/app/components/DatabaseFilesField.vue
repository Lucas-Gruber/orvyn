<script setup lang="ts">
const props = defineProps<{
    name: string;
    files: { id: string; filename: string; mediaType: string; size: number }[];
    modelValue: unknown;
    canEdit: boolean;
    disabled?: boolean;
  }>(),
  emit = defineEmits<{ "update:modelValue": [value: string[]]; manage: [] }>();
const selected = computed(() =>
    Array.isArray(props.modelValue) ? (props.modelValue as string[]) : [],
  ),
  linked = computed(() =>
    props.files.filter((file) => selected.value.includes(file.id)),
  );
</script>
<template>
  <div class="record-files">
    <ul v-if="linked.length">
      <li v-for="file in linked" :key="file.id">
        <a :href="'/api/v1/files/' + file.id + '/download'">{{
          file.filename
        }}</a
        ><small> · {{ Intl.NumberFormat().format(file.size) }} bytes</small>
      </li>
    </ul>
    <span v-else>No files selected</span>
    <label v-if="canEdit"
      >{{ name
      }}<select
        :aria-label="name"
        multiple
        :disabled="disabled"
        @change="
          emit(
            'update:modelValue',
            Array.from(
              ($event.target as HTMLSelectElement).selectedOptions,
            ).map((o) => o.value),
          )
        "
      >
        <option
          v-for="file in files"
          :key="file.id"
          :value="file.id"
          :selected="selected.includes(file.id)"
        >
          {{ file.filename }}
        </option>
      </select></label
    >
    <button type="button" :disabled="disabled" @click="emit('manage')">
      {{ canEdit ? "Manage record attachments" : "Open record attachments" }}
    </button>
  </div>
</template>
<style scoped>
.record-files {
  display: grid;
  gap: 0.4rem;
  min-width: 12rem;
}
.record-files ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.record-files label {
  display: grid;
  gap: 0.25rem;
}
.record-files small {
  color: var(--muted);
}
</style>

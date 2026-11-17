<script setup lang="ts">
const props = defineProps<{
    name: string;
    files: { id: string; filename: string; mediaType: string; size: number }[];
    modelValue: unknown;
    canEdit: boolean;
    disabled?: boolean;
    hideManage?: boolean;
  }>(),
  emit = defineEmits<{
    "update:modelValue": [value: string[]];
    draft: [value: string[]];
    manage: [];
  }>();
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
        }}</a><small>
          · {{ Intl.NumberFormat().format(file.size) }} bytes</small
        >
      </li>
    </ul>
    <UiMultiSelect
      v-if="canEdit"
      :label="name"
      :options="files.map((file) => ({ id: file.id, label: file.filename }))"
      :model-value="selected"
      :disabled="disabled"
      @draft="emit('draft', $event)"
      @update:model-value="emit('update:modelValue', $event)"
    />
    <span v-else-if="!linked.length" class="field-empty">Empty</span>
    <button
      v-if="!hideManage"
      class="ghost attachment-action"
      type="button"
      :disabled="disabled"
      :aria-label="
        canEdit ? 'Manage record attachments' : 'Open record attachments'
      "
      @click="emit('manage')"
    >
      <AppIcon name="paperclip" :size="13" />{{
        canEdit ? "Attachments" : "Open attachments"
      }}
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
.record-files {
  min-width: 10rem;
  gap: 3px;
}
.record-files a {
  color: var(--text);
  font-size: 12px;
}
.record-files small {
  display: none;
}
.attachment-action {
  font-size: 11px;
  color: var(--muted);
  justify-content: flex-start;
  padding: 3px 6px;
  min-height: 25px;
  width: fit-content;
}
</style>

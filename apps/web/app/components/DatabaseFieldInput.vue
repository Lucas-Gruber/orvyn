<script setup lang="ts">
import type { Property } from "@orvyn/shared";
const props = defineProps<{
  property: Property;
  modelValue: unknown;
  id?: string;
  disabled?: boolean;
  people?: { id: string; email: string }[];
  databaseId?: string;
  emptyLabel?: string;
}>();
const options = computed(() =>
  props.property.type === "Person"
    ? [
        ...(props.people || []).map((person) => ({
          id: person.id,
          label: person.email,
        })),
        ...(Array.isArray(props.modelValue) ? props.modelValue : [])
          .filter((id) => !props.people?.some((p) => p.id === id))
          .map((id) => ({ id, label: "Former member" })),
      ]
    : props.property.config.options || [],
);
const selectedOption = computed(() =>
  props.property.config.options?.find(
    (option) => option.id === props.modelValue,
  ),
);
const focused = ref(false),
  editingValue = ref(""),
  editingDate = ref(false),
  dateInput = ref<HTMLInputElement>();
async function editDate() {
  editingDate.value = true;
  await nextTick();
  dateInput.value?.focus();
}
const emit = defineEmits<{
  "update:modelValue": [value: unknown];
  draft: [value: unknown];
}>();
function inputValue(value: string) {
  return props.property.type === "Number"
    ? value === ""
      ? null
      : Number(value)
    : value || null;
}
function draftInput(event: Event) {
  editingValue.value = (event.target as HTMLInputElement).value;
  emit("draft", inputValue(editingValue.value));
}
usePendingWrites(async () => {
  if (focused.value && !props.disabled) {
    const value = inputValue(editingValue.value);
    if (JSON.stringify(value) !== JSON.stringify(props.modelValue ?? null))
      emit("update:modelValue", value);
  }
});
function changed(event: Event) {
  const input = event.target as HTMLInputElement;
  if (props.property.type === "Checkbox")
    emit("update:modelValue", input.checked);
  else if (props.property.type === "Number")
    emit("update:modelValue", input.value === "" ? null : Number(input.value));
  else emit("update:modelValue", input.value || null);
}
const inputType = computed(
  () =>
    (
      ({
        Number: "number",
        Date: "date",
        Email: "email",
        Phone: "tel",
        URL: "url",
      }) as Record<string, string>
    )[props.property.type] || "text",
);
</script>
<template>
  <DatabaseRelationField
    v-if="property.type === 'Relation'"
    :property="property"
    :database-id="databaseId"
    :model-value="modelValue"
    can-edit
    :disabled="disabled"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <input
    v-else-if="property.type === 'Checkbox'"
    :id="id"
    :aria-label="property.name"
    type="checkbox"
    :checked="modelValue === true"
    :disabled="disabled"
    @change="changed"
  /><span
    v-else-if="['Select', 'Status'].includes(property.type)"
    class="single-select-field"
    :class="{ 'is-disabled': disabled }"
  >
    <span
      aria-hidden="true"
      :class="selectedOption ? 'single-select-chip' : 'field-empty'"
      :data-color="selectedOption?.color"
    >
      <span
        v-if="selectedOption && property.type === 'Status'"
        class="status-dot"
      />{{ selectedOption?.label || emptyLabel || "Empty" }}
    </span>
    <select
      :id="id"
      :aria-label="property.name"
      :value="modelValue || ''"
      :disabled="disabled"
      @change="changed"
    >
      <option value="">{{ emptyLabel || "Unassigned" }}</option>
      <option v-for="option in options" :key="option.id" :value="option.id">
        {{ option.label }}
      </option>
    </select> </span
  ><UiMultiSelect
    v-else-if="['MultiSelect', 'Person'].includes(property.type)"
    :id="id"
    :label="property.name"
    :options="options"
    :person="property.type === 'Person'"
    :model-value="Array.isArray(modelValue) ? modelValue : []"
    :disabled="disabled"
    @draft="emit('draft', $event)"
    @update:model-value="emit('update:modelValue', $event)"
  /><button
    v-else-if="
      property.type === 'Date' && emptyLabel && !modelValue && !editingDate
    "
    type="button"
    :id="id"
    :aria-label="property.name + ' (empty)'"
    class="empty-date-field"
    :disabled="disabled"
    @click="editDate"
  >
    {{ emptyLabel }}</button
  ><input
    v-else
    ref="dateInput"
    :id="id"
    :aria-label="property.name"
    :type="inputType"
    :placeholder="emptyLabel"
    :value="focused ? editingValue : (modelValue ?? '')"
    :disabled="disabled"
    :step="inputType === 'number' ? 'any' : undefined"
    maxlength="10000"
    @focus="
      focused = true;
      editingValue = ($event.target as HTMLInputElement).value;
    "
    @input="draftInput"
    @blur="
      focused = false;
      editingDate = false;
    "
    @change="changed"
  />
</template>
<style scoped>
.single-select-field {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 34px;
  width: 100%;
  padding: 5px 8px;
  border-radius: 4px;
  font-size: 14px;
}
.single-select-field:hover {
  background: var(--surface-hover);
}
.single-select-field:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.single-select-field select {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}
.single-select-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 7px;
  max-width: 100%;
  border-radius: 4px;
  background: var(--surface-hover);
  color: var(--text);
  line-height: 22px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.single-select-chip[data-color="violet"] {
  background: color-mix(in srgb, #9470ce 18%, var(--bg));
}
.single-select-chip[data-color="green"] {
  background: color-mix(in srgb, #549d76 18%, var(--bg));
}
.single-select-chip[data-color="blue"] {
  background: color-mix(in srgb, #528fce 18%, var(--bg));
}
.single-select-chip[data-color="amber"] {
  background: color-mix(in srgb, #bf9950 18%, var(--bg));
}
.field-empty {
  color: var(--faint);
}
.is-disabled {
  opacity: 0.5;
}
.empty-date-field {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 8px;
  min-height: 32px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--faint);
  font-size: 14px;
  font-weight: 400;
}
.empty-date-field:hover {
  background: var(--surface-hover);
}
</style>

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
const focused = ref(false),
  editingValue = ref(""),
  editingDate = ref(false),
  dateInput = ref<HTMLInputElement>();
async function editDate() {
  editingDate.value = true;
  await nextTick();
  dateInput.value?.focus();
}
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();
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
  /><select
    v-else-if="['Select', 'Status'].includes(property.type)"
    :id="id"
    :aria-label="property.name"
    :value="modelValue || ''"
    :disabled="disabled"
    @change="changed"
  >
    <option value="">{{ emptyLabel || "Unassigned" }}</option>
    <option v-for="option in options" :key="option.id" :value="option.id">
      {{ option.label }}
    </option></select
  ><UiMultiSelect
    v-else-if="['MultiSelect', 'Person'].includes(property.type)"
    :id="id"
    :label="property.name"
    :options="options"
    :person="property.type === 'Person'"
    :model-value="Array.isArray(modelValue) ? modelValue : []"
    :disabled="disabled"
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
    @input="editingValue = ($event.target as HTMLInputElement).value"
    @blur="
      focused = false;
      editingDate = false;
    "
    @change="changed"
  />
</template>
<style scoped>
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
  font-size: 0.82rem;
  font-weight: 400;
}
.empty-date-field:hover {
  background: var(--surface-hover);
}
</style>

<script setup lang="ts">
import type { Property } from "@orvyn/shared";
const props = defineProps<{
  property: Property;
  modelValue: unknown;
  id?: string;
  disabled?: boolean;
  people?: { id: string; email: string }[];
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
  editingValue = ref("");
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
  <input
    v-if="property.type === 'Checkbox'"
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
    <option value="">Unassigned</option>
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
  /><input
    v-else
    :id="id"
    :aria-label="property.name"
    :type="inputType"
    :value="focused ? editingValue : (modelValue ?? '')"
    :disabled="disabled"
    :step="inputType === 'number' ? 'any' : undefined"
    maxlength="10000"
    @focus="
      focused = true;
      editingValue = ($event.target as HTMLInputElement).value;
    "
    @input="editingValue = ($event.target as HTMLInputElement).value"
    @blur="focused = false"
    @change="changed"
  />
</template>

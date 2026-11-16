<script setup lang="ts">
import { parseFormula, formulaType, type Property } from "@orvyn/shared";
const props = defineProps<{
    modelValue: string;
    properties: Property[];
    disabled?: boolean;
  }>(),
  emit = defineEmits<{ "update:modelValue": [value: string] }>(),
  id = useId(),
  input = ref<HTMLTextAreaElement>();
const validation = computed(() => {
  if (!props.modelValue.trim()) return { type: "", error: "" };
  try {
    const expression = parseFormula(props.modelValue, props.properties),
      type = formulaType(expression, props.properties);
    return type === "list"
      ? {
          type: "",
          error:
            "Use length() or empty() to return a number or boolean from a list.",
        }
      : { type: type === "null" ? "Empty" : type, error: "" };
  } catch (e: any) {
    return { type: "", error: e.message };
  }
});
async function insert(property: Property) {
  const start = input.value?.selectionStart ?? props.modelValue.length,
    end = input.value?.selectionEnd ?? start,
    text = `prop(${JSON.stringify(property.name)})`;
  emit(
    "update:modelValue",
    props.modelValue.slice(0, start) + text + props.modelValue.slice(end),
  );
  await nextTick();
  input.value?.focus();
  input.value?.setSelectionRange(start + text.length, start + text.length);
}
</script>
<template>
  <div class="formula-editor">
    <label :for="id">Formula expression</label>
    <textarea
      :id="id"
      ref="input"
      :value="modelValue"
      :disabled="disabled"
      :aria-invalid="!!validation.error"
      :aria-describedby="id + '-help'"
      required
      maxlength="2000"
      rows="4"
      spellcheck="false"
      placeholder='prop("Hours") * prop("Rate")'
      @input="
        emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)
      "
    />
    <p v-if="validation.error" class="error" role="alert">
      {{ validation.error }}
    </p>
    <p v-else-if="validation.type" class="formula-result" role="status">
      Result: {{ validation.type }}
    </p>
    <p :id="id + '-help'" class="formula-help">
      Use properties, + − * /, comparisons, if(), coalesce(), round(), concat(),
      length() and empty(). Results update automatically.
    </p>
    <div
      class="formula-properties"
      aria-label="Insert a property into the formula"
    >
      <button
        v-for="property in properties"
        :key="property.id"
        type="button"
        :disabled="disabled"
        :title="'Insert ' + property.name"
        @click="insert(property)"
      >
        {{ property.name }}
      </button>
    </div>
  </div>
</template>
<style scoped>
.formula-editor {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.formula-editor textarea {
  resize: vertical;
  font-family: var(--font-mono, monospace);
  font-size: 0.84rem;
  line-height: 1.65;
}
.formula-help,
.formula-result,
.formula-editor .error {
  font-size: 0.78rem;
  margin: 0;
}
.formula-help {
  color: var(--muted);
  line-height: 1.6;
}
.formula-result {
  color: var(--accent);
}
.formula-properties {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.formula-properties button {
  min-height: 25px;
  font-size: 0.72rem;
  padding: 3px 8px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 5px;
}
</style>

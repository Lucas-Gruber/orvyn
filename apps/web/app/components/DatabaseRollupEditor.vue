<script setup lang="ts">
import {
  rollupAggregations,
  rollupTargetSupported,
  type Property,
  type RollupConfig,
} from "@orvyn/shared";
const props = defineProps<{
    modelValue: RollupConfig;
    properties: Property[];
    databaseId: string;
    disabled?: boolean;
  }>(),
  emit = defineEmits<{ "update:modelValue": [value: RollupConfig] }>(),
  id = useId(),
  targets = ref<Property[]>([]),
  loading = ref(false),
  error = ref("");
const names: Record<string, string> = {
    count: "Count records",
    sum: "Sum",
    average: "Average",
    min: "Minimum",
    max: "Maximum",
    countValues: "Count nonempty values",
    unique: "Count unique values",
  },
  relations = computed(() =>
    props.properties.filter((p) => p.type === "Relation"),
  ),
  compatible = computed(() =>
    targets.value.filter((p) =>
      rollupTargetSupported(p, targets.value, props.modelValue.aggregation),
    ),
  );
let generation = 0,
  disposed = false;
function update(patch: Partial<RollupConfig>) {
  emit("update:modelValue", { ...props.modelValue, ...patch });
}
function relation(event: Event) {
  update({
    relationId: (event.target as HTMLSelectElement).value,
    targetPropertyId: undefined,
  });
}
function calculation(event: Event) {
  const aggregation = (event.target as HTMLSelectElement)
      .value as RollupConfig["aggregation"],
    target = targets.value.find(
      (p) => p.id === props.modelValue.targetPropertyId,
    );
  update({
    aggregation,
    targetPropertyId:
      aggregation === "count"
        ? undefined
        : loading.value
          ? props.modelValue.targetPropertyId
          : target && rollupTargetSupported(target, targets.value, aggregation)
            ? target.id
            : undefined,
  });
}
watch(
  () => props.modelValue.relationId,
  async (relationId) => {
    const token = ++generation;
    targets.value = [];
    error.value = "";
    if (!relationId) {
      loading.value = false;
      return;
    }
    loading.value = true;
    try {
      const data = await $fetch<any>(
        `/api/v1/databases/${props.databaseId}/properties/${relationId}/target-properties`,
      );
      if (!disposed && token === generation) {
        targets.value = data.properties;
        const selected = targets.value.find(
          (p) => p.id === props.modelValue.targetPropertyId,
        );
        if (
          props.modelValue.targetPropertyId &&
          (!selected ||
            !rollupTargetSupported(
              selected,
              targets.value,
              props.modelValue.aggregation,
            ))
        )
          update({ targetPropertyId: undefined });
      }
    } catch (e: any) {
      if (!disposed && token === generation)
        error.value = e.data?.message || "Related fields could not be loaded.";
    } finally {
      if (token === generation) loading.value = false;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
  generation++;
});
</script>
<template>
  <div class="rollup-editor">
    <label :for="id + '-relation'">Relation property</label>
    <select
      :id="id + '-relation'"
      :value="modelValue.relationId"
      required
      :disabled="disabled"
      @change="relation"
    >
      <option value="" disabled>Choose a relation</option>
      <option
        v-for="property in relations"
        :key="property.id"
        :value="property.id"
      >
        {{ property.name }}
      </option>
    </select>
    <p v-if="!relations.length" class="rollup-help">
      Add a Relation property to connect records first.
    </p>
    <label :for="id + '-calculation'">Calculation</label>
    <select
      :id="id + '-calculation'"
      :value="modelValue.aggregation"
      :disabled="disabled"
      @change="calculation"
    >
      <option
        v-for="aggregation in rollupAggregations"
        :key="aggregation"
        :value="aggregation"
      >
        {{ names[aggregation] }}
      </option>
    </select>
    <template v-if="modelValue.aggregation !== 'count'"
      ><label :for="id + '-target'">Related property</label
      ><select
        :id="id + '-target'"
        :value="modelValue.targetPropertyId || ''"
        required
        :disabled="disabled || loading"
        @change="
          update({
            targetPropertyId:
              ($event.target as HTMLSelectElement).value || undefined,
          })
        "
      >
        <option value="" disabled>Choose a compatible field</option>
        <option
          v-for="property in compatible"
          :key="property.id"
          :value="property.id"
        >
          {{ property.name }}
        </option>
      </select></template
    >
    <p v-if="loading" role="status" class="rollup-help">
      Loading related fields…
    </p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p class="rollup-help">
      Calculates from records you can currently read. Numbers and local numeric
      formulas support sums and averages.
    </p>
  </div>
</template>
<style scoped>
.rollup-editor {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.rollup-help,
.rollup-editor .error {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.6;
}
.rollup-help {
  color: var(--muted);
}
</style>

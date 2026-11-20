<script setup lang="ts">
import {
  missingPublicationInputs,
  retainPublicationFields,
} from "../../utils/publicationFields";
import type { PublicationInput } from "@orvyn/shared";
type Selection = PublicationInput["scope"]["records"][number];
const props = defineProps<{
    rootId: string;
    scope: Selection;
    busy: boolean;
  }>(),
  emit = defineEmits<{ change: [value: Selection] }>(),
  catalog = ref<any>(),
  error = ref("");
let alive = true;
function choose(id: string, checked: boolean) {
  const property = catalog.value?.properties.find(
    (property: any) => property.id === id,
  );
  if (!property?.allowed || property.required) return;
  emit("change", {
    recordId: props.scope.recordId,
    propertyIds: retainPublicationFields(
      checked
        ? [...props.scope.propertyIds, id]
        : props.scope.propertyIds.filter((value) => value !== id),
      catalog.value?.properties || [],
    ),
  });
}
onMounted(async () => {
  try {
    const result = await $fetch<any>(
      "/api/v1/pages/" +
        props.rootId +
        "/publications/records/" +
        props.scope.recordId,
    );
    if (!alive) return;
    catalog.value = result;
    const fields = retainPublicationFields(
      [
        ...new Set([
          ...props.scope.propertyIds.filter((id) =>
            result.properties.some(
              (property: any) => property.id === id && property.allowed,
            ),
          ),
          ...result.properties
            .filter((property: any) => property.required)
            .map((property: any) => property.id),
        ]),
      ] as string[],
      result.properties,
    );
    if (JSON.stringify(fields) !== JSON.stringify(props.scope.propertyIds))
      emit("change", { recordId: props.scope.recordId, propertyIds: fields });
  } catch (e: any) {
    if (alive)
      error.value = e.data?.message || "Could not load the record properties.";
  }
});
onBeforeUnmount(() => (alive = false));
</script>
<template>
  <section class="publication-record-scope">
    <header>
      <AppIcon name="file" :size="17" /><strong>{{
        catalog?.title || "Record page"
      }}</strong>
    </header>
    <p>
      Select the properties to share alongside this page’s content. The parent
      database and other items stay private.
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="publication-record-fields">
      <label
        v-for="property in catalog?.properties"
        :key="property.id"
        :class="{ unavailable: !property.allowed }"
        ><input
          type="checkbox"
          :checked="scope.propertyIds.includes(property.id)"
          :disabled="
            busy ||
            !property.allowed ||
            property.required ||
            missingPublicationInputs(property, scope.propertyIds).length > 0
          "
          @change="
            choose(property.id, ($event.target as HTMLInputElement).checked)
          "
        /><span
          >{{ property.name
          }}<small v-if="property.required">Page title · Required</small
          ><small v-else-if="!property.allowed">{{
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
          ></span
        ></label
      >
    </div>
  </section>
</template>
<style scoped>
.publication-record-scope {
  border: 1px solid var(--line);
  border-radius: 7px;
  margin: 16px 0;
  padding: 14px;
  background: var(--panel);
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 12px;
}
header strong {
  font-weight: 500;
  overflow-wrap: anywhere;
}
p {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.65;
  margin: 12px 0;
}
.publication-record-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.publication-record-fields label {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: 11px;
  cursor: pointer;
}
.publication-record-fields label.unavailable {
  color: var(--muted);
}
input {
  width: 13px;
  height: 13px;
  accent-color: var(--accent);
  flex-shrink: 0;
  margin: 2px 0 0;
}
small {
  display: block;
  color: var(--muted);
  font-size: 10px;
  line-height: 1.5;
  margin-top: 2px;
}
</style>

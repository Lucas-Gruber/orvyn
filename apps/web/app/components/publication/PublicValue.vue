<script setup lang="ts">
import type {
  PublicProperty,
  PublicValue,
  PublicationSnapshot,
} from "@orvyn/shared";
const props = defineProps<{
    property: PublicProperty;
    value?: PublicValue;
    snapshot: PublicationSnapshot;
    fileUrl: (id: string) => string;
    interactive?: boolean;
  }>(),
  emit = defineEmits<{ open: [id: string] }>();
const values = computed(() =>
  Array.isArray(props.value)
    ? props.value
    : props.value === null || props.value === undefined
      ? []
      : [String(props.value)],
);
const option = (id: string) =>
  props.property.options?.find((option) => option.id === id);
const record = (id: string) => {
  const document = props.snapshot.pages.find(
    (page) => page.id === id && page.record,
  );
  if (document?.record)
    return {
      pageId: document.id,
      title: document.title,
      values: document.record.values,
    };
  return props.snapshot.pages
    .flatMap((page) => page.database?.records || [])
    .find((record) => record.pageId === id);
};
const recordHref = (id: string) => {
  if (props.snapshot.pages.some((page) => page.id === id)) return "?page=" + id;
  const owner = props.snapshot.pages.find((page) =>
    page.database?.records.some((record) => record.pageId === id),
  );
  return owner ? "?page=" + owner.id + "#r-" + id : "";
};
function follow(event: MouseEvent, id: string) {
  if (props.interactive) {
    event.preventDefault();
    event.stopPropagation();
    emit("open", id);
  }
}
const file = (id: string) =>
  props.snapshot.files.find((file) => file.id === id);
const href = computed(() => {
  if (typeof props.value !== "string" || !props.value) return "";
  if (props.property.type === "Email")
    return "mailto:" + encodeURIComponent(props.value);
  if (props.property.type === "Phone")
    return "tel:" + encodeURIComponent(props.value);
  try {
    const url = new URL(props.value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
});
</script>
<template>
  <span
    v-if="['Select', 'MultiSelect', 'Status'].includes(property.type)"
    class="public-value-tags"
    ><span
      v-for="id in values.filter((id) => option(String(id)))"
      :key="String(id)"
      :class="'public-option public-option-' + option(String(id))?.color"
      >{{ option(String(id))?.label }}</span
    ></span
  >
  <span
    v-else-if="
      property.type === 'Checkbox' ||
      (property.type === 'Formula' && property.resultType === 'boolean')
    "
    class="public-value-check"
    :aria-label="value ? 'Checked' : 'Unchecked'"
    role="img"
    ><AppIcon v-if="value" name="check" :size="12"
  /></span>
  <span v-else-if="property.type === 'Relation'" class="public-value-links"
    ><component
      :is="interactive ? 'button' : 'a'"
      v-for="id in values.filter((id) => record(String(id)))"
      :key="String(id)"
      :type="interactive ? 'button' : undefined"
      :href="interactive ? undefined : recordHref(String(id))"
      @click="follow($event, String(id))"
    >
      <AppIcon name="file" :size="13" />{{ record(String(id))?.title }}
    </component></span
  >
  <span v-else-if="property.type === 'Files'" class="public-value-links"
    ><a
      v-for="id in values.filter((id) => file(String(id)))"
      :key="String(id)"
      :href="fileUrl(String(id))"
      @click.stop
      ><AppIcon name="paperclip" :size="13" />{{
        file(String(id))?.filename
      }}</a
    ></span
  >
  <a
    v-else-if="['URL', 'Email', 'Phone'].includes(property.type) && href"
    :href="href"
    rel="noopener noreferrer"
    target="_blank"
    @click.stop
    >{{ value }}</a
  >
  <span
    v-else-if="property.type.endsWith('Time') && typeof value === 'string'"
    >{{ new Date(value).toLocaleString() }}</span
  >
  <span v-else>{{ value === null || value === undefined ? "" : value }}</span>
</template>
<style scoped>
.public-value-tags,
.public-value-links {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  max-width: 100%;
}
.public-option {
  background: var(--surface);
  border-radius: 4px;
  padding: 1px 7px;
  line-height: 1.6;
  font-size: 11px;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}
.public-option-violet {
  background: #eae3f4;
  color: #5f4980;
}
.public-option-green {
  background: #e0efe4;
  color: #356246;
}
.public-option-blue {
  background: #dfeaf5;
  color: #3d6182;
}
.public-option-amber {
  background: #f6ebd0;
  color: #78602b;
}
.public-value-check {
  width: 15px;
  height: 15px;
  border: 1px solid var(--muted);
  border-radius: 3px;
  display: inline-flex;
  vertical-align: middle;
  align-items: center;
  justify-content: center;
}
.public-value-links :is(a, button) {
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 0;
  min-height: 0;
  padding: 0;
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 3px;
  white-space: normal;
  text-align: left;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
a {
  overflow-wrap: anywhere;
}
</style>

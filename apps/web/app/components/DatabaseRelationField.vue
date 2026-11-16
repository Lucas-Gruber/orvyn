<script setup lang="ts">
import type { Property } from "@orvyn/shared";
import { pageNavigationKey } from "../composables/pageNavigation";
import { pageLink } from "@orvyn/editor/links";
interface RelatedRecord {
  id: string;
  title: string;
  icon: string | null;
}
const props = defineProps<{
    property: Property;
    databaseId?: string;
    modelValue: unknown;
    records?: RelatedRecord[];
    canEdit: boolean;
    disabled?: boolean;
    single?: boolean;
  }>(),
  emit = defineEmits<{ "update:modelValue": [value: string[]] }>(),
  openPage = inject(pageNavigationKey),
  trigger = ref<HTMLButtonElement>(),
  panel = ref<HTMLElement>(),
  input = ref<HTMLInputElement>(),
  open = ref(false),
  query = ref(""),
  options = ref<RelatedRecord[]>([]),
  resolved = ref<RelatedRecord[]>([]),
  draft = ref<string[]>([]),
  loading = ref(false),
  error = ref("");
const selected = computed(() =>
    Array.isArray(props.modelValue) ? (props.modelValue as string[]) : [],
  ),
  linked = computed(() =>
    selected.value.flatMap((id) => {
      const record =
        props.records?.find((r) => r.id === id) ||
        resolved.value.find((r) => r.id === id);
      return record ? [record] : [];
    }),
  );
let generation = 0,
  disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
function position() {
  if (!open.value || !trigger.value || !panel.value) return;
  const rect = trigger.value.getBoundingClientRect(),
    width = Math.min(350, innerWidth - 24),
    below = innerHeight - rect.bottom,
    above = below < 240 && rect.top > 220;
  Object.assign(panel.value.style, {
    width: width + "px",
    maxHeight:
      Math.min(400, Math.max(160, above ? rect.top - 18 : below - 18)) + "px",
    left: Math.max(12, Math.min(rect.left, innerWidth - width - 12)) + "px",
    top: above ? "auto" : rect.bottom + 6 + "px",
    bottom: above ? innerHeight - rect.top + 6 + "px" : "auto",
  });
}
async function load() {
  if (!props.databaseId) return;
  const token = ++generation;
  loading.value = true;
  error.value = "";
  options.value = [];
  try {
    const data = await $fetch<any>(
      `/api/v1/databases/${props.databaseId}/properties/${props.property.id}/records`,
      {
        query: {
          q: open.value ? query.value : "",
          ids: selected.value.join(","),
        },
      },
    );
    if (disposed || token !== generation) return;
    resolved.value = data.records;
    options.value = open.value ? data.records : [];
  } catch (e: any) {
    if (!disposed && token === generation) {
      resolved.value = [];
      options.value = [];
      error.value = e.data?.message || "Related records could not be loaded.";
    }
  } finally {
    if (token === generation) loading.value = false;
  }
}
async function toggle() {
  if (open.value) {
    panel.value?.hidePopover();
    return;
  }
  draft.value = [...selected.value];
  query.value = "";
  error.value = "";
  open.value = true;
  panel.value?.showPopover();
  await nextTick();
  position();
  input.value?.focus();
  void load();
}
function pick(id: string) {
  if (props.disabled) return;
  if (draft.value.includes(id))
    draft.value = draft.value.filter((value) => value !== id);
  else if (props.single) draft.value = [id];
  else if (draft.value.length < 50) draft.value = [...draft.value, id];
  else error.value = "Choose up to 50 visible records at a time.";
}
function save() {
  emit("update:modelValue", [...draft.value]);
  panel.value?.hidePopover();
}
function visit(event: MouseEvent, record: RelatedRecord) {
  if (
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    !openPage
  )
    return;
  event.preventDefault();
  openPage(record.id);
}
function keys(event: KeyboardEvent) {
  if (event.key === "Enter" && event.target === input.value) {
    event.preventDefault();
    if (options.value[0]) pick(options.value[0].id);
    return;
  }
  if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
  event.preventDefault();
  const buttons = [
      ...(panel.value?.querySelectorAll<HTMLButtonElement>('[role="option"]') ||
        []),
    ],
    at = buttons.indexOf(document.activeElement as HTMLButtonElement),
    next =
      at < 0
        ? event.key === "ArrowDown"
          ? 0
          : buttons.length - 1
        : (at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
          buttons.length;
  buttons[next]?.focus();
  buttons[next]?.scrollIntoView({ block: "nearest" });
}
watch(
  () => props.canEdit,
  (canEdit) => {
    if (!canEdit) {
      panel.value?.hidePopover();
      open.value = false;
      generation++;
      clearTimeout(timer);
      loading.value = false;
      options.value = [];
    }
  },
);
watch(query, () => {
  if (!open.value) return;
  clearTimeout(timer);
  generation++;
  options.value = [];
  loading.value = true;
  timer = setTimeout(() => void load(), 160);
});
watch(
  () => JSON.stringify(selected.value),
  () => {
    if (open.value) {
      draft.value = [...selected.value];
      void load();
    } else if (
      selected.value.some((id) => !props.records?.some((r) => r.id === id))
    )
      void load();
  },
);
watch(
  () => JSON.stringify(props.records || []),
  () => {
    if (open.value) void load();
  },
);
onMounted(() => {
  if (selected.value.some((id) => !props.records?.some((r) => r.id === id)))
    void load();
  window.addEventListener("resize", position);
  window.addEventListener("scroll", position, true);
});
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  clearTimeout(timer);
  window.removeEventListener("resize", position);
  window.removeEventListener("scroll", position, true);
});
</script>
<template>
  <div class="record-relations">
    <ul v-if="linked.length">
      <li v-for="record in linked" :key="record.id">
        <a :href="pageLink(record.id)" @click="visit($event, record)"
          ><PageSymbol :icon="record.icon" kind="record" :size="14" /><span>{{
            record.title
          }}</span></a
        >
      </li>
    </ul>
    <button
      v-if="canEdit"
      ref="trigger"
      type="button"
      class="ghost relation-trigger"
      :aria-label="property.name"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :disabled="disabled || !databaseId"
      @click="toggle"
    >
      <AppIcon name="link" :size="13" />{{
        linked.length ? "Edit links" : "Add relation"
      }}</button
    ><span v-else-if="!linked.length" class="field-empty">Empty</span>
    <div
      v-if="canEdit"
      ref="panel"
      popover="auto"
      role="dialog"
      :aria-label="property.name + ' links'"
      class="relation-panel"
      @toggle="open = ($event as ToggleEvent).newState === 'open'"
      @keydown="keys"
    >
      <header>
        <AppIcon name="search" :size="14" /><input
          ref="input"
          v-model="query"
          :aria-label="'Search ' + property.name"
          placeholder="Search related records…"
          autocomplete="off"
        />
      </header>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="loading" class="relation-hint" role="status">
        Loading related records…
      </p>
      <div
        role="listbox"
        :aria-label="property.name + ' records'"
        :aria-multiselectable="!single"
      >
        <button
          v-for="record in options"
          :key="record.id"
          type="button"
          role="option"
          :aria-selected="draft.includes(record.id)"
          :disabled="disabled"
          @click="pick(record.id)"
        >
          <AppIcon
            :name="draft.includes(record.id) ? 'check' : 'file'"
            :size="14"
          /><span>{{ record.title }}</span>
        </button>
        <p v-if="!loading && !error && !options.length" class="relation-hint">
          No matching readable records.
        </p>
      </div>
      <footer>
        <button type="button" class="ghost" @click="panel?.hidePopover()">
          Cancel</button
        ><button
          type="button"
          class="primary"
          :disabled="disabled || loading"
          @click="save"
        >
          Apply links
        </button>
      </footer>
    </div>
  </div>
</template>
<style scoped>
.record-relations {
  min-width: 10rem;
  display: grid;
  gap: 3px;
}
.record-relations ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 3px;
}
.record-relations a {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text);
  max-width: 220px;
  font-size: 0.78rem;
  text-decoration: none;
}
.record-relations a:hover {
  color: var(--accent);
}
.record-relations a span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.relation-trigger {
  font-size: 0.7rem;
  padding: 3px 6px;
  min-height: 25px;
  justify-content: flex-start;
  color: var(--muted);
  width: fit-content;
}
.relation-panel {
  position: fixed;
  margin: 0;
  padding: 0;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--elevated);
  color: var(--text);
  box-shadow: var(--shadow);
}
.relation-panel header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border-bottom: 1px solid var(--line);
  position: sticky;
  top: 0;
  background: var(--elevated);
}
.relation-panel input {
  border: 0;
  background: transparent;
  box-shadow: none;
  padding: 4px;
  min-width: 0;
}
.relation-panel [role="listbox"] {
  padding: 5px;
}
.relation-panel [role="option"] {
  width: 100%;
  border: 0;
  background: transparent;
  text-align: left;
  justify-content: flex-start;
  gap: 8px;
  font-size: 0.8rem;
}
.relation-panel [role="option"] span {
  overflow-wrap: anywhere;
}
.relation-panel [aria-selected="true"] {
  background: var(--accent-soft);
  color: var(--accent);
}
.relation-hint,
.relation-panel .error {
  font-size: 0.75rem;
  padding: 8px 10px;
}
.relation-panel footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px;
  border-top: 1px solid var(--line);
  position: sticky;
  bottom: 0;
  background: var(--elevated);
}
.relation-panel footer button {
  font-size: 0.75rem;
}
</style>

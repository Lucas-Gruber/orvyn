<script setup lang="ts">
const props = defineProps<{
    id?: string;
    label: string;
    options: { id: string; label: string }[];
    modelValue: string[];
    disabled?: boolean;
    person?: boolean;
  }>(),
  emit = defineEmits<{ "update:modelValue": [value: string[]] }>(),
  uid = useId(),
  trigger = ref<HTMLButtonElement>(),
  panel = ref<HTMLElement>(),
  input = ref<HTMLInputElement>(),
  open = ref(false),
  query = ref("");
const filtered = computed(() =>
    props.options.filter((o) =>
      o.label.toLowerCase().includes(query.value.toLowerCase()),
    ),
  ),
  selected = computed(() =>
    props.options.filter((o) => props.modelValue.includes(o.id)),
  );
function position() {
  if (!open.value || !trigger.value || !panel.value) return;
  const rect = trigger.value.getBoundingClientRect(),
    width = Math.min(320, window.innerWidth - 24),
    below = window.innerHeight - rect.bottom,
    height = Math.min(
      300,
      Math.max(160, below < 220 ? rect.top - 16 : below - 16),
    );
  Object.assign(panel.value.style, {
    width: width + "px",
    maxHeight: height + "px",
    left:
      Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + "px",
    top: below < 220 ? "auto" : rect.bottom + 6 + "px",
    bottom: below < 220 ? window.innerHeight - rect.top + 6 + "px" : "auto",
  });
}
async function toggle() {
  if (open.value) {
    panel.value?.hidePopover();
    return;
  }
  query.value = "";
  open.value = true;
  position();
  panel.value?.showPopover();
  await nextTick();
  input.value?.focus();
}
function pick(id: string) {
  if (props.disabled) return;
  emit(
    "update:modelValue",
    props.modelValue.includes(id)
      ? props.modelValue.filter((value) => value !== id)
      : [...props.modelValue, id],
  );
}
function keys(event: KeyboardEvent) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  if (["Home", "End"].includes(event.key) && event.target === input.value)
    return;
  event.preventDefault();
  const items = [
      ...(panel.value?.querySelectorAll<HTMLButtonElement>('[role="option"]') ||
        []),
    ],
    current = items.indexOf(document.activeElement as HTMLButtonElement),
    index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : current < 0
            ? event.key === "ArrowDown"
              ? 0
              : items.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length;
  items[index]?.focus();
}
function toggled(event: Event) {
  open.value = (event as ToggleEvent).newState === "open";
}
onMounted(() => {
  window.addEventListener("resize", position);
  window.addEventListener("scroll", position, true);
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", position);
  window.removeEventListener("scroll", position, true);
});
</script>
<template>
  <button
    :id="id"
    ref="trigger"
    type="button"
    class="multi-select-trigger"
    :aria-label="label"
    aria-haspopup="dialog"
    :aria-expanded="open"
    :aria-controls="uid"
    :disabled="disabled"
    @click="toggle"
  >
    <span v-if="!selected.length" class="field-empty">Empty</span>
    <span
      v-for="option in selected.slice(0, 2)"
      :key="option.id"
      class="field-chip"
      :title="option.label"
    >
      <span v-if="person" class="field-person-avatar">{{
        option.label.slice(0, 1).toUpperCase()
      }}</span>
      <span>{{ option.label }}</span>
    </span>
    <span v-if="selected.length > 2" class="field-more"
      >+{{ selected.length - 2 }}</span
    >
  </button>
  <div
    :id="uid"
    ref="panel"
    popover="auto"
    role="dialog"
    :aria-label="label + ' options'"
    class="multi-select-panel"
    @toggle="toggled"
    @keydown="keys"
  >
    <div class="multi-select-search">
      <AppIcon name="search" :size="14" /><input
        ref="input"
        v-model="query"
        :aria-label="'Search ' + label"
        placeholder="Search options…"
        autocomplete="off"
      />
    </div>
    <div
      role="listbox"
      :aria-label="label"
      aria-multiselectable="true"
      class="multi-select-options"
    >
      <button
        v-for="option in filtered"
        :key="option.id"
        type="button"
        role="option"
        :aria-selected="modelValue.includes(option.id)"
        :disabled="disabled"
        @click="pick(option.id)"
      >
        <span class="option-check"
          ><AppIcon
            v-if="modelValue.includes(option.id)"
            name="check"
            :size="12" /></span
        ><span>{{ option.label }}</span>
      </button>
      <p v-if="!filtered.length" class="field-empty">
        {{ options.length ? "No matching options" : "No options available" }}
      </p>
    </div>
    <div class="multi-select-footer">
      <span>{{ modelValue.length }} selected</span
      ><button
        type="button"
        class="ghost"
        @click="
          panel?.hidePopover();
          trigger?.focus();
        "
      >
        Done
      </button>
    </div>
  </div>
</template>
<style scoped>
.multi-select-trigger {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-height: 34px;
  width: 100%;
  padding: 5px 7px;
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 5px;
}
.multi-select-trigger:hover {
  background: var(--surface-hover);
}
.multi-select-trigger:focus-visible {
  border-color: var(--accent);
}
.field-empty,
.field-more {
  color: var(--faint);
  font-size: 12px;
}
.field-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 165px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--text);
  padding: 2px 5px;
  font-size: 12px;
  line-height: 20px;
}
.field-chip > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.field-person-avatar {
  display: inline-grid;
  place-items: center;
  width: 19px;
  height: 19px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10px;
}
.multi-select-panel {
  position: fixed;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  background: var(--elevated);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 9px;
  box-shadow: var(--shadow);
}
.multi-select-panel::backdrop {
  background: transparent;
}
.multi-select-search {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--elevated);
  border-bottom: 1px solid var(--line-soft);
  color: var(--muted);
}
.multi-select-search input {
  width: 100%;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  font-size: 13px;
}
.multi-select-options {
  padding: 5px;
}
.multi-select-options button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px;
  border: 0;
  background: transparent;
  text-align: left;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.multi-select-options button:hover,
.multi-select-options button:focus-visible {
  background: var(--surface-hover);
  outline: 0;
}
.option-check {
  display: inline-grid;
  place-items: center;
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--accent);
}
[aria-selected="true"] .option-check {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.multi-select-options p {
  padding: 10px;
}
.multi-select-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid var(--line-soft);
  padding: 5px 10px;
  font-size: 11px;
  color: var(--muted);
}
</style>

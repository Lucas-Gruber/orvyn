<script setup lang="ts">
import type { EditorPerson } from "../composables/editorPeople";
const props = defineProps<{ pageId: string; query: string }>(),
  emit = defineEmits<{ close: []; select: [person: EditorPerson] }>(),
  root = ref<HTMLElement>(),
  people = ref<EditorPerson[]>([]),
  index = ref(0),
  loading = ref(true),
  error = ref("");
let generation = 0,
  disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => props.query,
  (query) => {
    const token = ++generation;
    clearTimeout(timer);
    people.value = [];
    index.value = 0;
    loading.value = true;
    error.value = "";
    timer = setTimeout(async () => {
      try {
        const data = await $fetch<EditorPerson[]>(
          `/api/v1/pages/${props.pageId}/mention-people`,
          { query: { q: query } },
        );
        if (!disposed && token === generation) people.value = data;
      } catch (e: any) {
        if (!disposed && token === generation)
          error.value = e.data?.message || "People could not be loaded.";
      } finally {
        if (!disposed && token === generation) loading.value = false;
      }
    }, 120);
  },
  { immediate: true },
);
function key(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return true;
  }
  if (["ArrowUp", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    index.value =
      (index.value +
        (event.key === "ArrowDown" ? 1 : -1) +
        Math.max(people.value.length, 1)) %
      Math.max(people.value.length, 1);
    void nextTick(() =>
      root.value
        ?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" }),
    );
    return true;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const person = people.value[index.value];
    if (person) emit("select", person);
    return true;
  }
  return false;
}
function outside(event: Event) {
  if (
    !root.value?.contains(event.target as Node) &&
    !(event.target as HTMLElement).closest?.(".tiptap")
  )
    emit("close");
}
defineExpose({ key });
onMounted(() => document.addEventListener("pointerdown", outside));
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  clearTimeout(timer);
  document.removeEventListener("pointerdown", outside);
});
</script>
<template>
  <div
    ref="root"
    class="person-picker"
    role="listbox"
    aria-label="Mention a page reader"
    @mousedown.prevent
  >
    <div class="picker-caption">Mention a person</div>
    <p v-if="loading" role="status">Finding people…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <p v-else-if="!people.length">No matching page readers.</p>
    <button
      v-for="(person, i) in people"
      :key="person.id"
      type="button"
      role="option"
      :aria-selected="index === i"
      @click="emit('select', person)"
    >
      <span class="person-avatar">{{
        person.email.slice(0, 2).toUpperCase()
      }}</span
      ><span>{{ person.email }}</span>
    </button>
    <div class="picker-footer">↑ ↓ Choose · Enter Insert · Esc Close</div>
  </div>
</template>
<style scoped>
.person-picker {
  z-index: 70;
  padding: 5px;
  max-height: 320px;
  overflow: auto;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--elevated);
  box-shadow: var(--shadow);
}
.picker-caption,
.picker-footer {
  color: var(--muted);
  font-size: 0.68rem;
  padding: 7px 8px;
}
.picker-footer {
  border-top: 1px solid var(--line-soft);
  margin-top: 5px;
}
.person-picker p {
  font-size: 0.8rem;
  padding: 8px;
}
.person-picker button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 0;
  background: transparent;
  text-align: left;
  font-size: 0.8rem;
}
.person-picker button[aria-selected="true"] {
  background: var(--accent-soft);
}
.person-picker button > span:last-child {
  overflow-wrap: anywhere;
}
.person-avatar {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  border-radius: 6px;
  background: var(--surface);
  color: var(--accent);
  font-size: 0.65rem;
}
</style>

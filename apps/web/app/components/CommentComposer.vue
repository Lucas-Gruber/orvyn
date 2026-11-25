<script setup lang="ts">
import type { CommentPerson } from "../composables/commentDrafts";
defineOptions({ inheritAttrs: false });
const props = defineProps<{
    modelValue: string;
    mentions: CommentPerson[];
    pageId: string;
    disabled?: boolean;
  }>(),
  emit = defineEmits<{
    "update:modelValue": [value: string];
    "update:mentions": [value: CommentPerson[]];
  }>(),
  input = ref<HTMLTextAreaElement>(),
  people = ref<CommentPerson[]>([]),
  open = ref(false),
  index = ref(0),
  loading = ref(false),
  id = useId(),
  message = ref("");
let range = { from: 0, to: 0 },
  generation = 0,
  disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
function hide() {
  open.value = false;
  generation++;
  clearTimeout(timer);
  loading.value = false;
}
function query() {
  const el = input.value;
  if (!el || props.disabled || el.selectionStart !== el.selectionEnd) {
    hide();
    return;
  }
  const cursor = el.selectionStart,
    match = props.modelValue.slice(0, cursor).match(/(?:^|[\s(])@([^\s@{}]*)$/);
  if (!match || match[1]!.length > 100) {
    hide();
    return;
  }
  range = { from: cursor - match[1]!.length - 1, to: cursor };
  const token = ++generation,
    q = match[1]!;
  clearTimeout(timer);
  people.value = [];
  index.value = 0;
  open.value = true;
  loading.value = true;
  timer = setTimeout(async () => {
    try {
      const data = await $fetch<CommentPerson[]>(
        `/api/v1/pages/${props.pageId}/mention-people`,
        { query: { q } },
      );
      if (!disposed && token === generation) people.value = data;
    } catch {
      if (!disposed && token === generation) people.value = [];
    } finally {
      if (!disposed && token === generation) loading.value = false;
    }
  }, 120);
}
function changed(event: Event) {
  const value = (event.target as HTMLTextAreaElement).value;
  emit("update:modelValue", value);
  emit(
    "update:mentions",
    props.mentions.filter(
      (person) =>
        person.displayName && value.includes("@" + person.displayName),
    ),
  );
  void nextTick(query);
}
async function choose(person: CommentPerson) {
  if (!person.displayName || props.disabled) return;
  if (
    props.mentions.length >= 20 &&
    !props.mentions.some((p) => p.id === person.id)
  ) {
    message.value = "Mention up to 20 people per comment.";
    hide();
    return;
  }
  const value =
      props.modelValue.slice(0, range.from) +
      "@" +
      person.displayName +
      " " +
      props.modelValue.slice(range.to),
    cursor = range.from + person.displayName.length + 2;
  if (value.length > 10000) {
    message.value = "Keep the comment within 10,000 characters.";
    hide();
    return;
  }
  message.value = "";
  emit("update:modelValue", value);
  emit("update:mentions", [
    ...props.mentions.filter(
      (p) =>
        p.id !== person.id &&
        p.displayName &&
        value.includes("@" + p.displayName),
    ),
    person,
  ]);
  hide();
  await nextTick();
  input.value?.focus();
  input.value?.setSelectionRange(cursor, cursor);
}
function keys(event: KeyboardEvent) {
  if (!open.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    hide();
  } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    index.value =
      (index.value +
        (event.key === "ArrowDown" ? 1 : -1) +
        Math.max(people.value.length, 1)) %
      Math.max(people.value.length, 1);
    void nextTick(() =>
      document
        .getElementById(id + "-" + index.value)
        ?.scrollIntoView({ block: "nearest" }),
    );
  } else if (event.key === "Enter" && people.value[index.value]) {
    event.preventDefault();
    void choose(people.value[index.value]!);
  }
}
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) hide();
  },
);
onBeforeUnmount(() => {
  disposed = true;
  hide();
});
</script>
<template>
  <div class="comment-input">
    <textarea
      ref="input"
      v-bind="$attrs"
      :value="modelValue"
      :disabled="disabled"
      aria-autocomplete="list"
      :aria-controls="open ? id : undefined"
      :aria-activedescendant="
        open && people[index] ? id + '-' + index : undefined
      "
      @input="changed"
      @keyup="
        !['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes($event.key) &&
        query()
      "
      @click="query"
      @keydown="keys"
      @blur="hide"
    />
    <div
      v-if="open"
      :id="id"
      class="mention-suggestions"
      role="listbox"
      aria-label="Mention a page reader"
      @mousedown.prevent
    >
      <p v-if="loading" role="status">Finding people…</p>
      <button
        v-for="(person, i) in people"
        :id="id + '-' + i"
        :key="person.id"
        type="button"
        role="option"
        :aria-selected="index === i"
        @click="choose(person)"
      >
        <span class="mention-avatar">{{
          person.displayName?.slice(0, 2).toUpperCase()
        }}</span><span>{{ person.displayName }}</span>
      </button>
      <p v-if="!loading && !people.length">No matching page readers.</p>
    </div>
    <p v-if="message" class="hint" role="status">{{ message }}</p>
    <small class="mention-hint"
      >Type @ to mention someone who can read this page.</small
    >
  </div>
</template>
<style scoped>
.comment-input {
  position: relative;
}
.comment-input textarea {
  width: 100%;
  margin-bottom: 0;
}
.mention-hint {
  display: block;
  margin: 6px 0 12px;
  font-size: 0.68rem;
  color: var(--muted);
}
.mention-suggestions {
  position: absolute;
  bottom: calc(100% - 4px);
  left: 0;
  right: 0;
  z-index: 5;
  max-height: 230px;
  overflow: auto;
  padding: 5px;
  border: 1px solid var(--line);
  background: var(--elevated);
  box-shadow: var(--shadow);
  border-radius: 8px;
}
.mention-suggestions button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  padding: 8px;
  font-size: 0.75rem;
}
.mention-suggestions button > span:last-child {
  overflow-wrap: anywhere;
}
.mention-suggestions button[aria-selected="true"] {
  background: var(--accent-soft);
}
.mention-suggestions p {
  padding: 8px;
  margin: 0;
  font-size: 0.75rem;
  color: var(--muted);
}
.mention-avatar {
  display: grid;
  place-items: center;
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.65rem;
}
</style>

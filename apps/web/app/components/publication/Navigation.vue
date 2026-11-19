<script setup lang="ts">
import type { PublicationSnapshot } from "@orvyn/shared";
import { publicationTree, publicationTrail } from "../../utils/publicationTree";
const props = defineProps<{
    snapshot: PublicationSnapshot;
    activeId: string;
    preview?: boolean;
  }>(),
  emit = defineEmits<{ select: [id: string] }>();
const disclosure = ref<HTMLDetailsElement>(),
  search = ref(""),
  expanded = ref<string[]>([props.snapshot.rootId]);
const entries = computed(() =>
  publicationTree(props.snapshot.pages, props.snapshot.rootId),
);
const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (q) {
    const include = new Set<string>();
    for (const entry of entries.value)
      if (entry.page.title.toLowerCase().includes(q)) {
        include.add(entry.page.id);
        for (const id of entry.path) include.add(id);
      }
    return entries.value.filter((entry) => include.has(entry.page.id));
  }
  return entries.value.filter((entry) =>
    entry.path.every((id) => expanded.value.includes(id)),
  );
});
const active = computed(() =>
  props.snapshot.pages.find((page) => page.id === props.activeId),
);
watch(
  () => props.activeId,
  () => {
    expanded.value = [
      ...new Set([
        ...expanded.value,
        ...publicationTrail(
          props.snapshot.pages,
          props.snapshot.rootId,
          props.activeId,
        ).map((page) => page.id),
      ]),
    ];
  },
  { immediate: true },
);
function toggle(id: string) {
  expanded.value = expanded.value.includes(id)
    ? expanded.value.filter((value) => value !== id)
    : [...expanded.value, id];
}
function pick(event: MouseEvent, id: string) {
  if (props.preview) {
    event.preventDefault();
    emit("select", id);
    if (disclosure.value) disclosure.value.open = false;
  }
}
function escape(event: KeyboardEvent) {
  if (disclosure.value?.open && (props.preview || !wide?.matches)) {
    event.preventDefault();
    event.stopPropagation();
    disclosure.value.open = false;
    disclosure.value.querySelector<HTMLElement>("summary")?.focus();
  }
}
let wide: MediaQueryList | undefined;
function resize() {
  if (disclosure.value)
    disclosure.value.open = !!wide?.matches && !props.preview;
}
onMounted(() => {
  wide = window.matchMedia("(min-width:1000px)");
  resize();
  wide.addEventListener("change", resize);
});
onBeforeUnmount(() => wide?.removeEventListener("change", resize));
</script>
<template>
  <nav
    class="publication-navigation"
    :class="{ compact: preview }"
    aria-label="Published pages"
  >
    <details ref="disclosure" :open="!preview" @keydown.esc="escape">
      <summary>
        <AppIcon name="sidebar" :size="16" /><span>{{
          active?.title || "Pages in this publication"
        }}</span
        ><span class="publication-navigation-total">{{
          snapshot.pages.length
        }}</span
        ><AppIcon name="chevronDown" :size="14" />
      </summary>
      <div class="publication-navigation-body">
        <header>
          <span>In this publication</span
          ><span>{{ snapshot.pages.length }}</span>
        </header>
        <label
          v-if="snapshot.pages.length > 7"
          class="publication-navigation-search"
          ><AppIcon name="search" :size="14" /><input
            v-model="search"
            type="search"
            aria-label="Search published pages"
            placeholder="Find a page…"
        /></label>
        <div class="publication-navigation-list">
          <div
            v-for="entry in visible"
            :key="entry.page.id"
            class="publication-tree-row"
            :style="{ paddingLeft: Math.min(entry.depth, 5) * 12 + 'px' }"
          >
            <button
              v-if="entry.hasChildren"
              type="button"
              class="publication-tree-toggle"
              :aria-label="'Toggle subpages of ' + entry.page.title"
              :aria-expanded="
                !!search.trim() || expanded.includes(entry.page.id)
              "
              :disabled="!!search.trim()"
              @click="toggle(entry.page.id)"
            >
              <AppIcon
                :name="
                  expanded.includes(entry.page.id)
                    ? 'chevronDown'
                    : 'chevronRight'
                "
                :size="12"
              /></button
            ><span v-else class="publication-tree-spacer" /><component
              :is="preview ? 'button' : 'a'"
              :type="preview ? 'button' : undefined"
              :href="preview ? undefined : '?page=' + entry.page.id"
              :aria-current="entry.page.id === activeId ? 'page' : undefined"
              :title="
                [
                  ...entry.path.map(
                    (id) =>
                      snapshot.pages.find((page) => page.id === id)?.title,
                  ),
                  entry.page.title,
                ]
                  .filter(Boolean)
                  .join(' / ')
              "
              @click="pick($event, entry.page.id)"
              ><PageSymbol
                :icon="entry.page.icon"
                :kind="entry.page.kind"
                :size="15"
              /><span>{{ entry.page.title }}</span></component
            >
          </div>
          <p v-if="!visible.length" class="publication-navigation-empty">
            No pages match your search.
          </p>
        </div>
      </div>
    </details>
  </nav>
</template>
<style scoped>
.publication-navigation {
  min-width: 0;
  font-size: 12px;
  border-bottom: 1px solid var(--line);
}
.publication-navigation details {
  margin: 0;
}
.publication-navigation summary {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 20px;
  cursor: pointer;
  list-style: none;
  font-size: 12px;
}
summary::-webkit-details-marker {
  display: none;
}
summary > span:first-of-type {
  flex: 1;
  min-width: 0;
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
}
.publication-navigation-total {
  color: var(--muted);
  font-size: 10px;
}
.publication-navigation-body {
  padding: 12px;
  border-top: 1px solid var(--line);
}
.publication-navigation-body > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 12px;
  color: var(--muted);
  font-size: 10px;
}
.publication-navigation-search {
  display: flex;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 0 8px;
  margin: 0 4px 10px;
  color: var(--muted);
}
.publication-navigation-search input {
  width: 100%;
  min-width: 0;
  border: 0;
  background: none;
  color: var(--text);
  font-size: 11px;
  padding: 7px 0;
  outline: none;
}
.publication-navigation-list {
  max-height: 360px;
  overflow: auto;
  scrollbar-width: thin;
}
.publication-tree-row {
  display: flex;
  align-items: center;
  gap: 1px;
  min-width: 0;
}
.publication-tree-toggle {
  padding: 0;
  min-height: 26px;
  width: 18px;
  flex-shrink: 0;
  border: 0;
  background: none;
  color: var(--muted);
}
.publication-tree-spacer {
  width: 18px;
  flex-shrink: 0;
}
.publication-tree-row > :is(a, button):last-child {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 7px;
  border: 0;
  border-radius: 4px;
  background: none;
  text-decoration: none;
  color: var(--muted);
  padding: 7px 6px;
  min-height: 30px;
  text-align: left;
  font-size: 11px;
  min-width: 0;
  flex: 1;
  line-height: 1.5;
}
.publication-tree-row > :is(a, button):last-child > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.publication-tree-row [aria-current="page"] {
  background: var(--surface) !important;
  color: var(--text) !important;
  font-weight: 500;
}
.publication-tree-row > :is(a, button):last-child:hover {
  background: var(--surface);
  color: var(--text);
}
.publication-navigation-empty {
  font-size: 11px;
  color: var(--muted);
  padding: 8px;
  text-align: center;
}
.publication-navigation.compact {
  border-bottom: 1px solid var(--line);
}
@media (min-width: 1000px) {
  .publication-navigation:not(.compact) {
    border-bottom: 0;
    border-right: 1px solid var(--line);
    height: 100%;
    position: relative;
  }
  .publication-navigation:not(.compact) > details {
    position: sticky;
    top: 58px;
  }
  .publication-navigation:not(.compact) summary {
    display: none;
  }
  .publication-navigation:not(.compact) .publication-navigation-body {
    border-top: 0;
    padding: 24px 10px;
  }
  .publication-navigation:not(.compact) .publication-navigation-list {
    max-height: calc(100dvh - 160px);
  }
}
</style>

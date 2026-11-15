<script setup lang="ts">
const props = defineProps<{
    pages: any[];
    activeId?: string;
    canCreate: boolean;
    expanded: string[];
  }>(),
  emit = defineEmits<{
    open: [id: string];
    create: [parentId: string];
    toggle: [id: string];
  }>();
const tree = ref<HTMLElement>();
const visible = computed(() => {
  const result: any[] = [],
    seen = new Set<string>(),
    ids = new Set(props.pages.map((p) => p.id));
  function visit(parent: string | null, depth: number) {
    for (const page of props.pages
      .filter((p) => (p.parent_id || null) === parent)
      .sort(
        (a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title),
      )) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      const children = props.pages.some((p) => p.parent_id === page.id);
      result.push({ ...page, depth, children });
      if (props.expanded.includes(page.id)) visit(page.id, depth + 1);
    }
  }
  visit(null, 0);
  for (const p of props.pages)
    if (!seen.has(p.id) && !ids.has(p.parent_id)) {
      seen.add(p.id);
      result.push({
        ...p,
        depth: 0,
        children: props.pages.some((c) => c.parent_id === p.id),
      });
      if (props.expanded.includes(p.id)) visit(p.id, 1);
    }
  return result;
});
function keys(event: KeyboardEvent, page: any) {
  const buttons = [
      ...(tree.value?.querySelectorAll<HTMLButtonElement>(".tree-page") || []),
    ],
    index = buttons.indexOf(event.currentTarget as HTMLButtonElement);
  if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : Math.max(
              0,
              Math.min(
                buttons.length - 1,
                index + (event.key === "ArrowDown" ? 1 : -1),
              ),
            );
    buttons[next]?.focus();
  } else if (
    event.key === "ArrowRight" &&
    page.children &&
    !props.expanded.includes(page.id)
  ) {
    event.preventDefault();
    emit("toggle", page.id);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (props.expanded.includes(page.id)) emit("toggle", page.id);
    else buttons.find((b) => b.dataset.page === page.parent_id)?.focus();
  }
}
</script>
<template>
  <nav ref="tree" class="workspace-tree" aria-label="Pages">
    <div
      v-for="page in visible"
      :key="page.id"
      class="tree-row"
      :class="{ selected: activeId === page.id }"
      :style="{ '--depth': Math.min(page.depth, 8) }"
    >
      <button
        v-if="page.children"
        class="tree-caret"
        :aria-label="'Toggle subpages of ' + page.title"
        :aria-expanded="expanded.includes(page.id)"
        @click="emit('toggle', page.id)"
      >
        <AppIcon
          :name="expanded.includes(page.id) ? 'chevronDown' : 'chevronRight'"
          :size="14"
        /></button
      ><span v-else class="tree-caret spacer" /><button
        class="tree-page"
        :data-page="page.id"
        :aria-current="activeId === page.id ? 'page' : undefined"
        @click="emit('open', page.id)"
        @keydown="keys($event, page)"
      >
        <AppIcon
          :name="page.kind === 'database' ? 'database' : 'file'"
          :size="16"
        /><span>{{ page.title }}</span
        ><AppIcon
          v-if="page.visibility === 'restricted'"
          name="lock"
          :size="12"
        /></button
      ><button
        v-if="canCreate && page.access_rank >= 30 && page.kind !== 'database'"
        class="tree-add"
        :aria-label="'Add subpage to ' + page.title"
        @click="emit('create', page.id)"
      >
        <AppIcon name="plus" :size="15" />
      </button>
    </div>
    <p v-if="!pages.length" class="tree-empty">Your pages will appear here.</p>
  </nav>
</template>

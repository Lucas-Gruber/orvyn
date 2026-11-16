<script setup lang="ts">
import { pageNavigationKey } from "../composables/pageNavigation";
const props = defineProps<{ pageId: string }>(),
  open = ref(false),
  links = ref<any[]>([]),
  cursor = ref(""),
  loading = ref(false),
  error = ref(""),
  navigate = inject(pageNavigationKey);
let generation = 0,
  timer: ReturnType<typeof setInterval> | undefined;
async function load(more = false) {
  if (!open.value || loading.value) return;
  const request = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const response = await $fetch.raw<any[]>(
      `/api/v1/pages/${props.pageId}/backlinks`,
      { query: { limit: 50, after: more ? cursor.value : "" } },
    );
    if (request !== generation) return;
    links.value = more
      ? [...links.value, ...(response._data || [])]
      : response._data || [];
    cursor.value = response.headers.get("X-Next-Cursor") || "";
  } catch {
    if (request === generation) {
      links.value = [];
      cursor.value = "";
      error.value = "Backlinks are unavailable. Try refreshing.";
    }
  } finally {
    if (request === generation) loading.value = false;
  }
}
watch(open, (value) => {
  clearInterval(timer);
  if (!value) {
    generation++;
    loading.value = false;
    return;
  }
  void load();
  timer = setInterval(() => {
    if (document.visibilityState === "visible" && !cursor.value) void load();
  }, 5000);
});
onBeforeUnmount(() => {
  generation++;
  clearInterval(timer);
});
</script>
<template>
  <details
    class="page-backlinks"
    @toggle="open = ($event.target as HTMLDetailsElement).open"
  >
    <summary>
      <AppIcon name="link" :size="15" />Backlinks<AppIcon
        :name="open ? 'chevronDown' : 'chevronRight'"
        :size="13"
      />
    </summary>
    <div v-if="open" class="backlinks-content">
      <div class="backlinks-header">
        <p>Documents you can access that link here.</p>
        <button
          class="icon-button"
          aria-label="Refresh backlinks"
          :disabled="loading"
          @click="load()"
        >
          <AppIcon name="history" :size="14" />
        </button>
      </div>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <p v-if="loading" role="status" class="hint">Loading backlinks…</p>
      <ul v-if="links.length">
        <li v-for="link in links" :key="link.id">
          <button type="button" @click="navigate?.(link.id)">
            <AppIcon
              :name="link.kind === 'database' ? 'database' : 'file'"
              :size="16"
            /><span
              >{{ link.title }}<small>{{ link.space_name }}</small></span
            ><AppIcon name="arrowRight" :size="14" />
          </button>
        </li>
      </ul>
      <p v-else-if="!loading && !error" class="hint">
        No accessible documents link here yet.
      </p>
      <button
        v-if="cursor"
        class="ghost"
        :disabled="loading"
        @click="load(true)"
      >
        Load more backlinks
      </button>
    </div>
  </details>
</template>
<style scoped>
.page-backlinks {
  border-top: 1px solid var(--line-soft);
  padding-top: 16px;
  margin-top: 32px;
}
summary {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  list-style: none;
  color: var(--muted);
  font-size: 0.8rem;
  width: fit-content;
}
summary::-webkit-details-marker {
  display: none;
}
.backlinks-content {
  padding-top: 8px;
}
.backlinks-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.backlinks-header p {
  font-size: 0.8rem;
  color: var(--muted);
  margin: 6px 0;
}
ul {
  list-style: none;
  margin: 6px 0;
  padding: 0;
}
li button {
  display: flex;
  width: 100%;
  background: transparent;
  border: 0;
  padding: 8px;
  text-align: left;
  justify-content: flex-start;
}
li button:hover {
  background: var(--surface-hover);
}
li button span {
  flex: 1;
  overflow-wrap: anywhere;
}
small {
  display: block;
  color: var(--muted);
  font-size: 0.75rem;
  margin-top: 3px;
}
</style>

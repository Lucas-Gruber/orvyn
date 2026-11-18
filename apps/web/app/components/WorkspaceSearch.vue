<script setup lang="ts">
interface SearchResult {
  id: string;
  title: string;
  icon: string | null;
  kind: string;
  space_id: string;
  space_name: string;
  excerpt: string;
  highlights: { start: number; end: number }[];
  match_source: "title" | "content" | "recent";
}
const props = withDefaults(
  defineProps<{
    spaces: { id: string; name: string }[];
    mode?: "workspace" | "database";
  }>(),
  { mode: "workspace" },
);
const emit = defineEmits<{ select: [id: string, result: SearchResult] }>();
const visible = ref(false),
  query = ref(""),
  spaceId = ref(""),
  kind = ref("all"),
  scope = ref("all");
const results = ref<SearchResult[]>([]),
  loading = ref(false),
  refreshing = ref(false),
  error = ref("");
const selected = ref(0),
  input = ref<HTMLInputElement>(),
  list = ref<HTMLElement>();
const cursors = ref([""]),
  pageIndex = ref(0),
  nextCursor = ref(""),
  uid = useId();
let generation = 0,
  opening = false,
  controller: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined,
  interval: ReturnType<typeof setInterval> | undefined;
const kinds: Record<string, string> = {
  page: "Page",
  folder: "Folder",
  database: "Database",
  record: "Record",
  whiteboard: "Whiteboard",
};

function invalidate() {
  generation++;
  controller?.abort();
  clearTimeout(timer);
}
async function fetchResults(background = false) {
  invalidate();
  const token = generation;
  controller = new AbortController();
  if (background) refreshing.value = true;
  else loading.value = true;
  error.value = "";
  const activeId = results.value[selected.value]?.id;
  try {
    const response = await $fetch.raw<SearchResult[]>("/api/v1/search", {
      query: {
        q: query.value,
        spaceId: spaceId.value,
        kind: kind.value,
        scope: scope.value,
        limit: 30,
        after: cursors.value[pageIndex.value] || "",
      },
      signal: controller.signal,
    });
    if (token !== generation || !visible.value) return;
    results.value = response._data || [];
    nextCursor.value = response.headers.get("X-Next-Cursor") || "";
    selected.value = background
      ? Math.max(
          0,
          results.value.findIndex((item) => item.id === activeId),
        )
      : 0;
  } catch {
    if (token === generation && visible.value) {
      results.value = [];
      nextCursor.value = "";
      error.value = "Search is unavailable. Try again.";
    }
  } finally {
    if (token === generation) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}
function schedule(delay = 180) {
  invalidate();
  results.value = [];
  nextCursor.value = "";
  error.value = "";
  cursors.value = [""];
  pageIndex.value = 0;
  selected.value = 0;
  loading.value = true;
  refreshing.value = false;
  timer = setTimeout(() => void fetchResults(), delay);
}
watch(
  [query, spaceId, kind, scope],
  () => {
    if (visible.value && !opening) schedule();
  },
  { flush: "sync" },
);
async function open() {
  if (visible.value) {
    input.value?.focus();
    input.value?.select();
    return;
  }
  opening = true;
  query.value = "";
  spaceId.value = "";
  kind.value = props.mode === "database" ? "database" : "all";
  scope.value = props.mode === "database" ? "title" : "all";
  opening = false;
  visible.value = true;
  schedule(0);
  await nextTick();
  input.value?.focus();
}
function close() {
  visible.value = false;
  invalidate();
  results.value = [];
  nextCursor.value = "";
  loading.value = false;
  refreshing.value = false;
  error.value = "";
}
function choose(result: SearchResult) {
  close();
  emit("select", result.id, result);
}
async function keys(event: KeyboardEvent) {
  if (
    !["ArrowDown", "ArrowUp", "Enter"].includes(event.key) ||
    event.isComposing
  )
    return;
  event.preventDefault();
  if (loading.value || !results.value.length) return;
  if (event.key === "Enter") {
    choose(results.value[selected.value]!);
    return;
  }
  selected.value =
    (selected.value +
      (event.key === "ArrowDown" ? 1 : -1) +
      results.value.length) %
    results.value.length;
  await nextTick();
  list.value
    ?.querySelector<HTMLElement>("[data-selected=true]")
    ?.scrollIntoView({ block: "nearest" });
}
function next() {
  if (!nextCursor.value || loading.value) return;
  cursors.value = [
    ...cursors.value.slice(0, pageIndex.value + 1),
    nextCursor.value,
  ];
  pageIndex.value++;
  results.value = [];
  nextCursor.value = "";
  selected.value = 0;
  void fetchResults();
}
function previous() {
  if (!pageIndex.value || loading.value) return;
  pageIndex.value--;
  results.value = [];
  nextCursor.value = "";
  selected.value = 0;
  void fetchResults();
}
function parts(result: SearchResult) {
  const segments: { text: string; match: boolean }[] = [];
  let index = 0;
  for (const range of result.highlights || []) {
    if (
      range.start < index ||
      range.end <= range.start ||
      range.end > result.excerpt.length
    )
      continue;
    if (range.start > index)
      segments.push({
        text: result.excerpt.slice(index, range.start),
        match: false,
      });
    segments.push({
      text: result.excerpt.slice(range.start, range.end),
      match: true,
    });
    index = range.end;
  }
  if (index < result.excerpt.length)
    segments.push({ text: result.excerpt.slice(index), match: false });
  return segments;
}
function refresh() {
  if (
    visible.value &&
    !loading.value &&
    !refreshing.value &&
    document.visibilityState === "visible"
  )
    void fetchResults(true);
}
onMounted(() => {
  interval = setInterval(refresh, 5000);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
});
onBeforeUnmount(() => {
  close();
  clearInterval(interval);
  window.removeEventListener("focus", refresh);
  document.removeEventListener("visibilitychange", refresh);
});
defineExpose({ open, close });
</script>
<template>
  <UiDialog
    :open="visible"
    :title="mode === 'database' ? 'Choose a database' : 'Search your workspace'"
    wide
    class="workspace-search"
    @close="close"
  >
    <div class="search-query">
      <AppIcon name="search" :size="21" /><input
        ref="input"
        v-model="query"
        type="search"
        :aria-label="mode === 'database' ? 'Search databases' : 'Search pages'"
        :aria-describedby="uid + '-help'"
        :placeholder="
          mode === 'database'
            ? 'Find a database in any accessible space…'
            : 'Search titles and document text…'
        "
        autocomplete="off"
        @keydown="keys"
      />
    </div>
    <div class="search-filters">
      <div>
        <AppIcon name="folder" :size="14" /><select
          v-model="spaceId"
          aria-label="Search space"
        >
          <option value="">All spaces</option>
          <option v-for="space in spaces" :key="space.id" :value="space.id">
            {{ space.name }}
          </option>
        </select>
      </div>
      <div v-if="mode !== 'database'">
        <AppIcon name="file" :size="14" /><select
          v-model="kind"
          aria-label="Content type"
        >
          <option value="all">All types</option>
          <option
            v-for="type in ['page', 'folder', 'database', 'record']"
            :key="type"
            :value="type"
          >
            {{ kinds[type] }}
          </option>
        </select>
      </div>
      <div v-if="mode !== 'database'">
        <AppIcon name="text" :size="14" /><select
          v-model="scope"
          aria-label="Search in"
        >
          <option value="all">Title and content</option>
          <option value="title">Titles only</option>
        </select>
      </div>
    </div>
    <div class="search-results-heading">
      <span>{{
        query.trim() ? "Search results" : "Recently edited"
      }}</span><span v-if="loading" role="status">Searching…</span
      ><span v-else-if="refreshing" role="status">Refreshing…</span
      ><span v-else
        >{{ results.length }}
        {{ results.length === 1 ? "result" : "results" }}</span
      >
    </div>
    <div v-if="error" class="search-error" role="alert">
      <p>{{ error }}</p>
      <button type="button" class="ghost" @click="schedule(0)">
        Try again
      </button>
    </div>
    <ul
      ref="list"
      class="search-results"
      aria-label="Search results"
      :aria-busy="loading"
    >
      <li v-for="(result, index) in results" :key="result.id">
        <button
          type="button"
          :data-selected="index === selected"
          @focus="selected = index"
          @click="choose(result)"
        >
          <PageSymbol :icon="result.icon" :kind="result.kind" :size="18" /><span
            class="search-result-text"
            ><span class="search-result-title">{{ result.title }}</span
            ><span v-if="result.excerpt" class="search-result-excerpt"
              ><template
                v-for="(part, partIndex) in parts(result)"
                :key="partIndex"
                ><mark v-if="part.match">{{ part.text }}</mark
                ><span v-else>{{ part.text }}</span></template
              ></span
            ><span class="search-result-location"
              >{{ result.space_name }}<span aria-hidden="true"> / </span
              >{{ kinds[result.kind] || "Page"
              }}<span
                v-if="result.match_source === 'content'"
                class="search-match-source"
                >Text match</span
              ></span
            ></span
          ><AppIcon
            v-if="index === selected"
            name="enter"
            class="search-enter"
            :size="15"
          />
        </button>
      </li>
    </ul>
    <p v-if="!loading && !results.length && !error" class="search-empty">
      {{
        query.trim() || spaceId || kind !== "all"
          ? "No results found. Try fewer words or different filters."
          : "Your accessible pages will appear here."
      }}
    </p>
    <div class="search-footer">
      <div class="search-paging">
        <button
          type="button"
          class="ghost"
          aria-label="Previous results"
          :disabled="!pageIndex || loading"
          @click="previous"
        >
          <AppIcon name="chevronLeft" :size="14" />Previous</button
        ><span>Page {{ pageIndex + 1 }}</span
        ><button
          type="button"
          class="ghost"
          aria-label="Next results"
          :disabled="!nextCursor || loading"
          @click="next"
        >
          Next<AppIcon name="chevronRight" :size="14" />
        </button>
      </div>
      <p :id="uid + '-help'">
        <span><kbd>↑</kbd> <kbd>↓</kbd> Choose</span
        ><span
          ><kbd>Enter</kbd> {{ mode === "database" ? "Choose" : "Open" }}</span
        ><span><kbd>Esc</kbd> Close</span>
      </p>
    </div>
    <span class="sr-only" role="status">{{
      results[selected]?.title || ""
    }}</span>
  </UiDialog>
</template>
<style scoped>
:global(.ui-dialog.workspace-search) {
  margin-top: min(10dvh, 80px);
  margin-bottom: auto;
  max-height: calc(100dvh - min(10dvh, 80px) - 24px);
}
.search-query {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 18px;
}
.search-query > .app-icon {
  color: var(--muted);
}
.search-query input {
  min-width: 0;
  width: 100%;
  font-size: 18px;
  padding: 6px 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}
.search-filters {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1.2fr);
  gap: 8px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 18px;
}
.search-filters > div {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--surface);
  color: var(--muted);
  min-width: 0;
}
.search-filters select {
  min-width: 0;
  width: 100%;
  font-size: 13px;
  background: transparent;
  border: 0;
  padding: 5px 0;
  color: var(--muted);
  box-shadow: none;
  text-overflow: ellipsis;
}
.search-results-heading {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin: 16px 2px 8px;
  color: var(--faint);
  font-size: 12px;
}
.search-results {
  list-style: none;
  margin: 0 -8px;
  padding: 0;
  min-height: 110px;
  max-height: min(420px, 48dvh);
  overflow-y: auto;
}
.search-results li {
  margin: 2px 0;
}
.search-results button {
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  width: 100%;
  text-align: left;
  gap: 12px;
  border: 0;
  background: transparent;
  padding: 12px 10px;
  border-radius: 6px;
  min-height: 52px;
}
.search-results button[data-selected="true"],
.search-results button:hover {
  background: var(--surface-hover);
}
.search-results button > .page-emoji,
.search-results button > .app-icon {
  color: var(--muted);
  margin-top: 3px;
  flex-shrink: 0;
}
.search-result-text {
  display: block;
  min-width: 0;
  flex: 1;
}
.search-result-title {
  display: block;
  font-size: 15px;
  font-weight: 550;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.search-result-excerpt {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 14px;
  line-height: 1.55;
  color: var(--muted);
  margin-top: 4px;
  overflow-wrap: anywhere;
}
.search-result-excerpt mark {
  background: var(--accent-soft);
  color: var(--text);
  font-weight: 550;
  border-radius: 2px;
}
.search-result-location {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  margin-top: 5px;
  font-size: 12px;
  color: var(--faint);
}
.search-match-source {
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--surface);
  margin-left: 4px;
}
.search-empty {
  color: var(--muted);
  padding: 28px 12px;
  text-align: center;
  font-size: 14px;
  line-height: 1.6;
}
.search-error {
  padding: 18px 0;
  color: var(--error);
  font-size: 14px;
}
.search-footer {
  border-top: 1px solid var(--line);
  padding-top: 10px;
  margin-top: 14px;
}
.search-paging {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.search-paging button {
  font-size: 12px;
  padding: 4px 6px;
  min-height: 28px;
}
.search-paging > span {
  font-size: 12px;
  color: var(--faint);
}
.search-footer > p {
  display: flex;
  justify-content: center;
  gap: 18px;
  color: var(--faint);
  margin: 10px 0 0;
  font-size: 11px;
}
@media (max-width: 600px) {
  .search-filters {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .search-filters > div:last-child {
    grid-column: 1/-1;
  }
  .search-query input {
    font-size: 16px;
  }
  .search-results {
    max-height: min(42dvh, calc(100dvh - 380px));
  }
}
</style>

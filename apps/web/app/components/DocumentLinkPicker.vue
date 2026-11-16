<script setup lang="ts">
const props = defineProps<{
    open: boolean;
    selectedText: string;
    preview?: boolean;
  }>(),
  emit = defineEmits<{
    close: [];
    select: [target: { pageId: string; headingId: string; label: string }];
  }>();
const query = ref(""),
  pages = ref<any[]>([]),
  selected = ref<any>(),
  headings = ref<any[]>([]),
  label = ref(""),
  loading = ref(false),
  error = ref("");
let generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
async function search() {
  const request = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const result = await $fetch<any[]>("/api/v1/search", {
      query: { q: query.value },
    });
    if (request === generation && props.open) pages.value = result;
  } catch {
    if (request === generation)
      error.value = "Documents could not be loaded. Try again.";
  } finally {
    if (request === generation) loading.value = false;
  }
}
watch(
  () => props.open,
  (open) => {
    clearTimeout(timer);
    generation++;
    if (!open) return;
    query.value = "";
    selected.value = undefined;
    pages.value = [];
    headings.value = [];
    label.value = props.selectedText;
    void search();
  },
);
watch(query, () => {
  if (!props.open || selected.value) return;
  clearTimeout(timer);
  generation++;
  pages.value = [];
  loading.value = true;
  timer = setTimeout(() => void search(), 180);
});
async function choose(page: any) {
  const request = ++generation;
  clearTimeout(timer);
  selected.value = page;
  headings.value = [];
  loading.value = true;
  error.value = "";
  try {
    const result = await $fetch<any[]>(
      "/api/v1/pages/" + page.id + "/headings",
    );
    if (request === generation && props.open) headings.value = result;
  } catch {
    if (request === generation) {
      selected.value = undefined;
      pages.value = [];
      error.value = "This document is unavailable or your access has changed.";
    }
  } finally {
    if (request === generation) loading.value = false;
  }
}
function insert(heading?: any) {
  if (!selected.value || loading.value) return;
  emit("select", {
    pageId: selected.value.id,
    headingId: heading?.id || "",
    label:
      label.value.trim() ||
      selected.value.title + (heading ? " › " + heading.text : ""),
  });
}
onBeforeUnmount(() => {
  generation++;
  clearTimeout(timer);
});
</script>
<template>
  <UiDialog
    :open="open"
    :title="preview ? 'Insert page preview' : 'Link to document'"
    :error="error"
    @close="emit('close')"
  >
    <p class="hint">
      Link to an accessible document or directly to one of its headings. A link
      does not grant access.
    </p>
    <template v-if="!selected">
      <label for="document-link-search">Find a document</label>
      <input
        id="document-link-search"
        v-model="query"
        type="search"
        maxlength="200"
        placeholder="Search document titles…"
        autocomplete="off"
      />
      <div class="document-link-results">
        <button
          v-for="page in pages"
          :key="page.id"
          type="button"
          @click="choose(page)"
        >
          <AppIcon
            :name="page.kind === 'database' ? 'database' : 'file'"
            :size="17"
          /><span
            >{{ page.title }}<small>{{ page.space_name }}</small></span
          ><AppIcon name="chevronRight" :size="15" />
        </button>
      </div>
      <p v-if="!loading && !pages.length && !error" class="hint">
        No accessible documents found.
      </p>
      <button v-if="error" type="button" class="ghost" @click="search">
        Retry search
      </button>
    </template>
    <template v-else>
      <button
        type="button"
        class="ghost"
        @click="
          selected = undefined;
          search();
        "
      >
        <AppIcon name="back" :size="14" />Choose another document
      </button>
      <h3 class="link-destination">
        <AppIcon name="file" :size="18" />{{ selected.title }}
      </h3>
      <label v-if="!preview" for="document-link-label"
        >Link text (optional)</label
      ><input
        v-if="!preview"
        id="document-link-label"
        v-model="label"
        maxlength="1000"
        placeholder="Use the document or heading title"
      />
      <button
        type="button"
        class="primary link-whole-document"
        :disabled="loading"
        @click="insert()"
      >
        <AppIcon name="link" :size="16" />{{
          preview ? "Preview entire document" : "Link entire document"
        }}
      </button>
      <h3 class="link-section-title">Or choose a heading</h3>
      <div class="document-link-results">
        <button
          v-for="heading in headings"
          :key="heading.id"
          type="button"
          :aria-label="
            (preview ? 'Preview heading ' : 'Link to heading ') + heading.text
          "
          :style="{ paddingLeft: 12 + (heading.level - 1) * 14 + 'px' }"
          @click="insert(heading)"
        >
          <AppIcon name="heading" :size="16" /><span>{{ heading.text }}</span>
        </button>
      </div>
      <p v-if="!loading && !headings.length" class="hint">
        This document has no headings yet.
      </p>
    </template>
    <p v-if="loading" role="status" class="hint">Loading destinations…</p>
  </UiDialog>
</template>
<style scoped>
.document-link-results {
  display: grid;
  gap: 2px;
  margin-top: 12px;
  max-height: 310px;
  overflow-y: auto;
}
.document-link-results button {
  background: transparent;
  border: 0;
  text-align: left;
  justify-content: flex-start;
  padding: 10px 12px;
  width: 100%;
}
.document-link-results button:hover {
  background: var(--surface-hover);
}
.document-link-results button > span {
  flex: 1;
  overflow-wrap: anywhere;
}
.document-link-results small {
  display: block;
  color: var(--muted);
  font-size: 0.75rem;
  margin-top: 3px;
}
.link-destination {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 20px 0;
  overflow-wrap: anywhere;
}
.link-whole-document {
  margin: 14px 0 12px;
}
.link-section-title {
  font-size: 0.8rem;
  color: var(--muted);
  font-weight: 500;
  margin: 14px 0 0;
}
</style>

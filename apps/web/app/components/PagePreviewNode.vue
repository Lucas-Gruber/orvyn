<script setup lang="ts">
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/vue-3";
import { pageNavigationKey } from "../composables/pageNavigation";
import { pageLink } from "@orvyn/editor/links";
const props = defineProps<NodeViewProps>(),
  editable = useNodeEditable(props.editor),
  navigate = inject(pageNavigationKey),
  root = ref<HTMLElement>(),
  data = ref<any>(),
  loading = ref(true),
  failed = ref(false);
let generation = 0,
  observer: IntersectionObserver | undefined;
async function load() {
  const request = ++generation;
  loading.value = true;
  try {
    const result = await $fetch<any>(
      `/api/v1/pages/${props.node.attrs.pageId}/preview`,
      { query: { heading: props.node.attrs.headingId || "" } },
    );
    if (request === generation) {
      data.value = result;
      failed.value = false;
    }
  } catch {
    if (request === generation) {
      data.value = undefined;
      failed.value = true;
    }
  } finally {
    if (request === generation) loading.value = false;
  }
}
onMounted(() => {
  if (root.value) {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer?.disconnect();
          void load();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(root.value);
  }
});
onBeforeUnmount(() => {
  generation++;
  observer?.disconnect();
});
watch(
  () => [props.node.attrs.pageId, props.node.attrs.headingId],
  () => {
    data.value = undefined;
    failed.value = false;
    void load();
  },
);
</script>
<template>
  <NodeViewWrapper class="page-preview-block" contenteditable="false"
    ><div ref="root">
      <p v-if="loading && !data" class="hint" role="status">
        Loading document preview…
      </p>
      <div v-else-if="failed || !data" class="preview-unavailable">
        <AppIcon name="lock" :size="18" /><span
          >This document is unavailable or you do not have access.</span
        ><button class="ghost" @click="load">Retry</button>
      </div>
      <a
        v-else
        :href="pageLink(node.attrs.pageId, node.attrs.headingId || '')"
        class="page-preview-card"
        @click="
          if (
            !$event.ctrlKey &&
            !$event.metaKey &&
            !$event.shiftKey &&
            !$event.altKey
          ) {
            $event.preventDefault();
            navigate?.(node.attrs.pageId, node.attrs.headingId || '');
          }
        "
        ><div class="preview-kind">
          <AppIcon
            :name="data.kind === 'database' ? 'database' : 'file'"
            :size="17"
          /><span
            >{{ data.spaceName }} ·
            {{ data.kind === "database" ? "Database" : "Document" }}</span
          ><AppIcon name="arrowRight" :size="15" />
        </div>
        <strong>{{ data.title }}</strong><span
          v-if="data.heading"
          class="preview-heading"
          ><AppIcon name="heading" :size="14" />{{ data.heading.text }}</span
        >
        <p v-if="data.excerpt">{{ data.excerpt }}</p>
        <small v-if="data.missingHeading"
          >The heading is no longer available. Open the document to
          continue.</small
        ></a
      >
    </div>
    <div class="preview-actions">
      <button
        class="ghost"
        :disabled="loading"
        aria-label="Refresh document preview"
        @click="load"
      >
        <AppIcon name="history" :size="13" />Refresh</button
      ><button
        v-if="editable"
        class="ghost"
        aria-label="Remove page preview"
        @click="deleteNode"
      >
        Remove block
      </button>
    </div></NodeViewWrapper
  >
</template>
<style scoped>
.page-preview-block {
  margin: 18px 0;
}
.page-preview-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  padding: 18px;
  text-decoration: none;
  color: var(--text);
}
.page-preview-card:hover {
  background: var(--surface-hover);
  border-color: var(--accent);
}
.preview-kind {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 0.75rem;
}
.preview-kind span {
  flex: 1;
}
strong {
  font-size: 1.1rem;
  overflow-wrap: anywhere;
}
.preview-heading {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--accent);
  font-size: 0.85rem;
}
.page-preview-card p {
  margin: 0;
  color: var(--muted);
  font-size: 0.88rem;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
small {
  color: var(--muted);
}
.preview-unavailable {
  display: flex;
  align-items: center;
  gap: 9px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  padding: 14px;
  color: var(--muted);
  font-size: 0.85rem;
}
.preview-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 5px;
}
.preview-actions button {
  font-size: 0.75rem;
  color: var(--muted);
}
</style>

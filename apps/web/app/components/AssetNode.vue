<script setup lang="ts">
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/vue-3";
const descriptionId = useId();
const props = defineProps<NodeViewProps>(),
  editable = useNodeEditable(props.editor),
  root = ref<HTMLElement>(),
  file = ref<any>(),
  loading = ref(true),
  failed = ref(false),
  revision = ref(0);
const image = computed(() => props.node.type.name === "orvynImage");
let generation = 0,
  observer: IntersectionObserver | undefined;
async function load() {
  const request = ++generation;
  loading.value = true;
  failed.value = false;
  try {
    const info = await $fetch<any>(
      "/api/v1/files/" + props.node.attrs.fileId + "/info",
    );
    if (request === generation) {
      file.value = info;
      revision.value++;
    }
  } catch {
    if (request === generation) {
      file.value = undefined;
      failed.value = true;
    }
  } finally {
    if (request === generation) loading.value = false;
  }
}
function changed(event: Event) {
  const detail = (event as CustomEvent).detail;
  if (detail?.fileId === props.node.attrs.fileId) void load();
}
onMounted(() => {
  const element = root.value;
  if (element) {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer?.disconnect();
          void load();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
  }
  window.addEventListener("orvyn-file-changed", changed);
});
onBeforeUnmount(() => {
  generation++;
  observer?.disconnect();
  window.removeEventListener("orvyn-file-changed", changed);
});
watch(
  () => props.node.attrs.fileId,
  () => void load(),
);
</script>
<template>
  <NodeViewWrapper
    :as="image ? 'figure' : 'div'"
    class="editor-asset"
    :class="{ 'image-asset': image }"
    contenteditable="false"
  >
    <div ref="root" class="asset-body">
      <p v-if="loading" role="status" class="hint">
        Loading {{ image ? "image" : "attachment" }}…
      </p>
      <div v-else-if="failed || !file" class="asset-unavailable">
        <AppIcon name="paperclip" :size="18" /><span
          >{{ image ? "Image" : "Attachment" }} unavailable or access
          denied.</span
        ><button class="ghost" type="button" @click="load">Retry</button>
      </div>
      <template v-else-if="image"
        ><img
          :key="revision"
          :src="'/api/v1/files/' + file.id + '/preview'"
          :alt="node.attrs.label || file.filename"
          loading="lazy"
          @error="failed = true"
        />
        <figcaption>
          {{ node.attrs.label || file.filename }}
        </figcaption></template
      >
      <a
        v-else
        class="editor-file-link"
        :href="'/api/v1/files/' + file.id + '/download'"
        ><AppIcon name="paperclip" :size="21" /><span
          >{{ node.attrs.label || file.filename
          }}<small
            >{{ Intl.NumberFormat().format(file.size) }} bytes ·
            {{ file.filename }}</small
          ></span
        ><AppIcon name="download" :size="16"
      /></a>
    </div>
    <div v-if="editable" class="asset-edit-controls">
      <label v-if="image" class="sr-only" :for="descriptionId"
        >Image description</label
      ><input
        v-if="image"
        :id="descriptionId"
        :value="node.attrs.label"
        maxlength="500"
        aria-label="Image description"
        @change="
          updateAttributes({ label: ($event.target as HTMLInputElement).value })
        "
      /><button
        type="button"
        class="ghost"
        aria-label="Remove embedded attachment"
        @click="deleteNode"
      >
        Remove block
      </button>
    </div>
  </NodeViewWrapper>
</template>
<style scoped>
.editor-asset {
  margin: 20px 0;
  position: relative;
  border-radius: 8px;
}
.image-asset img {
  display: block;
  max-width: 100%;
  max-height: 600px;
  margin: auto;
  object-fit: contain;
  border-radius: 6px;
}
figcaption {
  text-align: center;
  color: var(--muted);
  font-size: 0.8rem;
  margin-top: 8px;
  overflow-wrap: anywhere;
}
.editor-file-link {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  text-decoration: none;
  background: var(--surface);
  color: var(--text);
}
.editor-file-link:hover {
  background: var(--surface-hover);
}
.editor-file-link span {
  flex: 1;
  overflow-wrap: anywhere;
}
small {
  display: block;
  font-size: 0.75rem;
  color: var(--muted);
  margin-top: 3px;
}
.asset-unavailable {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  font-size: 0.85rem;
  color: var(--muted);
}
.asset-edit-controls {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 7px;
}
.asset-edit-controls input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: 0.8rem;
  color: var(--muted);
  border-color: transparent;
  background: transparent;
}
.asset-edit-controls input:focus {
  border-color: var(--line);
  background: var(--surface);
}
.asset-edit-controls button {
  font-size: 0.75rem;
  color: var(--muted);
}
</style>

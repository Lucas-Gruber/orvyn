<script setup lang="ts">
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/vue-3";
import {
  providerNames,
  videoSource,
  type VideoProvider,
} from "@orvyn/editor/embeds";
const props = defineProps<NodeViewProps>(),
  editable = useNodeEditable(props.editor),
  loaded = ref(false);
const provider = computed(
    () => providerNames[props.node.attrs.provider as VideoProvider] || "Video",
  ),
  src = computed(() =>
    videoSource(props.node.attrs.provider, props.node.attrs.resourceId),
  );
watch(
  () => [props.node.attrs.provider, props.node.attrs.resourceId],
  () => (loaded.value = false),
);
</script>
<template>
  <NodeViewWrapper class="video-embed-block" contenteditable="false">
    <div v-if="loaded && src" class="video-frame">
      <iframe
        :src="src"
        :title="node.attrs.title || provider + ' video'"
        sandbox="allow-scripts allow-same-origin allow-presentation"
        referrerpolicy="no-referrer"
        allow="encrypted-media; picture-in-picture; fullscreen"
        allowfullscreen
      />
    </div>
    <div v-else class="video-placeholder">
      <AppIcon name="globe" :size="27" /><strong>{{
        node.attrs.title || provider + " video"
      }}</strong>
      <p>
        External content from {{ provider }} loads only when you choose to load
        it.
      </p>
      <button
        class="primary"
        type="button"
        :disabled="!src"
        @click="loaded = true"
      >
        Load video
      </button>
    </div>
    <div class="video-embed-actions">
      <span>{{ provider }}</span
      ><button
        v-if="loaded"
        type="button"
        class="ghost"
        @click="loaded = false"
      >
        Unload video</button
      ><button
        v-if="editable"
        type="button"
        class="ghost"
        aria-label="Remove video embed"
        @click="deleteNode"
      >
        Remove block
      </button>
    </div>
  </NodeViewWrapper>
</template>
<style scoped>
.video-embed-block {
  margin: 20px 0;
}
.video-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  padding: 35px 24px;
  text-align: center;
}
.video-placeholder .app-icon {
  color: var(--accent);
}
strong {
  font-size: 1rem;
}
.video-placeholder p {
  margin: 0;
  color: var(--muted);
  font-size: 0.85rem;
}
.video-frame {
  aspect-ratio: 16/9;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}
iframe {
  border: 0;
  width: 100%;
  height: 100%;
  display: block;
}
.video-embed-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 5px;
  color: var(--muted);
  font-size: 0.75rem;
}
.video-embed-actions span {
  margin-right: auto;
}
.video-embed-actions button {
  font-size: 0.75rem;
  color: var(--muted);
}
</style>

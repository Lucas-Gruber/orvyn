<script setup lang="ts">
import {
  videoSource,
  providerNames,
  type VideoProvider,
} from "@orvyn/editor/embeds";
const props = defineProps<{ node: any }>(),
  loaded = ref(false),
  src = computed(() =>
    videoSource(props.node.attrs.provider, props.node.attrs.resourceId),
  ),
  provider = computed(
    () => providerNames[props.node.attrs.provider as VideoProvider] || "Video",
  );
</script>
<template>
  <div class="public-video">
    <iframe
      v-if="loaded && src"
      :src="src"
      :title="node.attrs.title || provider + ' video'"
      sandbox="allow-scripts allow-same-origin allow-presentation"
      referrerpolicy="no-referrer"
      allow="encrypted-media; picture-in-picture; fullscreen"
      allowfullscreen
    />
    <div v-else>
      <AppIcon name="video" :size="28" /><strong>{{
        node.attrs.title || provider + " video"
      }}</strong>
      <p>
        External content from {{ provider }} loads when you choose to play it.
      </p>
      <button :disabled="!src" @click="loaded = true">Load video</button>
    </div>
  </div>
</template>
<style scoped>
.public-video {
  margin: 24px 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}
.public-video > div {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 32px;
  text-align: center;
  background: var(--surface);
}
p {
  font-size: 13px;
  color: var(--muted);
  margin: 0;
}
iframe {
  display: block;
  width: 100%;
  aspect-ratio: 16/9;
  border: 0;
}
</style>

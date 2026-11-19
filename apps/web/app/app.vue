<script setup lang="ts">
const route = useRoute();
const publicPath = computed(() => route.path.startsWith("/s/"));
const token = computed(
  () => /^\/s\/([A-Za-z0-9_-]{43})\/?$/.exec(route.path)?.[1] || "invalid",
);
</script>
<template>
  <PublicViewer v-if="publicPath" :key="token" :token="token" /><WorkspaceApp
    v-else
  />
</template>

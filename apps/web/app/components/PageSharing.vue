<script setup lang="ts">
const props = defineProps<{ page: any; flush?: () => Promise<void> }>(),
  emit = defineEmits<{ changed: [] }>(),
  tab = ref("people");
const publishable = computed(() =>
  ["page", "folder", "whiteboard", "database", "record"].includes(
    props.page.kind,
  ),
);
</script>
<template>
  <div class="sharing-tabs" role="tablist" aria-label="Share page">
    <button
      role="tab"
      :aria-selected="tab === 'people'"
      aria-controls="sharing-panel"
      @click="tab = 'people'"
    >
      <AppIcon name="users" :size="16" />People</button
    ><button
      v-if="publishable"
      role="tab"
      :aria-selected="tab === 'publish'"
      aria-controls="sharing-panel"
      @click="tab = 'publish'"
    >
      <AppIcon name="globe" :size="16" />Publish
    </button>
  </div>
  <section id="sharing-panel" role="tabpanel">
    <PagePermissions
      v-if="tab === 'people'"
      :page="page"
      @changed="emit('changed')"
    /><PublicationPublishPanel v-else :page="page" :flush="flush" />
  </section>
</template>
<style scoped>
.sharing-tabs {
  display: flex;
  gap: 16px;
  border-bottom: 1px solid var(--line);
  margin: -4px 0 22px;
}
.sharing-tabs button {
  border: 0;
  background: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  padding: 8px 2px 12px;
  color: var(--muted);
}
.sharing-tabs button[aria-selected="true"] {
  border-bottom-color: var(--text);
  color: var(--text);
}
</style>

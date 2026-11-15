<script setup lang="ts">
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/vue-3";
import { pageNavigationKey } from "../composables/pageNavigation";
defineProps<NodeViewProps>();
const open = inject(pageNavigationKey);
</script>
<template>
  <NodeViewWrapper class="embedded-database" contenteditable="false"
    ><p class="hint">Linked database</p>
    <LazyDatabaseWorkspace
      :key="node.attrs.databaseId + ':' + node.attrs.viewId"
      :database-id="node.attrs.databaseId"
      :initial-view-id="node.attrs.viewId || undefined"
      @open="open?.($event)"
  /></NodeViewWrapper>
</template>
<style scoped>
.embedded-database {
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  padding: 1rem;
  margin: 1rem 0;
  max-height: 900px;
  overflow: auto;
}
</style>

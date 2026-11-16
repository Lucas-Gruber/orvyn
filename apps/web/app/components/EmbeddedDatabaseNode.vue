<script setup lang="ts">
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/vue-3";
import { pageNavigationKey } from "../composables/pageNavigation";
import { recordNavigationKey } from "../composables/recordNavigation";
defineProps<NodeViewProps>();
const open = inject(pageNavigationKey);
const openRecord = inject(recordNavigationKey);
function visit(id: string, mode: "side" | "modal" | "page" = "side") {
  if (openRecord) openRecord(id, mode);
  else open?.(id);
}
</script>
<template>
  <NodeViewWrapper class="embedded-database" contenteditable="false"
    ><p class="hint">Linked database</p>
    <LazyDatabaseWorkspace
      :key="node.attrs.databaseId + ':' + node.attrs.viewId"
      :database-id="node.attrs.databaseId"
      :initial-view-id="node.attrs.viewId || undefined"
      @open="visit"
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

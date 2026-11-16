<script setup lang="ts">
import {
  NodeViewWrapper,
  NodeViewContent,
  type NodeViewProps,
} from "@tiptap/vue-3";
defineProps<NodeViewProps>();
</script>
<template>
  <NodeViewWrapper class="columns-block"
    ><NodeViewContent
      class="columns-content"
      :style="{ '--column-count': node.childCount }"
  /></NodeViewWrapper>
</template>
<style>
.columns-block {
  margin: 18px 0;
}
.columns-content {
  display: grid;
  grid-template-columns: repeat(var(--column-count), minmax(0, 1fr));
  gap: 24px;
}
[data-orvyn-column] {
  min-width: 0;
  min-height: 36px;
  padding: 4px 0;
}
[data-orvyn-column] + [data-orvyn-column] {
  border-left: 1px solid var(--line-soft);
  padding-left: 20px;
}
.block-editor
  .tiptap
  [data-orvyn-column]
  > p:only-child:has(> br:only-child):before {
  content: "Write here…";
}
@media (max-width: 760px) {
  .columns-content {
    grid-template-columns: 1fr !important;
    gap: 12px;
  }
  [data-orvyn-column] + [data-orvyn-column] {
    border-left: 0;
    border-top: 1px solid var(--line-soft);
    padding: 14px 0 0;
  }
}
</style>

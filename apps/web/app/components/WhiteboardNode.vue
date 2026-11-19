<script setup lang="ts">
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/vue-3";
defineProps<NodeViewProps>();
</script>
<template>
  <NodeViewWrapper class="embedded-whiteboard" contenteditable="false"
    ><LazyWhiteboard
      :key="node.attrs.pageId"
      :page-id="node.attrs.pageId"
      embedded
  /></NodeViewWrapper>
</template>
<style scoped>
.embedded-whiteboard {
  margin: 18px 0;
}
</style>

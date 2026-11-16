<script setup lang="ts">
import {
  NodeViewWrapper,
  NodeViewContent,
  type NodeViewProps,
} from "@tiptap/vue-3";
const props = defineProps<NodeViewProps>(),
  expanded = ref(true),
  editable = useNodeEditable(props.editor),
  id = useId();
const label = computed(
  () => props.node.firstChild?.textContent || "Untitled toggle",
);
function toggle() {
  if (expanded.value && editable.value) {
    const start = props.getPos();
    if (typeof start === "number")
      props.editor.commands.setTextSelection(
        start + 1 + props.node.firstChild!.nodeSize - 1,
      );
  }
  expanded.value = !expanded.value;
}
function selectionChanged() {
  const start = props.getPos(),
    from = props.editor.state.selection.from;
  if (
    typeof start === "number" &&
    from > start + 1 + props.node.firstChild!.nodeSize &&
    from < start + props.node.nodeSize
  )
    expanded.value = true;
}
onMounted(() => props.editor.on("selectionUpdate", selectionChanged));
onBeforeUnmount(() => props.editor.off("selectionUpdate", selectionChanged));
</script>
<template>
  <NodeViewWrapper class="toggle-block" :class="{ 'is-collapsed': !expanded }">
    <button
      type="button"
      class="icon-button toggle-control"
      contenteditable="false"
      :aria-label="(expanded ? 'Collapse ' : 'Expand ') + label"
      :aria-expanded="expanded"
      :aria-controls="id"
      @mousedown.prevent
      @click="toggle"
    >
      <AppIcon :name="expanded ? 'chevronDown' : 'chevronRight'" :size="17" />
    </button>
    <NodeViewContent :id="id" class="toggle-content" />
  </NodeViewWrapper>
</template>
<style>
.toggle-block {
  position: relative;
  margin: 12px 0;
  padding-left: 28px;
}
.toggle-control {
  position: absolute;
  left: 0;
  top: -2px;
  width: 24px;
  color: var(--muted);
}
[data-orvyn-toggle-summary] {
  font-weight: 550;
  min-height: 26px;
}
[data-orvyn-toggle-summary]:empty:before {
  content: "Toggle title";
  color: var(--faint);
  pointer-events: none;
  float: left;
  height: 0;
}
[data-orvyn-toggle-content] {
  padding-top: 8px;
}
.toggle-block.is-collapsed
  > .toggle-content
  > [data-node-view-content]
  > [data-orvyn-toggle-content],
.toggle-block.is-collapsed > .toggle-content > [data-orvyn-toggle-content] {
  display: none;
}
</style>

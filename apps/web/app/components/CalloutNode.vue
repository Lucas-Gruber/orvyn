<script setup lang="ts">
import {
  NodeViewWrapper,
  NodeViewContent,
  type NodeViewProps,
} from "@tiptap/vue-3";
const props = defineProps<NodeViewProps>(),
  editable = useNodeEditable(props.editor);
const icons: Record<string, string> = {
  info: "info",
  neutral: "lightbulb",
  success: "check",
  warning: "warning",
  danger: "warning",
};
</script>
<template>
  <NodeViewWrapper
    as="aside"
    class="callout-block"
    :data-tone="node.attrs.tone"
    aria-label="Callout"
  >
    <div class="callout-controls" contenteditable="false">
      <AppIcon :name="icons[node.attrs.tone] || 'info'" :size="19" /><select
        v-if="editable"
        aria-label="Callout style"
        :value="node.attrs.tone"
        @change="
          updateAttributes({ tone: ($event.target as HTMLSelectElement).value })
        "
      >
        <option value="info">Info</option>
        <option value="neutral">Note</option>
        <option value="success">Success</option>
        <option value="warning">Warning</option>
        <option value="danger">Important</option>
      </select>
    </div>
    <NodeViewContent class="callout-content" />
  </NodeViewWrapper>
</template>
<style>
.callout-block {
  display: flex;
  gap: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px 16px;
  background: var(--accent-soft);
  margin: 16px 0;
}
.callout-controls {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--accent);
  padding-top: 3px;
}
.callout-controls select {
  width: 76px;
  min-height: 22px;
  padding: 0;
  font-size: 11px;
  border: 0;
  background: transparent;
  color: var(--muted);
}
.callout-controls select:focus {
  width: auto;
}
.callout-content {
  min-width: 0;
  flex: 1;
}
.callout-content > :last-child {
  margin-bottom: 0 !important;
}
.callout-block[data-tone="neutral"] {
  background: var(--surface);
}
.callout-block[data-tone="success"] {
  background: color-mix(in srgb, var(--success) 9%, var(--bg));
  border-color: color-mix(in srgb, var(--success) 25%, var(--line));
}
.callout-block[data-tone="success"] .callout-controls {
  color: var(--success);
}
.callout-block[data-tone="warning"] {
  background: color-mix(in srgb, var(--warning) 9%, var(--bg));
  border-color: color-mix(in srgb, var(--warning) 25%, var(--line));
}
.callout-block[data-tone="warning"] .callout-controls {
  color: var(--warning);
}
.callout-block[data-tone="danger"] {
  background: color-mix(in srgb, var(--error) 9%, var(--bg));
  border-color: color-mix(in srgb, var(--error) 25%, var(--line));
}
.callout-block[data-tone="danger"] .callout-controls {
  color: var(--error);
}
</style>

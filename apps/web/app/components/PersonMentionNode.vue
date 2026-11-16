<script setup lang="ts">
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/vue-3";
import { editorPeopleKey } from "../composables/editorPeople";
const props = defineProps<NodeViewProps>(),
  people = inject(editorPeopleKey),
  person = computed(() => people?.value.get(props.node.attrs.userId));
</script>
<template>
  <NodeViewWrapper
    as="span"
    class="editor-person"
    :class="{ unavailable: !person }"
    :data-person-id="node.attrs.userId"
    contenteditable="false"
    tabindex="-1"
    :title="person?.email || 'Person unavailable or no longer a page reader'"
    ><span aria-hidden="true">@</span
    >{{ person?.email || "Person unavailable" }}</NodeViewWrapper
  >
</template>
<style scoped>
.editor-person {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  vertical-align: baseline;
  border-radius: 4px;
  padding: 0 4px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.9em;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.editor-person.unavailable {
  color: var(--muted);
  background: var(--surface);
}
.editor-person.ProseMirror-selectednode,
.editor-person:focus,
.editor-person[data-mention-target] {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>

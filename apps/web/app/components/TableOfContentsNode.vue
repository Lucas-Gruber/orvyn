<script setup lang="ts">
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/vue-3";
import { documentHeadings } from "@orvyn/editor/links";
import { editorPageKey } from "../composables/editorContext";
import { pageNavigationKey } from "../composables/pageNavigation";
const props = defineProps<NodeViewProps>(),
  headings = ref(documentHeadings(props.editor.getJSON())),
  pageId = inject(editorPageKey),
  navigate = inject(pageNavigationKey);
function update() {
  headings.value = documentHeadings(props.editor.getJSON());
}
onMounted(() => props.editor.on("transaction", update));
onBeforeUnmount(() => props.editor.off("transaction", update));
</script>
<template>
  <NodeViewWrapper
    as="nav"
    class="toc-block"
    contenteditable="false"
    aria-label="Table of contents"
    ><div class="toc-title"><AppIcon name="list" :size="15" />On this page</div>
    <ul v-if="headings.length">
      <li v-for="heading in headings" :key="heading.id">
        <button
          type="button"
          :style="{ paddingLeft: 8 + (heading.level - 1) * 14 + 'px' }"
          @click="pageId && navigate?.(pageId(), heading.id)"
        >
          {{ heading.text }}
        </button>
      </li>
    </ul>
    <p v-else>
      Add headings to build an outline of this page.
    </p></NodeViewWrapper
  >
</template>
<style scoped>
.toc-block {
  border-left: 2px solid var(--line);
  padding: 8px 0 8px 14px;
  margin: 18px 0;
}
.toc-title {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  font-size: 0.8rem;
  margin-bottom: 5px;
}
ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
button {
  display: block;
  text-align: left;
  width: 100%;
  background: transparent;
  border: 0;
  padding: 5px 8px;
  color: var(--muted);
  font-size: 0.9rem;
  overflow-wrap: anywhere;
}
button:hover {
  color: var(--text);
  background: var(--surface-hover);
}
p {
  font-size: 0.85rem;
  color: var(--faint);
}
</style>

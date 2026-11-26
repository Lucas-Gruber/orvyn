<script setup lang="ts">
import { Editor, EditorContent } from "@tiptap/vue-3";
import { editorExtensions } from "@orvyn/editor";

const props = defineProps<{ document: Record<string, unknown> }>();
const preview = shallowRef<Editor>();
onMounted(() => {
  try {
    // A separate read-only editor: never seed the collaborative Y.Doc from an
    // HTTP snapshot, which could duplicate content when synchronization starts.
    preview.value = new Editor({
      extensions: editorExtensions(),
      content: props.document,
      editable: false,
      editorProps: {
        attributes: {
          role: "document",
          "aria-label": "Saved document preview",
        },
      },
    });
  } catch {
    // The connection panel still offers recovery for unsupported snapshots.
  }
});
onBeforeUnmount(() => preview.value?.destroy());
</script>
<template>
  <div v-if="preview" class="saved-document-preview">
    <p class="hint">Saved version · Read-only until connected</p>
    <EditorContent :editor="preview" />
  </div>
</template>

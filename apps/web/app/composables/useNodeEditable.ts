import type { NodeViewProps } from "@tiptap/vue-3";
export function useNodeEditable(editor: NodeViewProps["editor"]) {
  const editable = ref(editor.isEditable),
    update = () => (editable.value = editor.isEditable);
  onMounted(() => {
    editor.on("transaction", update);
    editor.on("update", update);
  });
  onBeforeUnmount(() => {
    editor.off("transaction", update);
    editor.off("update", update);
  });
  return editable;
}

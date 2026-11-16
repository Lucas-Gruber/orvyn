<script setup lang="ts">
import { BubbleMenu } from "@tiptap/vue-3/menus";
import type { NodeViewProps } from "@tiptap/vue-3";
import { BlockSelection } from "@orvyn/editor";
const props = defineProps<{
    editor: NodeViewProps["editor"];
    canComment?: boolean;
  }>(),
  emit = defineEmits<{ link: []; comment: [] }>();
// ProseMirror does not follow native selections in non-editable content.
// Keep its local selection in sync for commenting without changing the document.
function followReadonlySelection() {
  if (!props.canComment || props.editor.isEditable || props.editor.isDestroyed)
    return;
  const dom = props.editor.view.dom,
    selection = window.getSelection();
  if (
    !selection?.anchorNode ||
    !selection.focusNode ||
    !dom.contains(selection.anchorNode) ||
    !dom.contains(selection.focusNode)
  )
    return;
  const a = props.editor.view.posAtDOM(
      selection.anchorNode,
      selection.anchorOffset,
    ),
    b = props.editor.view.posAtDOM(selection.focusNode, selection.focusOffset),
    from = Math.min(a, b),
    to = Math.max(a, b);
  if (
    props.editor.state.selection.from !== from ||
    props.editor.state.selection.to !== to
  )
    props.editor.commands.setTextSelection({ from, to });
}
onMounted(() =>
  document.addEventListener("selectionchange", followReadonlySelection),
);
onBeforeUnmount(() =>
  document.removeEventListener("selectionchange", followReadonlySelection),
);
const menuContainer = () => document.body;
function selectionReference() {
  const selection = window.getSelection(),
    dom = props.editor.view.dom;
  if (
    !selection?.rangeCount ||
    selection.isCollapsed ||
    !selection.anchorNode ||
    !dom.contains(selection.anchorNode)
  )
    return null;
  const range = selection.getRangeAt(0).cloneRange();
  return {
    contextElement: dom,
    getBoundingClientRect: () => range.getBoundingClientRect(),
    getClientRects: () => range.getClientRects(),
  };
}
function visible({
  state,
  element,
}: {
  state: NodeViewProps["editor"]["state"];
  element: HTMLElement;
}) {
  return (
    (props.editor.isEditable || props.canComment) &&
    (props.editor.isFocused ||
      props.editor.view.dom.contains(document.activeElement) ||
      element.contains(document.activeElement)) &&
    !state.selection.empty &&
    !(state.selection instanceof BlockSelection) &&
    !!state.doc.textBetween(state.selection.from, state.selection.to).trim() &&
    (!props.editor.isActive("codeBlock") || props.canComment)
  );
}
</script>
<template>
  <BubbleMenu
    :editor="editor"
    :get-referenced-virtual-element="selectionReference"
    :append-to="menuContainer"
    style="z-index: 70"
    :should-show="visible"
    :update-delay="100"
    :options="{
      strategy: 'fixed',
      placement: 'top',
      offset: 8,
      shift: { padding: 12 },
      flip: true,
    }"
    ><div
      v-show="editor.isEditable || canComment"
      class="floating-format-menu"
      role="toolbar"
      :aria-label="
        editor.isEditable && !editor.isActive('codeBlock')
          ? 'Selected text formatting'
          : 'Selected text comments'
      "
      @mousedown.prevent
    >
      <template v-if="editor.isEditable && !editor.isActive('codeBlock')"
        ><button
          type="button"
          class="icon-button"
          title="Bold"
          aria-label="Bold"
          :aria-pressed="editor.isActive('bold')"
          @click="editor.chain().focus().toggleBold().run()"
        >
          <AppIcon name="bold" :size="16" /></button
        ><button
          type="button"
          class="icon-button"
          title="Italic"
          aria-label="Italic"
          :aria-pressed="editor.isActive('italic')"
          @click="editor.chain().focus().toggleItalic().run()"
        >
          <AppIcon name="italic" :size="16" /></button
        ><button
          type="button"
          class="icon-button"
          title="Underline"
          aria-label="Underline"
          :aria-pressed="editor.isActive('underline')"
          @click="editor.chain().focus().toggleUnderline().run()"
        >
          <span class="format-underline">U</span></button
        ><button
          type="button"
          class="icon-button"
          title="Strikethrough"
          aria-label="Strikethrough"
          :aria-pressed="editor.isActive('strike')"
          @click="editor.chain().focus().toggleStrike().run()"
        >
          <span class="format-strike">S</span></button
        ><button
          type="button"
          class="icon-button"
          title="Link selection"
          aria-label="Link selection"
          @click="emit('link')"
        >
          <AppIcon name="link" :size="16" /></button
        ><button
          type="button"
          class="ghost"
          @click="editor.chain().focus().unsetAllMarks().run()"
        >
          Clear formatting
        </button></template
      >
      <button
        v-if="canComment"
        type="button"
        class="ghost"
        title="Comment on selection · Ctrl/Cmd+Shift+M"
        @click="emit('comment')"
      >
        <AppIcon name="comments" :size="16" />Comment
      </button>
    </div></BubbleMenu
  >
</template>
<style scoped>
.floating-format-menu {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 5px;
  background: var(--elevated);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: var(--shadow);
  z-index: 70;
  max-width: calc(100vw - 24px);
}
.floating-format-menu button {
  font-size: 0.8rem;
  white-space: nowrap;
}
.floating-format-menu button[aria-pressed="true"] {
  background: var(--accent-soft);
  color: var(--accent);
}
.format-underline {
  text-decoration: underline;
}
.format-strike {
  text-decoration: line-through;
}
</style>

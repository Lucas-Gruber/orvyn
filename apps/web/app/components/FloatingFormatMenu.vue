<script setup lang="ts">
import { BubbleMenu } from "@tiptap/vue-3/menus";
import type { NodeViewProps } from "@tiptap/vue-3";
const props = defineProps<{ editor: NodeViewProps["editor"] }>(),
  emit = defineEmits<{ link: [] }>();
function visible({
  state,
  element,
}: {
  state: NodeViewProps["editor"]["state"];
  element: HTMLElement;
}) {
  return (
    props.editor.isEditable &&
    (props.editor.isFocused || element.contains(document.activeElement)) &&
    !state.selection.empty &&
    !!state.doc.textBetween(state.selection.from, state.selection.to).trim() &&
    !props.editor.isActive("codeBlock")
  );
}
</script>
<template>
  <BubbleMenu
    :editor="editor"
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
      class="floating-format-menu"
      role="toolbar"
      aria-label="Selected text formatting"
      @mousedown.prevent
    >
      <button
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
      </button>
    </div></BubbleMenu
  >
</template>
<style scoped>
.floating-format-menu {
  display: flex;
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

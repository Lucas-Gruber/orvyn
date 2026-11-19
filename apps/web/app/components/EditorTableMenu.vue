<script setup lang="ts">
import { BubbleMenu } from "@tiptap/vue-3/menus";
import type { NodeViewProps } from "@tiptap/vue-3";
import {
  tableSelectionContext,
  canRunEditorTableAction,
  runEditorTableAction,
  setEditorTableColumnWidth,
  editorTableMinWidth,
  editorTableMaxWidth,
  type EditorTableAction,
} from "@orvyn/editor";
const props = defineProps<{ editor: NodeViewProps["editor"] }>();
const revision = ref(0),
  widthOpen = ref(false),
  width = ref(160);
const widthId = useId();
let positionFrame = 0;
function positionAfterLayout() {
  void nextTick(() => {
    cancelAnimationFrame(positionFrame);
    positionFrame = requestAnimationFrame(() => {
      if (!props.editor.isDestroyed)
        props.editor.view.dispatch(
          props.editor.state.tr.setMeta("editorTableMenu", "updatePosition"),
        );
    });
  });
}
const context = computed(() => {
  revision.value;
  return tableSelectionContext(props.editor.state);
});
function refresh(event?: {
  transaction?: { docChanged: boolean; selectionSet: boolean };
}) {
  revision.value++;
  if (event?.transaction?.docChanged || event?.transaction?.selectionSet)
    positionAfterLayout();
}
function can(action: EditorTableAction) {
  revision.value;
  return canRunEditorTableAction(props.editor, action);
}
function run(action: EditorTableAction) {
  runEditorTableAction(props.editor, action);
}
function reference() {
  const current = tableSelectionContext(props.editor.state);
  if (!current) return null;
  const element = props.editor.view.nodeDOM(
    current.position,
  ) as HTMLElement | null;
  if (!element) return null;
  return {
    contextElement: element,
    getBoundingClientRect() {
      const root = props.editor.view.nodeDOM(
        current.position,
      ) as HTMLElement | null;
      const table =
        root?.tagName === "TABLE" ? root : root?.querySelector("table");
      const rect = (table || root || element).getBoundingClientRect();
      return new DOMRect(rect.left, rect.top, rect.width, 0);
    },
    getClientRects() {
      return element.getClientRects();
    },
  };
}
function container() {
  return (
    props.editor.view.dom.closest<HTMLElement>(".block-editor") ||
    props.editor.view.dom.parentElement ||
    document.body
  );
}
function visible({ element }: { element: HTMLElement }) {
  return (
    !!context.value &&
    props.editor.isEditable &&
    !widthOpen.value &&
    (props.editor.isFocused || element.contains(document.activeElement))
  );
}
function openWidth() {
  const current = context.value;
  if (!current) return;
  const root = props.editor.view.nodeDOM(
    current.position,
  ) as HTMLElement | null;
  const column = root?.querySelectorAll("colgroup > col")[current.column];
  width.value = Math.max(
    editorTableMinWidth,
    Math.min(
      editorTableMaxWidth,
      Math.round(column?.getBoundingClientRect().width || 160),
    ),
  );
  widthOpen.value = true;
}
async function closeWidth() {
  widthOpen.value = false;
  await nextTick();
  if (props.editor.isEditable) props.editor.commands.focus();
}
function saveWidth() {
  if (setEditorTableColumnWidth(props.editor, width.value)) void closeWidth();
}
watch(context, (current) => {
  if (!current || !props.editor.isEditable) widthOpen.value = false;
});
watch(
  () => !!context.value,
  (active) => {
    if (active) positionAfterLayout();
  },
  { flush: "post" },
);
onMounted(() => {
  props.editor.on("transaction", refresh);
  props.editor.on("update", refresh);
});
onBeforeUnmount(() => {
  cancelAnimationFrame(positionFrame);
  props.editor.off("transaction", refresh);
  props.editor.off("update", refresh);
});
</script>
<template>
  <BubbleMenu
    v-if="editor.isEditable && context"
    plugin-key="editorTableMenu"
    style="z-index: 75"
    :editor="editor"
    :should-show="visible"
    :get-referenced-virtual-element="reference"
    :append-to="container"
    :update-delay="30"
    :options="{
      strategy: 'fixed',
      placement: 'top-start',
      offset: 8,
      shift: { padding: 8 },
      flip: true,
    }"
  >
    <div
      class="table-flow-menu"
      role="toolbar"
      aria-label="Table controls"
      @mousedown.prevent
    >
      <UiMenu label="Table actions" align="left">
        <template #trigger
          ><AppIcon name="table" :size="15" /><span>Table</span
          ><AppIcon name="chevronDown" :size="12"
        /></template>
        <span class="table-menu-label"
          >{{ context?.rows }} rows · {{ context?.columns }} columns</span
        >
        <button
          role="menuitemcheckbox"
          :aria-checked="context?.headerRow || false"
          :disabled="!can('toggleHeaderRow')"
          @click="run('toggleHeaderRow')"
        >
          <AppIcon name="table" :size="15" />Header row<AppIcon
            v-if="context?.headerRow"
            name="check"
            :size="14"
          />
        </button>
        <button
          role="menuitemcheckbox"
          :aria-checked="context?.headerColumn || false"
          :disabled="!can('toggleHeaderColumn')"
          @click="run('toggleHeaderColumn')"
        >
          <AppIcon name="table" :size="15" />Header column<AppIcon
            v-if="context?.headerColumn"
            name="check"
            :size="14"
          />
        </button>
        <hr />
        <button
          role="menuitem"
          :disabled="!can('mergeCells')"
          @click="run('mergeCells')"
        >
          <AppIcon name="table" :size="15" />Merge selected cells
        </button>
        <button
          role="menuitem"
          :disabled="!can('splitCell')"
          @click="run('splitCell')"
        >
          <AppIcon name="table" :size="15" />Split cell
        </button>
        <button
          role="menuitem"
          :disabled="!can('resetWidths')"
          @click="run('resetWidths')"
        >
          <AppIcon name="refresh" :size="15" />Reset column widths
        </button>
        <hr />
        <button role="menuitem" :disabled="!can('exit')" @click="run('exit')">
          <AppIcon name="arrowRight" :size="15" />Continue below table
        </button>
        <button
          role="menuitem"
          class="danger"
          :disabled="!can('deleteTable')"
          @click="run('deleteTable')"
        >
          <AppIcon name="trash" :size="15" />Delete table
        </button>
      </UiMenu>
      <span class="table-flow-divider" aria-hidden="true" />
      <UiMenu label="Row actions" align="left">
        <template #trigger
          ><span>Row {{ (context?.row || 0) + 1 }}</span
          ><AppIcon name="chevronDown" :size="12"
        /></template>
        <button
          role="menuitem"
          :disabled="!can('addRowBefore')"
          @click="run('addRowBefore')"
        >
          <AppIcon name="plus" :size="15" />Insert row above
        </button>
        <button
          role="menuitem"
          :disabled="!can('addRowAfter')"
          @click="run('addRowAfter')"
        >
          <AppIcon name="plus" :size="15" />Insert row below
        </button>
        <hr />
        <button
          role="menuitem"
          class="danger"
          :disabled="!can('deleteRow')"
          @click="run('deleteRow')"
        >
          <AppIcon name="trash" :size="15" />Delete row
        </button>
      </UiMenu>
      <UiMenu label="Column actions" align="right">
        <template #trigger
          ><span>Column {{ (context?.column || 0) + 1 }}</span
          ><AppIcon name="chevronDown" :size="12"
        /></template>
        <button
          role="menuitem"
          :disabled="!can('addColumnBefore')"
          @click="run('addColumnBefore')"
        >
          <AppIcon name="plus" :size="15" />Insert column left
        </button>
        <button
          role="menuitem"
          :disabled="!can('addColumnAfter')"
          @click="run('addColumnAfter')"
        >
          <AppIcon name="plus" :size="15" />Insert column right
        </button>
        <button
          role="menuitem"
          :disabled="!editor.isEditable"
          @click="openWidth"
        >
          <AppIcon name="table" :size="15" />Set column width…
        </button>
        <hr />
        <button
          role="menuitem"
          class="danger"
          :disabled="!can('deleteColumn')"
          @click="run('deleteColumn')"
        >
          <AppIcon name="trash" :size="15" />Delete column
        </button>
      </UiMenu>
    </div>
  </BubbleMenu>
  <UiDialog :open="widthOpen" title="Column width" @close="closeWidth">
    <form class="table-width-form" @submit.prevent="saveWidth">
      <label :for="widthId">Width in pixels</label
      ><input
        :id="widthId"
        v-model.number="width"
        type="number"
        :min="editorTableMinWidth"
        :max="editorTableMaxWidth"
        step="1"
        required
      />
      <p>Drag a column boundary to resize directly in the table.</p>
      <div class="actions">
        <button type="button" class="ghost" @click="closeWidth">Cancel</button
        ><button
          type="submit"
          class="primary"
          :disabled="!context || !editor.isEditable"
        >
          Apply width
        </button>
      </div>
    </form>
  </UiDialog>
</template>
<style scoped>
.table-flow-menu {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  background: var(--elevated);
  border: 1px solid var(--line);
  border-radius: 7px;
  box-shadow: var(--shadow);
  max-width: calc(100vw - 24px);
  font-size: 12px;
}
.table-flow-menu :deep(.menu-anchor > .icon-button) {
  width: auto;
  min-height: 28px;
  display: inline-flex;
  gap: 6px;
  padding: 4px 7px;
  color: var(--muted);
  font-size: 12px;
}
.table-flow-menu :deep(.menu-anchor > .icon-button:hover),
.table-flow-menu :deep(.menu-anchor > .icon-button[aria-expanded="true"]) {
  color: var(--text);
  background: var(--surface-hover);
}
.table-flow-divider {
  height: 18px;
  border-left: 1px solid var(--line);
  margin: 0 3px;
}
.table-menu-label {
  display: block;
  padding: 5px 9px 8px;
  color: var(--faint);
  font-size: 11px;
}
.table-flow-menu :deep(.menu-popover) {
  min-width: 210px;
  font-size: 13px;
}
.table-width-form {
  display: grid;
  gap: 12px;
}
.table-width-form label {
  margin: 0;
}
.table-width-form p {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}
.table-width-form .actions {
  justify-content: flex-end;
  padding-top: 8px;
}
</style>

<script setup lang="ts">
import { shortcutLabel } from "../utils/shortcuts";
const open = ref(false),
  groups = [
    {
      name: "Workspace",
      entries: [
        ["Search pages", "Mod+P"],
        ["Search outside the editor", "Mod+K"],
        ["New page", "Mod+Alt+N"],
        ["New database", "Mod+Alt+D"],
        ["Toggle sidebar", "Mod+\\"],
        ["Toggle light / dark", "Mod+Shift+L"],
        ["Keyboard shortcuts", "Mod+/"],
      ],
    },
    {
      name: "Writing",
      entries: [
        ["Bold", "Mod+B"],
        ["Italic", "Mod+I"],
        ["Link to a document or heading", "Mod+K"],
        ["Text", "Mod+Alt+0"],
        ["Heading 1 / 2 / 3 / 4", "Mod+Alt+1 / 2 / 3 / 4"],
        ["Numbered list", "Mod+Shift+7"],
        ["Bullet list", "Mod+Shift+8"],
        ["Undo", "Mod+Z"],
        ["Redo", "Mod+Shift+Z"],
        ["Insert a block", "/"],
        ["Leave a structured block", "Mod+Enter"],
      ],
    },
    {
      name: "Database and dialogs",
      entries: [
        ["New record", "Mod+Alt+R"],
        ["View settings", "Mod+Alt+F"],
        ["Focus database search", "/"],
        ["Open focused record", "Enter"],
        ["Open record as modal", "Shift+Enter"],
        ["Open record as full page", "Mod+Enter"],
        ["Context menu", "Shift+F10"],
        ["Submit a dialog form", "Mod+Enter"],
        ["Close a menu or preview", "Esc"],
      ],
    },
    {
      name: "Blocks and hierarchy",
      entries: [
        ["Reorder selected blocks or pages", "Alt+Shift+↑ / ↓"],
        ["Move a block outside its container", "Alt+Shift+←"],
        ["Select the current editor block", "Mod+Shift+Space"],
        ["Resize focused column divider", "← / → (Shift for larger steps)"],
        ["Nest / outdent a sidebar page", "Alt+Shift+→ / ←"],
        ["Extend block selection", "Shift+Click"],
      ],
    },
  ];
defineExpose({
  open: () => {
    open.value = true;
  },
});
</script>
<template>
  <UiDialog :open="open" title="Keyboard shortcuts" wide @close="open = false"
    ><div class="shortcut-groups">
      <section v-for="group in groups" :key="group.name">
        <h3>{{ group.name }}</h3>
        <dl>
          <div v-for="entry in group.entries" :key="entry[0]">
            <dt>{{ entry[0] }}</dt>
            <dd>
              <kbd>{{ shortcutLabel(entry[1]!) }}</kbd>
            </dd>
          </div>
        </dl>
      </section>
    </div></UiDialog
  >
</template>
<style scoped>
.shortcut-groups {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 26px 32px;
}
.shortcut-groups h3 {
  margin: 0 0 14px;
  font-size: 0.79rem;
  font-weight: 600;
  color: var(--muted);
}
.shortcut-groups dl {
  margin: 0;
}
.shortcut-groups dl > div {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  min-height: 33px;
  border-bottom: 1px solid var(--line-soft);
}
.shortcut-groups dt {
  font-size: 0.76rem;
  line-height: 1.5;
}
.shortcut-groups dd {
  margin: 0;
  flex-shrink: 0;
}
.shortcut-groups kbd {
  font-size: 0.68rem;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 3px 5px;
  background: var(--surface);
}
@media (max-width: 700px) {
  .shortcut-groups {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

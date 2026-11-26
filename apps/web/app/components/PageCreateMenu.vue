<script setup lang="ts">
defineProps<{
  label: string;
  triggerClass?: string;
  triggerText?: string;
  parentTitle?: string;
  align?: "left" | "right";
}>();
const emit = defineEmits<{
  create: [kind: "page" | "whiteboard" | "database" | "folder"];
  import: [];
}>();
const kinds = [
  {
    kind: "page",
    label: "New page",
    description: "Write, plan and collect ideas",
    icon: "file",
  },
  {
    kind: "whiteboard",
    label: "New whiteboard",
    description: "Sketch and connect your ideas",
    icon: "whiteboard",
  },
  {
    kind: "database",
    label: "New database",
    description: "Organize with tables, boards and views",
    icon: "database",
  },
  {
    kind: "folder",
    label: "New folder",
    description: "Keep related pages together",
    icon: "folder",
  },
] as const;
</script>
<template>
  <UiMenu :label="label" :trigger-class="triggerClass" :align="align" floating>
    <template #trigger>
      <AppIcon name="plus" :size="16" />
      <span v-if="triggerText">{{ triggerText }}</span>
    </template>
    <div class="menu-caption create-caption" :title="parentTitle">
      {{ parentTitle ? "Add to " + parentTitle : "Create in this space" }}
    </div>
    <button
      v-for="item in kinds"
      :key="item.kind"
      type="button"
      role="menuitem"
      :aria-label="item.label"
      class="create-option"
      @click="emit('create', item.kind)"
    >
      <span class="create-option-icon"
        ><AppIcon :name="item.icon" :size="20"
      /></span>
      <span class="create-option-copy"
        ><span>{{ item.label }}</span
        ><small>{{ item.description }}</small></span
      >
    </button>
    <hr />
    <button type="button" role="menuitem" @click="emit('import')">
      <AppIcon name="upload" :size="16" />Import Markdown
    </button>
  </UiMenu>
</template>
<style scoped>
.create-caption {
  max-width: 265px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.create-option {
  gap: 11px;
  min-height: 57px;
}
.create-option-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 34px;
  height: 36px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
}
.create-option-copy {
  display: grid;
  gap: 3px;
  text-align: left;
}
.create-option-copy > span {
  font-weight: 500;
}
.create-option-copy small {
  font-size: 0.72rem;
  color: var(--muted);
}
</style>

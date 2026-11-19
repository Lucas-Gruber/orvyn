<script setup lang="ts">
withDefaults(
  defineProps<{ icon?: string | null; kind?: string; size?: number }>(),
  { size: 18 },
);
</script>
<template>
  <span
    v-if="icon"
    class="page-emoji"
    aria-hidden="true"
    :style="{ fontSize: size + 'px', width: size + 'px', height: size + 'px' }"
    >{{ icon }}</span
  >
  <AppIcon
    v-else
    :name="
      kind === 'database'
        ? 'database'
        : kind === 'folder'
          ? 'folder'
          : kind === 'whiteboard'
            ? 'whiteboard'
            : 'file'
    "
    :size="size"
  />
</template>
<style scoped>
.page-emoji {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  line-height: 1;
  font-family:
    "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
}
</style>

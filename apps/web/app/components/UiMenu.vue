<script setup lang="ts">
const props = withDefaults(
    defineProps<{
      label: string;
      align?: "left" | "right";
      up?: boolean;
      wide?: boolean;
    }>(),
    { align: "right" },
  ),
  open = ref(false),
  root = ref<HTMLElement>(),
  trigger = ref<HTMLButtonElement>(),
  panel = ref<HTMLElement>();
function close(restore = false) {
  open.value = false;
  if (restore) trigger.value?.focus();
}
async function toggle() {
  open.value = !open.value;
  if (open.value) {
    await nextTick();
    panel.value
      ?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')
      ?.focus();
  }
}
function keys(event: KeyboardEvent) {
  const items = [
      ...(panel.value?.querySelectorAll<HTMLButtonElement>(
        '[role^="menuitem"]:not(:disabled)',
      ) || []),
    ],
    index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    items[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length
    ]?.focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (event.key === "Tab") close(true);
}
function outside(event: Event) {
  if (open.value && !root.value?.contains(event.target as Node)) close();
}
onMounted(() => {
  document.addEventListener("pointerdown", outside);
  document.addEventListener("focusin", outside);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside);
  document.removeEventListener("focusin", outside);
});
</script>
<template>
  <div
    ref="root"
    class="menu-anchor"
    :class="{ 'space-switcher': wide }"
    @keydown="keys"
  >
    <button
      ref="trigger"
      :class="wide ? '' : 'icon-button'"
      :aria-label="label"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggle"
      @keydown.down.prevent="!open && toggle()"
    >
      <slot name="trigger"><AppIcon name="more" /></slot>
    </button>
    <div
      v-if="open"
      ref="panel"
      role="menu"
      :aria-label="label"
      :class="[
        'menu-popover',
        { left: align === 'left', up, 'space-options': wide },
      ]"
      @click="
        ($event.target as HTMLElement).closest('[role^=menuitem]') &&
        close(true)
      "
    >
      <slot />
    </div>
  </div>
</template>
<style scoped>
.menu-popover.up {
  top: auto;
  bottom: calc(100% + 7px);
}
</style>

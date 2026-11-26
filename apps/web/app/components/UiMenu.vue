<script setup lang="ts">
const props = withDefaults(
    defineProps<{
      label: string;
      align?: "left" | "right";
      up?: boolean;
      wide?: boolean;
      triggerClass?: string;
      floating?: boolean;
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
    if (props.floating && panel.value && trigger.value) {
      panel.value.showPopover();
      const anchor = trigger.value.getBoundingClientRect(),
        bounds = panel.value.getBoundingClientRect(),
        below = anchor.bottom + 7,
        above = anchor.top - bounds.height - 7,
        left =
          props.align === "left" ? anchor.left : anchor.right - bounds.width,
        top =
          props.up || (below + bounds.height > innerHeight - 10 && above >= 10)
            ? above
            : below;
      panel.value.style.left =
        Math.max(10, Math.min(left, innerWidth - bounds.width - 10)) + "px";
      panel.value.style.top =
        Math.max(10, Math.min(top, innerHeight - bounds.height - 10)) + "px";
    }
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
function reposition(event: Event) {
  if (
    props.floating &&
    open.value &&
    (event.type === "resize" || !panel.value?.contains(event.target as Node))
  )
    close();
}
onMounted(() => {
  document.addEventListener("pointerdown", outside);
  document.addEventListener("focusin", outside);
  window.addEventListener("resize", reposition);
  document.addEventListener("scroll", reposition, true);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside);
  document.removeEventListener("focusin", outside);
  window.removeEventListener("resize", reposition);
  document.removeEventListener("scroll", reposition, true);
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
      :class="triggerClass || (wide ? '' : 'icon-button')"
      :aria-label="label"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggle"
      @keydown.down.prevent.stop="!open && toggle()"
    >
      <slot name="trigger"><AppIcon name="more" /></slot>
    </button>
    <div
      v-if="open"
      ref="panel"
      role="menu"
      :aria-label="label"
      :popover="floating ? 'manual' : undefined"
      :class="[
        'menu-popover',
        { left: align === 'left', up, 'space-options': wide, floating },
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
.menu-popover.floating {
  position: fixed;
  inset: auto;
  margin: 0;
  width: min(300px, calc(100vw - 20px));
  min-width: 0;
  max-width: calc(100vw - 20px);
  max-height: calc(100dvh - 20px);
  overflow: auto;
  color: var(--text);
}
</style>

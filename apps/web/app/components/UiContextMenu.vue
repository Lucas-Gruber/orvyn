<script setup lang="ts">
const props = defineProps<{
    label: string;
    items: {
      id: string;
      label: string;
      icon: string;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      separator?: boolean;
    }[];
  }>(),
  emit = defineEmits<{ select: [id: string] }>(),
  panel = ref<HTMLElement>(),
  opened = ref(false);
let returnFocus: HTMLElement | undefined;
function close(restore = false) {
  if (panel.value?.matches(":popover-open")) panel.value.hidePopover();
  opened.value = false;
  if (restore && returnFocus?.isConnected) returnFocus.focus();
}
async function open(event: MouseEvent | KeyboardEvent) {
  if (event.type === "contextmenu" && event.shiftKey) return;
  event.preventDefault();
  event.stopPropagation();
  returnFocus =
    event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>("button,a,[tabindex]") ||
        (event.currentTarget as HTMLElement)
      : (event.currentTarget as HTMLElement);
  const rect = returnFocus?.getBoundingClientRect(),
    x =
      "clientX" in event && event.clientX
        ? event.clientX
        : (rect?.left || 12) + 12,
    y =
      "clientY" in event && event.clientY ? event.clientY : rect?.bottom || 12;
  opened.value = true;
  panel.value?.showPopover();
  await nextTick();
  if (!panel.value) return;
  const bounds = panel.value.getBoundingClientRect();
  panel.value.style.left =
    Math.max(10, Math.min(x, innerWidth - bounds.width - 10)) + "px";
  panel.value.style.top =
    Math.max(10, Math.min(y, innerHeight - bounds.height - 10)) + "px";
  panel.value
    .querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
    ?.focus();
}
function choose(id: string) {
  close(true);
  emit("select", id);
}
function keys(event: KeyboardEvent) {
  if (event.key === "Escape" || event.key === "Tab") {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
    }
    close(true);
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const buttons = [
      ...(panel.value?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) || []),
    ],
    at = buttons.indexOf(document.activeElement as HTMLButtonElement),
    next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length;
  buttons[next]?.focus();
}
function outside(event: Event) {
  if (opened.value && !panel.value?.contains(event.target as Node)) close();
}
function resize() {
  close();
}
onMounted(() => {
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", resize);
});
onBeforeUnmount(() => {
  close();
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("resize", resize);
});
defineExpose({ open, close });
</script>
<template>
  <div
    ref="panel"
    popover="manual"
    role="menu"
    :aria-label="label"
    class="context-menu"
    @keydown="keys"
    @contextmenu="!$event.shiftKey && $event.preventDefault()"
  >
    <template v-for="item in items" :key="item.id"
      ><hr v-if="item.separator" />
      <button
        type="button"
        role="menuitem"
        :disabled="item.disabled"
        :class="{ danger: item.danger }"
        @click="choose(item.id)"
      >
        <AppIcon :name="item.icon" :size="16" /><span>{{ item.label }}</span
        ><kbd v-if="item.shortcut">{{ item.shortcut }}</kbd>
      </button></template
    >
  </div>
</template>
<style scoped>
.context-menu {
  position: fixed;
  inset: auto;
  margin: 0;
  padding: 5px;
  min-width: 240px;
  max-width: min(330px, calc(100vw - 20px));
  max-height: calc(100dvh - 20px);
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--elevated);
  color: var(--text);
  box-shadow: var(--shadow);
}
.context-menu button {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 34px;
  padding: 7px 9px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  text-align: left;
  font-size: 0.79rem;
}
.context-menu button:hover,
.context-menu button:focus-visible {
  background: var(--surface-hover);
  outline: 0;
}
.context-menu button .app-icon {
  color: var(--muted);
  flex-shrink: 0;
}
.context-menu button.danger,
.context-menu button.danger .app-icon {
  color: var(--danger);
}
.context-menu button span {
  flex: 1;
}
.context-menu kbd {
  font-size: 0.67rem;
  color: var(--faint);
  background: transparent;
  padding: 0;
  border: 0;
}
.context-menu hr {
  margin: 4px -1px;
  border: 0;
  border-top: 1px solid var(--line);
}
</style>

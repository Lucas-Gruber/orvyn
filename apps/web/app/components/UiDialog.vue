<script setup lang="ts">
const props = withDefaults(
    defineProps<{
      open: boolean;
      title: string;
      wide?: boolean;
      drawer?: boolean;
      error?: string;
      modal?: boolean;
    }>(),
    { modal: true },
  ),
  emit = defineEmits<{ close: [] }>(),
  dialog = ref<HTMLDialogElement>(),
  id = useId();
let openedModal = true,
  ignoredClosures = 0;
function synchronize() {
  if (!dialog.value) return;
  if (props.open && dialog.value.open && props.modal !== openedModal) {
    ignoredClosures++;
    dialog.value.close();
  }
  if (props.open && !dialog.value.open) {
    openedModal = props.modal;
    if (props.modal) dialog.value.showModal();
    else dialog.value.show();
    dialog.value
      .querySelector<HTMLElement>("input:not([type=hidden]), textarea, select")
      ?.focus();
  } else if (!props.open && dialog.value.open) dialog.value.close();
}
watch([() => props.open, () => props.modal], () => nextTick(synchronize));
onMounted(synchronize);
function closed() {
  if (ignoredClosures) {
    ignoredClosures--;
    return;
  }
  emit("close");
}
function keys(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key === "Enter" &&
    !(event.target as HTMLElement).closest('[contenteditable="true"]')
  ) {
    const form = (event.target as HTMLElement).closest("form"),
      submit = form?.querySelector<HTMLButtonElement>(
        'button[type="submit"]:not(:disabled),button:not([type]):not(:disabled)',
      );
    if (form && submit) {
      event.preventDefault();
      event.stopPropagation();
      form.requestSubmit(submit);
      return;
    }
  }
  if (!props.modal && event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    emit("close");
  }
}
function outside(event: MouseEvent) {
  if (event.target !== dialog.value) return;
  const rect = dialog.value.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
    emit("close");
}
</script>
<template>
  <dialog
    ref="dialog"
    :aria-labelledby="id + '-title'"
    :class="['ui-dialog', { wide, drawer, 'non-modal': !modal }]"
    @close="closed"
    @keydown="keys"
    @cancel.prevent="emit('close')"
    @click="outside"
  >
    <header class="dialog-header">
      <h2 :id="id + '-title'">{{ title }}</h2>
      <div class="dialog-header-actions">
        <slot name="actions" /><button
          class="icon-button"
          type="button"
          aria-label="Close dialog"
          @click="emit('close')"
        >
          <AppIcon name="x" />
        </button>
      </div>
    </header>
    <div v-if="open" class="dialog-content">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <slot />
    </div>
  </dialog>
</template>
<style scoped>
.dialog-content {
  padding: 22px 24px;
  min-width: 0;
}
.dialog-header {
  padding-inline: 24px;
}
.dialog-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.dialog-content :deep(form) {
  min-width: 0;
}
.dialog-content :deep(.actions) {
  flex-wrap: wrap;
}
@media (max-width: 600px) {
  .dialog-content {
    padding: 18px 20px;
  }
  .dialog-header {
    padding-inline: 20px;
  }
}
</style>

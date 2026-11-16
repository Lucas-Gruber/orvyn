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
      <button
        class="icon-button"
        type="button"
        aria-label="Close dialog"
        @click="emit('close')"
      >
        <AppIcon name="x" />
      </button>
    </header>
    <div v-if="open" class="dialog-content">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <slot />
    </div>
  </dialog>
</template>

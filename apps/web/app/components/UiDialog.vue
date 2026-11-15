<script setup lang="ts">
const props = defineProps<{
    open: boolean;
    title: string;
    wide?: boolean;
    drawer?: boolean;
    error?: string;
  }>(),
  emit = defineEmits<{ close: [] }>(),
  dialog = ref<HTMLDialogElement>(),
  id = useId();
function synchronize() {
  if (!dialog.value) return;
  if (props.open && !dialog.value.open) {
    dialog.value.showModal();
    dialog.value
      .querySelector<HTMLElement>("input:not([type=hidden]), textarea, select")
      ?.focus();
  } else if (!props.open && dialog.value.open) dialog.value.close();
}
watch(
  () => props.open,
  () => nextTick(synchronize),
);
onMounted(synchronize);
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
    :class="['ui-dialog', { wide, drawer }]"
    @close="emit('close')"
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

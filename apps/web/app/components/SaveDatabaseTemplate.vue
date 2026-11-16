<script setup lang="ts">
const props = defineProps<{
    databaseId: string;
    recordId?: string;
    title: string;
    beforeSave?: () => Promise<void>;
  }>(),
  emit = defineEmits<{ saved: [] }>(),
  open = ref(false),
  name = ref(""),
  busy = ref(false),
  error = ref(""),
  id = useId();
function show() {
  name.value = props.title.slice(0, 100);
  error.value = "";
  open.value = true;
}
async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await props.beforeSave?.();
    await $fetch(`/api/v1/databases/${props.databaseId}/templates`, {
      method: "POST",
      body: {
        name: name.value,
        kind: props.recordId ? "record" : "database",
        ...(props.recordId ? { recordId: props.recordId } : {}),
      },
    });
    open.value = false;
    emit("saved");
  } catch (e: any) {
    error.value =
      e.data?.message || e.message || "Template could not be saved.";
  } finally {
    busy.value = false;
  }
}
defineExpose({ open: show });
</script>
<template>
  <UiDialog :open="open" title="Save as template" @close="open = false">
    <form class="database-form" @submit.prevent="save">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p class="hint">
        {{
          recordId
            ? "Save the current page content, attachments and property defaults for new records."
            : "Save these properties, formulas and views as the starting point for a new database."
        }}
      </p>
      <label :for="id">Template name</label
      ><input
        :id="id"
        v-model="name"
        required
        maxlength="100"
        :disabled="busy"
      />
      <div class="actions">
        <button class="primary" :disabled="busy">Save template</button
        ><button type="button" :disabled="busy" @click="open = false">
          Cancel
        </button>
      </div>
    </form>
  </UiDialog>
</template>

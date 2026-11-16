<script setup lang="ts">
import { parseVideoUrl } from "@orvyn/editor/embeds";
const props = defineProps<{ open: boolean }>(),
  emit = defineEmits<{
    close: [];
    select: [value: { provider: string; resourceId: string; title: string }];
  }>();
const url = ref(""),
  title = ref(""),
  error = ref("");
watch(
  () => props.open,
  (open) => {
    if (open) {
      url.value = "";
      title.value = "";
      error.value = "";
    }
  },
);
function insert() {
  const value = parseVideoUrl(url.value);
  if (!value) {
    error.value = "Use a public HTTPS video link from YouTube, Vimeo or Loom.";
    return;
  }
  emit("select", { ...value, title: title.value.trim() });
}
</script>
<template>
  <UiDialog
    :open="open"
    title="Insert video embed"
    :error="error"
    @close="emit('close')"
    ><p class="hint">
      Supported providers: YouTube, Vimeo and Loom. Readers choose whether to
      load the external player.
    </p>
    <form @submit.prevent="insert">
      <label for="embed-url">Video URL</label
      ><input
        id="embed-url"
        v-model="url"
        type="url"
        required
        maxlength="2000"
        placeholder="https://…"
      /><label for="embed-title">Video title (optional)</label
      ><input id="embed-title" v-model="title" maxlength="160" />
      <div class="actions"><button class="primary">Insert embed</button></div>
    </form></UiDialog
  >
</template>

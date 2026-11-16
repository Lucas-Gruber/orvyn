<script setup lang="ts">
const props = defineProps<{ open: boolean; pageId: string; image: boolean }>(),
  emit = defineEmits<{
    close: [];
    select: [file: { fileId: string; label: string }];
  }>();
const files = ref<any[]>([]),
  chosen = ref<File>(),
  error = ref(""),
  loading = ref(false),
  busy = ref(false),
  description = ref(""),
  limit = ref(0);
const supported = (file: any) =>
    ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
      file.media_type,
    ),
  shown = computed(() =>
    files.value.filter((f) => !props.image || supported(f)),
  );
let generation = 0;
watch(
  () => props.open,
  async (open) => {
    const request = ++generation;
    if (!open) return;
    files.value = [];
    chosen.value = undefined;
    description.value = "";
    error.value = "";
    loading.value = true;
    try {
      const [list, limits] = await Promise.all([
        $fetch<any[]>(`/api/v1/pages/${props.pageId}/files`),
        $fetch<any>("/api/v1/files/limits"),
      ]);
      if (request === generation) {
        files.value = list;
        limit.value = limits.maxUploadBytes;
      }
    } catch {
      if (request === generation)
        error.value = "Attachments could not be loaded.";
    } finally {
      if (request === generation) loading.value = false;
    }
  },
);
function choose(file: any) {
  emit("select", {
    fileId: file.id,
    label: description.value.trim() || file.filename,
  });
}
async function upload() {
  if (!chosen.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const data = new FormData();
    data.append("file", chosen.value);
    const file = await $fetch<any>(`/api/v1/pages/${props.pageId}/files`, {
      method: "POST",
      body: data,
    });
    if (props.image && !supported(file)) {
      error.value =
        "This file was uploaded as an attachment. Choose a PNG, JPEG, GIF or WebP image for an image block.";
      chosen.value = undefined;
      return;
    }
    if (props.open) choose(file);
  } catch (e: any) {
    error.value = e.data?.message || "Upload failed. Please try again.";
  } finally {
    busy.value = false;
  }
}
onBeforeUnmount(() => generation++);
</script>
<template>
  <UiDialog
    :open="open"
    :title="image ? 'Insert image' : 'Insert file'"
    :error="error"
    @close="!busy && emit('close')"
  >
    <p class="hint">
      Uploads are private attachments. Viewing an embedded file still requires
      access to the page that owns it.
    </p>
    <label for="asset-description">{{
      image ? "Image description (optional)" : "Link label (optional)"
    }}</label><input
      id="asset-description"
      v-model="description"
      maxlength="500"
      placeholder="Use the filename"
      :disabled="busy"
    />
    <form class="asset-upload" @submit.prevent="upload">
      <label for="editor-asset-file">{{
        image ? "Choose image" : "Choose file"
      }}</label
      ><input
        id="editor-asset-file"
        type="file"
        :accept="
          image ? 'image/png,image/jpeg,image/gif,image/webp' : undefined
        "
        :disabled="busy"
        required
        @change="chosen = ($event.target as HTMLInputElement).files?.[0]"
      />
      <p v-if="limit" class="hint">
        Maximum upload: {{ Intl.NumberFormat().format(limit) }} bytes.
      </p>
      <button class="primary" :disabled="busy || !chosen">
        {{ busy ? "Uploading…" : "Upload and insert" }}
      </button>
    </form>
    <h3 class="asset-existing-title">Or choose an existing attachment</h3>
    <p v-if="loading" role="status" class="hint">Loading attachments…</p>
    <ul v-else-if="shown.length" class="asset-options">
      <li v-for="file in shown" :key="file.id">
        <button type="button" :disabled="busy" @click="choose(file)">
          <AppIcon name="paperclip" :size="16" /><span>{{ file.filename }}</span
          ><small>{{ Intl.NumberFormat().format(file.size) }} bytes</small>
        </button>
      </li>
    </ul>
    <p v-else class="hint">
      No {{ image ? "supported images" : "attachments" }} on this page yet.
    </p>
    <p v-if="files.length === 200" class="hint">
      Showing the latest 200 attachments.
    </p>
  </UiDialog>
</template>
<style scoped>
.asset-upload {
  margin: 18px 0;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
}
.asset-existing-title {
  font-size: 0.85rem;
  color: var(--muted);
  font-weight: 500;
  margin-top: 22px;
}
.asset-options {
  padding: 0;
  margin: 8px 0;
  list-style: none;
  max-height: 240px;
  overflow: auto;
}
.asset-options button {
  display: flex;
  width: 100%;
  justify-content: flex-start;
  background: transparent;
  border: 0;
  padding: 10px 6px;
}
.asset-options button:hover {
  background: var(--surface-hover);
}
.asset-options span {
  flex: 1;
  text-align: left;
  overflow-wrap: anywhere;
}
small {
  color: var(--muted);
  font-size: 0.75rem;
}
</style>

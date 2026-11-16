<script setup lang="ts">
const props = defineProps<{ page: any }>(),
  files = ref<any[]>([]),
  chosen = ref<File>(),
  error = ref(""),
  busy = ref(false),
  limit = ref(0),
  fileInput = ref<HTMLInputElement>(),
  fileId = useId();
let job: Promise<void> | undefined;
async function track(operation: () => Promise<void>) {
  if (job) return job;
  const current = operation();
  job = current;
  try {
    await current;
  } finally {
    if (job === current) job = undefined;
  }
}
function upload() {
  return track(doUpload);
}
function remove(file: any) {
  return track(() => doRemove(file));
}
usePendingWrites(async () => {
  await job;
  if (chosen.value && error.value) throw new Error(error.value);
});
async function load() {
  files.value = await $fetch<any[]>(
    "/api/v1/pages/" + props.page.id + "/files",
  );
}
async function doUpload() {
  if (!chosen.value) return;
  busy.value = true;
  error.value = "";
  try {
    const body = new FormData();
    body.append("file", chosen.value);
    await $fetch("/api/v1/pages/" + props.page.id + "/files", {
      method: "POST",
      body,
    });
    chosen.value = undefined;
    if (fileInput.value) fileInput.value.value = "";
    await load();
  } catch (e: any) {
    error.value = e.data?.message || "Upload failed";
  } finally {
    busy.value = false;
  }
}
async function doRemove(file: any) {
  if (!window.confirm("Remove this attachment from the page?")) return;
  busy.value = true;
  error.value = "";
  try {
    await $fetch("/api/v1/files/" + file.id, { method: "DELETE", body: {} });
    window.dispatchEvent(
      new CustomEvent("orvyn-file-changed", { detail: { fileId: file.id } }),
    );
    await load();
  } catch (e: any) {
    error.value = e.data?.message || "Removal failed";
  } finally {
    busy.value = false;
  }
}
onMounted(async () => {
  try {
    const [_, limits] = await Promise.all([
      load(),
      $fetch<any>("/api/v1/files/limits"),
    ]);
    limit.value = limits.maxUploadBytes;
  } catch {
    error.value = "Attachments could not be loaded";
  }
});
</script>
<template>
  <div class="attachments">
    <h2>Attachments</h2>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <ul>
      <li v-for="file in files" :key="file.id">
        <div>
          <a :href="'/api/v1/files/' + file.id + '/download'"
            >Download {{ file.filename }}</a
          ><small> · {{ Intl.NumberFormat().format(file.size) }} bytes</small
          ><img
            v-if="file.media_type.startsWith('image/')"
            :src="'/api/v1/files/' + file.id + '/preview'"
            :alt="file.filename"
            loading="lazy"
          />
        </div>
        <button
          v-if="page.access_rank >= 30"
          :disabled="busy"
          @click="remove(file)"
        >
          Remove {{ file.filename }}
        </button>
      </li>
    </ul>
    <p v-if="!files.length">No attachments on this page.</p>
    <form v-if="page.access_rank >= 30" @submit.prevent="upload">
      <label :for="fileId">Choose attachment</label
      ><input
        :id="fileId"
        ref="fileInput"
        type="file"
        required
        @change="chosen = ($event.target as HTMLInputElement).files?.[0]"
      />
      <p v-if="limit">
        Maximum upload: {{ Intl.NumberFormat().format(limit) }} bytes. Downloads
        require access to this page.
      </p>
      <button :disabled="busy || !chosen">
        {{ busy ? "Uploading…" : "Upload attachment" }}
      </button>
    </form>
  </div>
</template>
<style scoped>
.attachments {
  margin: 2rem 0;
  border-top: 1px solid var(--line);
  padding-top: 1rem;
}
.attachments ul {
  list-style: none;
  padding: 0;
}
.attachments li {
  display: flex;
  gap: 1rem;
  align-items: center;
  padding: 1rem 0;
  border-bottom: 1px solid var(--line);
}
.attachments li > div {
  flex: 1;
  min-width: 0;
}
.attachments a {
  color: var(--accent);
  overflow-wrap: anywhere;
}
.attachments img {
  display: block;
  max-width: 100%;
  max-height: 300px;
  object-fit: contain;
  margin-top: 0.8rem;
}
.attachments small {
  color: var(--muted);
}
</style>

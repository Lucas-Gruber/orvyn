<script setup lang="ts">
import {
  coverIds,
  covers,
  coverBackground,
  emojiChoices,
  validEmoji,
} from "@orvyn/shared";
const props = defineProps<{
    open: boolean;
    title: string;
    resourcePath: string;
    appearance: any;
    pageId?: string;
  }>(),
  emit = defineEmits<{ close: []; changed: [appearance: any] }>(),
  icon = ref(""),
  preset = ref<string | null>(null),
  fileId = ref<string | null>(null),
  version = ref(1),
  busy = ref(false),
  error = ref(""),
  conflict = ref(false),
  showImage = ref(false);
function draft(value: any) {
  icon.value = value.icon || "";
  preset.value = value.cover_preset || null;
  fileId.value = value.cover_file_id || null;
  version.value = value.appearance_version || 1;
  error.value = "";
  conflict.value = false;
  showImage.value = false;
}
watch(
  [() => props.open, () => props.resourcePath],
  () => {
    if (props.open) draft(props.appearance);
  },
  { immediate: true },
);
function cover(value: string | null) {
  preset.value = value;
  fileId.value = null;
}
async function reload() {
  busy.value = true;
  try {
    draft(
      await $fetch<any>(
        "/api/v1/" + props.resourcePath + (props.pageId ? "" : "/appearance"),
      ),
    );
  } catch {
    error.value = "Appearance could not be loaded.";
  } finally {
    busy.value = false;
  }
}
async function save() {
  if (busy.value) return;
  if (!validEmoji(icon.value || null)) {
    error.value = "Choose one emoji for the icon.";
    return;
  }
  busy.value = true;
  error.value = "";
  conflict.value = false;
  const path = props.resourcePath;
  try {
    const result = await $fetch<any>("/api/v1/" + path + "/appearance", {
      method: "PATCH",
      body: {
        icon: icon.value || null,
        coverPreset: preset.value,
        coverFileId: fileId.value,
        appearanceVersion: version.value,
      },
    });
    if (props.resourcePath === path) {
      emit("changed", result);
      emit("close");
    }
  } catch (e: any) {
    conflict.value = e.statusCode === 409 || e.status === 409;
    error.value = e.data?.message || "Appearance could not be saved.";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <UiDialog
    :open="open"
    :title="title"
    :error="error"
    @close="!busy && emit('close')"
  >
    <form class="page-appearance-form" @submit.prevent="save">
      <label for="appearance-icon">Icon</label>
      <div class="appearance-icon-input">
        <PageSymbol :icon="icon" :size="32" /><input
          id="appearance-icon"
          v-model="icon"
          maxlength="64"
          placeholder="Choose one emoji"
          :disabled="busy"
        /><button
          type="button"
          class="ghost"
          :disabled="busy || !icon"
          @click="icon = ''"
        >
          Remove icon
        </button>
      </div>
      <div class="emoji-options" aria-label="Suggested icons">
        <button
          v-for="[emoji, label] in emojiChoices"
          :key="emoji"
          type="button"
          :aria-label="label + ' icon'"
          :title="label"
          :aria-pressed="icon === emoji"
          :disabled="busy"
          @click="icon = emoji"
        >
          <PageSymbol :icon="emoji" :size="24" />
        </button>
      </div>
      <h3>Cover</h3>
      <div class="cover-options" aria-label="Cover styles">
        <button
          type="button"
          :aria-pressed="!preset && !fileId"
          :disabled="busy"
          @click="cover(null)"
        >
          <span class="cover-swatch empty">—</span>No cover</button
        ><button
          v-for="id in coverIds"
          :key="id"
          type="button"
          :aria-pressed="preset === id"
          :disabled="busy"
          @click="cover(id)"
        >
          <span
            class="cover-swatch"
            :style="{ background: coverBackground(id) }"
          />{{ covers[id].label }}
        </button>
      </div>
      <template v-if="pageId"
        ><button type="button" :disabled="busy" @click="showImage = true">
          <AppIcon name="image" :size="16" />Choose image</button
        ><CoverBanner v-if="fileId" :file-id="fileId" compact />
        <p class="hint">
          Images are private attachments on this page.
        </p></template
      >
      <p v-if="conflict" class="appearance-conflict">
        Someone changed this appearance.
        <button type="button" class="ghost" :disabled="busy" @click="reload">
          Reload saved appearance
        </button>
      </p>
      <div class="actions">
        <button type="submit" class="primary" :disabled="busy || conflict">
          {{ busy ? "Saving…" : "Save appearance" }}</button
        ><button
          type="button"
          class="ghost"
          :disabled="busy"
          @click="emit('close')"
        >
          Cancel
        </button>
      </div>
    </form>
  </UiDialog>
  <EditorAssetPicker
    v-if="pageId"
    :open="open && showImage"
    :page-id="pageId"
    image
    @close="showImage = false"
    @select="
      (value) => {
        fileId = value.fileId;
        preset = null;
        showImage = false;
      }
    "
  />
</template>
<style scoped>
.appearance-icon-input {
  display: flex;
  gap: 12px;
  align-items: center;
}
.appearance-icon-input input {
  width: 180px;
  min-width: 0;
}
.appearance-icon-input button {
  font-size: 0.75rem;
}
.emoji-options {
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 4px;
  margin: 16px 0 24px;
}
.emoji-options button {
  padding: 8px;
  border: 1px solid transparent;
  background: transparent;
  justify-content: center;
}
.emoji-options button[aria-pressed="true"],
.cover-options button[aria-pressed="true"] {
  border-color: var(--accent);
  background-color: var(--accent-soft);
}
.cover-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 18px;
}
.cover-options button {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 5px;
  font-size: 0.75rem;
  border: 1px solid var(--line);
}
.cover-swatch {
  display: grid;
  place-items: center;
  width: 100%;
  height: 48px;
  border-radius: 4px;
}
.cover-swatch.empty {
  background: var(--surface);
  color: var(--muted);
}
.page-appearance-form .hint {
  font-size: 0.75rem;
}
.page-appearance-form .actions {
  margin-top: 24px;
}
@media (max-width: 500px) {
  .emoji-options {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
  .appearance-icon-input {
    flex-wrap: wrap;
  }
}
</style>

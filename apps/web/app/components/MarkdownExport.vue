<script setup lang="ts">
import { copyText } from "../utils/clipboard";
import { shortcutLabel } from "../utils/shortcuts";
const props = defineProps<{
    pageId: string;
    beforeExport?: () => Promise<void>;
  }>(),
  opened = ref(false),
  loading = ref(false),
  downloading = ref(false),
  includePeopleNames = ref(false),
  error = ref(""),
  notice = ref(""),
  result = ref<{
    title: string;
    filename: string;
    markdown: string;
    warnings: string[];
    digest: string;
  } | null>(null);
let alive = true,
  epoch = 0;
async function load() {
  const current = ++epoch;
  loading.value = true;
  error.value = "";
  notice.value = "";
  result.value = null;
  try {
    await props.beforeExport?.();
    if (!alive || current !== epoch) return;
    const value = await $fetch<any>(
      "/api/v1/pages/" + props.pageId + "/export/markdown",
      {
        query: { includePeopleNames: String(includePeopleNames.value) },
        timeout: 15000,
      },
    );
    if (alive && current === epoch) result.value = value;
  } catch (e: any) {
    if (alive && current === epoch)
      error.value =
        e.data?.message || e.message || "Could not prepare the export.";
  } finally {
    if (alive && current === epoch) loading.value = false;
  }
}
function open() {
  opened.value = true;
  void load();
}
function close() {
  if (!downloading.value) {
    opened.value = false;
    epoch++;
    loading.value = false;
    result.value = null;
  }
}
async function download() {
  if (!result.value || loading.value || downloading.value) return;
  downloading.value = true;
  error.value = "";
  notice.value = "";
  const reviewed = result.value;
  try {
    const blob = await $fetch<Blob>(
      "/api/v1/pages/" + props.pageId + "/export.md",
      {
        query: {
          includePeopleNames: String(includePeopleNames.value),
          review: reviewed.digest,
        },
        responseType: "blob",
        timeout: 15000,
      },
    );
    if (!alive) return;
    const url = URL.createObjectURL(blob),
      anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = reviewed.filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice.value = "Markdown downloaded.";
  } catch (e: any) {
    if (alive) {
      // Blob responses still carry JSON error bodies. Preserve the server's
      // current-access/stale-review message instead of offering the old file.
      let message = e.data?.message;
      if (e.data instanceof Blob) {
        try {
          message = JSON.parse(await e.data.text()).message;
        } catch {}
      }
      result.value = null;
      error.value =
        message ||
        "Could not download the current export. Refresh and try again.";
    }
  } finally {
    if (alive) downloading.value = false;
  }
}
async function copy() {
  if (!result.value) return;
  try {
    await copyText(result.value.markdown);
    notice.value = "Markdown copied.";
  } catch {
    error.value =
      "Could not copy the Markdown. Select the file contents below to copy manually.";
  }
}
watch(includePeopleNames, () => {
  if (opened.value) void load();
});
onBeforeUnmount(() => {
  alive = false;
  epoch++;
});
defineExpose({ open });
</script>
<template>
  <UiDialog
    :open="opened"
    title="Export Markdown"
    :error="error"
    wide
    @close="close"
  >
    <form class="markdown-export-form" @submit.prevent="download">
      <div class="markdown-export-intro">
        <AppIcon name="file" :size="22" />
        <div>
          <strong>Download this page as Markdown</strong>
          <p>
            Review the saved page content before downloading. Linked pages and
            database properties have separate exports.
          </p>
        </div>
      </div>
      <label class="markdown-export-people"
        ><input
          v-model="includePeopleNames"
          type="checkbox"
          :disabled="downloading"
        /><span
          >Include visible people names<small
            >May include account addresses. Unchecked mentions become
            @person.</small
          ></span
        ></label
      >
      <div class="markdown-export-controls">
        <span>{{
          result?.filename ||
          (loading ? "Preparing file…" : "Refresh to prepare the file")
        }}</span><button
          type="button"
          class="ghost"
          :disabled="loading || downloading"
          @click="load"
        >
          <AppIcon name="refresh" :size="14" />Refresh
        </button>
      </div>
      <ul v-if="result?.warnings.length" class="markdown-export-warnings">
        <li v-for="warning in result.warnings" :key="warning">
          <AppIcon name="info" :size="15" />{{ warning }}
        </li>
      </ul>
      <label v-if="result" class="markdown-export-source"
        >File contents<textarea
          :value="result.markdown"
          readonly
          spellcheck="false"
          aria-label="Exported Markdown"
        />
      </label>
      <div v-else-if="loading" class="markdown-export-empty" role="status">
        Preparing the saved content…
      </div>
      <p v-if="notice" class="markdown-export-notice" role="status">
        {{ notice }}
      </p>
      <footer>
        <button
          type="button"
          class="ghost"
          :disabled="!result || loading || downloading"
          @click="copy"
        >
          <AppIcon name="copy" :size="15" />Copy Markdown</button
        ><button
          type="submit"
          class="primary"
          :disabled="!result || loading || downloading"
          :title="shortcutLabel('Mod+Enter')"
        >
          <AppIcon name="download" :size="16" />{{
            downloading ? "Downloading…" : "Download .md"
          }}
        </button>
      </footer>
    </form>
  </UiDialog>
</template>
<style scoped>
.markdown-export-form {
  display: block;
  margin: 0;
}
.markdown-export-intro {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.markdown-export-intro > svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.markdown-export-intro strong {
  font-weight: 500;
  font-size: 13px;
}
.markdown-export-intro p {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}
.markdown-export-people {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 20px 0;
  padding: 16px 0;
  border-block: 1px solid var(--line);
  font-size: 12px;
}
.markdown-export-people input {
  width: 14px;
  height: 14px;
  min-height: 14px;
  flex: 0 0 14px;
  margin: 3px 0 0;
  accent-color: var(--accent);
}
.markdown-export-people small {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
}
.markdown-export-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.markdown-export-controls span {
  overflow-wrap: anywhere;
  font-size: 12px;
  color: var(--muted);
  min-width: 0;
}
.markdown-export-controls button {
  font-size: 11px;
  flex-shrink: 0;
}
.markdown-export-warnings {
  list-style: none;
  padding: 10px 12px;
  margin: 0 0 14px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
}
.markdown-export-warnings li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 11px;
  line-height: 1.6;
  margin: 4px 0;
}
.markdown-export-warnings svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.markdown-export-source {
  display: grid;
  gap: 8px;
  font-size: 11px;
  color: var(--muted);
}
.markdown-export-source textarea {
  width: 100%;
  min-height: 300px;
  max-height: 50vh;
  resize: vertical;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  line-height: 1.7;
  tab-size: 2;
  white-space: pre-wrap;
}
.markdown-export-empty {
  text-align: center;
  padding: 36px 12px;
  font-size: 12px;
  color: var(--muted);
}
.markdown-export-notice {
  font-size: 12px;
  color: var(--muted);
  margin: 12px 0;
}
footer {
  border-top: 1px solid var(--line);
  padding-top: 18px;
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
@media (max-width: 500px) {
  footer {
    flex-wrap: wrap;
  }
  .markdown-export-source textarea {
    min-height: 220px;
  }
}
</style>

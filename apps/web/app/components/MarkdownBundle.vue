<script setup lang="ts">
import {
  markdownBundleLimits,
  type MarkdownBundleInput,
  type MarkdownBundleTree,
  type MarkdownBundlePreview,
} from "@orvyn/shared";
import { shortcutLabel } from "../utils/shortcuts";
const props = defineProps<{
    pageId: string;
    beforeExport?: () => Promise<void>;
  }>(),
  opened = ref(false),
  treeLoading = ref(false),
  loading = ref(false),
  downloading = ref(false),
  error = ref(""),
  notice = ref(""),
  tree = ref<MarkdownBundleTree | null>(null),
  selected = ref<string[]>([]),
  includeAttachments = ref(true),
  includePeopleNames = ref(false),
  review = ref<MarkdownBundlePreview | null>(null);
let epoch = 0,
  treeEpoch = 0,
  alive = true;
const count = computed(() => selected.value.length),
  input = (): MarkdownBundleInput => ({
    pageIds: [...selected.value],
    includeAttachments: includeAttachments.value,
    includePeopleNames: includePeopleNames.value,
  });
function size(bytes: number) {
  return (
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
      bytes / (bytes >= 1024 * 1024 ? 1024 * 1024 : 1024),
    ) + (bytes >= 1024 * 1024 ? " MB" : " KB")
  );
}
function invalidate() {
  epoch++;
  loading.value = false;
  review.value = null;
  error.value = "";
  notice.value = "";
}
watch([selected, includeAttachments, includePeopleNames], invalidate, {
  deep: true,
});
async function open() {
  opened.value = true;
  tree.value = null;
  selected.value = [];
  await loadTree(false);
}
async function loadTree(preserve = true) {
  invalidate();
  review.value = null;
  error.value = "";
  notice.value = "";
  const current = ++treeEpoch;
  treeLoading.value = true;
  try {
    await props.beforeExport?.();
    if (!alive || current !== treeEpoch) return;
    const result = await $fetch<MarkdownBundleTree>(
      "/api/v1/pages/" + props.pageId + "/export/tree",
      { timeout: 15000 },
    );
    if (!alive || current !== treeEpoch) return;
    tree.value = result;
    selected.value = preserve
      ? result.pages
          .filter(
            (page) =>
              page.id === props.pageId || selected.value.includes(page.id),
          )
          .map((page) => page.id)
      : result.pages
          .slice(0, markdownBundleLimits.pages)
          .map((page) => page.id);
  } catch (e: any) {
    if (alive && current === treeEpoch)
      error.value =
        e.data?.message || e.message || "Could not load the page hierarchy.";
  } finally {
    if (alive && current === treeEpoch) treeLoading.value = false;
  }
}
function close() {
  if (!downloading.value) {
    opened.value = false;
    treeEpoch++;
    treeLoading.value = false;
    invalidate();
    tree.value = null;
  }
}
function toggle(id: string, event: Event) {
  const control = event.target as HTMLInputElement,
    checked = control.checked;
  if (checked && count.value >= markdownBundleLimits.pages) {
    control.checked = false;
    error.value = "Choose at most 100 pages.";
    return;
  }
  selected.value = checked
    ? [...selected.value, id]
    : selected.value.filter((page) => page !== id);
}
async function prepare() {
  const current = ++epoch,
    options = input();
  loading.value = true;
  error.value = "";
  notice.value = "";
  review.value = null;
  try {
    await props.beforeExport?.();
    if (!alive || current !== epoch) return;
    const result = await $fetch<MarkdownBundlePreview>(
      "/api/v1/pages/" + props.pageId + "/export/bundle/preview",
      { method: "POST", body: options, timeout: 20000 },
    );
    if (alive && current === epoch) review.value = result;
  } catch (e: any) {
    if (alive && current === epoch)
      error.value =
        e.data?.message || e.message || "Could not prepare the bundle.";
  } finally {
    if (alive && current === epoch) loading.value = false;
  }
}
async function download() {
  if (!review.value || loading.value || downloading.value) return;
  const reviewed = review.value;
  downloading.value = true;
  error.value = "";
  notice.value = "";
  try {
    const blob = await $fetch<Blob>(
      "/api/v1/pages/" + props.pageId + "/export/bundle",
      {
        method: "POST",
        body: { ...input(), review: reviewed.digest },
        responseType: "blob",
        timeout: 100000,
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
    notice.value = "Markdown bundle downloaded.";
  } catch (e: any) {
    if (alive) {
      let message = e.data?.message;
      if (e.data instanceof Blob) {
        try {
          message = JSON.parse(await e.data.text()).message;
        } catch {}
      }
      review.value = null;
      error.value =
        message ||
        "Could not download the bundle. Refresh the review and retry.";
    }
  } finally {
    if (alive) downloading.value = false;
  }
}
onBeforeUnmount(() => {
  alive = false;
  epoch++;
  treeEpoch++;
});
defineExpose({ open });
</script>
<template>
  <UiDialog
    :open="opened"
    title="Export pages"
    :error="error"
    wide
    @close="close"
  >
    <form class="bundle-form" @submit.prevent="review ? download() : prepare()">
      <div class="bundle-intro">
        <AppIcon name="folder" :size="23" />
        <div>
          <strong>Take your pages with you</strong>
          <p>
            Choose documents and folders for a Markdown ZIP. Links between
            selected pages work inside the download.
          </p>
        </div>
      </div>
      <fieldset :disabled="downloading" class="bundle-options">
        <label
          ><input v-model="includeAttachments" type="checkbox" /><span
            >Copy embedded images and files<small
              >Included files open outside Orvyn. Up to 100 files and 32 MB in
              total.</small
            ></span
          ></label
        >
        <label
          ><input v-model="includePeopleNames" type="checkbox" /><span
            >Include visible people names<small
              >May include account addresses. Otherwise mentions become
              @person.</small
            ></span
          ></label
        >
      </fieldset>
      <div class="bundle-section-heading">
        <strong
          >Pages to include <span>{{ count }} / 100</span></strong
        >
        <div class="bundle-selection-actions">
          <button
            type="button"
            class="ghost"
            :disabled="treeLoading || downloading || !tree"
            @click="selected = tree!.pages.slice(0, 100).map((page) => page.id)"
          >
            Select all</button
          ><button
            type="button"
            class="ghost"
            :disabled="treeLoading || downloading || !tree"
            @click="selected = [pageId]"
          >
            Starting page only</button
          ><button
            type="button"
            class="icon-button"
            aria-label="Refresh page list"
            :disabled="treeLoading || downloading"
            @click="loadTree()"
          >
            <AppIcon name="refresh" :size="14" />
          </button>
        </div>
      </div>
      <p v-if="tree?.truncated" class="bundle-hint">
        Showing the first 500 readable documents and folders. Open a smaller
        section to reach more pages.
      </p>
      <div v-if="tree" class="bundle-tree" aria-label="Pages to export">
        <label
          v-for="page in tree.pages"
          :key="page.id"
          :style="{ '--depth': Math.min(page.depth, 8) }"
          ><input
            type="checkbox"
            :checked="selected.includes(page.id)"
            :disabled="downloading || treeLoading || page.id === pageId"
            @change="toggle(page.id, $event)"
          /><AppIcon
            :name="page.kind === 'folder' ? 'folder' : 'file'"
            :size="15"
          /><span>{{ page.title }}</span
          ><small v-if="page.id === pageId">Starting page</small></label
        >
      </div>
      <p v-else-if="treeLoading" class="bundle-hint" role="status">
        Loading the page hierarchy…
      </p>
      <template v-if="review">
        <div class="bundle-summary">
          <AppIcon name="download" :size="18" />
          <div>
            <strong>{{ review.filename }}</strong><small
              >{{ review.pages.length }} pages ·
              {{ review.files.length }} copied files ·
              {{ size(review.bytes) }}</small
            >
          </div>
        </div>
        <details class="bundle-details">
          <summary>Files and conversion notes</summary>
          <ul>
            <li v-for="page in review.pages" :key="page.id">
              <code>{{ page.path }}</code><small>{{ size(page.bytes) }}</small>
              <p v-for="warning in page.warnings" :key="warning">
                {{ warning }}
              </p>
            </li>
            <li v-for="file in review.files" :key="file.path">
              <code>{{ file.path }}</code><small>{{ size(file.bytes) }}</small>
            </li>
          </ul>
        </details>
        <div class="bundle-notes">
          <p v-for="warning in review.warnings" :key="warning">
            <AppIcon name="info" :size="14" />{{ warning }}
          </p>
        </div>
      </template>
      <p v-else class="bundle-hint">
        Database data, whiteboard drawings, comments and history have separate
        formats. Only the selected documents and folders are included.
      </p>
      <p v-if="notice" class="bundle-notice" role="status">{{ notice }}</p>
      <footer>
        <span>{{
          review
            ? "Saved content and access are checked again on download."
            : "Review the selected files before downloading."
        }}</span><button
          v-if="review"
          type="button"
          class="ghost"
          :disabled="loading || downloading"
          @click="prepare"
        >
          <AppIcon name="refresh" :size="14" />Refresh</button
        ><button
          type="submit"
          class="primary"
          :disabled="loading || treeLoading || downloading || !tree || !count"
          :title="shortcutLabel('Mod+Enter')"
        >
          <AppIcon :name="review ? 'download' : 'file'" :size="16" />{{
            loading
              ? "Preparing…"
              : downloading
                ? "Downloading…"
                : review
                  ? "Download ZIP"
                  : "Review export"
          }}
        </button>
      </footer>
    </form>
  </UiDialog>
</template>
<style scoped>
.bundle-form {
  display: block;
  margin: 0;
}
.bundle-intro {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.bundle-intro > svg {
  flex-shrink: 0;
  margin-top: 3px;
  color: var(--muted);
}
.bundle-intro strong {
  font-size: 14px;
  font-weight: 500;
}
.bundle-intro p,
.bundle-hint {
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
  margin: 6px 0 0;
}
.bundle-options {
  padding: 18px 0;
  margin: 20px 0 16px;
  display: grid;
  gap: 15px;
  border: 0;
  border-block: 1px solid var(--line);
  min-width: 0;
}
.bundle-options label {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  font-size: 12px;
}
.bundle-options small {
  display: block;
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
  margin-top: 3px;
}
.bundle-form input[type="checkbox"] {
  width: 14px;
  height: 14px;
  min-height: 14px;
  flex: 0 0 14px;
  margin: 3px 0 0;
  accent-color: var(--accent);
}
.bundle-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  margin-bottom: 8px;
}
.bundle-section-heading strong {
  font-weight: 500;
}
.bundle-section-heading strong span {
  font-weight: 400;
  color: var(--muted);
  margin-left: 6px;
}
.bundle-selection-actions {
  display: flex;
  align-items: center;
  gap: 3px;
}
.bundle-tree {
  max-height: 260px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px;
}
.bundle-tree label {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 5px 8px 5px calc(8px + var(--depth) * 16px);
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
}
.bundle-tree label:hover {
  background: var(--hover);
}
.bundle-tree svg {
  color: var(--muted);
  flex-shrink: 0;
}
.bundle-tree span {
  overflow-wrap: anywhere;
  min-width: 0;
}
.bundle-tree small {
  margin-left: auto;
  white-space: nowrap;
  font-size: 10px;
  color: var(--muted);
}
.bundle-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 17px 0;
  border-bottom: 1px solid var(--line);
}
.bundle-summary strong {
  font-size: 13px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.bundle-summary small {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  color: var(--muted);
}
.bundle-details {
  font-size: 12px;
  margin: 15px 0;
}
.bundle-details summary {
  cursor: pointer;
  color: var(--muted);
}
.bundle-details ul {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  max-height: 230px;
  overflow: auto;
}
.bundle-details li {
  padding: 9px 0;
  border-bottom: 1px solid var(--line);
}
.bundle-details code {
  font-size: 11px;
  overflow-wrap: anywhere;
}
.bundle-details small {
  display: block;
  font-size: 10px;
  color: var(--muted);
  margin-top: 3px;
}
.bundle-details p {
  font-size: 11px;
  line-height: 1.6;
  margin: 6px 0 0;
  color: var(--muted);
}
.bundle-notes p {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: 11px;
  line-height: 1.65;
  color: var(--muted);
  margin: 10px 0;
}
.bundle-notes svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.bundle-notice {
  color: var(--accent);
  font-size: 12px;
}
.bundle-form footer {
  position: sticky;
  bottom: 0;
  z-index: 1;
  background: var(--elevated);
  padding-bottom: 22px;
  margin-bottom: -22px;
  border-top: 1px solid var(--line);
  padding-top: 17px;
  margin-top: 20px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.bundle-form footer > span {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.5;
  margin-right: auto;
  max-width: 260px;
}
@media (max-width: 600px) {
  .bundle-section-heading {
    flex-wrap: wrap;
  }
  .bundle-selection-actions {
    margin-left: auto;
  }
  .bundle-form footer {
    flex-wrap: wrap;
  }
  .bundle-form footer > span {
    flex-basis: 100%;
    max-width: none;
  }
  .bundle-tree small {
    display: none;
  }
  .bundle-section-heading {
    align-items: flex-start;
  }
  .bundle-section-heading > button {
    font-size: 10px;
  }
  .bundle-tree label {
    padding-left: calc(6px + var(--depth) * 10px);
  }
}
</style>

<script setup lang="ts">
import type { MarkdownImportInput, PublicationSnapshot } from "@orvyn/shared";
import { markdownImportMaxBytes, markdownImportSizeLabel } from "@orvyn/shared";
import { markdownUpload } from "../utils/markdownUpload";
const props = defineProps<{
    space: any;
    pages: any[];
    beforeImport?: () => Promise<void>;
  }>(),
  emit = defineEmits<{ created: [id: string] }>(),
  opened = ref(false),
  busy = ref(false),
  loadingFile = ref(false),
  error = ref(""),
  filename = ref("Imported page.md"),
  source = ref(""),
  title = ref(""),
  titleFromHeading = ref(true),
  parentId = ref(""),
  review = ref<{
    title: string;
    previewPageId: string;
    document: Record<string, unknown>;
    warnings: string[];
    destination: any;
    previewToken: string;
    input: MarkdownImportInput;
    requestId: string;
  } | null>(null);
const working = computed(() => busy.value || loadingFile.value),
  path = computed(
    () => "/api/v1/spaces/" + props.space.id + "/imports/markdown",
  ),
  parents = computed(() =>
    props.pages.filter(
      (page) =>
        ["page", "folder"].includes(page.kind) && page.access_rank >= 30,
    ),
  ),
  snapshot = computed<PublicationSnapshot | null>(() =>
    review.value
      ? {
          version: 1,
          rootId: review.value.previewPageId,
          files: [],
          attachmentIds: [],
          pages: [
            {
              id: review.value.previewPageId,
              order: 0,
              title: review.value.title,
              kind: "page",
              parentId: null,
              icon: null,
              coverPreset: null,
              coverFileId: null,
              document: review.value.document,
            },
          ],
        }
      : null,
  );
let alive = true,
  fileEpoch = 0;
function open(parent?: string) {
  parentId.value = parent || "";
  review.value = null;
  error.value = "";
  opened.value = true;
}
function close() {
  if (!working.value) {
    opened.value = false;
    fileEpoch++;
  }
}
async function fileSelected(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0],
    epoch = ++fileEpoch;
  input.value = "";
  if (!file) return;
  error.value = "";
  if (
    file.size > markdownImportMaxBytes ||
    !/\.(?:md|markdown)$/i.test(file.name)
  ) {
    error.value =
      "Choose a .md or .markdown file up to " + markdownImportSizeLabel + ".";
    return;
  }
  loadingFile.value = true;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await file.arrayBuffer(),
    );
    if (!alive || epoch !== fileEpoch) return;
    filename.value = file.name.slice(0, 160).replace(/[\uD800-\uDBFF]$/u, "");
    source.value = text;
    title.value = "";
    review.value = null;
  } catch {
    if (alive && epoch === fileEpoch)
      error.value = "Choose a UTF-8 Markdown text file.";
  } finally {
    if (alive && epoch === fileEpoch) loadingFile.value = false;
  }
}
function input(): MarkdownImportInput {
  return {
    filename: filename.value,
    markdown: source.value,
    ...(title.value.trim() ? { title: title.value.trim() } : {}),
    titleFromHeading: titleFromHeading.value,
    parentId: parentId.value || null,
  };
}
async function prepare() {
  if (working.value) return;
  if (
    !source.value.trim() ||
    new TextEncoder().encode(source.value).length > markdownImportMaxBytes
  ) {
    error.value =
      "Choose or paste Markdown up to " + markdownImportSizeLabel + ".";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    await props.beforeImport?.();
    if (!alive) return;
    const value = input(),
      result = await $fetch<any>(path.value + "/preview", {
        method: "POST",
        body: markdownUpload(value),
        timeout: 15000,
      });
    if (alive)
      review.value = {
        ...result,
        input: value,
        requestId: crypto.randomUUID(),
      };
  } catch (e: any) {
    if (alive)
      error.value =
        e.data?.message || e.message || "Could not prepare this Markdown file.";
  } finally {
    if (alive) busy.value = false;
  }
}
async function create() {
  if (busy.value || !review.value) return;
  busy.value = true;
  error.value = "";
  const reviewed = review.value;
  try {
    const body = markdownUpload(reviewed.input, {
      requestId: reviewed.requestId,
      previewToken: reviewed.previewToken,
    });
    let result: any;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await $fetch<any>(path.value, {
          method: "POST",
          body,
          timeout: 15000,
        });
        break;
      } catch (e: any) {
        const status = e.statusCode || e.response?.status || 0;
        if (attempt === 0 && (!status || status >= 500)) continue;
        throw e;
      }
    }
    if (!alive) return;
    opened.value = false;
    review.value = null;
    source.value = "";
    title.value = "";
    emit("created", result.id);
  } catch (e: any) {
    if (alive) {
      const status = e.statusCode || e.response?.status || 0;
      if (!status || status >= 500)
        error.value =
          "Could not confirm the import. Retry to recover the same page.";
      else {
        review.value = null;
        error.value =
          e.data?.message || "Could not import this page. Review it again.";
      }
    }
  } finally {
    if (alive) busy.value = false;
  }
}
const noFile = () => "";
onBeforeUnmount(() => {
  alive = false;
  fileEpoch++;
});
defineExpose({ open });
</script>
<template>
  <UiDialog
    :open="opened"
    :title="review ? 'Review Markdown import' : 'Import Markdown'"
    :error="error"
    wide
    @close="close"
  >
    <template v-if="review && snapshot">
      <div class="markdown-review-bar">
        <div>
          <strong
            >Create a new page in
            {{
              review.destination.parentTitle || review.destination.spaceName
            }}</strong
          >
          <p>The page inherits access from this destination.</p>
        </div>
        <button class="primary" :disabled="working" @click="create">
          <AppIcon name="file" :size="16" />{{
            busy ? "Importing…" : error ? "Retry import" : "Import page"
          }}
        </button>
      </div>
      <ul v-if="review.warnings.length" class="markdown-warnings">
        <li v-for="warning in review.warnings" :key="warning">
          <AppIcon name="info" :size="15" />{{ warning }}
        </li>
      </ul>
      <div class="markdown-preview">
        <PublicationPublicContent
          :snapshot="snapshot"
          :file-url="noFile"
          preview
        />
      </div>
      <button
        class="ghost markdown-back"
        :disabled="working"
        @click="
          review = null;
          error = '';
        "
      >
        <AppIcon name="back" :size="15" />Back to file
      </button>
    </template>
    <form v-else class="markdown-import-form" @submit.prevent="prepare">
      <p>
        Import headings, lists, tasks, tables and links as editable blocks.
        Choose a file or paste Markdown below, then review the page before
        creating it.
      </p>
      <label class="markdown-file"
        ><AppIcon name="upload" :size="21" /><span
          ><strong>Choose a Markdown file</strong
          ><small
            >.md or .markdown · UTF-8 · Up to
            {{ markdownImportSizeLabel }}</small
          ></span
        ><input
          type="file"
          accept=".md,.markdown,text/markdown"
          :disabled="working"
          aria-label="Choose a Markdown file"
          @change="fileSelected"
      /></label>
      <div v-if="source" class="markdown-file-name">
        <AppIcon name="file" :size="15" />{{ filename }}
      </div>
      <label class="markdown-field"
        >Or paste Markdown<textarea
          v-model="source"
          aria-label="Markdown source"
          placeholder="# Your page title&#10;&#10;Start with a note, a checklist or a table…"
          spellcheck="false"
          :disabled="working"
        />
      </label>
      <div class="markdown-settings">
        <label class="markdown-field"
          >Page title<input
            v-model="title"
            aria-label="Imported page title"
            placeholder="From the first heading or filename"
            maxlength="300"
            :disabled="working" /></label
        ><label class="markdown-field"
          >Import into<select
            v-model="parentId"
            aria-label="Import into"
            :disabled="working"
          >
            <option value="">{{ space.name }} · Top level</option>
            <option
              v-for="parent in parents"
              :key="parent.id"
              :value="parent.id"
            >
              {{ parent.title }}
            </option>
          </select></label
        >
      </div>
      <label class="markdown-heading-choice"
        ><input
          v-model="titleFromHeading"
          type="checkbox"
          :disabled="working"
        /><span
          >Use the first H1 heading as the page title<small
            >That heading becomes the title above the document.</small
          ></span
        ></label
      >
      <p class="markdown-limits">
        Images stay as text links. This import creates one page; folders and
        attachment files can be added separately.
      </p>
      <footer>
        <button type="button" class="ghost" :disabled="working" @click="close">
          Cancel</button
        ><button
          type="submit"
          class="primary"
          :disabled="working || !source.trim()"
        >
          <AppIcon name="file" :size="16" />{{
            busy ? "Preparing…" : "Preview import"
          }}<AppIcon name="arrowRight" :size="15" />
        </button>
      </footer>
    </form>
  </UiDialog>
</template>
<style scoped>
.markdown-import-form {
  max-width: 720px;
  margin: 0 auto;
}
.markdown-import-form > p {
  margin: 0 0 20px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.7;
}
.markdown-file {
  display: flex;
  align-items: center;
  gap: 14px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  padding: 22px;
  position: relative;
  cursor: pointer;
  margin-bottom: 18px;
}
.markdown-file:hover {
  background: var(--surface);
}
.markdown-file:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.markdown-file input {
  position: absolute;
  opacity: 0;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: pointer;
}
.markdown-file strong {
  font-size: 13px;
  font-weight: 500;
}
small {
  display: block;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.6;
  margin-top: 3px;
}
.markdown-file-name {
  display: flex;
  gap: 7px;
  align-items: center;
  font-size: 12px;
  margin-bottom: 16px;
  overflow-wrap: anywhere;
}
.markdown-field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 12px;
  min-width: 0;
}
.markdown-field input,
.markdown-field select,
.markdown-field textarea {
  width: 100%;
  font-size: 12px;
}
.markdown-field textarea {
  min-height: 200px;
  resize: vertical;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  line-height: 1.65;
  tab-size: 2;
}
.markdown-settings {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin: 18px 0;
}
.markdown-heading-choice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  padding: 14px 0;
  border-top: 1px solid var(--line);
}
.markdown-heading-choice input {
  accent-color: var(--accent);
  margin: 3px 0 0;
}
.markdown-import-form .markdown-limits {
  font-size: 11px;
  margin: 8px 0 20px;
}
footer {
  border-top: 1px solid var(--line);
  padding-top: 18px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.markdown-review-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--line);
}
.markdown-review-bar strong {
  font-size: 12px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.markdown-review-bar p {
  color: var(--muted);
  font-size: 11px;
  margin: 5px 0 0;
}
.markdown-review-bar button {
  flex-shrink: 0;
}
.markdown-warnings {
  margin: 16px 0;
  list-style: none;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface);
}
.markdown-warnings li {
  font-size: 11px;
  line-height: 1.6;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 4px 0;
}
.markdown-warnings svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.markdown-preview {
  max-height: 60vh;
  overflow: auto;
  margin: 18px 0;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.markdown-back {
  font-size: 12px;
}
@media (max-width: 600px) {
  .markdown-settings {
    grid-template-columns: 1fr;
  }
  .markdown-review-bar {
    align-items: flex-start;
    flex-direction: column;
  }
  .markdown-file {
    padding: 16px;
  }
}
</style>

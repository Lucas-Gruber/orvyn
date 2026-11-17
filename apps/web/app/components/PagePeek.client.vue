<script setup lang="ts">
import type { DatabaseRecord } from "@orvyn/shared";
import type { CommentAnchor } from "@orvyn/editor/comments";
import { pageNavigationKey } from "../composables/pageNavigation";
import { pendingWritesKey } from "../composables/pendingWrites";
const props = defineProps<{
    pageId: string;
    mode: "side" | "modal";
    user: any;
    paused?: boolean;
  }>(),
  emit = defineEmits<{
    close: [];
    fullpage: [id: string, heading?: string];
    mode: [value: "side" | "modal"];
    changed: [];
  }>(),
  page = ref<any>(),
  databaseTitle = ref(""),
  titleInput = ref<HTMLTextAreaElement>(),
  loading = ref(true),
  error = ref(""),
  closing = ref(false),
  savedTitle = ref(""),
  titleState = ref(""),
  titleConflict = ref<any>(),
  editor = ref<any>(),
  fields = ref<any>(),
  saveTemplate = ref<{ open: () => void }>(),
  canTemplate = ref(false),
  attachments = ref(false),
  appearance = ref(false),
  comments = ref(false),
  anchor = ref<CommentAnchor | null>(null),
  requestedThread = ref(""),
  commentVisit = ref(0),
  focusedComment = ref<any>(),
  anchorStatus = ref<"active" | "changed" | "missing">("active"),
  mobile = ref(false),
  targetHeading = ref(""),
  headingVisit = ref(0);
let generation = 0,
  disposed = false,
  titleTimer: ReturnType<typeof setTimeout> | undefined,
  titleJob: Promise<void> | undefined,
  media: MediaQueryList | undefined;
const pendingWrites = inject(pendingWritesKey);
async function load() {
  const token = ++generation;
  loading.value = true;
  try {
    const data = await $fetch<any>("/api/v1/pages/" + props.pageId);
    if (disposed || token !== generation) return;
    if (data.kind === "database" || data.kind === "folder") {
      emit("fullpage", data.id);
      return;
    }
    page.value = data;
    savedTitle.value = data.title;
    error.value = "";
  } catch (e: any) {
    if (!disposed && token === generation) {
      page.value = undefined;
      error.value = e.data?.message || "This page is unavailable.";
    }
  } finally {
    if (token === generation) loading.value = false;
  }
}
function scheduleTitle() {
  clearTimeout(titleTimer);
  titleState.value = "Unsaved title";
  titleTimer = setTimeout(() => void saveTitle().catch(() => {}), 450);
}
async function saveTitle() {
  clearTimeout(titleTimer);
  if (titleJob) await titleJob;
  if (
    !page.value ||
    page.value.access_rank < 30 ||
    page.value.title === savedTitle.value
  )
    return;
  if (titleConflict.value)
    throw new Error("Review the title conflict before leaving this page.");
  const current = page.value,
    title = current.title;
  titleJob = (async () => {
    titleState.value = "Saving title…";
    try {
      const result = await $fetch<any>(`/api/v1/pages/${current.id}/title`, {
        method: "PATCH",
        body: { title, titleVersion: current.title_version },
      });
      if (disposed || page.value?.id !== current.id) return;
      current.title_version = result.title_version;
      savedTitle.value = result.title;
      titleState.value =
        current.title === savedTitle.value ? "" : "Unsaved title";
      emit("changed");
    } catch (e: any) {
      if (e.status === 409)
        titleConflict.value = await $fetch<any>("/api/v1/pages/" + current.id);
      titleState.value = "Title could not be saved";
      throw e;
    } finally {
      titleJob = undefined;
    }
  })();
  await titleJob;
  if (page.value?.title !== savedTitle.value) await saveTitle();
}
async function resolveTitle(mine: boolean) {
  if (!page.value || !titleConflict.value) return;
  const latest = titleConflict.value;
  page.value.title_version = latest.title_version;
  savedTitle.value = latest.title;
  if (!mine) page.value.title = latest.title;
  titleConflict.value = undefined;
  titleState.value = "";
  if (mine) await saveTitle();
}
async function flush() {
  await saveTitle();
  await fields.value?.flush();
  await Promise.all([...(pendingWrites || [])].map((save) => save()));
  await editor.value?.flush();
}
async function close(force = false) {
  if (closing.value) return;
  closing.value = true;
  error.value = "";
  try {
    if (!force) await flush();
    emit("close");
  } catch (e: any) {
    error.value =
      e.data?.message || e.message || "Changes are still waiting to save.";
  } finally {
    closing.value = false;
  }
}
async function fullpage(id = props.pageId, heading = "") {
  try {
    await flush();
    emit("fullpage", id, heading);
  } catch (e: any) {
    error.value = e.message || "Changes are still waiting to save.";
  }
}
provide(pageNavigationKey, (id, heading = "") => void fullpage(id, heading));
function snapshot(record: DatabaseRecord) {
  if (!page.value || record.pageId !== page.value.id) return;
  page.value.access_rank = record.accessRank;
  if (page.value.title === savedTitle.value && !titleJob) {
    page.value.title = record.title;
    savedTitle.value = record.title;
    page.value.title_version = record.titleVersion;
  }
  page.value.icon = record.icon;
}
function access(value: { rank: number }) {
  if (page.value) page.value.access_rank = value.rank;
  if (value.rank < 10) {
    page.value = undefined;
    error.value = "This page is unavailable or your access changed.";
  }
}
function commentOnText(value: CommentAnchor) {
  anchor.value = value;
  requestedThread.value = "";
  comments.value = true;
}
function openThread(id: string) {
  anchor.value = null;
  requestedThread.value = id;
  commentVisit.value++;
  comments.value = true;
}
function jumpThread(thread: any) {
  focusedComment.value = {
    id: thread.id,
    pageId: props.pageId,
    anchor: thread.anchor,
  };
  void nextTick(() => editor.value?.focusComment());
}
function resize() {
  mobile.value = !!media?.matches;
  void nextTick(resizeTitle);
}
function resizeTitle() {
  const input = titleInput.value;
  if (input) {
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
  }
}
watch(
  [() => page.value?.title, () => props.mode],
  () => void nextTick(resizeTitle),
);
function beforeUnload(event: BeforeUnloadEvent) {
  if (titleJob || (page.value && page.value.title !== savedTitle.value)) {
    event.preventDefault();
    event.returnValue = "";
  }
}
onMounted(() => {
  media = matchMedia("(max-width: 900px)");
  resize();
  media.addEventListener("change", resize);
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("resize", resizeTitle);
});
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  clearTimeout(titleTimer);
  media?.removeEventListener("change", resize);
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener("resize", resizeTitle);
});
watch(
  () => props.pageId,
  () => void load(),
  { immediate: true },
);
defineExpose({ flush, requestClose: () => close() });
</script>
<template>
  <UiDialog
    :open="true"
    :title="page?.title || 'Page preview'"
    :drawer="mode === 'side'"
    :modal="mode === 'modal' || mobile"
    wide
    class="page-peek"
    :aria-busy="loading || closing"
    @close="close()"
  >
    <template #title="{ id }">
      <div class="peek-header-location">
        <button
          v-if="page?.kind === 'record'"
          class="icon-button"
          aria-label="Back to database"
          title="Back to database"
          @click="close()"
        >
          <AppIcon name="back" :size="17" />
        </button>
        <div class="peek-header-context">
          <AppIcon
            :name="page?.kind === 'record' ? 'database' : 'file'"
            :size="15"
          /><span aria-hidden="true">{{
            page?.kind === "record" ? databaseTitle || "Database" : "Page"
          }}</span>
        </div>
        <h2 :id="id" class="sr-only">{{ page?.title || "Page preview" }}</h2>
      </div>
    </template>
    <template #actions>
      <div id="peek-editor-tools" />
      <button
        v-if="page"
        class="icon-button"
        aria-label="Comments"
        title="Comments"
        :aria-pressed="comments"
        @click="comments = !comments"
      >
        <AppIcon name="comments" :size="16" />
      </button>
      <UiMenu v-if="page" label="Record actions">
        <button
          v-if="canTemplate"
          role="menuitem"
          @click="saveTemplate?.open()"
        >
          <AppIcon name="copy" :size="16" />Save as template
        </button>
        <button
          v-if="page.access_rank >= 30"
          role="menuitem"
          @click="appearance = true"
        >
          <AppIcon name="palette" :size="16" />Icon and cover
        </button>
        <button role="menuitem" @click="attachments = !attachments">
          <AppIcon name="paperclip" :size="16" />Attachments
        </button>
      </UiMenu>
      <span class="peek-header-divider" aria-hidden="true" />
      <button
        class="icon-button"
        :aria-label="mode === 'side' ? 'Open as modal' : 'Open to side'"
        :title="mode === 'side' ? 'Center peek' : 'Side peek'"
        @click="emit('mode', mode === 'side' ? 'modal' : 'side')"
      >
        <AppIcon :name="mode === 'side' ? 'gallery' : 'sidePeek'" :size="16" />
      </button>
      <button
        class="icon-button"
        aria-label="Open as full page"
        title="Open as full page"
        @click="fullpage()"
      >
        <AppIcon name="expand" :size="16" />
      </button>
      <span class="peek-header-divider" aria-hidden="true" />
    </template>
    <div class="page-peek-body">
      <div v-if="error" class="peek-error" role="alert">
        <p>{{ error }}</p>
        <button class="ghost" :disabled="closing" @click="close(true)">
          Close anyway
        </button>
      </div>
      <p v-if="loading" role="status" class="hint">Opening page…</p>
      <article v-else-if="page" class="peek-page">
        <CoverBanner
          :preset="page.cover_preset"
          :file-id="page.cover_file_id"
        />
        <div v-if="page.icon" class="peek-page-symbol">
          <PageSymbol :icon="page.icon" :kind="page.kind" :size="38" />
        </div>
        <div
          v-if="
            page.access_rank >= 30 &&
            (!page.icon || (!page.cover_preset && !page.cover_file_id))
          "
          class="peek-appearance-actions"
        >
          <button v-if="!page.icon" class="ghost" @click="appearance = true">
            <AppIcon name="plus" :size="12" />Add icon</button
          ><button
            v-if="!page.cover_preset && !page.cover_file_id"
            class="ghost"
            @click="appearance = true"
          >
            <AppIcon name="image" :size="12" />Add cover
          </button>
        </div>
        <textarea
          ref="titleInput"
          v-model="page.title"
          rows="1"
          class="peek-page-title"
          aria-label="Page title"
          maxlength="300"
          placeholder="Untitled"
          :readonly="page.access_rank < 30 || closing || paused"
          @input="
            scheduleTitle();
            resizeTitle();
          "
          @keydown.enter.prevent="editor?.focusStart?.()"
          @blur="saveTitle().catch(() => {})"
        />
        <small v-if="titleState" role="status" class="hint">{{
          titleState
        }}</small>
        <div v-if="titleConflict" class="peek-error" role="alert">
          <p>
            The saved title is “{{ titleConflict.title }}”. Keep your title or
            use the saved one.
          </p>
          <button @click="resolveTitle(false)">Use saved title</button
          ><button @click="resolveTitle(true)">Keep my title</button>
        </div>
        <RecordProperties
          v-if="page.kind === 'record' && page.parent_id"
          ref="fields"
          :database-id="page.parent_id"
          :record-id="page.id"
          :editable="page.access_rank >= 30 && !closing && !paused"
          @snapshot="snapshot"
          @database="databaseTitle = $event.title"
          @denied="access({ rank: 0 })"
          @changed="emit('changed')"
          @manage="attachments = true"
          @template-access="canTemplate = $event"
        />
        <LazyBlockEditor
          ref="editor"
          :key="page.id"
          :page-id="page.id"
          :space-id="page.space_id"
          :user="user"
          :access-rank="page.access_rank"
          :paused="closing || paused"
          :focused-comment="focusedComment"
          :target-heading="targetHeading"
          :heading-visit="headingVisit"
          chrome-target="#peek-editor-tools"
          @access="access"
          @comment="commentOnText"
          @thread="openThread"
          @anchor-status="anchorStatus = $event.status"
        />
        <section class="peek-page-details" aria-label="Page details">
          <PageBacklinks :key="'backlinks-' + page.id" :page-id="page.id" />
          <details
            class="page-attachments-disclosure"
            :open="attachments"
            @toggle="attachments = ($event.target as HTMLDetailsElement).open"
          >
            <summary>
              <AppIcon name="paperclip" :size="15" />Attachments<AppIcon
                :name="attachments ? 'chevronDown' : 'chevronRight'"
                :size="13"
              />
            </summary>
            <PageAttachments
              v-if="attachments"
              :key="'files-' + page.id"
              :page="page"
            />
          </details>
        </section>
        <SaveDatabaseTemplate
          v-if="page.kind === 'record' && page.parent_id"
          ref="saveTemplate"
          :database-id="page.parent_id"
          :record-id="page.id"
          :title="page.title"
          :before-save="flush"
        />
        <PageAppearanceDialog
          :open="appearance"
          title="Page appearance"
          :resource-path="'pages/' + page.id"
          :page-id="page.id"
          :appearance="page"
          @close="appearance = false"
          @changed="
            Object.assign(page, $event);
            emit('changed');
          "
        />
        <PageComments
          :key="'comments-' + page.id"
          :open="comments"
          :page-id="page.id"
          :anchor="anchor"
          :requested-thread="requestedThread"
          :request-visit="commentVisit"
          :anchor-status="anchorStatus"
          @close="
            comments = false;
            anchor = null;
            focusedComment = undefined;
          "
          @changed="editor?.refreshComments()"
          @select="
            focusedComment = $event.thread
              ? {
                  id: $event.thread.id,
                  pageId: page.id,
                  anchor: $event.thread.anchor,
                }
              : undefined
          "
          @jump="jumpThread"
        />
      </article>
    </div>
  </UiDialog>
</template>
<style>
.ui-dialog.page-peek {
  width: min(1040px, calc(100vw - 80px));
  max-height: calc(100dvh - 48px);
  background: var(--bg);
}
.ui-dialog.page-peek.drawer {
  width: min(800px, calc(100vw - 32px));
  max-height: 100dvh;
}
.page-peek > .dialog-header {
  position: sticky;
  top: 0;
  z-index: 5;
  min-height: 52px;
  padding: 9px 16px;
  gap: 12px;
  background: var(--bg);
  border-bottom: 1px solid var(--line-soft);
}
.ui-dialog.page-peek > .dialog-content,
.ui-dialog.page-peek.drawer > .dialog-content {
  padding: 0;
}
.peek-header-location {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  flex: 1;
}
.peek-header-context {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  color: var(--muted);
  font-size: 13px;
}
.peek-header-context > span {
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}
.peek-header-context .app-icon {
  flex-shrink: 0;
}
.page-peek .dialog-header-actions {
  gap: 3px;
}
.peek-header-divider {
  width: 1px;
  height: 18px;
  background: var(--divider);
  margin-inline: 4px;
}
.page-peek-body {
  padding: 48px 56px 64px;
}
.ui-dialog.page-peek:not(.drawer) .page-peek-body {
  padding: 56px 80px 80px;
}
.peek-page {
  max-width: 760px;
  margin-inline: auto;
}
.peek-appearance-actions {
  display: flex;
  gap: 5px;
  min-height: 25px;
  margin-bottom: 12px;
  opacity: 0;
  transition: opacity 0.15s;
}
.peek-page:hover .peek-appearance-actions,
.peek-page:focus-within .peek-appearance-actions {
  opacity: 1;
}
.peek-appearance-actions > button {
  color: var(--faint);
  font-size: 13px;
  padding: 3px 5px;
  min-height: 25px;
  background: transparent;
}
.peek-appearance-actions > button:hover {
  color: var(--text);
  background: var(--surface-hover);
}
.peek-page-symbol {
  margin-block: 8px 16px;
  color: var(--faint);
}
.peek-page-title {
  display: block;
  width: 100%;
  min-height: 42px;
  padding: 0;
  margin: 0 0 28px;
  resize: none;
  overflow: hidden;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  font-family: inherit;
  font-size: 40px;
  letter-spacing: -0.025em;
  font-weight: 700;
  line-height: 1.2;
}
.peek-page-title:focus {
  box-shadow: none;
  outline: 0;
}
.peek-page > .hint {
  display: block;
  margin-top: -16px;
  margin-bottom: 20px;
}
.peek-error {
  padding: 12px;
  background: var(--surface);
  border: 1px solid var(--divider);
  border-radius: 7px;
  font-size: 0.8rem;
  margin-bottom: 16px;
}
.peek-error button {
  font-size: 0.76rem;
  margin-right: 6px;
}
.page-peek .block-editor .tiptap {
  min-height: 200px;
}
.page-peek .record-property-row {
  grid-template-columns: 156px minmax(0, 1fr);
}
.peek-page-details {
  border-top: 1px solid var(--line-soft);
  margin-top: 28px;
  padding-top: 12px;
}
.peek-page-details > .page-backlinks,
.peek-page-details > .page-attachments-disclosure {
  margin: 0;
  padding: 8px 0;
  border: 0;
}
.peek-page-details > .page-backlinks > summary,
.peek-page-details > .page-attachments-disclosure > summary {
  width: 100%;
  min-height: 20px;
  font-size: 13px;
}
.peek-page-details summary > .app-icon:last-child {
  margin-left: auto;
}
@media (max-width: 900px) {
  .ui-dialog.page-peek,
  .ui-dialog.page-peek.drawer {
    width: calc(100vw - 20px);
    max-height: calc(100dvh - 20px);
  }
}
@media (max-width: 600px) {
  .ui-dialog.page-peek,
  .ui-dialog.page-peek.drawer {
    width: 100vw;
    max-width: 100vw;
    height: 100dvh;
    max-height: 100dvh;
    margin: 0;
    inset: 0;
    border-radius: 0;
    border: 0;
  }
  .page-peek-body,
  .ui-dialog.page-peek:not(.drawer) .page-peek-body {
    padding: 24px;
  }
  .page-peek > .dialog-header {
    padding-inline: 10px;
    gap: 6px;
  }
  .page-peek .dialog-header-actions {
    gap: 1px;
  }
  .peek-header-divider {
    margin-inline: 2px;
  }
  .peek-header-context {
    max-width: 100px;
  }
  .peek-page-title {
    font-size: 32px;
  }
  .page-peek .record-property-row {
    grid-template-columns: 112px minmax(0, 1fr);
    gap: 8px;
  }
}
@media (hover: none) {
  .peek-appearance-actions {
    opacity: 1;
  }
}
</style>

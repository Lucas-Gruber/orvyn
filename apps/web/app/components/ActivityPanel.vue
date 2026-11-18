<script setup lang="ts">
const props = defineProps<{
    open: boolean;
    spaceId: string;
    pageId?: string;
    visit: (pageId: string) => Promise<void>;
  }>(),
  emit = defineEmits<{ close: [] }>(),
  items = ref<any[]>([]),
  nextBefore = ref(""),
  loading = ref(false),
  busy = ref(false),
  paged = ref(false),
  error = ref("");
const labels: Record<string, string> = {
  "page.created": "Created a page",
  "page.updated": "Edited the document",
  "page.title_updated": "Renamed the page",
  "page.appearance_updated": "Changed the page appearance",
  "page.permissions_changed": "Updated page access",
  "page.moved": "Moved the page",
  "page.trashed": "Moved the page to trash",
  "page.restored": "Restored the page",
  "comment.thread_created": "Started a discussion",
  "comment.replied": "Replied to a discussion",
  "comment.edited": "Edited a comment",
  "comment.deleted": "Removed a comment",
  "comment.resolved": "Resolved a discussion",
  "comment.reopened": "Reopened a discussion",
  "file.uploaded": "Added an attachment",
  "file.deleted": "Removed an attachment",
  "database.created": "Created a database",
  "database.property_created": "Added a database property",
  "database.property_renamed": "Renamed a database property",
  "database.property_updated": "Updated a database property",
  "database.property_converted": "Changed a database property type",
  "database.property_deleted": "Deleted a database property",
  "database.property_restored": "Restored a database property",
  "database.view_created": "Created a database view",
  "database.view_updated": "Updated a database view",
  "database.record_created": "Created a database record",
  "database.record_updated": "Updated a database record",
  "database.csv_imported": "Imported a database record",
  "database.template_created": "Saved a template",
  "database.template_updated": "Updated a template",
  "database.template_deleted": "Deleted a template",
  "database.created_from_template": "Created a database from a template",
  "database.record_created_from_template": "Created a record from a template",
  "space.created": "Created this space",
  "space.appearance_updated": "Changed the space appearance",
  "space.converted_to_team": "Converted to a team space",
  "space.invitation_created": "Invited a person to the space",
  "space.invitation_accepted": "Accepted a space invitation",
  "space.member_role_changed": "Changed a member’s role",
  "space.member_removed": "Removed a space member",
};
const when = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
let generation = 0,
  disposed = false,
  timer: ReturnType<typeof setInterval> | undefined;
async function load(append = false) {
  const token = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const data = await $fetch<any>(`/api/v1/spaces/${props.spaceId}/activity`, {
      query: {
        page: props.pageId || "",
        before: append ? nextBefore.value : "",
      },
    });
    if (disposed || token !== generation || !props.open) return;
    items.value = append
      ? [
          ...items.value,
          ...data.events.filter(
            (event: any) => !items.value.some((old) => old.id === event.id),
          ),
        ]
      : data.events;
    nextBefore.value = data.nextBefore;
    paged.value = append;
  } catch (e: any) {
    if (!disposed && token === generation) {
      error.value = e.data?.message || "Activity could not be loaded.";
      if ([401, 403, 404].includes(e.statusCode || e.status)) items.value = [];
    }
  } finally {
    if (token === generation) loading.value = false;
  }
}
async function visit(item: any) {
  if (busy.value || !item.pageId) return;
  busy.value = true;
  error.value = "";
  try {
    await props.visit(item.pageId);
    emit("close");
  } catch (e: any) {
    if ([401, 403, 404].includes(e.statusCode || e.status)) await load();
    error.value =
      e.data?.message || e.message || "This page could not be opened.";
  } finally {
    busy.value = false;
  }
}
watch(
  [() => props.open, () => props.spaceId, () => props.pageId],
  () => {
    generation++;
    items.value = [];
    nextBefore.value = "";
    paged.value = false;
    error.value = "";
    loading.value = false;
    if (props.open) void load();
  },
  { immediate: true },
);
onMounted(() => {
  timer = setInterval(() => {
    if (
      props.open &&
      !paged.value &&
      !busy.value &&
      !loading.value &&
      document.visibilityState === "visible"
    )
      void load();
  }, 15000);
});
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  clearInterval(timer);
});
</script>
<template>
  <UiDialog
    :open="open"
    :title="pageId ? 'Page activity' : 'Space activity'"
    drawer
    :error="error"
    @close="emit('close')"
    ><div class="activity-controls">
      <p>Changes you can currently access.</p>
      <button
        class="icon-button"
        aria-label="Refresh activity"
        :disabled="loading || busy"
        @click="load()"
      >
        <AppIcon name="refresh" :size="16" />
      </button>
    </div>
    <p v-if="loading && !items.length" role="status">Loading activity…</p>
    <div v-else-if="!items.length && !error" class="activity-empty">
      <AppIcon name="history" :size="30" />
      <h3>No activity yet</h3>
      <p>Edits, discussions and workspace changes will appear here.</p>
    </div>
    <ol class="activity-events">
      <li v-for="item in items" :key="item.id">
        <span class="activity-avatar">{{
          (item.actor.email || "Former member").slice(0, 2).toUpperCase()
        }}</span>
        <div>
          <strong>{{ item.actor.email || "Former member" }}</strong>
          <p>{{ labels[item.kind] || "Updated this item" }}</p>
          <button
            v-if="item.pageId"
            class="activity-page"
            :disabled="busy"
            @click="visit(item)"
          >
            <PageSymbol
              :icon="item.icon"
              :kind="item.pageKind"
              :size="14"
            /><span>{{ item.title }}</span
            ><AppIcon name="arrowRight" :size="13" /></button
          ><span v-else class="activity-space">Space</span
          ><time
            :datetime="item.createdAt"
            :title="
              item.updatedAt !== item.createdAt
                ? 'Latest edit: ' + when(item.updatedAt)
                : undefined
            "
            >{{ when(item.createdAt) }}</time
          >
        </div>
      </li>
    </ol>
    <button
      v-if="nextBefore"
      class="ghost"
      :disabled="loading || busy"
      @click="load(true)"
    >
      Load earlier activity
    </button></UiDialog
  >
</template>
<style scoped>
.activity-controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}
.activity-controls p {
  font-size: 0.75rem;
  color: var(--muted);
  margin: 0;
}
.activity-empty {
  display: grid;
  justify-items: center;
  text-align: center;
  padding: 60px 16px;
  color: var(--muted);
}
.activity-empty h3 {
  font-size: 1rem;
  color: var(--text);
  margin: 14px 0 5px;
}
.activity-empty p {
  font-size: 0.8rem;
  max-width: 260px;
}
.activity-events {
  list-style: none;
  margin: 0;
  padding: 0;
}
.activity-events li {
  display: flex;
  gap: 12px;
  padding: 18px 0;
  border-bottom: 1px solid var(--line-soft);
}
.activity-avatar {
  flex: 0 0 28px;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.7rem;
}
.activity-events li > div {
  min-width: 0;
  flex: 1;
}
.activity-events strong {
  display: block;
  font-size: 0.75rem;
  font-weight: 550;
  overflow-wrap: anywhere;
}
.activity-events p {
  margin: 5px 0 7px;
  font-size: 0.85rem;
  line-height: 1.5;
}
.activity-page {
  display: flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  background: var(--surface);
  padding: 5px 8px;
  font-size: 0.8rem;
  border: 0;
}
.activity-page span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.activity-space {
  color: var(--muted);
  font-size: 0.75rem;
}
.activity-events time {
  display: block;
  margin-top: 9px;
  color: var(--muted);
  font-size: 0.68rem;
}
</style>

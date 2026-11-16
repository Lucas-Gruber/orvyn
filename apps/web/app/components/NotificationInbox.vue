<script setup lang="ts">
const props = defineProps<{ visit: (item: any) => Promise<void> }>(),
  open = ref(false),
  items = ref<any[]>([]),
  unread = ref(0),
  filter = ref("all"),
  nextBefore = ref(""),
  paged = ref(false),
  busy = ref(false),
  loading = ref(false),
  error = ref("");
let generation = 0,
  disposed = false,
  timer: ReturnType<typeof setInterval> | undefined;
const when = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
async function summary() {
  if (disposed || open.value || document.visibilityState !== "visible") return;
  try {
    const data = await $fetch<any>("/api/v1/notifications", {
      query: { state: "unread", limit: 1 },
    });
    if (!disposed && !open.value) unread.value = data.unread;
  } catch {
    if (!disposed && !open.value) unread.value = 0;
  }
}
async function load(append = false) {
  const token = ++generation,
    state = filter.value;
  loading.value = true;
  error.value = "";
  try {
    const data = await $fetch<any>("/api/v1/notifications", {
      query: { state, before: append ? nextBefore.value : "" },
    });
    if (disposed || token !== generation || !open.value) return;
    items.value = append
      ? [
          ...items.value,
          ...data.notifications.filter(
            (n: any) => !items.value.some((old) => old.id === n.id),
          ),
        ]
      : data.notifications;
    nextBefore.value = data.nextBefore;
    paged.value = append;
    unread.value = data.unread;
  } catch (e: any) {
    if (!disposed && token === generation) {
      error.value = e.data?.message || "Notifications could not be loaded.";
      if ([401, 403, 404].includes(e.statusCode || e.status)) {
        items.value = [];
        unread.value = 0;
      }
    }
  } finally {
    if (token === generation) loading.value = false;
  }
}
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await action();
  } catch (e: any) {
    if ([401, 403, 404].includes(e.statusCode || e.status)) await load();
    error.value =
      e.data?.message || e.message || "Notification could not be opened.";
  } finally {
    busy.value = false;
  }
}
async function visit(item: any) {
  await run(async () => {
    const current = await $fetch<any>("/api/v1/notifications/" + item.id, {
      method: "PATCH",
      body: { read: true },
    });
    await props.visit(current);
    open.value = false;
    await summary();
  });
}
async function mark(item: any) {
  await run(async () => {
    await $fetch("/api/v1/notifications/" + item.id, {
      method: "PATCH",
      body: { read: !item.readAt },
    });
    await load();
  });
}
async function allRead() {
  await run(async () => {
    await $fetch("/api/v1/notifications/read-all", {
      method: "POST",
      body: {},
    });
    await load();
  });
}
watch([open, filter], () => {
  if (open.value) void load();
  else {
    generation++;
    items.value = [];
    error.value = "";
    loading.value = false;
  }
});
onMounted(() => {
  void summary();
  timer = setInterval(() => {
    if (document.visibilityState !== "visible" || busy.value || loading.value)
      return;
    if (open.value) {
      if (!paged.value) void load();
    } else void summary();
  }, 15000);
});
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  clearInterval(timer);
});
</script>
<template>
  <button class="inbox-trigger" aria-label="Notifications" @click="open = true">
    <AppIcon name="inbox" :size="17" /><span>Inbox</span
    ><span
      v-if="unread"
      class="inbox-count"
      aria-label="Unread notifications"
      >{{ unread > 99 ? "99+" : unread }}</span
    >
  </button>
  <UiDialog
    :open="open"
    title="Inbox"
    drawer
    :error="error"
    @close="open = false"
  >
    <div class="inbox-controls">
      <label
        >Show<select v-model="filter" :disabled="busy || loading">
          <option value="all">All notifications</option>
          <option value="unread">Unread</option>
        </select></label
      ><button
        class="ghost"
        :disabled="busy || loading || !unread"
        @click="allRead"
      >
        Mark all read</button
      ><button
        class="icon-button"
        aria-label="Refresh notifications"
        :disabled="busy || loading"
        @click="load()"
      >
        <AppIcon name="refresh" :size="16" />
      </button>
    </div>
    <p v-if="loading && !items.length" role="status">Loading notifications…</p>
    <div v-else-if="!items.length" class="inbox-empty">
      <AppIcon name="inbox" :size="32" />
      <h3>
        {{
          filter === "unread" ? "You’re all caught up" : "Your inbox is clear"
        }}
      </h3>
      <p>Mentions and replies to your discussions will appear here.</p>
    </div>
    <ol class="inbox-items">
      <li
        v-for="item in items"
        :key="item.id"
        :class="{ unread: !item.readAt }"
      >
        <button class="inbox-item" :disabled="busy" @click="visit(item)">
          <span class="inbox-avatar">{{
            (item.actor.email || "Former member").slice(0, 2).toUpperCase()
          }}</span><span
            ><span class="inbox-who">{{
              item.actor.email || "Former member"
            }}</span
            ><span class="inbox-kind">{{
              item.kind === "document_mention"
                ? "mentioned you in a document"
                : item.kind === "comment_mention"
                  ? "mentioned you in a comment"
                  : "replied to your discussion"
            }}</span
            ><strong>{{ item.title }}</strong
            ><span class="inbox-excerpt">{{ item.excerpt }}</span
            ><time :datetime="item.createdAt">{{
              when(item.createdAt)
            }}</time></span
          ><i
            v-if="!item.readAt"
            class="unread-dot"
            aria-label="Unread"
          /></button
        ><button class="ghost inbox-read" :disabled="busy" @click="mark(item)">
          {{ item.readAt ? "Mark unread" : "Mark read" }}
        </button>
      </li>
    </ol>
    <button
      v-if="nextBefore"
      class="ghost"
      :disabled="busy || loading"
      @click="load(true)"
    >
      Load more notifications
    </button>
  </UiDialog>
</template>
<style scoped>
.inbox-trigger {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}
.inbox-count {
  margin-left: auto;
  border-radius: 5px;
  padding: 1px 6px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.68rem;
}
.inbox-controls {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
.inbox-controls label {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 0.75rem;
  margin: 0;
  color: var(--muted);
}
.inbox-controls select {
  width: auto;
  font-size: 0.75rem;
  padding: 6px;
}
.inbox-controls button {
  font-size: 0.7rem;
}
.inbox-empty {
  display: grid;
  justify-items: center;
  padding: 60px 12px;
  color: var(--muted);
  text-align: center;
}
.inbox-empty h3 {
  color: var(--text);
  margin: 15px 0 8px;
  font-size: 1rem;
}
.inbox-empty p {
  font-size: 0.8rem;
  max-width: 250px;
}
.inbox-items {
  list-style: none;
  padding: 0;
  margin: 0;
}
.inbox-items li {
  border-bottom: 1px solid var(--line-soft);
  padding: 4px;
  border-radius: 7px;
}
.inbox-items li.unread {
  background: var(--accent-soft);
}
.inbox-item {
  display: flex;
  gap: 10px;
  width: 100%;
  padding: 14px 8px 8px;
  border: 0;
  background: transparent;
  text-align: left;
  align-items: flex-start;
}
.inbox-item > span:nth-child(2) {
  display: grid;
  gap: 5px;
  flex: 1;
  min-width: 0;
}
.inbox-who,
.inbox-kind {
  font-size: 0.78rem;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.inbox-who {
  color: var(--text);
}
.inbox-item strong {
  font-size: 0.95rem;
  margin: 4px 0;
  overflow-wrap: anywhere;
}
.inbox-excerpt {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 0.84rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.inbox-item time {
  margin-top: 4px;
  color: var(--muted);
  font-size: 0.7rem;
}
.inbox-avatar {
  flex: 0 0 28px;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  background: var(--surface);
  color: var(--accent);
  font-size: 0.7rem;
}
.inbox-read {
  font-size: 0.7rem;
  margin: 0 0 8px 46px;
  padding: 3px 6px;
}
.unread-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  margin-top: 8px;
  border-radius: 100%;
  background: var(--accent);
}
</style>

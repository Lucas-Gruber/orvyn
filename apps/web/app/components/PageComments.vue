<script setup lang="ts">
import {
  commentDraftsKey,
  type CommentDraftState,
  type CommentPerson,
} from "../composables/commentDrafts";
import type { CommentAnchor } from "@orvyn/editor/comments";
const props = defineProps<{
  open: boolean;
  pageId: string;
  modal?: boolean;
  anchor?: CommentAnchor | null;
  requestedThread?: string;
  requestVisit?: number;
  anchorStatus?: "active" | "changed" | "missing";
}>();
const cache = inject(commentDraftsKey, new Map()),
  savedDraft: CommentDraftState = cache.get(props.pageId) || {
    body: "",
    replies: new Map<string, string>(),
    keys: new Map<string, { body: string; key: string }>(),
  };
cache.set(props.pageId, savedDraft);
savedDraft.replyMentions ??= new Map();
const emit = defineEmits<{
    close: [];
    changed: [pageId: string];
    select: [value: { pageId: string; thread: any | null }];
    jump: [thread: any];
  }>(),
  threads = ref<any[]>([]),
  selected = ref<any>(),
  messages = ref<any[]>([]),
  rank = ref(0),
  filter = ref("open"),
  nextBefore = ref(""),
  messageBefore = ref(""),
  paged = ref(false),
  messagePaged = ref(false),
  loading = ref(false),
  busy = ref(false),
  error = ref(""),
  draft = ref(savedDraft.body),
  draftMentions = ref<CommentPerson[]>(savedDraft.mentions || []),
  replyMentions = ref<CommentPerson[]>([]),
  editMentions = ref<CommentPerson[]>([]),
  draftAnchor = ref<CommentAnchor | null>(savedDraft.anchor || null),
  reply = ref(""),
  editing = ref<any>(),
  editText = ref(""),
  deleting = ref<any>();
const canComment = computed(() => rank.value >= 20);
let generation = 0,
  viewEpoch = 0,
  handledRequest = "",
  timer: ReturnType<typeof setInterval> | undefined;
const keys = savedDraft.keys;
watch(draft, (value) => (savedDraft.body = value));
watch(draftMentions, (value) => (savedDraft.mentions = value));
watch(replyMentions, (value) => {
  if (selected.value) savedDraft.replyMentions!.set(selected.value.id, value);
});
watch(draftAnchor, (value) => (savedDraft.anchor = value));
watch(selected, (thread) =>
  emit("select", { pageId: props.pageId, thread: thread || null }),
);
watch(
  () => props.anchor,
  (anchor) => {
    if (anchor) {
      viewEpoch++;
      draftAnchor.value = anchor;
      selected.value = undefined;
      editing.value = undefined;
      filter.value = "open";
    }
  },
  { immediate: true },
);
watch(
  [() => props.requestedThread, () => props.requestVisit, () => props.open],
  () => {
    viewEpoch++;
    handledRequest = "";
  },
);
watch(
  [
    () => props.requestedThread,
    () => props.requestVisit,
    () => props.open,
    busy,
    loading,
  ],
  () => {
    const key = props.requestedThread + ":" + (props.requestVisit || 0);
    if (
      !props.open ||
      !props.requestedThread ||
      busy.value ||
      loading.value ||
      handledRequest === key
    )
      return;
    handledRequest = key;
    void choose({ id: props.requestedThread });
  },
  { flush: "post" },
);
watch(reply, (value) => {
  if (selected.value) savedDraft.replies.set(selected.value.id, value);
});
function requestKey(scope: string, body: string) {
  if (keys.get(scope)?.body !== body)
    keys.set(scope, { body, key: crypto.randomUUID() });
  return keys.get(scope)!.key;
}
const author = (value: any) => value?.displayName || "Former member";
const date = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
function failed(e: any) {
  error.value = e.data?.message || e.message || "Comments could not be loaded.";
  if ([401, 403, 404].includes(e.statusCode || e.status)) {
    threads.value = [];
    messages.value = [];
    selected.value = undefined;
    rank.value = 0;
  }
}
function adopt(data: any, expectedGeneration: number) {
  if (
    !props.open ||
    generation !== expectedGeneration ||
    data.thread.pageId !== props.pageId
  )
    return false;
  selected.value = data.thread;
  rank.value = data.accessRank;
  messageBefore.value = data.nextBefore;
  messages.value = data.messages;
  const at = threads.value.findIndex((t) => t.id === data.thread.id);
  if (at >= 0) threads.value[at] = data.thread;
  return true;
}
function adoptMutation(data: any, token: number, epoch: number) {
  if (
    !props.open ||
    generation !== token ||
    data.thread.pageId !== props.pageId
  )
    return false;
  emit("changed", props.pageId);
  return epoch === viewEpoch && adopt(data, token);
}
async function loadList(append = false) {
  const token = generation,
    page = props.pageId,
    state = filter.value;
  const data = await $fetch<any>(`/api/v1/pages/${page}/threads`, {
    query: { state, before: append ? nextBefore.value : "" },
  });
  if (
    !props.open ||
    token !== generation ||
    page !== props.pageId ||
    filter.value !== state
  )
    return;
  threads.value = append
    ? [
        ...threads.value,
        ...data.threads.filter(
          (t: any) => !threads.value.some((old) => old.id === t.id),
        ),
      ]
    : data.threads;
  rank.value = data.accessRank;
  nextBefore.value = data.nextBefore;
  paged.value = append;
}
async function loadThread(id: string, older = false) {
  const token = generation,
    epoch = viewEpoch,
    prior = messages.value,
    data = await $fetch<any>("/api/v1/threads/" + id, {
      query: { before: older ? messageBefore.value : "" },
    });
  if (epoch !== viewEpoch || selected.value?.id !== id || !adopt(data, token))
    return;
  if (older)
    messages.value = [
      ...data.messages,
      ...prior.filter(
        (m) => !data.messages.some((old: any) => old.id === m.id),
      ),
    ];
  messagePaged.value = older;
}
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  const token = generation;
  busy.value = true;
  error.value = "";
  try {
    await action();
  } catch (e: any) {
    if (token === generation && props.open) failed(e);
  } finally {
    busy.value = false;
  }
}
async function choose(t: any) {
  if (busy.value || loading.value) return;
  viewEpoch++;
  editing.value = undefined;
  if (selected.value) savedDraft.replies.set(selected.value.id, reply.value);
  selected.value = t;
  reply.value = savedDraft.replies.get(t.id) || "";
  replyMentions.value = savedDraft.replyMentions!.get(t.id) || [];
  messages.value = [];
  await run(() => loadThread(t.id));
}
async function refresh() {
  await run(async () => {
    if (selected.value) await loadThread(selected.value.id);
    else await loadList();
  });
}
async function post(first: boolean) {
  const body = first ? draft.value : reply.value,
    token = generation,
    epoch = viewEpoch,
    anchor = draftAnchor.value,
    mentions = (first ? draftMentions.value : replyMentions.value).map(
      (person) => person.id,
    ),
    id = selected.value?.id,
    scope = first ? props.pageId + JSON.stringify(anchor) : id;
  if (!body.trim() || !canComment.value) return;
  await run(async () => {
    const path = first
        ? `pages/${props.pageId}/threads`
        : `threads/${id}/comments`,
      data = await $fetch<any>("/api/v1/" + path, {
        method: "POST",
        body: {
          body,
          requestId: requestKey(scope, JSON.stringify({ body, mentions })),
          mentions,
          ...(first ? { anchor } : {}),
        },
      });
    if (adoptMutation(data, token, epoch)) {
      keys.delete(scope);
      if (first) {
        draft.value = "";
        draftMentions.value = [];
        draftAnchor.value = null;
      } else {
        reply.value = "";
        replyMentions.value = [];
      }
      messagePaged.value = false;
      await loadList();
    }
  });
}
async function resolve() {
  if (!selected.value?.canResolve) return;
  const token = generation,
    epoch = viewEpoch,
    thread = selected.value;
  await run(async () => {
    const data = await $fetch<any>("/api/v1/threads/" + thread.id, {
      method: "PATCH",
      body: { version: thread.version, resolved: !thread.resolvedAt },
    });
    if (adoptMutation(data, token, epoch)) await loadList();
  });
}
async function saveEdit() {
  const token = generation,
    epoch = viewEpoch,
    message = editing.value;
  if (!message) return;
  await run(async () => {
    const data = await $fetch<any>("/api/v1/comments/" + message.id, {
      method: "PATCH",
      body: {
        version: message.version,
        body: editText.value,
        mentions: editMentions.value.map((person) => person.id),
      },
    });
    if (adoptMutation(data, token, epoch)) {
      editing.value = undefined;
      await loadList();
    }
  });
}
async function remove() {
  const token = generation,
    epoch = viewEpoch,
    message = deleting.value;
  if (!message) return;
  await run(async () => {
    const data = await $fetch<any>("/api/v1/comments/" + message.id, {
      method: "DELETE",
      body: { version: message.version },
    });
    if (adoptMutation(data, token, epoch)) {
      deleting.value = undefined;
      await loadList();
    }
  });
}
watch(
  [() => props.open, () => props.pageId],
  async () => {
    const token = ++generation;
    clearInterval(timer);
    threads.value = [];
    messages.value = [];
    selected.value = undefined;
    rank.value = 0;
    error.value = "";
    editing.value = undefined;
    deleting.value = undefined;
    paged.value = false;
    if (!props.open) return;
    loading.value = true;
    try {
      await loadList();
    } catch (e: any) {
      if (token === generation) failed(e);
    } finally {
      if (token === generation) loading.value = false;
    }
    if (token !== generation || !props.open) return;
    timer = setInterval(async () => {
      if (
        !props.open ||
        busy.value ||
        editing.value ||
        document.visibilityState !== "visible"
      )
        return;
      try {
        if (selected.value && !messagePaged.value)
          await loadThread(selected.value.id);
        else if (!selected.value && !paged.value) await loadList();
      } catch (e: any) {
        if (token === generation && props.open) failed(e);
      }
    }, 5000);
  },
  { immediate: true },
);
watch(filter, () => {
  if (props.open) {
    selected.value = undefined;
    void refresh();
  }
});
onBeforeUnmount(() => {
  generation++;
  clearInterval(timer);
});
</script>
<template>
  <UiDialog
    :open="open"
    title="Comments"
    drawer
    :modal="modal ?? true"
    :error="error"
    @close="emit('close')"
  >
    <div class="page-comments">
      <div class="comment-controls">
        <button
          v-if="selected"
          type="button"
          class="ghost"
          :disabled="busy"
          @click="
            viewEpoch++;
            selected = undefined;
            editing = undefined;
          "
        >
          <AppIcon name="back" :size="15" />All threads</button
        ><label v-else
          >Show threads<select v-model="filter" :disabled="busy">
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select></label
        ><button
          type="button"
          class="icon-button"
          aria-label="Refresh comments"
          :disabled="busy || loading"
          @click="refresh"
        >
          <AppIcon name="refresh" :size="16" />
        </button>
      </div>
      <p v-if="loading" role="status">Loading comments…</p>
      <template v-else-if="selected">
        <div class="comment-thread-heading">
          <span class="comment-state">{{
            selected.resolvedAt ? "Resolved" : "Open discussion"
          }}</span><button
            v-if="selected.canResolve"
            class="ghost"
            :disabled="busy"
            @click="resolve"
          >
            <AppIcon
              :name="selected.resolvedAt ? 'history' : 'check'"
              :size="15"
            />{{ selected.resolvedAt ? "Reopen thread" : "Resolve thread" }}
          </button>
        </div>
        <div v-if="selected.anchor" class="comment-reference">
          <span class="hint">Comment on selected text</span>
          <blockquote>{{ selected.anchor.quote }}</blockquote>
          <p v-if="anchorStatus === 'changed'" class="hint">
            This text has changed since the discussion started.
          </p>
          <p v-else-if="anchorStatus === 'missing'" class="hint">
            The original text is no longer in this document. The discussion is
            still available.
          </p>
          <button
            type="button"
            class="ghost"
            :disabled="anchorStatus === 'missing'"
            @click="emit('jump', selected)"
          >
            <AppIcon name="link" :size="14" />Show in document
          </button>
        </div>
        <button
          v-if="messageBefore"
          class="ghost"
          :disabled="busy"
          @click="run(() => loadThread(selected.id, true))"
        >
          Load earlier replies
        </button>
        <ol class="comment-messages">
          <li
            v-for="message in messages"
            :key="message.id"
            class="comment-message"
          >
            <div class="comment-author">
              <span class="comment-avatar">{{
                author(message.author).slice(0, 2).toUpperCase()
              }}</span>
              <div>
                <strong>{{ author(message.author) }}</strong><time
                  :datetime="message.createdAt"
                  >{{ date(message.createdAt)
                  }}<span v-if="message.editedAt"> · Edited</span></time
                >
              </div>
              <UiMenu
                v-if="message.canEdit || message.canDelete"
                label="Comment actions"
                ><button
                  v-if="message.canEdit"
                  role="menuitem"
                  @click="
                    editing = message;
                    editText = message.body;
                    editMentions = message.mentions.filter(
                      (person: CommentPerson) =>
                        person.displayName &&
                        message.body.includes('@' + person.displayName),
                    );
                  "
                >
                  Edit comment</button
                ><button
                  v-if="message.canDelete"
                  role="menuitem"
                  class="danger"
                  @click="deleting = message"
                >
                  Delete comment
                </button></UiMenu
              >
            </div>
            <form v-if="editing?.id === message.id" @submit.prevent="saveEdit">
              <label class="sr-only" for="edit-comment-text">Edit comment</label
              ><CommentComposer
                id="edit-comment-text"
                v-model="editText"
                v-model:mentions="editMentions"
                :page-id="pageId"
                rows="4"
                maxlength="10000"
                required
                :disabled="busy"
              />
              <div class="actions">
                <button class="primary" :disabled="busy || !editText.trim()">
                  Save comment</button
                ><button
                  type="button"
                  class="ghost"
                  :disabled="busy"
                  @click="editing = undefined"
                >
                  Cancel edit
                </button>
              </div>
            </form>
            <p
              v-else
              class="comment-body"
              :class="{ deleted: message.deleted }"
            >
              {{ message.deleted ? "Comment deleted" : message.body }}
            </p>
          </li>
        </ol>
        <form
          v-if="canComment && !selected.resolvedAt"
          class="comment-composer"
          @submit.prevent="post(false)"
        >
          <label for="reply-comment">Reply</label
          ><CommentComposer
            id="reply-comment"
            v-model="reply"
            v-model:mentions="replyMentions"
            :page-id="pageId"
            rows="4"
            maxlength="10000"
            placeholder="Add to the discussion…"
            required
            :disabled="busy"
          /><button class="primary" :disabled="busy || !reply.trim()">
            Send reply
          </button>
        </form>
        <p v-else-if="selected.resolvedAt" class="hint">
          This discussion is resolved.
        </p>
      </template>
      <template v-else
        ><div class="thread-list">
          <button
            v-for="thread in threads"
            :key="thread.id"
            type="button"
            class="thread-card"
            :disabled="busy"
            @click="choose(thread)"
          >
            <div>
              <strong>{{ author(thread.author) }}</strong><small>{{
                thread.resolvedAt ? "Resolved" : date(thread.createdAt)
              }}</small>
            </div>
            <p>
              {{ thread.deletedPreview ? "Comment deleted" : thread.preview }}
            </p>
            <span
              >{{ thread.replyCount }}
              {{ thread.replyCount === 1 ? "reply" : "replies" }}</span
            >
          </button>
        </div>
        <p v-if="!threads.length && !loading" class="comment-empty">
          No {{ filter === "all" ? "" : filter + " " }}discussions yet.
        </p>
        <button
          v-if="nextBefore"
          class="ghost"
          :disabled="busy"
          @click="run(() => loadList(true))"
        >
          Load more threads
        </button>
        <form
          v-if="canComment"
          class="comment-composer"
          @submit.prevent="post(true)"
        >
          <div v-if="draftAnchor" class="comment-reference draft-reference">
            <span class="hint">Comment on selected text</span>
            <blockquote>{{ draftAnchor.quote }}</blockquote>
            <button
              type="button"
              class="ghost"
              :disabled="busy"
              @click="draftAnchor = null"
            >
              Remove text reference
            </button>
          </div>
          <label for="new-comment">New comment</label
          ><CommentComposer
            id="new-comment"
            v-model="draft"
            v-model:mentions="draftMentions"
            :page-id="pageId"
            rows="4"
            maxlength="10000"
            placeholder="Start a discussion…"
            required
            :disabled="busy"
          /><button class="primary" :disabled="busy || !draft.trim()">
            Post comment
          </button>
        </form></template
      >
      <p v-if="rank > 0 && !canComment" class="hint">
        You can read discussions. Comment permission is required to reply.
      </p>
    </div>
  </UiDialog>
  <UiDialog
    :open="!!deleting"
    title="Delete comment?"
    @close="!busy && (deleting = undefined)"
    ><p>The comment text will be removed. Replies remain in the discussion.</p>
    <div class="actions">
      <button class="danger" :disabled="busy" @click="remove">
        Delete comment</button
      ><button class="ghost" :disabled="busy" @click="deleting = undefined">
        Cancel
      </button>
    </div></UiDialog
  >
</template>
<style scoped>
.comment-reference {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  margin: 12px 0;
}
.comment-reference blockquote {
  border-left: 2px solid var(--accent);
  padding-left: 10px;
  margin: 10px 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 150px;
  overflow: auto;
  font-size: 0.84rem;
}
.comment-reference .hint {
  font-size: 0.75rem;
}
.comment-reference button {
  font-size: 0.76rem;
}

.comment-controls,
.comment-thread-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}
.comment-controls label {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 0.8rem;
  color: var(--muted);
}
.comment-controls select {
  width: auto;
  padding: 5px 10px;
}
.comment-thread-heading {
  font-size: 0.8rem;
  color: var(--muted);
}
.comment-thread-heading button {
  font-size: 0.8rem;
}
.comment-messages {
  list-style: none;
  padding: 0;
  margin: 0;
}
.comment-message {
  padding: 18px 0;
  border-bottom: 1px solid var(--line-soft);
}
.comment-author {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
}
.comment-author > div:not(.menu-anchor) {
  flex: 1;
  min-width: 0;
}
.comment-author strong {
  display: block;
  font-size: 0.78rem;
  font-weight: 550;
  overflow-wrap: anywhere;
}
.comment-author time {
  display: block;
  font-size: 0.68rem;
  color: var(--muted);
  margin-top: 4px;
}
.comment-avatar {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  flex: none;
  background: var(--accent-soft);
  border-radius: 7px;
  color: var(--accent);
  font-size: 0.65rem;
}
.comment-body {
  color: var(--text);
  font-size: 0.86rem;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 12px 0 0 38px;
}
.comment-body.deleted {
  color: var(--muted);
  font-style: italic;
}
.comment-composer {
  margin-top: 24px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}
.page-comments textarea {
  width: 100%;
  resize: vertical;
  min-height: 100px;
  font: inherit;
  font-size: 0.85rem;
  line-height: 1.6;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 10px;
  background: var(--surface);
  color: var(--text);
}
.comment-composer button {
  margin-top: 10px;
}
.thread-list {
  display: grid;
  gap: 10px;
}
.thread-card {
  display: block;
  width: 100%;
  padding: 14px;
  text-align: left;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.thread-card > div {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}
.thread-card strong {
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}
.thread-card small,
.thread-card > span {
  font-size: 0.68rem;
  color: var(--muted);
}
.thread-card p {
  color: var(--text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.84rem;
  font-weight: normal;
  line-height: 1.6;
  margin: 8px 0;
}
.comment-empty {
  text-align: center;
  color: var(--muted);
  font-size: 0.85rem;
  padding: 24px 0;
}
</style>

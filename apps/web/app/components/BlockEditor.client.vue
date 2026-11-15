<script setup lang="ts">
import { Editor, EditorContent, VueNodeViewRenderer } from "@tiptap/vue-3";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { HocuspocusProvider } from "@hocuspocus/provider";
import EmbeddedDatabaseNode from "./EmbeddedDatabaseNode.vue";
import { editorExtensions } from "@orvyn/editor";
import * as Y from "yjs";
const props = defineProps<{ pageId: string; spaceId: string; user: any }>();
const document = new Y.Doc(),
  editor = shallowRef<Editor>(),
  status = ref("connecting"),
  synced = ref(false),
  readOnly = ref(true),
  unsynced = ref(0),
  denied = ref(false),
  peers = ref<any[]>([]),
  tick = ref(0);
const slash = ref(""),
  slashOpen = ref(false),
  slashIndex = ref(0);
let slashRange = { from: 0, to: 0 };
const config = useRuntimeConfig(),
  url = String(
    config.public.collaborationUrl ||
      new URL("/collaboration", window.location.href)
        .toString()
        .replace(/^http/, "ws"),
  );
const saveStatus = computed(() =>
  denied.value
    ? "Access denied"
    : status.value !== "connected"
      ? "Disconnected · Editing paused"
      : !synced.value
        ? "Synchronizing…"
        : readOnly.value
          ? "Read-only"
          : unsynced.value
            ? "Saving changes…"
            : "All changes saved",
);
interface SlashCommand {
  label: string;
  run: (editor: Editor) => unknown;
  keepSelection?: boolean;
}
const commands: SlashCommand[] = [
  {
    label: "Paragraph",
    run: (e: Editor) => e.chain().focus().setParagraph().run(),
  },
  {
    label: "Heading 1",
    run: (e: Editor) => e.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    label: "Heading 2",
    run: (e: Editor) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    label: "Heading 3",
    run: (e: Editor) => e.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    label: "Bullet list",
    run: (e: Editor) => e.chain().focus().toggleBulletList().run(),
  },
  {
    label: "Numbered list",
    run: (e: Editor) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    label: "Checklist",
    run: (e: Editor) => e.chain().focus().toggleTaskList().run(),
  },
  {
    label: "Quote",
    run: (e: Editor) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    label: "Code block",
    run: (e: Editor) => e.chain().focus().toggleCodeBlock().run(),
  },
  {
    label: "Divider",
    run: (e: Editor) => e.chain().focus().setHorizontalRule().run(),
  },
  {
    label: "Linked database",
    keepSelection: true,
    run: () => {
      void openLinkPicker();
    },
  },
  {
    label: "Table",
    run: (e: Editor) =>
      e
        .chain()
        .focus()
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
];
const filtered = computed(() =>
  commands.filter((c) =>
    c.label.toLowerCase().includes(slash.value.toLowerCase()),
  ),
);
function applyCommand(index: number) {
  const command = filtered.value[index];
  if (!editor.value || !command) return;
  slashOpen.value = false;
  if (command.keepSelection) editor.value.commands.setTextSelection(slashRange);
  else editor.value.chain().focus().deleteRange(slashRange).run();
  command.run(editor.value);
}
function initialize() {
  if (editor.value) return;
  editor.value = new Editor({
    extensions: [
      ...editorExtensions(true).map((extension) =>
        extension.name === "orvynDatabase"
          ? extension.extend({
              addNodeView() {
                return VueNodeViewRenderer(EmbeddedDatabaseNode);
              },
            })
          : extension,
      ),
      Collaboration.configure({ document }),
      CollaborationCaret.configure({
        provider,
        user: {
          id: props.user.id,
          name: props.user.email,
          color:
            getComputedStyle(window.document.documentElement)
              .getPropertyValue("--accent")
              .trim() || "#b69bff",
        },
      }),
    ],
    editable: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "Document",
        "aria-multiline": "true",
      },
      handleKeyDown: (_view, event) => {
        if (!slashOpen.value) return false;
        if (event.key === "Escape") {
          slashOpen.value = false;
          return true;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          slashIndex.value =
            (slashIndex.value +
              (event.key === "ArrowDown" ? 1 : -1) +
              Math.max(filtered.value.length, 1)) %
            Math.max(filtered.value.length, 1);
          return true;
        }
        if (event.key === "Enter") {
          applyCommand(slashIndex.value);
          return true;
        }
        return false;
      },
    },
    onTransaction() {
      tick.value++;
    },
    onUpdate({ editor: e }) {
      const { selection } = e.state,
        paragraph = selection.$from.parent,
        text = paragraph.textContent;
      if (
        paragraph.type.name === "paragraph" &&
        /^\/[a-z0-9 ]*$/i.test(text) &&
        selection.$from.parentOffset === text.length
      ) {
        slash.value = text.slice(1);
        slashRange = { from: selection.$from.start(), to: selection.from };
        slashIndex.value = 0;
        slashOpen.value = true;
      } else slashOpen.value = false;
    },
  });
}
const linkDialog = ref<HTMLDialogElement>(),
  linkSpaces = ref<any[]>([]),
  linkDatabases = ref<any[]>([]),
  linkMetadata = ref<any>(),
  linkSpace = ref(props.spaceId),
  linkDatabase = ref(""),
  linkView = ref(""),
  linkSeparate = ref(false),
  linkName = ref(""),
  inlineName = ref(""),
  linkError = ref(""),
  linkBusy = ref(false);
async function loadLinkMetadata() {
  linkMetadata.value = undefined;
  linkView.value = "";
  if (!linkDatabase.value) return;
  const id = linkDatabase.value;
  try {
    const data = await $fetch<any>("/api/v1/databases/" + id);
    if (linkDatabase.value === id) {
      linkMetadata.value = data;
      linkView.value = data.views[0]?.id || "";
    }
  } catch {
    linkError.value = "This database is unavailable";
  }
}
async function loadLinkDatabases() {
  linkDatabase.value = "";
  linkDatabases.value = [];
  linkMetadata.value = undefined;
  const space = linkSpace.value;
  try {
    const data = await $fetch<any[]>("/api/v1/spaces/" + space + "/databases");
    if (linkSpace.value === space) {
      linkDatabases.value = data;
      linkDatabase.value = data[0]?.id || "";
      await loadLinkMetadata();
    }
  } catch {
    linkError.value = "Databases could not be loaded";
  }
}
async function openLinkPicker() {
  if (!editor.value?.isEditable) return;
  slashOpen.value = false;
  linkError.value = "";
  linkSeparate.value = false;
  linkName.value = "";
  inlineName.value = "";
  linkSpace.value = props.spaceId;
  linkDialog.value?.showModal();
  linkBusy.value = true;
  try {
    linkSpaces.value = await $fetch<any[]>("/api/v1/spaces");
    await loadLinkDatabases();
  } catch {
    linkError.value = "Sources could not be loaded";
  } finally {
    linkBusy.value = false;
  }
}
function insertDatabase(databaseId: string, viewId: string | null) {
  if (!editor.value?.isEditable) {
    linkError.value = "Editing is paused";
    return;
  }
  linkDialog.value?.close();
  editor.value
    .chain()
    .focus()
    .insertContent({ type: "orvynDatabase", attrs: { databaseId, viewId } })
    .run();
}
async function insertLinkedDatabase() {
  if (linkBusy.value || !linkDatabase.value || !linkView.value) return;
  linkBusy.value = true;
  linkError.value = "";
  try {
    let viewId = linkView.value;
    if (linkSeparate.value) {
      const selected = linkMetadata.value.views.find(
        (v: any) => v.id === viewId,
      );
      const view = await $fetch<any>(
        "/api/v1/databases/" + linkDatabase.value + "/views",
        {
          method: "POST",
          body: {
            name: linkName.value,
            type: selected.type,
            config: selected.config,
          },
        },
      );
      viewId = view.id;
    }
    insertDatabase(linkDatabase.value, viewId);
  } catch (e: any) {
    linkError.value = e.data?.message || "Database could not be linked";
  } finally {
    linkBusy.value = false;
  }
}
async function createInlineDatabase() {
  if (linkBusy.value) return;
  linkBusy.value = true;
  linkError.value = "";
  try {
    const data = await $fetch<any>(
      "/api/v1/spaces/" + props.spaceId + "/databases",
      {
        method: "POST",
        body: { name: inlineName.value, parentId: props.pageId },
      },
    );
    insertDatabase(data.id, data.views[0]?.id || null);
  } catch (e: any) {
    linkError.value = e.data?.message || "Database could not be created";
  } finally {
    linkBusy.value = false;
  }
}
const provider = new HocuspocusProvider({
  url,
  name: props.pageId,
  document,
  token: "cookie",
  onAuthenticated({ scope }) {
    readOnly.value = scope === "readonly";
    denied.value = false;
  },
  onAuthenticationFailed() {
    denied.value = true;
    readOnly.value = true;
    provider.disconnect();
  },
  onStatus({ status: s }) {
    status.value = s;
  },
  onSynced({ state }) {
    if (state) initialize();
    synced.value = state;
  },
  onUnsyncedChanges({ number }) {
    unsynced.value = number;
  },
  onStateless({ payload }) {
    try {
      const message = JSON.parse(payload);
      if (message.type === "permissions") readOnly.value = message.readOnly;
    } catch {}
  },
  onAwarenessChange({ states }) {
    peers.value = [
      ...new Map(
        states.filter((s) => s.user?.id).map((s) => [s.user.id, s.user]),
      ).values(),
    ];
  },
  onClose({ event }) {
    if (
      event.code === 4403 ||
      ["Access changed", "Document access denied"].includes(event.reason)
    ) {
      denied.value = true;
      readOnly.value = true;
      provider.disconnect();
    }
  },
});
watch([status, synced, readOnly, editor, denied], () =>
  editor.value?.setEditable(
    status.value === "connected" &&
      synced.value &&
      !readOnly.value &&
      !denied.value,
  ),
);
onBeforeUnmount(() => {
  editor.value?.destroy();
  provider.destroy();
  document.destroy();
});
</script>
<template>
  <div class="block-editor" :data-revision="tick">
    <div class="editor-status">
      <span role="status">{{ saveStatus }}</span><span
        >{{ peers.length }} present</span
      >
    </div>
    <p v-if="peers.length" class="presence">
      {{ peers.map((p) => p.name).join(" · ") }}
    </p>
    <dialog
      ref="linkDialog"
      aria-labelledby="link-database-title"
      class="link-database-dialog"
    >
      <h2 id="link-database-title">Link a database</h2>
      <p v-if="linkError" class="error" role="alert">{{ linkError }}</p>
      <p v-if="linkBusy" role="status">Loading or saving…</p>
      <form @submit.prevent="insertLinkedDatabase">
        <label for="linked-space">Source space</label
        ><select
          id="linked-space"
          v-model="linkSpace"
          :disabled="linkBusy"
          @change="loadLinkDatabases"
        >
          <option v-for="space in linkSpaces" :key="space.id" :value="space.id">
            {{ space.name }}
          </option></select
        ><label for="linked-database">Source database</label
        ><select
          id="linked-database"
          v-model="linkDatabase"
          :disabled="linkBusy"
          required
          @change="loadLinkMetadata"
        >
          <option
            v-for="database in linkDatabases"
            :key="database.id"
            :value="database.id"
          >
            {{ database.title }}
          </option>
        </select>
        <p v-if="!linkDatabases.length && !linkBusy">
          No accessible databases in this space.
        </p>
        <label for="linked-view">View</label
        ><select
          id="linked-view"
          v-model="linkView"
          :disabled="linkBusy"
          required
        >
          <option
            v-for="view in linkMetadata?.views || []"
            :key="view.id"
            :value="view.id"
          >
            {{ view.name }}
          </option></select
        ><label v-if="linkMetadata?.accessRank >= 30"
          ><input
            v-model="linkSeparate"
            type="checkbox"
            style="width: auto"
          />Create a separate view with independent filters</label
        ><template v-if="linkSeparate"
          ><label for="linked-view-name">New view name</label
          ><input
            id="linked-view-name"
            v-model="linkName"
            required
            maxlength="80" /></template
        ><button :disabled="linkBusy || !linkView">Insert linked view</button>
      </form>
      <hr />
      <form @submit.prevent="createInlineDatabase">
        <h3>Or create a database in this page</h3>
        <label for="inline-database-name">Inline database name</label
        ><input
          id="inline-database-name"
          v-model="inlineName"
          required
          maxlength="120"
        /><button :disabled="linkBusy">Create and insert database</button>
      </form>
      <button type="button" @click="linkDialog?.close()">Cancel</button>
    </dialog>
    <template v-if="editor"
      ><div class="editor-toolbar" aria-label="Text formatting">
        <button :disabled="!editor.isEditable" @click="openLinkPicker">
          Link database
        </button>
        <button
          :disabled="!editor.isEditable"
          :aria-pressed="editor.isActive('bold')"
          @click="editor.chain().focus().toggleBold().run()"
        >
          Bold</button
        ><button
          :disabled="!editor.isEditable"
          :aria-pressed="editor.isActive('italic')"
          @click="editor.chain().focus().toggleItalic().run()"
        >
          Italic</button
        ><button
          :disabled="!editor.isEditable"
          @click="editor.chain().focus().toggleHeading({ level: 2 }).run()"
        >
          Heading</button
        ><button
          :disabled="!editor.isEditable"
          @click="editor.chain().focus().toggleBulletList().run()"
        >
          List</button
        ><button
          :disabled="!editor.isEditable"
          @click="editor.chain().focus().toggleTaskList().run()"
        >
          Checklist</button
        ><button
          :disabled="!editor.isEditable"
          @click="editor.chain().focus().toggleCodeBlock().run()"
        >
          Code</button
        ><button
          :disabled="!editor.isEditable"
          @click="editor.chain().focus().undo().run()"
        >
          Undo</button
        ><button
          :disabled="!editor.isEditable"
          @click="editor.chain().focus().redo().run()"
        >
          Redo
        </button>
      </div>
      <div
        v-if="slashOpen"
        class="slash-menu"
        role="listbox"
        aria-label="Insert block"
      >
        <button
          v-for="(command, index) in filtered"
          :key="command.label"
          role="option"
          :aria-selected="index === slashIndex"
          @mousedown.prevent
          @click="applyCommand(index)"
        >
          {{ command.label }}
        </button>
        <p v-if="!filtered.length">No matching block</p>
      </div>
      <EditorContent :editor="editor" />
      <p class="hint">
        Type / for blocks · Markdown shortcuts supported · Changes save
        automatically
      </p></template
    >
    <p v-else>
      {{
        denied ? "This document is unavailable." : "Connecting to the document…"
      }}
    </p>
  </div>
</template>
<style>
.block-editor {
  border: 1px solid var(--line);
  border-radius: 0.6rem;
  margin: 1rem 0;
  padding: 1rem;
}
.editor-status {
  display: flex;
  justify-content: space-between;
  color: var(--muted);
  font-size: 0.85rem;
}
.presence {
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}
.editor-toolbar {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin: 1rem 0;
}
.editor-toolbar button {
  padding: 0.4rem 0.6rem;
}
.block-editor .tiptap {
  min-height: 300px;
  line-height: 1.75;
  padding: 1rem;
  outline: none;
}
.block-editor .tiptap:focus-visible {
  outline: 1px solid var(--accent);
  border-radius: 0.4rem;
}
.block-editor .tiptap h1 {
  font-size: 2rem;
  letter-spacing: -0.02em;
}
.block-editor .tiptap h2 {
  font-size: 1.5rem;
  color: var(--text);
}
.block-editor .tiptap h3 {
  font-size: 1.2rem;
}
.block-editor .tiptap blockquote {
  border-left: 3px solid var(--accent);
  margin: 1rem 0;
  padding-left: 1rem;
}
.block-editor .tiptap pre {
  background: var(--panel);
  padding: 1rem;
  overflow: auto;
  border-radius: 0.4rem;
}
.block-editor .tiptap table {
  width: 100%;
  border-collapse: collapse;
}
.block-editor .tiptap td,
.block-editor .tiptap th {
  border: 1px solid var(--line);
  padding: 0.5rem;
  min-width: 3rem;
}
.block-editor .tiptap ul[data-type="taskList"] {
  list-style: none;
  padding: 0;
}
.block-editor .tiptap li[data-type="taskItem"] {
  display: flex;
  gap: 0.6rem;
}
.block-editor .tiptap li[data-type="taskItem"] > label {
  display: flex;
  align-items: center;
}
.block-editor .tiptap li[data-type="taskItem"] > div {
  flex: 1;
}
.block-editor .tiptap input[type="checkbox"] {
  width: auto;
}
.block-editor .collaboration-carets__caret {
  border-left: 1px solid;
  border-right: 1px solid;
  margin-left: -1px;
  margin-right: -1px;
  pointer-events: none;
  position: relative;
  word-break: normal;
}
.block-editor .collaboration-carets__label {
  border-radius: 3px 3px 3px 0;
  color: var(--bg);
  font-size: 0.75rem;
  font-weight: 600;
  left: -1px;
  line-height: normal;
  padding: 0.15rem 0.35rem;
  position: absolute;
  top: -1.4em;
  user-select: none;
  white-space: nowrap;
}
.slash-menu {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--accent);
  border-radius: 0.5rem;
  padding: 0.5rem;
}
.slash-menu button {
  text-align: left;
}
.slash-menu button[aria-selected="true"] {
  border-color: var(--accent);
}
button:disabled {
  cursor: default;
  opacity: 0.5;
}
.link-database-dialog {
  max-width: 640px;
  width: calc(100% - 2rem);
  max-height: 90vh;
  overflow: auto;
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 0.7rem;
  padding: 2rem;
}
.link-database-dialog::backdrop {
  background: color-mix(in srgb, var(--bg) 70%, transparent);
}
.link-database-dialog form {
  margin: 1rem 0;
}
</style>

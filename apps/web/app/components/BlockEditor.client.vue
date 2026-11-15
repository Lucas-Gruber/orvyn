<script setup lang="ts">
import { Editor, EditorContent } from "@tiptap/vue-3";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { editorExtensions } from "@orvyn/editor";
import * as Y from "yjs";
const props = defineProps<{ pageId: string; user: any }>();
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
const commands = [
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
  editor.value.chain().focus().deleteRange(slashRange).run();
  command.run(editor.value);
}
function initialize() {
  if (editor.value) return;
  editor.value = new Editor({
    extensions: [
      ...editorExtensions(true),
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
    <template v-if="editor"
      ><div class="editor-toolbar" aria-label="Text formatting">
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
</style>

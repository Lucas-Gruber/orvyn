<script setup lang="ts">
import { Editor, EditorContent, VueNodeViewRenderer } from "@tiptap/vue-3";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { HocuspocusProvider } from "@hocuspocus/provider";
import EmbeddedDatabaseNode from "./EmbeddedDatabaseNode.vue";
import CalloutNode from "./CalloutNode.vue";
import ToggleNode from "./ToggleNode.vue";
import TableOfContentsNode from "./TableOfContentsNode.vue";
import CodeBlockNode from "./CodeBlockNode.vue";
import AssetNode from "./AssetNode.vue";
import PagePreviewNode from "./PagePreviewNode.vue";
import VideoEmbedNode from "./VideoEmbedNode.vue";
import { editorPageKey } from "../composables/editorContext";
import {
  editorExtensions,
  documentHeadings,
  yDocToDocument,
  pageLink,
  headingFromHash,
  validHeadingId,
} from "@orvyn/editor";
import { pageNavigationKey } from "../composables/pageNavigation";
import * as Y from "yjs";
const props = defineProps<{
  pageId: string;
  spaceId: string;
  user: any;
  paused?: boolean;
  targetHeading?: string;
  headingVisit?: number;
}>();
provide(editorPageKey, () => props.pageId);
const openPage = inject(pageNavigationKey),
  root = ref<HTMLElement>(),
  showDocumentLink = ref(false),
  linkAsPreview = ref(false),
  showAsset = ref(false),
  showVideo = ref(false),
  assetImage = ref(true),
  selectedLinkText = ref(""),
  linkMessage = ref(""),
  headingMessage = ref("");
let insertionRange = { from: 0, to: 0 };
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
  slashIndex = ref(0),
  slashStyle = ref<Record<string, string>>({});
let pickerSelectionActive = false;
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
  aliases?: string[];
}
const commands: SlashCommand[] = [
  {
    label: "Embed",
    aliases: ["video", "einbetten"],
    keepSelection: true,
    run: () => void openVideo(),
  },
  {
    label: "Image",
    aliases: ["bild", "photo"],
    keepSelection: true,
    run: () => void openAsset(true),
  },
  {
    label: "File",
    aliases: ["datei", "attachment"],
    keepSelection: true,
    run: () => void openAsset(false),
  },
  {
    label: "Callout",
    aliases: ["note", "hinweis"],
    run: (e) =>
      e
        .chain()
        .focus()
        .insertContent({
          type: "orvynCallout",
          attrs: { tone: "info" },
          content: [{ type: "paragraph" }],
        })
        .run(),
  },
  {
    label: "Toggle",
    aliases: ["collapse", "aufklappen"],
    run: (e: Editor) => e.chain().focus().insertToggle().run(),
  },
  {
    label: "Table of contents",
    aliases: ["toc", "outline", "inhaltsverzeichnis"],
    run: (e) =>
      e
        .chain()
        .focus()
        .insertContent([{ type: "orvynToc" }, { type: "paragraph" }])
        .run(),
  },
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
    label: "Link to document",
    aliases: ["link", "page", "document", "seite", "dokument", "verlinken"],
    keepSelection: true,
    run: () => {
      void openDocumentLink(true);
    },
  },
  {
    label: "Page preview",
    aliases: ["vorschau", "page card"],
    keepSelection: true,
    run: () => {
      void openDocumentLink(true, true);
    },
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
    [c.label, ...(c.aliases || [])].some((label) =>
      label.toLowerCase().includes(slash.value.toLowerCase()),
    ),
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
  persistInitialHeadingIds();
  editor.value = new Editor({
    extensions: [
      ...editorExtensions(true).map((extension) =>
        [
          "orvynCallout",
          "orvynToggle",
          "orvynToc",
          "codeBlock",
          "orvynImage",
          "orvynFile",
          "orvynPagePreview",
          "orvynVideo",
        ].includes(extension.name)
          ? extension.extend({
              addNodeView() {
                return VueNodeViewRenderer(
                  (
                    {
                      orvynCallout: CalloutNode,
                      orvynToggle: ToggleNode,
                      orvynToc: TableOfContentsNode,
                      codeBlock: CodeBlockNode,
                      orvynImage: AssetNode,
                      orvynFile: AssetNode,
                      orvynPagePreview: PagePreviewNode,
                      orvynVideo: VideoEmbedNode,
                    } as Record<string, any>
                  )[extension.name],
                );
              },
            })
          : extension.name === "headingIdentity"
            ? extension.configure({
                onCopy: copyHeadingLink,
                activeHeading: () => props.targetHeading || "",
              })
            : extension.name === "orvynDatabase"
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
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "k" &&
          editor.value?.isEditable
        ) {
          event.preventDefault();
          event.stopPropagation();
          void openDocumentLink();
          return true;
        }
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
          void nextTick(() =>
            root.value
              ?.querySelector<HTMLElement>('.slash-menu [aria-selected="true"]')
              ?.scrollIntoView({ block: "nearest" }),
          );
          return true;
        }
        if (event.key === "Enter") {
          applyCommand(slashIndex.value);
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        click: (_view, event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return false;
          const anchor = (event.target as HTMLElement).closest("a[href]");
          if (!anchor) return false;
          const href = new URL(
              anchor.getAttribute("href")!,
              window.location.href,
            ),
            id = href.searchParams.get("page");
          if (
            href.origin !== window.location.origin ||
            href.pathname !== "/" ||
            !id ||
            !/^[a-f0-9-]{36}$/.test(id)
          )
            return false;
          event.preventDefault();
          openPage?.(id, headingFromHash(href.hash));
          return true;
        },
      },
    },
    onTransaction({ transaction }) {
      tick.value++;
      if (pickerSelectionActive && transaction.docChanged) {
        insertionRange = {
          from: transaction.mapping.map(insertionRange.from, 1),
          to: transaction.mapping.map(insertionRange.to, -1),
        };
        if (insertionRange.to < insertionRange.from)
          insertionRange.to = insertionRange.from;
      }
    },
    onUpdate: ({ editor: e }) => updateSlash(e),
    onSelectionUpdate: ({ editor: e }) => updateSlash(e),
  });
}
function updateSlash(e: Pick<Editor, "state" | "isEditable">) {
  const { selection } = e.state,
    paragraph = selection.$from.parent,
    text = paragraph.textContent;
  if (
    !e.isEditable ||
    pickerSelectionActive ||
    paragraph.type.name !== "paragraph" ||
    !/^\/[\p{L}\p{N} -]*$/u.test(text) ||
    selection.$from.parentOffset !== text.length
  ) {
    slashOpen.value = false;
    return;
  }
  if (slash.value !== text.slice(1)) slashIndex.value = 0;
  slash.value = text.slice(1);
  slashRange = { from: selection.$from.start(), to: selection.from };
  slashOpen.value = true;
  void nextTick(positionSlash);
}
function positionSlash() {
  if (!slashOpen.value || !editor.value) return;
  const rect = editor.value.view.coordsAtPos(editor.value.state.selection.from),
    below = window.innerHeight - rect.bottom - 12,
    above = below < 220 && rect.top > 220,
    width = Math.min(280, window.innerWidth - 24);
  slashStyle.value = {
    position: "fixed",
    width: width + "px",
    left:
      Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + "px",
    top: above ? "auto" : rect.bottom + 6 + "px",
    bottom: above ? window.innerHeight - rect.top + 6 + "px" : "auto",
    maxHeight:
      Math.min(350, Math.max(120, above ? rect.top - 18 : below)) + "px",
  };
}
function persistInitialHeadingIds() {
  if (readOnly.value || !synced.value) return;
  const targets = documentHeadings(yDocToDocument(document));
  let index = 0;
  function walk(nodes: (Y.XmlElement | Y.XmlText)[]) {
    for (const node of nodes) {
      if (!(node instanceof Y.XmlElement)) continue;
      if (node.nodeName === "heading") {
        const target = targets[index++];
        if (target && !validHeadingId(node.getAttribute("id")))
          node.setAttribute("id", target.id);
      }
      walk(node.toArray() as (Y.XmlElement | Y.XmlText)[]);
    }
  }
  document.transact(
    () =>
      walk(
        document.getXmlFragment("default").toArray() as (
          Y.XmlElement | Y.XmlText
        )[],
      ),
    "heading-identity",
  );
}
async function openDocumentLink(fromSlash = false, asPreview = false) {
  linkAsPreview.value = asPreview;
  if (!editor.value?.isEditable) return;
  // Native selectionchange can arrive after a fast shortcut; use the actual
  // selection in this editor instead of replacing a stale/collapsed range.
  const selected = window.getSelection(),
    view = editor.value.view;
  if (
    !fromSlash &&
    selected?.anchorNode &&
    selected.focusNode &&
    view.dom.contains(selected.anchorNode) &&
    view.dom.contains(selected.focusNode)
  ) {
    const anchor = view.posAtDOM(selected.anchorNode, selected.anchorOffset),
      focus = view.posAtDOM(selected.focusNode, selected.focusOffset);
    editor.value.commands.setTextSelection({
      from: Math.min(anchor, focus),
      to: Math.max(anchor, focus),
    });
  }
  insertionRange = fromSlash
    ? { ...slashRange }
    : {
        from: editor.value.state.selection.from,
        to: editor.value.state.selection.to,
      };
  selectedLinkText.value = fromSlash
    ? ""
    : editor.value.state.doc.textBetween(
        insertionRange.from,
        insertionRange.to,
        " ",
      );
  slashOpen.value = false;
  pickerSelectionActive = true;
  try {
    await flush();
    showDocumentLink.value = true;
  } catch {
    pickerSelectionActive = false;
    linkMessage.value = "Save pending changes before adding a link.";
  }
}
function insertDocumentLink(target: {
  pageId: string;
  headingId: string;
  label: string;
}) {
  if (!editor.value?.isEditable) return;
  pickerSelectionActive = false;
  if (linkAsPreview.value) {
    editor.value
      .chain()
      .focus()
      .insertContentAt(insertionRange, [
        {
          type: "orvynPagePreview",
          attrs: { pageId: target.pageId, headingId: target.headingId || null },
        },
        { type: "paragraph" },
      ])
      .run();
    showDocumentLink.value = false;
    return;
  }

  if (
    insertionRange.from < insertionRange.to &&
    selectedLinkText.value &&
    target.label.trim() === selectedLinkText.value.trim()
  ) {
    editor.value
      .chain()
      .focus()
      .setTextSelection(insertionRange)
      .setLink({
        href: pageLink(target.pageId, target.headingId),
        target: "_self",
        rel: null,
      })
      .run();
    showDocumentLink.value = false;
    return;
  }
  editor.value
    .chain()
    .focus()
    .insertContentAt(insertionRange, {
      type: "text",
      text: target.label,
      marks: [
        {
          type: "link",
          attrs: {
            href: pageLink(target.pageId, target.headingId),
            target: "_self",
            rel: null,
          },
        },
      ],
    })
    .run();
  showDocumentLink.value = false;
}
function closeDocumentLink() {
  showDocumentLink.value = false;
  pickerSelectionActive = false;
  editor.value?.commands.focus();
}
async function openAsset(image: boolean) {
  if (!editor.value?.isEditable) return;
  insertionRange = { ...slashRange };
  pickerSelectionActive = true;
  slashOpen.value = false;
  try {
    await flush();
    assetImage.value = image;
    showAsset.value = true;
  } catch {
    pickerSelectionActive = false;
    linkMessage.value = "Save pending changes before inserting an attachment.";
  }
}
function insertAsset(file: { fileId: string; label: string }) {
  if (!editor.value?.isEditable) return;
  pickerSelectionActive = false;
  editor.value
    .chain()
    .focus()
    .insertContentAt(insertionRange, [
      { type: assetImage.value ? "orvynImage" : "orvynFile", attrs: file },
      { type: "paragraph" },
    ])
    .run();
  showAsset.value = false;
}
function closeAsset() {
  showAsset.value = false;
  pickerSelectionActive = false;
  editor.value?.commands.focus();
}
async function openVideo() {
  if (!editor.value?.isEditable) return;
  insertionRange = { ...slashRange };
  pickerSelectionActive = true;
  slashOpen.value = false;
  try {
    await flush();
    showVideo.value = true;
  } catch {
    pickerSelectionActive = false;
    linkMessage.value = "Save pending changes before inserting a video.";
  }
}
function insertVideo(value: {
  provider: string;
  resourceId: string;
  title: string;
}) {
  if (!editor.value?.isEditable) return;
  pickerSelectionActive = false;
  editor.value
    .chain()
    .focus()
    .insertContentAt(insertionRange, [
      { type: "orvynVideo", attrs: value },
      { type: "paragraph" },
    ])
    .run();
  showVideo.value = false;
}
function closeVideo() {
  showVideo.value = false;
  pickerSelectionActive = false;
  editor.value?.commands.focus();
}
async function copyHeadingLink(id: string) {
  try {
    if (!readOnly.value) await flush();
    await navigator.clipboard.writeText(
      new URL(pageLink(props.pageId, id), window.location.href).toString(),
    );
    linkMessage.value = "Heading link copied.";
  } catch {
    linkMessage.value =
      "Link could not be copied. Try again after changes are saved.";
  }
}
async function revealHeading() {
  headingMessage.value = "";
  if (editor.value) editor.value.view.updateState(editor.value.state);
  if (!props.targetHeading || !editor.value || !synced.value) return;
  await nextTick();
  const heading = root.value?.querySelector<HTMLElement>(
    '[id="h-' + props.targetHeading + '"]',
  );
  if (!heading) {
    headingMessage.value =
      "This heading is no longer in this document. You can still read the document.";
    return;
  }
  heading.scrollIntoView({
    block: "start",
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
  });
  heading.focus({ preventScroll: true });
}
watch(
  [() => props.targetHeading, () => props.headingVisit, editor, synced],
  () => void revealHeading(),
  {
    flush: "post",
  },
);
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
    synced.value = state;
    if (state) initialize();
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
async function flush() {
  if (!unsynced.value) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop();
      reject(
        new Error(
          "Document changes are still waiting to save. Reconnect before leaving this page.",
        ),
      );
    }, 8000);
    const stop = watch(unsynced, (count) => {
      if (count) return;
      clearTimeout(timeout);
      stop();
      resolve();
    });
  });
}
defineExpose({ flush });
function beforeUnload(event: BeforeUnloadEvent) {
  if (!unsynced.value) return;
  event.preventDefault();
  event.returnValue = "";
}
onMounted(() => window.addEventListener("beforeunload", beforeUnload));
onMounted(() => {
  window.addEventListener("scroll", positionSlash, true);
  window.addEventListener("resize", positionSlash);
});
watch([status, synced, readOnly, editor, denied, () => props.paused], () => {
  persistInitialHeadingIds();
  editor.value?.setEditable(
    status.value === "connected" &&
      synced.value &&
      !readOnly.value &&
      !denied.value &&
      !props.paused,
  );
});
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener("scroll", positionSlash, true);
  window.removeEventListener("resize", positionSlash);
  editor.value?.destroy();
  provider.destroy();
  document.destroy();
});
</script>
<template>
  <div ref="root" class="block-editor" :data-revision="tick">
    <div v-if="linkMessage" class="editor-link-toast" role="status">
      <span>{{ linkMessage }}</span><button
        class="ghost"
        aria-label="Dismiss link notification"
        @click="linkMessage = ''"
      >
        ×
      </button>
    </div>
    <p v-if="headingMessage" class="heading-link-notice" role="status">
      {{ headingMessage }}
    </p>
    <DocumentLinkPicker
      :open="showDocumentLink"
      :preview="linkAsPreview"
      :selected-text="selectedLinkText"
      @close="closeDocumentLink"
      @select="insertDocumentLink"
    />
    <EditorAssetPicker
      :open="showAsset"
      :page-id="pageId"
      :image="assetImage"
      @close="closeAsset"
      @select="insertAsset"
    />
    <VideoEmbedPicker
      :open="showVideo"
      @close="closeVideo"
      @select="insertVideo"
    />
    <div class="editor-status">
      <span role="status">{{ saveStatus }}</span>
      <div
        v-if="peers.length > 1"
        class="presence"
        aria-label="People on this page"
      >
        <span
          v-for="peer in peers.slice(0, 5)"
          :key="peer.id"
          class="presence-avatar"
          :title="peer.name"
          >{{ peer.name.slice(0, 2).toUpperCase() }}</span
        >
      </div>
    </div>
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
        <button
          title="Link to document · Ctrl+K"
          aria-label="Link to document"
          :disabled="!editor.isEditable"
          @click="openDocumentLink()"
        >
          <AppIcon name="link" :size="16" />
        </button>
        <button
          title="Link a database"
          :disabled="!editor.isEditable"
          @click="openLinkPicker"
        >
          <AppIcon name="database" :size="16" /><span>Link database</span>
        </button>
        <button
          title="Bold · Ctrl+B"
          :disabled="!editor.isEditable"
          :aria-pressed="editor.isActive('bold')"
          @click="editor.chain().focus().toggleBold().run()"
        >
          <AppIcon name="bold" :size="16" /><span class="sr-only"
            >Bold</span
          ></button
        ><button
          title="Italic · Ctrl+I"
          :disabled="!editor.isEditable"
          :aria-pressed="editor.isActive('italic')"
          @click="editor.chain().focus().toggleItalic().run()"
        >
          <AppIcon name="italic" :size="16" /><span class="sr-only"
            >Italic</span
          ></button
        ><button
          title="Heading"
          :disabled="!editor.isEditable"
          @click="editor.chain().focus().toggleHeading({ level: 2 }).run()"
        >
          <AppIcon name="heading" :size="16" /><span class="sr-only"
            >Heading</span
          ></button
        ><button
          title="Bullet list"
          :disabled="!editor.isEditable"
          @click="editor.chain().focus().toggleBulletList().run()"
        >
          <AppIcon name="list" :size="16" /><span class="sr-only"
            >List</span
          ></button
        ><button
          title="Checklist"
          :disabled="!editor.isEditable"
          @click="editor.chain().focus().toggleTaskList().run()"
        >
          <AppIcon name="checklist" :size="16" /><span class="sr-only"
            >Checklist</span
          ></button
        ><button
          title="Code block"
          :disabled="!editor.isEditable"
          @click="editor.chain().focus().toggleCodeBlock().run()"
        >
          <AppIcon name="code" :size="16" /><span class="sr-only"
            >Code</span
          ></button
        ><button
          title="Undo · Ctrl+Z"
          :disabled="!editor.isEditable"
          @click="editor.chain().focus().undo().run()"
        >
          <AppIcon name="undo" :size="16" /><span class="sr-only"
            >Undo</span
          ></button
        ><button
          title="Redo · Ctrl+Shift+Z"
          :disabled="!editor.isEditable"
          @click="editor.chain().focus().redo().run()"
        >
          <AppIcon name="redo" :size="16" /><span class="sr-only">Redo</span>
        </button>
      </div>
      <div
        v-if="slashOpen"
        class="slash-menu"
        :style="slashStyle"
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

.block-editor {
  border: 0;
  padding: 0;
  margin: 4px 0 0;
  position: relative;
}
.editor-status {
  font-size: 0.72rem;
  color: var(--faint);
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
  margin-bottom: 6px;
  min-height: 19px;
}
.editor-toolbar {
  gap: 2px;
  align-items: center;
  padding: 5px 6px;
  margin: 0 0 22px;
  border: 1px solid var(--line-soft);
  border-radius: 7px;
  background: var(--surface);
  width: fit-content;
  max-width: 100%;
}
.editor-toolbar button {
  border: 0;
  background: transparent;
  color: var(--muted);
  padding: 5px 7px;
  min-width: 29px;
  min-height: 29px;
  border-radius: 4px;
}
.editor-toolbar button:hover,
.editor-toolbar button[aria-pressed="true"] {
  background: var(--surface-hover);
  color: var(--text);
}
.editor-toolbar button:first-child {
  border-right: 1px solid var(--line);
  border-radius: 0;
  padding-right: 12px;
  margin-right: 4px;
  font-size: 0.75rem;
}
.block-editor .tiptap {
  padding: 0;
  min-height: calc(100dvh - 430px);
  font-size: 1rem;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.block-editor .tiptap:focus-visible {
  outline: 0;
  border-radius: 0;
}
.block-editor .tiptap p {
  color: var(--text);
  margin: 0 0 0.65em;
  line-height: 1.8;
}
.block-editor .tiptap p:only-child:empty:before,
.block-editor .tiptap p:only-child:has(> br:only-child):before {
  content: "Start writing, or type / to insert a block…";
  color: var(--faint);
  float: left;
  pointer-events: none;
  height: 0;
}
.block-editor .tiptap h1 {
  font-size: 1.8rem;
  margin: 1.4em 0 0.4em;
  font-weight: 650;
}
.block-editor .tiptap h2 {
  font-size: 1.4rem;
  margin: 1.5em 0 0.5em;
  font-weight: 600;
}
.block-editor .tiptap h3 {
  font-size: 1.15rem;
  margin: 1.4em 0 0.4em;
  font-weight: 600;
}
.block-editor .tiptap ul,
.block-editor .tiptap ol {
  padding-left: 1.6em;
  line-height: 1.8;
}
.block-editor .tiptap li p {
  margin-bottom: 0.25em;
}
.block-editor .tiptap blockquote {
  border-left: 3px solid var(--muted);
  padding-left: 1em;
  margin: 1em 0;
  font-size: 1.03rem;
}
.block-editor .tiptap pre {
  font:
    0.83rem/1.75 "JetBrains Mono Variable",
    monospace;
  border: 1px solid var(--line);
  padding: 18px;
  border-radius: 7px;
}
.block-editor .tiptap code {
  font-family: "JetBrains Mono Variable", monospace;
  font-size: 0.85em;
  background: var(--surface);
  padding: 2px 4px;
  border-radius: 3px;
}
.block-editor .tiptap pre code {
  padding: 0;
  background: transparent;
}
.block-editor .hint {
  font-size: 0.71rem;
  color: var(--faint);
  margin: 20px 0 0;
  opacity: 0.7;
}
.slash-menu {
  position: absolute;
  z-index: 20;
  left: 0;
  top: 105px;
  width: 280px;
  max-height: 350px;
  overflow: auto;
  background: var(--elevated);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
  padding: 6px;
  border-radius: 9px;
}
.slash-menu button {
  justify-content: flex-start;
  background: transparent;
  border: 0;
  font-size: 0.83rem;
  padding: 8px 10px;
}
.slash-menu button[aria-selected="true"] {
  background: var(--accent-soft);
  color: var(--accent);
}
.presence {
  position: absolute;
  right: 0;
  top: -2px;
  display: flex;
  gap: 3px;
}
.presence-avatar {
  width: 23px;
  height: 23px;
  border: 2px solid var(--bg);
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  display: grid;
  place-items: center;
  font-size: 0.6rem;
}
.link-database-dialog {
  background: var(--elevated);
  padding: 24px;
  border-radius: 12px;
}
.link-database-dialog h2 {
  font-size: 1.1rem;
  color: var(--text);
}
@media (max-width: 760px) {
  .editor-toolbar {
    margin-bottom: 20px;
    gap: 0;
  }
  .editor-toolbar button {
    padding: 4px 6px;
  }
  .editor-toolbar button:first-child span {
    display: none;
  }
  .block-editor .tiptap {
    min-height: calc(100dvh - 370px);
  }
  .editor-status {
    font-size: 0.68rem;
  }
}
</style>
<style>
.block-editor .tiptap h1,
.block-editor .tiptap h2,
.block-editor .tiptap h3 {
  position: relative;
  scroll-margin-top: 80px;
}
.block-editor .tiptap [data-link-target] {
  background: var(--accent-soft);
  border-radius: 4px;
  outline: 1px solid var(--accent);
  outline-offset: 6px;
}
.heading-permalink {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  margin-left: 8px;
  min-height: 24px;
  width: 24px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 16px;
  opacity: 0;
  user-select: none;
}
.tiptap h1:hover .heading-permalink,
.tiptap h2:hover .heading-permalink,
.tiptap h3:hover .heading-permalink,
.heading-permalink:focus-visible {
  opacity: 1;
}
.heading-link-notice {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 0.85rem;
  color: var(--muted);
}
@media (max-width: 760px) {
  .heading-permalink {
    opacity: 1;
  }
  .editor-toolbar button:has(> span:not(.sr-only)) span {
    display: none;
  }
}
</style>
<style>
.editor-link-toast {
  position: fixed;
  z-index: 70;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: calc(100vw - 32px);
  background: var(--elevated);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 12px;
  box-shadow: var(--shadow);
  font-size: 0.85rem;
}
</style>

<style>
.editor-status .presence {
  position: static;
  margin: 0;
  align-items: center;
}
</style>

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
import WhiteboardNode from "./WhiteboardNode.vue";
import AssetNode from "./AssetNode.vue";
import PagePreviewNode from "./PagePreviewNode.vue";
import VideoEmbedNode from "./VideoEmbedNode.vue";
import ColumnsNode from "./ColumnsNode.vue";
import PersonMentionNode from "./PersonMentionNode.vue";
import {
  editorPeopleKey,
  type EditorPerson,
} from "../composables/editorPeople";
import { editorPageKey } from "../composables/editorContext";
import { shortcutLabel } from "../utils/shortcuts";
import {
  editorExtensions,
  documentHeadings,
  yDocToDocument,
  pageLink,
  headingFromHash,
  validHeadingId,
  cancelEditorTableResize,
} from "@orvyn/editor";
import { pageNavigationKey } from "../composables/pageNavigation";
import * as Y from "yjs";
import {
  anchorForRange,
  commentAnchorResolver,
  type CommentAnchor,
} from "@orvyn/editor/comments";
const props = defineProps<{
  pageId: string;
  spaceId: string;
  user: any;
  accessRank: number;
  focusedComment?: { id: string; pageId: string; anchor: CommentAnchor | null };
  paused?: boolean;
  targetHeading?: string;
  headingVisit?: number;
  targetPerson?: string;
  personVisit?: number;
  chromeTarget?: string;
}>();
const emit = defineEmits<{
  comment: [anchor: CommentAnchor];
  thread: [id: string];
  access: [value: { pageId: string; rank: number }];
  anchorStatus: [
    value: {
      pageId: string;
      id: string;
      status: "active" | "changed" | "missing";
    },
  ];
}>();
const accessRank = ref(props.accessRank);
watch(
  () => props.accessRank,
  (rank) => (accessRank.value = rank),
);
provide(editorPageKey, () => props.pageId);
const people = shallowRef(new Map<string, EditorPerson>());
provide(editorPeopleKey, people);
const openPage = inject(pageNavigationKey),
  root = ref<HTMLElement>(),
  showDocumentLink = ref(false),
  linkAsPreview = ref(false),
  showAsset = ref(false),
  showWhiteboard = ref(false),
  showVideo = ref(false),
  assetImage = ref(true),
  selectedLinkText = ref(""),
  linkMessage = ref(""),
  headingMessage = ref("");
const personOpen = ref(false),
  personQuery = ref(""),
  personStyle = ref<Record<string, string>>({}),
  personPicker = ref<{ key: (event: KeyboardEvent) => boolean }>();
let personRange = { from: 0, to: 0 },
  peopleRequest = 0,
  peopleTimer: ReturnType<typeof setTimeout> | undefined,
  lastPeople = "",
  fetchedPeople = "";
function currentPeople() {
  const ids = new Set<string>();
  editor.value?.state.doc.descendants((node) => {
    if (node.type.name === "orvynPerson") ids.add(node.attrs.userId);
  });
  return [...ids].sort();
}
async function refreshPeople() {
  if (disposed || !synced.value || denied.value || unsynced.value) return;
  const ids = currentPeople(),
    token = ++peopleRequest;
  if (!ids.length) {
    people.value = new Map();
    fetchedPeople = "";
    return;
  }
  try {
    const data = await $fetch<EditorPerson[]>(
      `/api/v1/pages/${props.pageId}/people-references`,
      { query: { ids: ids.join(",") } },
    );
    if (
      !disposed &&
      token === peopleRequest &&
      !unsynced.value &&
      ids.join(",") === currentPeople().join(",")
    ) {
      people.value = new Map(data.map((person) => [person.id, person]));
      fetchedPeople = ids.join(",");
    }
  } catch {
    if (!disposed && token === peopleRequest) people.value = new Map();
  }
}
function schedulePeople() {
  const ids = currentPeople().join(",");
  if (ids === lastPeople) return;
  lastPeople = ids;
  clearTimeout(peopleTimer);
  peopleTimer = setTimeout(() => void refreshPeople(), 150);
}
function updatePerson(
  e: Pick<Editor, "isEditable" | "state" | "isActive" | "view">,
) {
  if (
    !e.isEditable ||
    pickerSelectionActive ||
    !e.state.selection.empty ||
    e.isActive("codeBlock") ||
    e.view.composing
  ) {
    personOpen.value = false;
    return;
  }
  const selection = e.state.selection,
    text = selection.$from.parent.textBetween(
      0,
      selection.$from.parentOffset,
      "",
      "\uFFFC",
    ),
    match = text.match(/(?:^|[\s(])@([^\s@{}]*)$/);
  if (!match || match[1]!.length > 100) {
    personOpen.value = false;
    return;
  }
  personQuery.value = match[1]!;
  personRange = {
    from: selection.from - match[1]!.length - 1,
    to: selection.from,
  };
  personOpen.value = true;
  void nextTick(positionSlash);
}
function insertPerson(person: EditorPerson) {
  const e = editor.value;
  if (!e?.isEditable) return;
  if (!currentPeople().includes(person.id) && currentPeople().length >= 100) {
    linkMessage.value = "Mention up to 100 different people in one document.";
    return;
  }
  people.value = new Map([...people.value, [person.id, person]]);
  personOpen.value = false;
  e.chain()
    .focus()
    .insertContentAt(personRange, [
      { type: "orvynPerson", attrs: { userId: person.id } },
      { type: "text", text: " " },
    ])
    .run();
}
async function visitPerson() {
  if (!props.targetPerson || !synced.value || !editor.value) return;
  await nextTick();
  // Inbox navigation closes its modal after page selection. Wait for its DOM
  // update and the inline node view before moving focus out of the dialog.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (disposed || !editor.value) return;
  const node = editor.value.view.dom.querySelector<HTMLElement>(
    '[data-person-id="' + CSS.escape(props.targetPerson) + '"]',
  );
  editor.value.view.dom
    .querySelectorAll("[data-mention-target]")
    .forEach((el) => el.removeAttribute("data-mention-target"));
  node?.setAttribute("data-mention-target", "");
  node?.scrollIntoView({ block: "center" });
  node?.focus({ preventScroll: true });
}
const blockMenuPosition = ref<{ left: number; top: number }>();
let commentAnchors: { id: string; anchor: CommentAnchor }[] = [],
  annotationFrame = 0,
  annotationRequest = 0,
  disposed = false;
let annotationTimer: ReturnType<typeof setInterval> | undefined;
function reportAccess(rank: number) {
  accessRank.value = rank;
  emit("access", { pageId: props.pageId, rank });
}
function refreshHighlights() {
  if (!editor.value || !synced.value || disposed) return;
  const resolve = commentAnchorResolver(document),
    all = new Map(commentAnchors.map((anchor) => [anchor.id, anchor.anchor]));
  if (
    props.focusedComment?.anchor &&
    props.focusedComment.pageId === props.pageId
  )
    all.set(props.focusedComment.id, props.focusedComment.anchor);
  const focused = props.focusedComment;
  if (focused?.anchor && focused.pageId === props.pageId) {
    const range = resolve(focused.anchor);
    emit("anchorStatus", {
      pageId: props.pageId,
      id: focused.id,
      status: !range ? "missing" : range.changed ? "changed" : "active",
    });
  }
  editor.value.commands.setCommentHighlights(
    [...all].flatMap(([id, anchor]) => {
      const range = resolve(anchor);
      return range
        ? [{ id, from: range.from, to: range.to, changed: range.changed }]
        : [];
    }),
  );
}
function scheduleHighlights() {
  if (!annotationFrame && !disposed)
    annotationFrame = requestAnimationFrame(() => {
      annotationFrame = 0;
      refreshHighlights();
    });
}
async function refreshComments() {
  if (disposed || !synced.value || denied.value) return;
  const token = ++annotationRequest;
  try {
    const data = await $fetch<any>(
      `/api/v1/pages/${props.pageId}/thread-anchors`,
    );
    if (disposed || token !== annotationRequest) return;
    commentAnchors = data.anchors;
    reportAccess(data.accessRank);
    scheduleHighlights();
  } catch (e: any) {
    if (disposed || token !== annotationRequest) return;
    commentAnchors = [];
    scheduleHighlights();
    if ([401, 403, 404].includes(e.statusCode || e.status)) reportAccess(0);
  }
}
function focusComment() {
  refreshHighlights();
  const id = props.focusedComment?.id;
  if (!id) return;
  const marker = editor.value?.view.dom.querySelector<HTMLButtonElement>(
    'button.comment-marker[data-comment-thread="' + CSS.escape(id) + '"]',
  );
  marker?.scrollIntoView({ block: "center" });
  marker?.focus({ preventScroll: true });
}
async function prepareComment() {
  const e = editor.value;
  if (!e || accessRank.value < 20 || !synced.value || denied.value) return;
  const selected = window.getSelection();
  if (
    selected?.anchorNode &&
    selected.focusNode &&
    e.view.dom.contains(selected.anchorNode) &&
    e.view.dom.contains(selected.focusNode)
  ) {
    const from = e.view.posAtDOM(selected.anchorNode, selected.anchorOffset),
      to = e.view.posAtDOM(selected.focusNode, selected.focusOffset);
    e.commands.setTextSelection({
      from: Math.min(from, to),
      to: Math.max(from, to),
    });
  }
  const anchor = anchorForRange(
    document,
    e.state.selection.from,
    e.state.selection.to,
  );
  if (!anchor) {
    linkMessage.value = "Select up to 2,000 characters to comment on.";
    return;
  }
  try {
    await flush();
    emit("comment", anchor);
  } catch {
    linkMessage.value =
      "Save pending changes before commenting on selected text.";
  }
}
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
const formattingOpen = ref(false),
  formattingId = useId();
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
  icon: string;
  run: (editor: Editor) => unknown;
  keepSelection?: boolean;
  aliases?: string[];
}
const commands: SlashCommand[] = [
  {
    label: "Mention person",
    icon: "users",
    aliases: ["erwähnen", "person", "mention"],
    run: (e) => e.chain().focus().insertContent("@").run(),
  },
  {
    label: "2 columns",
    icon: "columns2",
    aliases: ["spalten"],
    run: (e) => e.chain().focus().insertColumns(2).run(),
  },
  {
    label: "3 columns",
    icon: "board",
    aliases: ["spalten"],
    run: (e) => e.chain().focus().insertColumns(3).run(),
  },
  {
    label: "Embed",
    icon: "video",
    aliases: ["video", "einbetten"],
    keepSelection: true,
    run: () => void openVideo(),
  },
  {
    label: "Image",
    icon: "image",
    aliases: ["bild", "photo"],
    keepSelection: true,
    run: () => void openAsset(true),
  },
  {
    label: "File",
    icon: "paperclip",
    aliases: ["datei", "attachment"],
    keepSelection: true,
    run: () => void openAsset(false),
  },
  {
    label: "Callout",
    icon: "lightbulb",
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
    icon: "chevronRight",
    aliases: ["collapse", "aufklappen"],
    run: (e: Editor) => e.chain().focus().insertToggle().run(),
  },
  {
    label: "Table of contents",
    icon: "list",
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
    icon: "text",
    run: (e: Editor) => e.chain().focus().setParagraph().run(),
  },
  {
    label: "Heading 1",
    icon: "heading1",
    run: (e: Editor) => e.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    label: "Heading 2",
    icon: "heading",
    run: (e: Editor) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    label: "Heading 3",
    icon: "heading3",
    run: (e: Editor) => e.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    label: "Heading 4",
    icon: "heading4",
    run: (e: Editor) => e.chain().focus().toggleHeading({ level: 4 }).run(),
  },
  {
    label: "Bullet list",
    icon: "list",
    run: (e: Editor) => e.chain().focus().toggleBulletList().run(),
  },
  {
    label: "Numbered list",
    icon: "listOrdered",
    run: (e: Editor) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    label: "Checklist",
    icon: "checklist",
    run: (e: Editor) => e.chain().focus().toggleTaskList().run(),
  },
  {
    label: "Quote",
    icon: "quote",
    run: (e: Editor) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    label: "Code block",
    icon: "code",
    run: (e: Editor) => e.chain().focus().toggleCodeBlock().run(),
  },
  {
    label: "Divider",
    icon: "divider",
    run: (e: Editor) => e.chain().focus().setHorizontalRule().run(),
  },
  {
    label: "Link to document",
    icon: "link",
    aliases: ["link", "page", "document", "seite", "dokument", "verlinken"],
    keepSelection: true,
    run: () => {
      void openDocumentLink(true);
    },
  },
  {
    label: "Page preview",
    icon: "file",
    aliases: ["vorschau", "page card"],
    keepSelection: true,
    run: () => {
      void openDocumentLink(true, true);
    },
  },
  {
    label: "Linked database",
    icon: "database",
    keepSelection: true,
    run: () => {
      void openLinkPicker();
    },
  },
  {
    label: "Table",
    icon: "table",
    run: (e: Editor) =>
      e
        .chain()
        .focus()
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    label: "Whiteboard",
    icon: "whiteboard",
    keepSelection: true,
    run: () => {
      void openWhiteboard(true);
    },
  },
];
const basicCommands = [
  "Paragraph",
  "Heading 1",
  "Heading 2",
  "Heading 3",
  "Heading 4",
  "Bullet list",
  "Numbered list",
  "Checklist",
  "Quote",
  "Callout",
  "Toggle",
  "Divider",
  "Link to document",
  "Page preview",
  "Mention person",
  "Table",
  "Linked database",
  "Whiteboard",
  "Code block",
  "Image",
  "File",
  "Embed",
  "2 columns",
  "3 columns",
  "Table of contents",
];
commands.sort(
  (a, b) => basicCommands.indexOf(a.label) - basicCommands.indexOf(b.label),
);
const commandDescriptions: Record<string, string> = {
  Paragraph: "Start writing with plain text",
  "Heading 1": "A large section heading",
  "Heading 2": "A medium section heading",
  "Heading 3": "A small section heading",
  "Heading 4": "A compact subsection heading",
  "Bullet list": "Create a simple bulleted list",
  "Numbered list": "Keep steps in order",
  Checklist: "Track work with checkboxes",
  Quote: "Highlight a quotation",
  Callout: "Make a note stand out",
  Toggle: "Keep details in a collapsible section",
  Divider: "Separate sections with a line",
  "Link to document": "Reference a page or a specific heading",
  "Page preview": "Show a linked page as a card",
  "Mention person": "Bring someone into the conversation",
  Table: "Arrange content in rows and columns",
  "Linked database": "Insert a live view of your database",
  Whiteboard: "Embed a collaborative drawing canvas",
  "Code block": "Write code with syntax highlighting",
  Image: "Upload an image",
  File: "Attach a file to this page",
  Embed: "Add a video from a supported service",
  "2 columns": "Arrange blocks side by side",
  "3 columns": "Create a three-column layout",
  "Table of contents": "Navigate the headings on this page",
};
const filtered = computed(() =>
  commands.filter((c) =>
    [c.label, ...(c.aliases || [])].some((label) =>
      label.toLowerCase().includes(slash.value.toLowerCase()),
    ),
  ),
);
const textStyle = computed(() => {
  const node = editor.value?.state.selection.$from.parent;
  return node?.type.name === "heading"
    ? "heading-" + node.attrs.level
    : "paragraph";
});
function changeTextStyle(event: Event) {
  const value = (event.target as HTMLSelectElement).value,
    e = editor.value;
  if (!e?.isEditable) return;
  if (value === "paragraph") e.chain().focus().setParagraph().run();
  else
    e.chain()
      .focus()
      .setHeading({ level: Number(value.slice(-1)) as 1 | 2 | 3 | 4 })
      .run();
}
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
          "orvynColumns",
          "orvynPerson",
          "orvynWhiteboard",
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
                      orvynColumns: ColumnsNode,
                      orvynPerson: PersonMentionNode,
                      orvynWhiteboard: WhiteboardNode,
                    } as Record<string, any>
                  )[extension.name],
                );
              },
            })
          : extension.name === "orvynCommentHighlights"
            ? extension.configure({
                onOpen: (id: string) => emit("thread", id),
                active: () => props.focusedComment?.id || "",
              })
            : extension.name === "orvynBlockControls"
              ? extension.configure({
                  onMenu: (rect: DOMRect) => {
                    blockMenuPosition.value = {
                      left: rect.left,
                      top: rect.bottom + 4,
                    };
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
          name: props.user.displayName,
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
        tabindex: "0",
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
        if (personOpen.value && personPicker.value?.key(event)) return true;
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
        keydown: (_view, event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.shiftKey &&
            event.key.toLowerCase() === "m" &&
            accessRank.value >= 20
          ) {
            event.preventDefault();
            event.stopPropagation();
            void prepareComment();
            return true;
          }
          return false;
        },
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
      if (transaction.docChanged) {
        scheduleHighlights();
        schedulePeople();
      }
      if (pickerSelectionActive && transaction.docChanged) {
        insertionRange = {
          from: transaction.mapping.map(insertionRange.from, 1),
          to: transaction.mapping.map(insertionRange.to, -1),
        };
        if (insertionRange.to < insertionRange.from)
          insertionRange.to = insertionRange.from;
      }
    },
    onUpdate: ({ editor: e }) => {
      updateSlash(e);
      updatePerson(e);
    },
    onSelectionUpdate: ({ editor: e }) => {
      updateSlash(e);
      updatePerson(e);
    },
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
  if ((!slashOpen.value && !personOpen.value) || !editor.value) return;
  const rect = editor.value.view.coordsAtPos(editor.value.state.selection.from),
    below = window.innerHeight - rect.bottom - 12,
    above = below < 220 && rect.top > 220,
    width = Math.min(personOpen.value ? 340 : 280, window.innerWidth - 24);
  const style = {
    position: "fixed",
    width: width + "px",
    left:
      Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + "px",
    top: above ? "auto" : rect.bottom + 6 + "px",
    bottom: above ? window.innerHeight - rect.top + 6 + "px" : "auto",
    maxHeight:
      Math.min(350, Math.max(120, above ? rect.top - 18 : below)) + "px",
  };
  if (personOpen.value) personStyle.value = style;
  else slashStyle.value = style;
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
async function openWhiteboard(fromSlash = false) {
  if (!editor.value?.isEditable) return;
  insertionRange = fromSlash
    ? { ...slashRange }
    : {
        from: editor.value.state.selection.from,
        to: editor.value.state.selection.to,
      };
  pickerSelectionActive = true;
  slashOpen.value = false;
  try {
    await flush();
    showWhiteboard.value = true;
  } catch {
    pickerSelectionActive = false;
    linkMessage.value = "Save pending changes before inserting a whiteboard.";
  }
}
function insertWhiteboard(pageId: string) {
  if (!editor.value?.isEditable) return;
  pickerSelectionActive = false;
  editor.value
    .chain()
    .focus()
    .insertContentAt(insertionRange, [
      { type: "orvynWhiteboard", attrs: { pageId } },
      { type: "paragraph" },
    ])
    .run();
  showWhiteboard.value = false;
}
function closeWhiteboard() {
  showWhiteboard.value = false;
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
  // A fixed short batch also collapses rapid caret awareness updates. Every
  // merged update still receives the server's durable acknowledgement.
  flushDelay: 40,
  onAuthenticated({ scope }) {
    readOnly.value = scope === "readonly";
    denied.value = false;
  },
  onAuthenticationFailed() {
    reportAccess(0);
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
    if (!number && !disposed && currentPeople().join(",") !== fetchedPeople) {
      clearTimeout(peopleTimer);
      peopleTimer = setTimeout(() => void refreshPeople(), 150);
    }
  },
  onStateless({ payload }) {
    try {
      const message = JSON.parse(payload);
      if (message.type === "permissions") {
        readOnly.value = message.readOnly;
        if (typeof message.accessRank === "number")
          reportAccess(message.accessRank);
      }
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
      reportAccess(0);
      provider.disconnect();
    }
  },
});
async function flush() {
  provider.flushPendingUpdates();
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
defineExpose({
  flush,
  refreshComments,
  focusComment,
  focusStart: () => editor.value?.commands.focus("start"),
});
function beforeUnload(event: BeforeUnloadEvent) {
  if (!unsynced.value) return;
  event.preventDefault();
  event.returnValue = "";
}
onMounted(() => window.addEventListener("beforeunload", beforeUnload));
onMounted(() => {
  window.addEventListener("scroll", positionSlash, true);
  window.addEventListener("resize", positionSlash);
  annotationTimer = setInterval(() => {
    if (window.document.visibilityState === "visible") {
      void refreshComments();
      void refreshPeople();
    }
  }, 5000);
});
watch([editor, synced], () => {
  if (editor.value && synced.value) {
    void refreshComments();
    void refreshPeople();
  }
});
watch(() => props.focusedComment, scheduleHighlights);
watch(
  [() => props.targetPerson, () => props.personVisit, editor, synced],
  () => void visitPerson(),
);
watch(
  [status, synced, readOnly, editor, denied, accessRank, () => props.paused],
  () => {
    persistInitialHeadingIds();
    const editable =
      status.value === "connected" &&
      synced.value &&
      !readOnly.value &&
      !denied.value &&
      accessRank.value >= 30 &&
      !props.paused;
    if (editor.value && !editable) cancelEditorTableResize(editor.value);
    editor.value?.setEditable(editable);
  },
);
onBeforeUnmount(() => {
  if (editor.value) cancelEditorTableResize(editor.value);
  disposed = true;
  peopleRequest++;
  clearTimeout(peopleTimer);
  annotationRequest++;
  clearInterval(annotationTimer);
  cancelAnimationFrame(annotationFrame);
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
    <PersonMentionPicker
      v-if="personOpen"
      ref="personPicker"
      :style="personStyle"
      :page-id="pageId"
      :query="personQuery"
      @close="personOpen = false"
      @select="insertPerson"
    />
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
    <Teleport :to="chromeTarget || 'body'" :disabled="!chromeTarget">
      <div class="editor-chrome">
        <div
          class="editor-status"
          :data-state="
            status !== 'connected'
              ? 'disconnected'
              : unsynced
                ? 'saving'
                : 'saved'
          "
        >
          <span role="status" class="editor-save-state" :title="saveStatus"
            ><AppIcon
              :name="status === 'connected' && !unsynced ? 'check' : 'clock'"
              :size="14"
            /><span class="editor-save-label">{{ saveStatus }}</span></span
          >
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
          <button
            v-if="editor && !readOnly"
            type="button"
            class="editor-format-toggle"
            aria-label="Text formatting"
            :aria-expanded="formattingOpen"
            :aria-controls="formattingId"
            @mousedown.prevent
            @click="formattingOpen = !formattingOpen"
          >
            <AppIcon
              :name="
                textStyle === 'paragraph'
                  ? 'text'
                  : 'heading' + textStyle.slice(-1)
              "
              :size="15"
            />{{
              textStyle === "paragraph" ? "Format" : "H" + textStyle.slice(-1)
            }}<AppIcon
              :name="formattingOpen ? 'chevronUp' : 'chevronDown'"
              :size="12"
            />
          </button>
        </div>
      </div>
    </Teleport>
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
      ><EditorBlockMenu
        :editor="editor"
        :position="blockMenuPosition"
        @close="blockMenuPosition = undefined"
      />
      <FloatingFormatMenu
        :editor="editor"
        :can-comment="
          synced && !denied && status === 'connected' && accessRank >= 20
        "
        @link="openDocumentLink()"
        @comment="prepareComment"
      />
      <EditorTableMenu :editor="editor" />
      <WhiteboardPicker
        :open="showWhiteboard"
        :space-id="spaceId"
        :parent-id="pageId"
        @insert="insertWhiteboard"
        @close="closeWhiteboard"
      />
      <div
        v-show="formattingOpen && !readOnly"
        :id="formattingId"
        class="editor-toolbar"
        role="toolbar"
        aria-label="Text formatting"
      >
        <div class="editor-tool-group">
          <select
            class="editor-text-style"
            aria-label="Text style"
            :value="textStyle"
            :disabled="!editor.isEditable"
            @change="changeTextStyle"
          >
            <option value="paragraph">Text</option>
            <option value="heading-1">Heading 1</option>
            <option value="heading-2">Heading 2</option>
            <option value="heading-3">Heading 3</option>
            <option value="heading-4">Heading 4</option>
          </select>
        </div>
        <div class="editor-tool-group">
          <button
            :title="'Link to document · ' + shortcutLabel('Mod+K')"
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
        </div>
        <div class="editor-tool-group">
          <button
            :title="'Bold · ' + shortcutLabel('Mod+B')"
            :disabled="!editor.isEditable"
            :aria-pressed="editor.isActive('bold')"
            @click="editor.chain().focus().toggleBold().run()"
          >
            <AppIcon name="bold" :size="16" /><span class="sr-only"
              >Bold</span
            ></button
          ><button
            :title="'Italic · ' + shortcutLabel('Mod+I')"
            :disabled="!editor.isEditable"
            :aria-pressed="editor.isActive('italic')"
            @click="editor.chain().focus().toggleItalic().run()"
          >
            <AppIcon name="italic" :size="16" /><span class="sr-only"
              >Italic</span
            >
          </button>
        </div>
        <div class="editor-tool-group">
          <button
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
            <AppIcon name="code" :size="16" /><span class="sr-only">Code</span>
          </button>
        </div>
        <div class="editor-tool-group">
          <button
            :title="'Undo · ' + shortcutLabel('Mod+Z')"
            :disabled="!editor.isEditable"
            @click="editor.chain().focus().undo().run()"
          >
            <AppIcon name="undo" :size="16" /><span class="sr-only"
              >Undo</span
            ></button
          ><button
            :title="'Redo · ' + shortcutLabel('Mod+Shift+Z')"
            :disabled="!editor.isEditable"
            @click="editor.chain().focus().redo().run()"
          >
            <AppIcon name="redo" :size="16" /><span class="sr-only">Redo</span>
          </button>
        </div>
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
          :aria-label="command.label"
          :aria-selected="index === slashIndex"
          @mousedown.prevent
          @click="applyCommand(index)"
        >
          <span class="slash-command-icon" aria-hidden="true"
            ><AppIcon :name="command.icon" :size="18" /></span
          ><span class="slash-command-copy"
            ><strong>{{ command.label }}</strong
            ><small>{{ commandDescriptions[command.label] }}</small></span
          >
        </button>
        <p v-if="!filtered.length">No matching block</p>
      </div>
      <EditorContent :editor="editor" />
    </template>
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
  table-layout: fixed;
  margin: 0;
}
.block-editor .tiptap .tableWrapper {
  overflow-x: auto;
  margin: 1.1em 0;
  max-width: 100%;
}
.block-editor .tiptap[contenteditable="true"] .tableWrapper {
  margin-top: 52px;
}
.block-editor .tiptap td,
.block-editor .tiptap th {
  border: 1px solid var(--line);
  padding: 8px 12px;
  min-width: 96px;
  vertical-align: top;
  position: relative;
}
.block-editor .tiptap th {
  font-weight: 600;
  text-align: left;
  background: var(--surface);
}
.block-editor .tiptap :is(td, th) p {
  margin: 0;
  min-height: 1.6em;
}
.block-editor .tiptap .selectedCell::after {
  position: absolute;
  inset: 0;
  content: "";
  background: var(--accent-soft);
  pointer-events: none;
}
.block-editor .tiptap :is(td, th) > .column-resize-handle {
  position: absolute;
  right: -2px;
  top: 0;
  bottom: 0;
  width: 4px;
  background: var(--accent);
  pointer-events: none;
  z-index: 2;
}
.block-editor .tiptap.resize-cursor {
  cursor: col-resize;
}
.block-editor .tiptap a[href] {
  cursor: pointer;
}
.block-editor .tiptap ul[data-type="taskList"] {
  list-style: none;
  padding: 0;
}
.block-editor .tiptap li[data-type="taskItem"] {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 4px 0;
}
.block-editor .tiptap li[data-type="taskItem"] > label {
  display: flex;
  align-items: center;
  flex: 0 0 16px;
  margin: 0;
  padding-top: 5px;
  cursor: pointer;
}
.block-editor .tiptap li[data-type="taskItem"] > div {
  flex: 1;
  min-width: 0;
}
.block-editor
  .tiptap
  li[data-type="taskItem"][data-checked="true"]
  > div
  > p:first-child {
  color: var(--muted);
  text-decoration: line-through;
}
.block-editor .tiptap input[type="checkbox"] {
  width: 14px;
  height: 14px;
  min-height: 14px;
  margin: 0;
  padding: 0;
  accent-color: var(--accent);
}
.block-editor .tiptap input[type="checkbox"]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
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
  gap: 10px;
  margin: 0;
  min-height: 30px;
}
.editor-chrome {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.editor-save-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  white-space: nowrap;
}
.editor-status[data-state="saving"] .editor-save-state {
  color: var(--accent);
}
.editor-status[data-state="disconnected"] .editor-save-state {
  color: var(--warning);
}
.editor-status .editor-format-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: 1px solid transparent;
  padding: 4px 7px;
  min-height: 28px;
  color: var(--muted);
  font-size: 12px;
  border-radius: 5px;
}
.editor-status .editor-format-toggle:hover,
.editor-status .editor-format-toggle[aria-expanded="true"] {
  background: var(--surface-hover);
  color: var(--text);
  border-color: var(--line);
}
.editor-toolbar {
  gap: 4px;
  align-items: center;
  padding: 5px 6px;
  margin: 0 0 22px;
  border: 1px solid var(--divider);
  border-radius: 7px;
  background: var(--surface);
  width: 100%;
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
.editor-tool-group {
  display: flex;
  align-items: center;
  gap: 2px;
}
.editor-tool-group + .editor-tool-group {
  border-left: 1px solid var(--divider);
  padding-left: 5px;
}
.block-editor .tiptap {
  padding: 0;
  min-height: calc(100dvh - 430px);
  font-size: 16px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.block-editor .tiptap:focus-visible {
  outline: 0;
  border-radius: 0;
}
.block-editor .tiptap p {
  color: var(--text);
  margin: 0 0 0.5em;
  line-height: 1.6;
}
.block-editor .tiptap[contenteditable="true"] > p:only-child:empty:before,
.block-editor
  .tiptap[contenteditable="true"]
  > p:only-child:has(> br:only-child):before {
  content: "Start writing, or type / to insert a block…";
  color: var(--faint);
  float: left;
  pointer-events: none;
  height: 0;
}
.block-editor .tiptap h1 {
  font-size: 30px;
  margin: 1.4em 0 0.4em;
  font-weight: 650;
}
.block-editor .tiptap h2 {
  font-size: 24px;
  margin: 1.5em 0 0.5em;
  font-weight: 600;
}
.block-editor .tiptap h3 {
  font-size: 20px;
  margin: 1.4em 0 0.4em;
  font-weight: 600;
}
.block-editor .tiptap h4 {
  font-size: 18px;
  margin: 1.4em 0 0.4em;
  font-weight: 650;
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
.block-editor .tiptap h3,
.block-editor .tiptap h4 {
  position: relative;
  scroll-margin-top: 80px;
  min-height: 1.4em;
  caret-color: var(--text);
}
.block-editor .tiptap [data-heading-marker]::before {
  content: attr(data-heading-marker);
  position: absolute;
  left: -32px;
  top: 0.35em;
  width: 28px;
  text-align: right;
  color: var(--faint);
  opacity: 0.6;
  font:
    500 9.5px/1.6 "JetBrains Mono Variable",
    monospace;
  pointer-events: none;
  user-select: none;
}
.block-editor .ProseMirror-focused [data-heading-active="true"]::before {
  color: var(--accent);
  opacity: 0.8;
}
.block-editor .tiptap [data-heading-empty="true"]::after {
  content: "Heading " attr(data-heading-level);
  position: absolute;
  inset: 0 auto auto 0;
  color: var(--faint);
  opacity: 0.55;
  pointer-events: none;
  user-select: none;
}
.slash-command-icon {
  display: grid;
  place-items: center;
  flex: 0 0 31px;
  width: 31px;
  height: 31px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--muted);
  background: var(--surface);
}
.slash-command-copy {
  display: grid;
  gap: 3px;
  text-align: left;
  min-width: 0;
}
.slash-command-copy strong {
  font-size: 0.78rem;
  font-weight: 500;
}
.slash-command-copy small {
  font-size: 0.66rem;
  color: var(--faint);
  white-space: normal;
  line-height: 1.3;
}
.editor-text-style {
  width: 112px;
  min-height: 29px;
  padding: 4px 7px;
  border: 0;
  border-radius: 0;
  background: transparent;
  font-size: 0.75rem;
  box-shadow: none;
}
.slash-menu button {
  display: flex;
  align-items: center;
  gap: 11px;
  min-height: 44px;
  border-radius: 6px;
  padding: 5px 7px;
}
.slash-menu button[aria-selected="true"] .slash-command-icon {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 35%, var(--line));
}
@media (max-width: 760px) {
  .block-editor .tiptap [data-heading-marker]::before {
    left: -24px;
    width: 21px;
    font-size: 8.5px;
  }
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
.tiptap h4:hover .heading-permalink,
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

<style>
.block-editor .comment-highlight {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  border-bottom: 2px solid color-mix(in srgb, var(--accent) 65%, transparent);
}
.block-editor .comment-highlight.active {
  background: color-mix(in srgb, var(--accent) 28%, transparent);
  border-color: var(--accent);
}
.block-editor .comment-highlight.changed {
  border-bottom-style: dashed;
}
.block-editor .comment-marker {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  width: 22px;
  height: 22px;
  min-height: 22px;
  padding: 2px;
  margin: 0 3px;
  color: var(--accent);
  background: var(--accent-soft);
  border: 0;
  border-radius: 4px;
  user-select: none;
}
.block-editor .comment-marker:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>

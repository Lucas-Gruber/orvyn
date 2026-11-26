<script setup lang="ts">
import {
  NodeViewWrapper,
  NodeViewContent,
  type NodeViewProps,
} from "@tiptap/vue-3";
import { copyText } from "../utils/clipboard";
const props = defineProps<NodeViewProps>(),
  editable = useNodeEditable(props.editor);
const isMermaid = computed(
  () => String(props.node.attrs.language).toLowerCase() === "mermaid",
);
const canRenderMermaid = computed(() => {
  if (
    !editable.value ||
    !["", "plaintext", "text"].includes(
      String(props.node.attrs.language || "").toLowerCase(),
    )
  )
    return false;
  const source = props.node.textContent;
  if (source.length > 20000) return false;
  const first =
    source
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("%%")) || "";
  return /^(?:(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b|(?:sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|requirementDiagram|quadrantChart|xychart(?:-beta)?|block-beta|packet-beta|architecture-beta|kanban|sankey-beta|C4(?:Context|Container|Component|Dynamic|Deployment))(?:\s|$))/.test(
    first,
  );
});
function renderDiagram() {
  if (!canRenderMermaid.value) return;
  const pos = props.getPos();
  if (typeof pos !== "number") return;
  props.editor
    .chain()
    .focus()
    .setNodeSelection(pos)
    .updateAttributes("codeBlock", { language: "mermaid" })
    .run();
  sourceOpen.value = false;
}
const sourceOpen = ref(false),
  copied = ref(false);
const sourceId = "code-source-" + crypto.randomUUID();
let copyTimer: ReturnType<typeof setTimeout> | undefined;
function revealSelection() {
  if (!isMermaid.value || !editable.value || !props.editor.isFocused) return;
  const pos = props.getPos(),
    { from, to } = props.editor.state.selection;
  if (typeof pos === "number" && from > pos && to < pos + props.node.nodeSize)
    sourceOpen.value = true;
}
async function toggleSource() {
  sourceOpen.value = !sourceOpen.value;
  if (!sourceOpen.value && editable.value) {
    const pos = props.getPos();
    if (typeof pos === "number") props.editor.commands.setNodeSelection(pos);
  }
  if (sourceOpen.value && editable.value) {
    await nextTick();
    const pos = props.getPos();
    if (typeof pos === "number") {
      props.editor.commands.setTextSelection(pos + 1);
      props.editor.view.focus();
    }
  }
}
async function copySource() {
  try {
    await copyText(props.node.textContent);
    copied.value = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied.value = false), 2000);
  } catch {
    copied.value = false;
  }
}
onMounted(() => {
  props.editor.on("selectionUpdate", revealSelection);
  revealSelection();
});
onBeforeUnmount(() => {
  props.editor.off("selectionUpdate", revealSelection);
  clearTimeout(copyTimer);
});
watch(isMermaid, revealSelection);
const languages = [
  ["plaintext", "Plain text"],
  ["javascript", "JavaScript"],
  ["typescript", "TypeScript"],
  ["json", "JSON"],
  ["python", "Python"],
  ["bash", "Shell"],
  ["sql", "SQL"],
  ["xml", "HTML / XML"],
  ["css", "CSS"],
  ["yaml", "YAML"],
  ["markdown", "Markdown"],
  ["mermaid", "Mermaid"],
  ["go", "Go"],
  ["rust", "Rust"],
  ["java", "Java"],
  ["cpp", "C++"],
  ["c", "C"],
];
</script>
<template>
  <NodeViewWrapper class="code-block" :class="{ 'mermaid-block': isMermaid }"
    ><div class="code-block-controls" contenteditable="false">
      <AppIcon :name="isMermaid ? 'diagram' : 'code'" :size="14" /><select
        aria-label="Code language"
        :value="node.attrs.language || 'plaintext'"
        :disabled="!editable"
        @change="
          updateAttributes({
            language: ($event.target as HTMLSelectElement).value,
          })
        "
      >
        <option
          v-if="
            node.attrs.language &&
            !languages.some((l) => l[0] === node.attrs.language)
          "
          :value="node.attrs.language"
        >
          {{ node.attrs.language }}
        </option>
        <option
          v-for="language in languages"
          :key="language[0]"
          :value="language[0]"
        >
          {{ language[1] }}
        </option>
      </select>
      <button
        v-if="!isMermaid && canRenderMermaid"
        type="button"
        class="ghost mermaid-render-action"
        title="Render this code as a Mermaid diagram"
        @click="renderDiagram"
      >
        <AppIcon name="diagram" :size="14" />Render diagram
      </button>
      <template v-if="isMermaid">
        <div class="mermaid-controls">
          <button
            type="button"
            class="ghost"
            :aria-controls="sourceId"
            :aria-expanded="sourceOpen"
            @click="toggleSource"
          >
            <AppIcon name="code" :size="14" />{{
              sourceOpen
                ? "Hide source"
                : editable
                  ? "Edit diagram"
                  : "Show source"
            }}
          </button>
          <button
            type="button"
            class="ghost"
            :aria-label="copied ? 'Code copied' : 'Copy Mermaid code'"
            @click="copySource"
          >
            <AppIcon :name="copied ? 'check' : 'copy'" :size="14" />
          </button>
        </div>
      </template>
    </div>
    <pre
      :id="sourceId"
      v-show="!isMermaid || sourceOpen"
    ><NodeViewContent as="code" spellcheck="false"/></pre>
    <MermaidPreview
      v-if="isMermaid"
      :source="node.textContent"
      @error="editable && (sourceOpen = true)"
    />
  </NodeViewWrapper>
</template>
<style>
.mermaid-render-action {
  margin-left: auto;
  min-height: 26px;
  padding: 3px 7px;
  font-size: 0.75rem;
}
.code-block {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  overflow: hidden;
  margin: 16px 0;
}
.code-block-controls {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  color: var(--muted);
  border-bottom: 1px solid var(--line-soft);
}
.code-block-controls select {
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 0.75rem;
  padding: 2px;
  min-height: 24px;
  width: auto;
}
.mermaid-controls {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.mermaid-controls button {
  min-height: 26px;
  padding: 3px 6px;
  font-size: 0.73rem;
  color: var(--muted);
}
.mermaid-block pre {
  border-bottom: 1px solid var(--line-soft) !important;
}
.block-editor .tiptap .code-block pre {
  margin: 0;
  border: 0;
  border-radius: 0;
  padding: 16px;
  background: transparent;
  white-space: pre;
  overflow: auto;
}
.code-block code {
  font-family: "JetBrains Mono Variable", monospace;
  font-size: 0.93rem;
}
.code-block .hljs-keyword,
.code-block .hljs-selector-tag,
.code-block .hljs-literal {
  color: var(--accent);
}
.code-block .hljs-string,
.code-block .hljs-attr,
.code-block .hljs-template-tag {
  color: var(--success);
}
.code-block .hljs-number,
.code-block .hljs-built_in,
.code-block .hljs-type {
  color: var(--warning);
}
.code-block .hljs-comment,
.code-block .hljs-quote {
  color: var(--faint);
  font-style: italic;
}
.code-block .hljs-title,
.code-block .hljs-section {
  color: var(--text);
  font-weight: 600;
}
</style>

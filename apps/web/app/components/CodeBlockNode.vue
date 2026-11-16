<script setup lang="ts">
import {
  NodeViewWrapper,
  NodeViewContent,
  type NodeViewProps,
} from "@tiptap/vue-3";
const props = defineProps<NodeViewProps>(),
  editable = useNodeEditable(props.editor);
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
  ["go", "Go"],
  ["rust", "Rust"],
  ["java", "Java"],
  ["cpp", "C++"],
  ["c", "C"],
];
</script>
<template>
  <NodeViewWrapper class="code-block"
    ><div class="code-block-controls" contenteditable="false">
      <AppIcon name="code" :size="14" /><select
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
    </div>
    <pre><NodeViewContent as="code" spellcheck="false"/></pre>
  </NodeViewWrapper>
</template>
<style>
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

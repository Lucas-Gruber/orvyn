<script setup lang="ts">
import type { PublicationSnapshot } from "@orvyn/shared";

import PublicInline from "./PublicInline";
const props = defineProps<{
  node: any;
  snapshot: PublicationSnapshot;
  fileUrl: (id: string) => string;
}>();
const target = computed(() =>
  props.snapshot.pages.find((p) => p.id === props.node.attrs?.pageId),
);
const file = computed(() =>
  props.snapshot.files.find((f) => f.id === props.node.attrs?.fileId),
);
const headingTag = computed(
  () =>
    ("h" + Math.min(4, Math.max(1, props.node.attrs?.level || 1))) as
      "h1" | "h2" | "h3" | "h4",
);
const headings = inject<
  ComputedRef<{ id: string; text: string; level: number }[]>
>(
  "orvyn.public.headings",
  computed(() => []),
);
const rows = computed(() =>
  props.node.type === "table" ? props.node.content || [] : [],
);
const widths = computed(() => {
  const result: number[] = [];
  for (const cell of rows.value[0]?.content || [])
    for (let i = 0; i < (cell.attrs?.colspan || 1); i++)
      result.push(cell.attrs?.colwidth?.[i] || 120);
  return result;
});
</script>
<template>
  <PublicInline
    v-if="node.type === 'text' || node.type === 'hardBreak'"
    :node="node"
  />
  <component
    :is="headingTag"
    v-else-if="node.type === 'heading'"
    :id="'h-' + node.attrs.id"
    ><PublicDocumentNode
      v-for="(child, i) in node.content"
      :key="i"
      :node="child"
      :snapshot="snapshot"
      :file-url="fileUrl"
  /></component>
  <div v-else-if="node.type === 'table'" class="public-table-scroll">
    <table :style="{ minWidth: widths.reduce((a, b) => a + b, 0) + 'px' }">
      <colgroup>
        <col
          v-for="(width, i) in widths"
          :key="i"
          :style="{ width: width + 'px' }"
        />
      </colgroup>
      <tbody>
        <PublicDocumentNode
          v-for="(child, i) in node.content"
          :key="i"
          :node="child"
          :snapshot="snapshot"
          :file-url="fileUrl"
        />
      </tbody>
    </table>
  </div>
  <component
    :is="node.type === 'tableHeader' ? 'th' : 'td'"
    v-else-if="['tableCell', 'tableHeader'].includes(node.type)"
    :colspan="node.attrs?.colspan"
    :rowspan="node.attrs?.rowspan"
    ><PublicDocumentNode
      v-for="(child, i) in node.content"
      :key="i"
      :node="child"
      :snapshot="snapshot"
      :file-url="fileUrl"
  /></component>
  <pre
    v-else-if="node.type === 'codeBlock'"
  ><code><PublicDocumentNode v-for="(child,i) in node.content" :key="i" :node="child" :snapshot="snapshot" :file-url="fileUrl" /></code></pre>
  <figure v-else-if="node.type === 'orvynImage' && file">
    <img
      :src="fileUrl(file.id)"
      :alt="node.attrs.label || 'Published image'"
      loading="lazy"
    />
    <figcaption v-if="node.attrs.label">{{ node.attrs.label }}</figcaption>
  </figure>
  <a
    v-else-if="node.type === 'orvynFile' && file"
    :href="fileUrl(file.id)"
    class="public-file"
    ><AppIcon name="paperclip" :size="18" /><span>{{
      node.attrs.label || file.filename
    }}</span
    ><AppIcon name="download" :size="15"
  /></a>
  <a
    v-else-if="node.type === 'orvynPagePreview' && target"
    :href="
      '?page=' +
      target.id +
      (node.attrs.headingId ? '#h-' + node.attrs.headingId : '')
    "
    class="public-page-card"
    ><PageSymbol :icon="target.icon" :kind="target.kind" /><span>{{
      target.title
    }}</span
    ><AppIcon name="arrowRight" :size="16"
  /></a>
  <div
    v-else-if="node.type === 'orvynWhiteboard' && target?.whiteboard"
    class="public-canvas-embed"
  >
    <a :href="'?page=' + target.id"
      ><AppIcon name="whiteboard" :size="16" />{{ target.title
      }}<AppIcon name="external" :size="14" /></a
    ><PublicationPublicCanvas
      :scene="target.whiteboard"
      :file-url="fileUrl"
      :key="target.id"
    />
  </div>
  <VideoEmbedPublic v-else-if="node.type === 'orvynVideo'" :node="node" />
  <details v-else-if="node.type === 'orvynToggle'">
    <PublicDocumentNode
      v-for="(child, i) in node.content"
      :key="i"
      :node="child"
      :snapshot="snapshot"
      :file-url="fileUrl"
    />
  </details>
  <aside
    v-else-if="node.type === 'orvynCallout'"
    class="public-callout"
    :data-tone="node.attrs.tone"
  >
    <PublicDocumentNode
      v-for="(child, i) in node.content"
      :key="i"
      :node="child"
      :snapshot="snapshot"
      :file-url="fileUrl"
    />
  </aside>
  <div
    v-else-if="node.type === 'orvynColumns'"
    class="public-columns"
    :style="{
      gridTemplateColumns: (node.attrs.widths || node.content.map(() => 1))
        .map((n: number) => n + 'fr')
        .join(' '),
    }"
  >
    <PublicDocumentNode
      v-for="(child, i) in node.content"
      :key="i"
      :node="child"
      :snapshot="snapshot"
      :file-url="fileUrl"
    />
  </div>
  <li v-else-if="node.type === 'taskItem'" class="public-task">
    <input
      type="checkbox"
      :checked="node.attrs.checked"
      disabled
      aria-label="Completed task"
    />
    <div>
      <PublicDocumentNode
        v-for="(child, i) in node.content"
        :key="i"
        :node="child"
        :snapshot="snapshot"
        :file-url="fileUrl"
      />
    </div>
  </li>
  <nav
    v-else-if="node.type === 'orvynToc'"
    aria-label="On this page"
    class="public-toc"
  >
    <a
      v-for="heading in headings"
      :key="heading.id"
      :href="'#h-' + heading.id"
      :style="{
        display: 'block',
        paddingLeft: (heading.level - 1) * 12 + 'px',
      }"
      >{{ heading.text }}</a
    >
  </nav>
  <hr v-else-if="node.type === 'horizontalRule'" />
  <component
    :is="
      (
        {
          doc: 'div',
          paragraph: 'p',
          bulletList: 'ul',
          orderedList: 'ol',
          listItem: 'li',
          taskList: 'ul',
          blockquote: 'blockquote',
          tableRow: 'tr',
          orvynToggleSummary: 'summary',
          orvynToggleContent: 'div',
          orvynColumn: 'div',
        } as Record<string, string>
      )[node.type] || 'div'
    "
    v-else
    :start="node.type === 'orderedList' ? node.attrs?.start : undefined"
    ><PublicDocumentNode
      v-for="(child, i) in node.content"
      :key="i"
      :node="child"
      :snapshot="snapshot"
      :file-url="fileUrl"
  /></component>
</template>

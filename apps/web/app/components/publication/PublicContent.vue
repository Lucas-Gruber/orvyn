<script setup lang="ts">
import type { PublicationSnapshot } from "@orvyn/shared";
import { documentHeadings } from "@orvyn/editor/links";
import { publicationTrail } from "../../utils/publicationTree";
import PublicValue from "./PublicValue.vue";
import PublicDocumentNode from "./PublicDocumentNode.vue";
const props = defineProps<{
  snapshot: PublicationSnapshot;
  pageId?: string;
  fileUrl: (id: string) => string;
  preview?: boolean;
}>();
const selected = ref("");
function navigatePreview(event: MouseEvent) {
  if (!props.preview || !(event.target instanceof Element)) return;
  const anchor = event.target.closest("a[href]");
  const href = anchor?.getAttribute("href");
  if (!href?.startsWith("?page=")) return;
  const url = new URL(href, window.location.href),
    id = url.searchParams.get("page");
  if (!props.snapshot.pages.some((page) => page.id === id)) return;
  event.preventDefault();
  event.stopPropagation();
  selected.value = id!;
  void nextTick(() => {
    if (url.hash)
      document
        .getElementById(url.hash.slice(1))
        ?.scrollIntoView({ block: "start" });
  });
}
const page = computed(() =>
  props.snapshot.pages.find(
    (p) =>
      p.id ===
      (props.preview
        ? selected.value || props.snapshot.rootId
        : props.pageId || props.snapshot.rootId),
  ),
);
const additionalFiles = computed(() =>
  props.snapshot.files.filter((file) =>
    props.snapshot.attachmentIds.includes(file.id),
  ),
);
const trail = computed(() =>
  publicationTrail(
    props.snapshot.pages,
    props.snapshot.rootId,
    page.value?.id || props.snapshot.rootId,
  ),
);
provide(
  "orvyn.public.headings",
  computed(() => documentHeadings(page.value?.document || {})),
);
watch(
  () => props.snapshot,
  () => (selected.value = ""),
);
</script>
<template>
  <div
    class="publication-content"
    :class="{ 'has-sidebar': !preview && snapshot.pages.length > 1 }"
    @click.capture="navigatePreview"
  >
    <PublicationNavigation
      v-if="snapshot.pages.length > 1"
      :snapshot="snapshot"
      :active-id="page?.id || snapshot.rootId"
      :preview="preview"
      @select="selected = $event"
    />
    <article
      v-if="page"
      :key="page.id"
      :class="{ 'has-canvas': !!page.whiteboard || !!page.database }"
    >
      <nav
        v-if="trail.length > 1"
        class="publication-breadcrumbs"
        aria-label="Published breadcrumbs"
      >
        <template v-for="ancestor in trail.slice(0, -1)" :key="ancestor.id"
          ><component
            :is="preview ? 'button' : 'a'"
            :href="preview ? undefined : '?page=' + ancestor.id"
            @click="preview && (selected = ancestor.id)"
            >{{ ancestor.title }}</component
          ><AppIcon name="chevronRight" :size="12" /></template
        ><span>{{ page.title }}</span>
      </nav>
      <div
        v-if="page.coverFileId || page.coverPreset"
        class="publication-cover"
        :class="'publication-cover-' + page.coverPreset"
      >
        <img
          v-if="page.coverFileId"
          :src="fileUrl(page.coverFileId)"
          alt="Page cover"
        />
      </div>
      <header class="publication-title">
        <PageSymbol v-if="page.icon" :icon="page.icon" :size="44" />
        <h1>{{ page.title }}</h1>
      </header>
      <PublicationPublicCanvas
        v-if="page.whiteboard"
        :scene="page.whiteboard"
        :file-url="fileUrl"
      />
      <PublicationPublicDatabase
        v-else-if="page.database"
        :database="page.database"
        :snapshot="snapshot"
        :file-url="fileUrl"
      />
      <div v-if="page.record" class="public-page-properties">
        <div
          v-for="property in page.record.properties.filter(
            (property) => property.type !== 'Title',
          )"
          :key="property.id"
        >
          <span>{{ property.name }}</span><PublicValue
            :property="property"
            :value="page.record.values[property.id]"
            :snapshot="snapshot"
            :file-url="fileUrl"
          />
        </div>
      </div>
      <PublicDocumentNode
        v-if="!page.whiteboard && !page.database"
        :node="page.document"
        :snapshot="snapshot"
        :file-url="fileUrl"
      />
      <div v-if="additionalFiles.length" class="publication-attachments">
        <details>
          <summary>Shared attachments</summary>
          <a
            v-for="file in additionalFiles"
            :key="file.id"
            :href="fileUrl(file.id)"
            class="public-file"
            ><AppIcon name="paperclip" :size="16" />{{ file.filename
            }}<AppIcon name="download" :size="14"
          /></a>
        </details>
      </div>
    </article>
    <div v-else class="publication-missing">
      <AppIcon name="file" :size="28" />
      <h1>This page is not included</h1>
      <p>Choose one of the pages in this publication.</p>
      <a :href="'?page=' + snapshot.rootId">Back to the first page</a>
    </div>
  </div>
</template>
<style>
.publication-breadcrumbs {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  margin: -16px 0 28px;
  font-size: 11px;
  color: var(--muted);
}
.publication-content .publication-breadcrumbs :is(a, button) {
  border: 0;
  background: none;
  font-size: 11px;
  padding: 0;
  min-height: 24px;
  line-height: 1.4;
  text-decoration: none;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.publication-breadcrumbs > span {
  overflow-wrap: anywhere;
}
.publication-breadcrumbs > .app-icon {
  flex-shrink: 0;
}
.publication-content.has-sidebar {
  flex: 1;
}
.publication-content.has-sidebar article {
  width: 100%;
}
@media (min-width: 1000px) {
  .publication-content.has-sidebar {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
  }
  .publication-content.has-sidebar article {
    max-width: 900px;
  }
  .publication-content.has-sidebar article.has-canvas {
    max-width: 1100px;
  }
}
.publication-content {
  width: 100%;
  min-width: 0;
  line-height: 1.75;
  font-size: 15px;
}
.publication-content article {
  max-width: 780px;
  margin: 0 auto;
  padding: 56px 40px 80px;
  min-width: 0;
}
.publication-content article.has-canvas {
  max-width: 1100px;
}
.publication-title {
  margin-bottom: 32px;
}
.publication-title h1 {
  font-size: 38px;
  font-weight: 700;
  letter-spacing: -1.2px;
  line-height: 1.2;
  margin: 14px 0 0;
  overflow-wrap: anywhere;
}
.publication-content article h1:not(.publication-title h1) {
  font-size: 30px;
}
.publication-content article h2 {
  font-size: 25px;
  margin-top: 36px;
}
.publication-content article h3 {
  font-size: 20px;
  margin-top: 28px;
}
.publication-content article h4 {
  font-size: 17px;
  margin-top: 24px;
}
.publication-content article :is(h1, h2, h3, h4) {
  line-height: 1.3;
  scroll-margin-top: 80px;
  letter-spacing: -0.025em;
}
.public-page-properties {
  border-block: 1px solid var(--line);
  padding: 14px 0;
  margin-bottom: 28px;
}
.public-page-properties > div {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 16px;
  padding: 8px 0;
  font-size: 13px;
}
.public-page-properties > div > span {
  font-size: 12px;
  color: var(--muted);
}
.publication-content p {
  color: var(--text);
  margin: 8px 0;
  min-height: 1em;
  overflow-wrap: anywhere;
}
.publication-content a {
  color: inherit;
  text-decoration: underline;
  text-decoration-color: var(--muted);
  text-underline-offset: 3px;
  cursor: pointer;
}
.publication-content a:hover {
  color: var(--accent);
}
.publication-content blockquote {
  margin: 20px 0;
  padding: 3px 20px;
  border-left: 3px solid var(--text);
}
.publication-content pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--surface);
  border-radius: 6px;
  padding: 20px;
  font-size: 13px;
}
.publication-content code {
  font-family: "JetBrains Mono Variable", monospace;
  background: var(--surface);
  border-radius: 3px;
  padding: 2px 4px;
  font-size: 0.87em;
}
.publication-content pre code {
  padding: 0;
  background: none;
}
.publication-content hr {
  border: 0;
  border-top: 1px solid var(--line);
  margin: 28px 0;
}
.publication-content details {
  margin: 12px 0;
}
.publication-content summary {
  cursor: pointer;
  font-weight: 500;
  padding: 4px 0;
}
.publication-content details > div {
  padding-left: 22px;
}
.publication-content figure {
  margin: 24px 0;
}
.publication-content figure img {
  display: block;
  max-width: 100%;
  height: auto;
  margin: auto;
  border-radius: 5px;
}
.publication-content figcaption {
  text-align: center;
  font-size: 12px;
  color: var(--muted);
  margin-top: 8px;
}
.public-table-scroll {
  overflow: auto;
  margin: 22px 0;
  border: 1px solid var(--line);
  border-radius: 5px;
}
.public-table-scroll table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
.public-table-scroll :is(td, th) {
  border: 1px solid var(--line);
  padding: 8px 12px;
  vertical-align: top;
  text-align: left;
}
.public-table-scroll th {
  background: var(--surface);
  font-weight: 600;
}
.public-table-scroll :is(td, th) p {
  margin: 0;
}
.public-callout {
  padding: 16px 20px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 7px;
  margin: 20px 0;
}
.public-callout[data-tone="info"] {
  background: color-mix(in srgb, var(--accent) 7%, var(--panel));
}
.public-callout[data-tone="success"] {
  background: #eaf6ed;
  color: #294e32;
}
.public-callout[data-tone="warning"] {
  background: #fbf2d9;
  color: #614f1d;
}
.public-callout[data-tone="danger"] {
  background: #faeaea;
  color: #783434;
}
.public-columns {
  display: grid;
  gap: 24px;
  align-items: start;
  margin: 20px 0;
}
.public-columns > div {
  min-width: 0;
}
.public-task {
  display: flex;
  gap: 10px;
  align-items: baseline;
  list-style: none;
}
.public-task > div {
  min-width: 0;
}
.public-task input:checked + div {
  text-decoration: line-through;
  color: var(--muted);
}
.public-file,
.public-page-card {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 12px 14px;
  margin: 10px 0;
  text-decoration: none !important;
  overflow-wrap: anywhere;
}
.public-file :last-child,
.public-page-card :last-child {
  margin-left: auto;
  flex-shrink: 0;
}
.public-canvas-embed {
  margin: 24px 0;
}
.public-canvas-embed > a {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 8px;
  text-decoration: none;
}
.publication-cover {
  height: 180px;
  background: linear-gradient(120deg, #dde9e4, #eadfcf);
  border-radius: 8px;
  margin-bottom: 36px;
  overflow: hidden;
}
.publication-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.publication-cover-aurora {
  background: linear-gradient(120deg, #b8e0d4, #d1c9ea);
}
.publication-cover-sunset {
  background: linear-gradient(120deg, #f4d2bd, #d2bed9);
}
.publication-attachments {
  border-top: 1px solid var(--line);
  margin-top: 48px;
  padding-top: 14px;
  color: var(--muted);
  font-size: 13px;
}
.publication-missing {
  padding: 80px 24px;
  text-align: center;
}
.publication-missing h1 {
  font-size: 24px;
}
@media (max-width: 600px) {
  .publication-content article {
    padding: 32px 22px 60px;
  }
  .publication-title h1 {
    font-size: 30px;
    letter-spacing: -0.8px;
  }
  .public-columns {
    display: block;
  }
  .public-columns > div + div {
    margin-top: 16px;
  }
  .publication-cover {
    height: 130px;
    margin-bottom: 24px;
  }
}
</style>

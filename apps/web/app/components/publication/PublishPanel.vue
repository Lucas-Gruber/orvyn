<script setup lang="ts">
import type { PublicationInput, PublicationSnapshot } from "@orvyn/shared";
import { copyText } from "../../utils/clipboard";
const props = defineProps<{ page: any; flush?: () => Promise<void> }>();
const path = computed(() => "/api/v1/pages/" + props.page.id + "/publications");
const links = ref<any[]>([]),
  choices = ref<any[]>([]),
  files = ref<any[]>([]),
  selected = ref<string[]>([]),
  extras = ref<string[]>([]),
  search = ref(""),
  label = ref("Published page"),
  protectedLink = ref(false),
  password = ref(""),
  expires = ref(""),
  indexable = ref(false),
  target = ref<any>(null),
  error = ref(""),
  notice = ref(""),
  reviewError = ref(""),
  busy = ref(false),
  review = ref<{
    snapshot: PublicationSnapshot;
    warnings: any;
    previewToken: string;
    input: PublicationInput;
    requestId: string;
  } | null>(null),
  previewOpen = ref(false);
const databaseScopes = ref<PublicationInput["scope"]["databases"]>([]),
  scopeGeneration = ref(0);
const totalRecords = computed(() =>
  databaseScopes.value.reduce((sum, item) => sum + item.recordIds.length, 0),
);
function syncDatabases() {
  const ids = new Set([
    ...choices.value
      .filter(
        (page) => page.kind === "database" && selected.value.includes(page.id),
      )
      .map((page) => page.id),
    ...(props.page.kind === "database" ? [props.page.id] : []),
  ]);
  const removed = databaseScopes.value
    .filter((scope) => !ids.has(scope.databaseId))
    .flatMap((scope) => scope.recordIds);
  if (removed.some((id) => selected.value.includes(id)))
    selected.value = selected.value.filter((id) => !removed.includes(id));
  databaseScopes.value = [...ids].map(
    (id) =>
      databaseScopes.value.find((scope) => scope.databaseId === id) || {
        databaseId: id,
        viewId: "",
        recordIds: [],
        propertyIds: [],
      },
  );
}
watch([selected, choices], syncDatabases, { immediate: true });
function setDatabase(value: PublicationInput["scope"]["databases"][number]) {
  databaseScopes.value = databaseScopes.value.map((scope) =>
    scope.databaseId === value.databaseId ? value : scope,
  );
}
const count = computed(() => new Set([props.page.id, ...selected.value]).size);
const filtered = computed(() =>
  choices.value.filter(
    (p) =>
      p.title.toLowerCase().includes(search.value.toLowerCase()) ||
      selected.value.includes(p.id),
  ),
);
let alive = true,
  searchTimer: ReturnType<typeof setTimeout> | undefined,
  choiceEpoch = 0;
watch(
  [
    selected,
    databaseScopes,
    extras,
    label,
    protectedLink,
    password,
    expires,
    indexable,
    target,
  ],
  () => {
    review.value = null;
    reviewError.value = "";
    previewOpen.value = false;
  },
  { deep: true, flush: "sync" },
);
watch(protectedLink, (value) => {
  if (value) indexable.value = false;
});
async function loadLinks() {
  links.value = await $fetch<any[]>(path.value);
}
async function loadChoices() {
  const epoch = ++choiceEpoch;
  try {
    const result = await $fetch<any>(path.value + "/choices", {
      query: { q: search.value, selected: selected.value.join(",") },
    });
    if (alive && epoch === choiceEpoch) {
      const keep = choices.value.filter((p) => selected.value.includes(p.id));
      choices.value = [
        ...new Map(
          [...result.pages, ...keep].map((p: any) => [p.id, p]),
        ).values(),
      ];
    }
  } catch (e: any) {
    if (alive && epoch === choiceEpoch)
      error.value = e.data?.message || "Could not load pages.";
  }
}
watch(search, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadChoices, 250);
});
onMounted(async () => {
  label.value = props.page.title.slice(0, 100) || "Published page";
  try {
    await Promise.all([
      loadLinks(),
      loadChoices(),
      (async () => {
        const list = await $fetch<any[]>(
          `/api/v1/pages/${props.page.id}/files`,
        );
        if (alive)
          files.value = list.filter(
            (f) =>
              !JSON.stringify(props.page.document || {}).includes(f.id) &&
              props.page.cover_file_id !== f.id,
          );
      })(),
    ]);
  } catch (e: any) {
    if (alive) error.value = e.data?.message || "Could not load sharing.";
  }
});
onBeforeUnmount(() => {
  alive = false;
  choiceEpoch++;
  clearTimeout(searchTimer);
  password.value = "";
});
function edit(link: any) {
  target.value = { id: link.id, version: link.version };
  selected.value = [
    ...new Set([
      ...link.scope.pageIds,
      ...link.scope.databases.map((scope: any) => scope.databaseId),
    ]),
  ];
  databaseScopes.value = link.scope.databases.map((scope: any) => ({
    ...scope,
    recordIds: [...scope.recordIds],
    propertyIds: [...scope.propertyIds],
  }));
  scopeGeneration.value++;
  extras.value = [...link.scope.extraFileIds];
  label.value = link.label;
  protectedLink.value = link.passwordProtected;
  password.value = "";
  expires.value = link.expiresAt
    ? new Date(
        new Date(link.expiresAt).getTime() -
          new Date(link.expiresAt).getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16)
    : "";
  indexable.value = link.indexable;
  notice.value = "Review a fresh snapshot before updating this link.";
  void loadChoices();
}
function linkState(link: any) {
  return link.revokedAt
    ? "Revoked"
    : !link.enabled
      ? "Off"
      : link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()
        ? "Expired"
        : "Live";
}
function fresh() {
  target.value = null;
  selected.value = [];
  databaseScopes.value = [];
  syncDatabases();
  scopeGeneration.value++;
  extras.value = [];
  password.value = "";
  review.value = null;
  notice.value = "";
}
function input(): PublicationInput {
  return {
    scope: {
      pageIds: selected.value.filter((id) => id !== props.page.id),
      databases: databaseScopes.value.map((scope) => ({
        ...scope,
        recordIds: [...scope.recordIds],
        propertyIds: [...scope.propertyIds],
      })),
      extraFileIds: extras.value,
    },
    settings: {
      label: label.value.trim(),
      passwordProtected: protectedLink.value,
      ...(protectedLink.value && password.value
        ? { password: password.value }
        : {}),
      expiresAt: expires.value ? new Date(expires.value).toISOString() : null,
      indexable: indexable.value,
    },
    target: target.value,
  };
}
async function prepare() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await props.flush?.();
    if (!alive) return;
    const value = input(),
      result = await $fetch<any>(path.value + "/preview", {
        method: "POST",
        body: value,
      });
    if (alive) {
      review.value = {
        ...result,
        input: value,
        requestId: crypto.randomUUID(),
      };
      reviewError.value = "";
      previewOpen.value = true;
    }
  } catch (e: any) {
    if (alive)
      error.value = e.data?.message || "Could not prepare the preview.";
  } finally {
    if (alive) busy.value = false;
  }
}
async function publish() {
  if (busy.value || !review.value) return;
  busy.value = true;
  error.value = "";
  reviewError.value = "";
  try {
    const reviewed = review.value;
    const body = {
      requestId: reviewed.requestId,
      previewToken: reviewed.previewToken,
      input: reviewed.input,
    };
    let link: any;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        link = await $fetch<any>(path.value, { method: "POST", body });
        break;
      } catch (e: any) {
        const status = e.statusCode || e.response?.status || 0;
        if (attempt === 0 && (!status || status >= 500)) continue;
        throw e;
      }
    }
    if (!alive) return;
    await loadLinks();
    review.value = null;
    previewOpen.value = false;
    target.value = null;
    password.value = "";
    notice.value = link.revokedAt
      ? "The snapshot was saved, but this link was revoked after source access changed. Review and create a new link."
      : !link.enabled
        ? "The snapshot is saved. This link is currently turned off."
        : "Published. Copy the link below to share this snapshot.";
  } catch (e: any) {
    if (alive) {
      const status = e.statusCode || e.response?.status || 0;
      if (!status || status >= 500) {
        reviewError.value =
          "Could not confirm the publication. Retry to check the result; the same request will not create another link.";
      } else {
        review.value = null;
        previewOpen.value = false;
        error.value = e.data?.message || "Could not publish this page.";
      }
    }
  } finally {
    if (alive) busy.value = false;
  }
}
function closeReview() {
  previewOpen.value = false;
  if (reviewError.value) void loadLinks().catch(() => {});
}
async function change(link: any, remove = false) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await $fetch(path.value + "/" + link.id, {
      method: remove ? "DELETE" : "PATCH",
      body: remove ? {} : { version: link.version, enabled: !link.enabled },
    });
    if (alive) {
      await loadLinks();
      review.value = null;
      notice.value = remove
        ? "Link revoked. A new publication needs a new link."
        : link.enabled
          ? "Link turned off."
          : "Link turned on.";
    }
  } catch (e: any) {
    if (alive) error.value = e.data?.message || "Could not update this link.";
  } finally {
    if (alive) busy.value = false;
  }
}
async function copy(link: any) {
  try {
    await copyText(link.url);
    notice.value = "Link copied.";
  } catch (e: any) {
    error.value = e.message;
  }
}
const previewFile = (id: string) => "/api/v1/files/" + id + "/preview";
</script>
<template>
  <div class="publish-panel">
    <p class="publish-intro">
      Share a read-only snapshot with anyone who has the link. Choose exactly
      which pages to include.
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="publish-notice" role="status">{{ notice }}</p>
    <div v-if="links.length" class="published-links">
      <h3>
        Published links <span>{{ links.length }}</span>
      </h3>
      <div v-for="link in links" :key="link.id" class="published-link">
        <div class="published-link-title">
          <AppIcon
            :name="link.revokedAt ? 'lock' : 'globe'"
            :size="17"
          /><strong>{{ link.label }}</strong
          ><span class="publish-state">{{ linkState(link) }}</span>
        </div>
        <p>
          {{ link.pages }} {{ link.pages === 1 ? "page" : "pages"
          }}<span v-if="link.passwordProtected"> · Password protected</span
          ><span v-if="link.expiresAt">
            · Until {{ new Date(link.expiresAt).toLocaleDateString() }}</span
          >
        </p>
        <p
          v-if="link.revokedReason === 'source-access-changed'"
          class="publish-revoked"
        >
          Source permissions changed. Create a new link after reviewing the
          content.
        </p>
        <div class="published-link-actions">
          <button :disabled="!!link.revokedAt || busy" @click="copy(link)">
            <AppIcon name="copy" :size="14" />Copy link</button
          ><a
            v-if="!link.revokedAt && link.enabled"
            :href="link.url"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open published page"
            ><AppIcon name="external" :size="15" /></a
          ><UiMenu v-if="!link.revokedAt" label="Published link actions"
            ><button role="menuitem" :disabled="busy" @click="edit(link)">
              <AppIcon name="refresh" :size="15" />Update snapshot</button
            ><button role="menuitem" :disabled="busy" @click="change(link)">
              <AppIcon name="globe" :size="15" />{{
                link.enabled ? "Turn link off" : "Turn link on"
              }}
            </button>
            <hr />
            <button
              role="menuitem"
              class="danger-text"
              :disabled="busy"
              @click="change(link, true)"
            >
              <AppIcon name="trash" :size="15" />Revoke link permanently
            </button></UiMenu
          >
        </div>
      </div>
    </div>
    <form @submit.prevent="prepare">
      <div class="publish-section-heading">
        <h3>{{ target ? "Update published snapshot" : "New publication" }}</h3>
        <button v-if="target" type="button" class="ghost" @click="fresh">
          New link
        </button>
      </div>
      <label class="publish-field"
        >Link name<input
          v-model="label"
          maxlength="100"
          required
          :disabled="busy"
      /></label>
      <div class="publish-selection-title">
        <span>Pages to include</span><span>{{ count }} / 100</span>
      </div>
      <div class="publish-page-search">
        <AppIcon name="search" :size="15" /><input
          v-model="search"
          placeholder="Find pages or whiteboards…"
          aria-label="Find pages to publish"
          :disabled="busy"
        />
      </div>
      <div class="publish-choices">
        <label class="publish-choice"
          ><input type="checkbox" checked disabled /><PageSymbol
            :kind="page.kind"
            :icon="page.icon"
            :size="16"
          /><span
            >{{ page.title }}<small>This page · Always included</small></span
          ></label
        ><label
          v-for="item in filtered.filter((p) => p.id !== page.id)"
          :key="item.id"
          class="publish-choice"
          ><input
            v-model="selected"
            type="checkbox"
            :value="item.id"
            :disabled="busy || (!selected.includes(item.id) && count >= 100)"
          /><PageSymbol :kind="item.kind" :size="16" /><span
            >{{ item.title }}<small>{{ item.space_name }}</small></span
          ></label
        >
      </div>
      <PublicationDatabaseScope
        v-for="scope in databaseScopes"
        :key="scope.databaseId + ':' + scopeGeneration"
        :root-id="page.id"
        :scope="scope"
        :record-pages="selected"
        :page-count="count"
        :total-records="totalRecords"
        :busy="busy"
        @change="setDatabase"
        @pages="selected = $event"
      />
      <p class="publish-hint">
        Subpages and linked pages are included only when selected. Images
        attached to selected pages are included; unrelated attachments stay
        private.
      </p>
      <details v-if="files.length" class="publish-extra">
        <summary>
          Additional attachments
          <span v-if="extras.length">({{ extras.length }} selected)</span>
        </summary>
        <label v-for="file in files" :key="file.id" class="publish-choice"
          ><input
            v-model="extras"
            type="checkbox"
            :value="file.id"
            :disabled="busy"
          /><AppIcon name="paperclip" :size="15" /><span>{{
            file.filename
          }}</span></label
        >
      </details>
      <div class="publish-options">
        <label class="publish-switch"
          ><AppIcon name="lock" :size="16" /><span>Password protection</span
          ><input
            v-model="protectedLink"
            type="checkbox"
            :disabled="busy" /></label
        ><input
          v-if="protectedLink"
          v-model="password"
          type="password"
          autocomplete="new-password"
          minlength="8"
          maxlength="256"
          :required="!target"
          :placeholder="
            target
              ? 'Leave blank to keep the current password'
              : 'At least 8 characters'
          "
          aria-label="Publication password"
          :disabled="busy"
        /><label class="publish-field"
          ><span><AppIcon name="calendar" :size="16" />Link expires</span
          ><input
            v-model="expires"
            type="datetime-local"
            aria-label="Link expires"
            :disabled="busy" /></label
        ><label class="publish-switch"
          ><AppIcon name="search" :size="16" /><span
            >Allow search engine indexing</span
          ><input
            v-model="indexable"
            type="checkbox"
            :disabled="protectedLink || busy"
        /></label>
      </div>
      <p class="publish-hint">
        Future edits stay private until you update the snapshot. Changing source
        permissions revokes this link.
      </p>
      <button
        class="primary publish-review"
        :disabled="
          busy || !label.trim() || databaseScopes.some((scope) => !scope.viewId)
        "
      >
        <AppIcon name="globe" :size="16" />{{
          busy ? "Preparing…" : "Review publication"
        }}<AppIcon name="arrowRight" :size="16" />
      </button>
    </form>
    <UiDialog
      :open="previewOpen && !!review"
      title="Review publication"
      :error="reviewError"
      wide
      @close="closeReview"
      ><template v-if="review"
        ><div class="publish-review-bar">
          <div>
            <strong
              >{{ review.snapshot.pages.length }} pages ·
              {{ review.snapshot.files.length }} attachments</strong
            >
            <p>
              Only the content below will be visible.
              {{
                protectedLink
                  ? "A password is required."
                  : "Anyone with the link can read it."
              }}
            </p>
          </div>
          <button class="primary" :disabled="busy" @click="publish">
            <AppIcon name="globe" :size="16" />{{
              busy
                ? "Publishing…"
                : reviewError
                  ? "Retry publication"
                  : target
                    ? "Update publication"
                    : "Publish snapshot"
            }}
          </button>
        </div>
        <div
          v-if="
            review.warnings.excludedBlocks ||
            review.warnings.excludedFiles ||
            review.warnings.anonymousMentions ||
            review.warnings.excludedRelations
          "
          class="publish-review-warning"
        >
          <AppIcon name="info" :size="16" /><span
            >{{ review.warnings.excludedBlocks }} linked blocks and
            {{ review.warnings.excludedFiles }} files excluded.
            {{ review.warnings.anonymousMentions }} person mentions anonymized.
            {{ review.warnings.excludedRelations || 0 }} links to unselected
            records excluded.</span
          >
        </div>
        <div class="publication-review-document">
          <PublicationPublicContent
            :snapshot="review.snapshot"
            :file-url="previewFile"
            preview
          /></div></template
    ></UiDialog>
  </div>
</template>
<style scoped>
.publish-intro {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.7;
  margin: 0 0 22px;
}
.publish-notice {
  font-size: 12px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--accent) 9%, var(--panel));
  border: 1px solid var(--line);
  border-radius: 6px;
}
.publish-panel h3 {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
}
.publish-panel h3 span {
  color: var(--muted);
  font-weight: 400;
  margin-left: 8px;
}
.published-links {
  border-bottom: 1px solid var(--line);
  padding-bottom: 24px;
  margin-bottom: 24px;
}
.published-links > h3 {
  margin-bottom: 12px;
}
.published-link {
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 7px;
  margin: 10px 0;
  background: var(--surface);
}
.published-link-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.published-link-title strong {
  font-weight: 500;
  overflow-wrap: anywhere;
  min-width: 0;
}
.publish-state {
  margin-left: auto;
  color: var(--muted);
  font-size: 10px;
  border: 1px solid var(--line);
  padding: 1px 6px;
  border-radius: 4px;
}
.published-link p {
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
  margin: 8px 0 12px;
}
.published-link-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.published-link-actions > button {
  font-size: 11px;
  min-height: 28px;
  padding: 4px 8px;
  background: var(--panel);
}
.published-link-actions > a {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--muted);
}
.published-link-actions :deep(.ui-menu) {
  margin-left: auto;
}
.publish-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.publish-section-heading button {
  font-size: 11px;
}
.publish-field {
  display: grid;
  gap: 7px;
  font-size: 12px;
  margin-bottom: 18px;
}
.publish-field > span {
  display: flex;
  gap: 8px;
  align-items: center;
}
.publish-panel input:not([type="checkbox"]) {
  min-width: 0;
  width: 100%;
  padding: 9px 10px;
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 5px;
  font-size: 12px;
}
.publish-selection-title {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  margin-bottom: 9px;
}
.publish-selection-title > span + span {
  color: var(--muted);
  font-size: 11px;
}
.publish-page-search {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--line);
  border-radius: 5px 5px 0 0;
  padding: 0 10px;
  color: var(--muted);
}
.publish-page-search input {
  border: 0 !important;
  padding-inline: 0 !important;
  outline: none;
}
.publish-choices {
  max-height: 235px;
  overflow: auto;
  border: 1px solid var(--line);
  border-top: 0;
  border-radius: 0 0 5px 5px;
  padding: 4px;
}
.publish-choice {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}
.publish-choice:hover {
  background: var(--surface);
}
.publish-choice > span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.publish-choice small {
  display: block;
  color: var(--muted);
  font-size: 10px;
  margin-top: 3px;
}
.publish-choice input,
.publish-switch input {
  accent-color: var(--accent);
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.publish-hint {
  font-size: 11px;
  line-height: 1.65;
  color: var(--muted);
  margin: 10px 0 20px;
}
.publish-options {
  display: grid;
  gap: 14px;
  border-block: 1px solid var(--line);
  padding: 16px 0;
  margin-top: 20px;
}
.publish-options .publish-field {
  margin: 0;
}
.publish-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  cursor: pointer;
}
.publish-switch > input {
  margin-left: auto;
}
.publish-extra {
  font-size: 12px;
  margin-top: 16px;
}
.publish-extra summary {
  cursor: pointer;
  color: var(--muted);
  padding: 6px 0;
}
.publish-review {
  width: 100%;
  font-size: 12px;
}
.publish-review-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding-bottom: 18px;
}
.publish-review-bar strong {
  font-size: 13px;
}
.publish-review-bar p {
  font-size: 12px;
  color: var(--muted);
  margin: 5px 0 0;
  line-height: 1.5;
}
.publish-review-bar button {
  white-space: nowrap;
  font-size: 12px;
}
.publication-review-document {
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel);
}
.publish-review-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  margin-bottom: 14px;
  font-size: 12px;
  color: var(--muted);
}
@media (max-width: 600px) {
  .publish-review-bar {
    align-items: flex-start;
    flex-direction: column;
  }
  .publish-review-bar button {
    width: 100%;
  }
}
</style>

<script setup lang="ts">
const props = defineProps<{
    kind: "database" | "record";
    spaceId?: string;
    databaseId?: string;
    canCreate: boolean;
    flushSource?: (id: string) => Promise<void>;
  }>(),
  emit = defineEmits<{ created: [id: string]; select: [template: any] }>(),
  open = ref(false),
  loading = ref(false),
  busy = ref(false),
  error = ref(""),
  query = ref(""),
  templates = ref<any[]>([]),
  nextCursor = ref<string | null>(null),
  selected = ref<any>(),
  editing = ref(false),
  name = ref(""),
  title = ref(""),
  privateCopy = ref(false),
  confirmDelete = ref(false);
const domId = useId();
let generation = 0,
  disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined,
  requestId = "",
  requestBody = "";
async function load(append = false) {
  const token = ++generation;
  loading.value = true;
  try {
    const url =
        props.kind === "database"
          ? `/api/v1/spaces/${props.spaceId}/templates`
          : `/api/v1/databases/${props.databaseId}/templates`,
      result = await $fetch<any>(url, {
        query: {
          q: query.value,
          ...(append && nextCursor.value ? { before: nextCursor.value } : {}),
        },
      });
    if (disposed || token !== generation) return;
    templates.value = append
      ? [
          ...templates.value,
          ...result.templates.filter(
            (t: any) => !templates.value.some((old) => old.id === t.id),
          ),
        ]
      : result.templates;
    nextCursor.value = result.nextCursor;
    error.value = "";
  } catch (e: any) {
    if (!disposed && token === generation) {
      error.value = e.data?.message || "Templates could not be loaded.";
      if (!append) templates.value = [];
    }
  } finally {
    if (token === generation) loading.value = false;
  }
}
function show() {
  open.value = true;
  selected.value = undefined;
  editing.value = false;
  confirmDelete.value = false;
  query.value = "";
  error.value = "";
  templates.value = [];
  nextCursor.value = null;
  void load();
}
async function choose(item: any) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const value = await $fetch<any>("/api/v1/templates/" + item.id);
    if (disposed || !open.value) return;
    selected.value = value;
    name.value = selected.value.name;
    title.value = selected.value.preview.title || selected.value.name;
    privateCopy.value = false;
    editing.value = false;
    confirmDelete.value = false;
  } catch (e: any) {
    selected.value = undefined;
    await load();
    error.value = e.data?.message || "This template is unavailable.";
  } finally {
    busy.value = false;
  }
}
async function use() {
  if (!selected.value || busy.value || !props.canCreate) return;
  error.value = "";
  if (props.kind === "record") {
    const value = selected.value;
    open.value = false;
    await nextTick();
    emit("select", value);
    return;
  }
  busy.value = true;
  try {
    const body = {
        version: selected.value.version,
        title: title.value,
        visibility: privateCopy.value ? "restricted" : "space",
      },
      fingerprint = JSON.stringify([selected.value.id, body]);
    if (fingerprint !== requestBody) {
      requestBody = fingerprint;
      requestId = crypto.randomUUID();
    }
    const result = await $fetch<any>(
      `/api/v1/templates/${selected.value.id}/apply`,
      { method: "POST", body: { ...body, requestId } },
    );
    open.value = false;
    emit("created", result.pageId);
  } catch (e: any) {
    error.value = e.data?.message || "Database could not be created.";
  } finally {
    busy.value = false;
  }
}
async function save(refresh = false) {
  if (!selected.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    if (refresh) await props.flushSource?.(selected.value.sourcePageId);
    await $fetch(`/api/v1/templates/${selected.value.id}`, {
      method: "PATCH",
      body: { name: name.value, version: selected.value.version, refresh },
    });
    const id = selected.value.id;
    await load();
    await chooseAfterSave(id);
  } catch (e: any) {
    error.value =
      e.data?.message || e.message || "Template could not be updated.";
  } finally {
    busy.value = false;
  }
}
async function chooseAfterSave(id: string) {
  selected.value = await $fetch<any>("/api/v1/templates/" + id);
  name.value = selected.value.name;
  editing.value = false;
}
async function remove() {
  if (!selected.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await $fetch(`/api/v1/templates/${selected.value.id}`, {
      method: "DELETE",
      body: { version: selected.value.version },
    });
    selected.value = undefined;
    confirmDelete.value = false;
    await load();
  } catch (e: any) {
    error.value = e.data?.message || "Template could not be deleted.";
  } finally {
    busy.value = false;
  }
}
watch(query, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (open.value) void load();
  }, 180);
});
watch(open, (value) => {
  if (!value) {
    generation++;
    loading.value = false;
    clearTimeout(timer);
  }
});
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  clearTimeout(timer);
});
defineExpose({
  open: show,
  close: () => {
    open.value = false;
  },
});
</script>
<template>
  <UiDialog
    :open="open"
    :title="kind === 'database' ? 'Database templates' : 'Record templates'"
    wide
    @close="open = false"
  >
    <div class="template-library">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <template v-if="!selected">
        <label class="template-search"
          ><AppIcon name="search" :size="16" /><input
            v-model="query"
            aria-label="Search templates"
            placeholder="Find a template…"
        /></label>
        <p v-if="loading" role="status" class="hint">Loading templates…</p>
        <div class="template-grid">
          <button
            v-for="item in templates"
            :key="item.id"
            class="template-card"
            :disabled="busy"
            @click="choose(item)"
          >
            <AppIcon
              :name="kind === 'database' ? 'database' : 'file'"
              :size="23"
            /><strong>{{ item.name }}</strong
            ><span>{{
              kind === "database"
                ? "Schema and saved views"
                : "Page content and defaults"
            }}</span>
          </button>
        </div>
        <p v-if="!loading && !templates.length" class="hint">
          {{
            query
              ? "No matching templates."
              : kind === "database"
                ? "Save a database as a template from its options menu."
                : "Save a record as a template from its page actions."
          }}
        </p>
        <button
          v-if="nextCursor"
          :disabled="loading || busy"
          @click="load(true)"
        >
          Load more templates
        </button>
      </template>
      <template v-else>
        <button
          class="ghost template-back"
          :disabled="busy"
          @click="selected = undefined"
        >
          ← All templates
        </button>
        <header class="template-detail">
          <AppIcon
            :name="kind === 'database' ? 'database' : 'file'"
            :size="27"
          />
          <h3>{{ selected.name }}</h3>
        </header>
        <p v-if="kind === 'database'" class="hint">
          {{ selected.preview.propertyCount }} properties ·
          {{ selected.preview.views.length }} saved views · Starts with no
          records
        </p>
        <p v-else class="template-excerpt">
          {{
            selected.preview.excerpt ||
            "An empty page with saved property defaults."
          }}
        </p>
        <p v-if="selected.preview.fileCount" class="hint">
          {{ selected.preview.fileCount }} attachment{{
            selected.preview.fileCount === 1 ? "" : "s"
          }}
          will be copied.
        </p>
        <ul v-if="kind === 'database'" class="template-views">
          <li v-for="(view, i) in selected.preview.views" :key="i">
            {{ view.name }}
          </li>
        </ul>
        <form v-if="canCreate" class="database-form" @submit.prevent="use">
          <template v-if="kind === 'database'"
            ><label :for="'template-database-name-' + domId"
              >Database name</label
            ><input
              :id="'template-database-name-' + domId"
              v-model="title"
              required
              maxlength="120"
              :disabled="busy"
            /><label class="template-checkbox"
              ><input
                v-model="privateCopy"
                type="checkbox"
                :disabled="busy"
              />Restrict this database to you and the space owner</label
            ></template
          >
          <button class="primary" :disabled="busy">
            {{ kind === "database" ? "Create database" : "Use this template" }}
          </button>
        </form>
        <section v-if="selected.canEdit" class="template-management">
          <button class="ghost" :disabled="busy" @click="editing = !editing">
            Manage template
          </button>
          <form
            v-if="editing"
            class="database-form"
            @submit.prevent="save(false)"
          >
            <label :for="'managed-template-name-' + domId">Template name</label
            ><input
              :id="'managed-template-name-' + domId"
              v-model="name"
              required
              maxlength="100"
              :disabled="busy"
            />
            <div class="actions">
              <button :disabled="busy">Rename</button
              ><button type="button" :disabled="busy" @click="save(true)">
                Refresh from source</button
              ><button
                type="button"
                class="danger"
                :disabled="busy"
                @click="confirmDelete = true"
              >
                Delete template
              </button>
            </div>
          </form>
          <div v-if="confirmDelete" class="template-delete">
            <p>Delete this saved template? Existing pages stay available.</p>
            <button class="danger" :disabled="busy" @click="remove">
              Delete saved template</button
            ><button
              class="ghost"
              :disabled="busy"
              @click="confirmDelete = false"
            >
              Cancel
            </button>
          </div>
        </section>
      </template>
    </div>
  </UiDialog>
</template>
<style scoped>
.template-library {
  display: grid;
  gap: 16px;
}
.template-search {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0 10px;
}
.template-search input {
  border: 0;
  background: transparent;
  box-shadow: none;
}
.template-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}
.template-card {
  display: grid;
  justify-items: start;
  align-content: start;
  gap: 10px;
  padding: 18px;
  min-height: 135px;
  text-align: left;
  border: 1px solid var(--line);
  background: var(--surface);
  border-radius: 8px;
}
.template-card:hover {
  border-color: var(--accent);
}
.template-card strong {
  overflow-wrap: anywhere;
}
.template-card span,
.template-excerpt {
  color: var(--muted);
  font-size: 0.8rem;
  line-height: 1.6;
}
.template-back {
  justify-self: start;
}
.template-detail {
  display: flex;
  gap: 12px;
  align-items: center;
}
.template-detail h3 {
  margin: 0;
  font-size: 1.25rem;
}
.template-views {
  display: flex;
  flex-wrap: wrap;
  list-style: none;
  margin: 0;
  padding: 0;
  gap: 6px;
}
.template-views li {
  border: 1px solid var(--line);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
}
.template-checkbox {
  display: flex;
  gap: 7px;
  align-items: center;
  font-size: 0.8rem;
}
.template-checkbox input {
  width: auto;
}
.template-management {
  border-top: 1px solid var(--line);
  padding-top: 12px;
}
.template-management .database-form {
  margin-top: 12px;
}
.template-delete {
  margin-top: 12px;
  padding: 12px;
  background: var(--surface);
  border-radius: 6px;
  font-size: 0.82rem;
}
.template-delete button {
  margin-right: 6px;
}
</style>

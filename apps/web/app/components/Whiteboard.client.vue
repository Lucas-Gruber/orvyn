<script setup lang="ts">
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import {
  emptyWhiteboard,
  validateWhiteboardScene,
  whiteboardFromYDoc,
  whiteboardFiles,
  type WhiteboardScene,
} from "@orvyn/editor/whiteboards";
import type { WhiteboardAdapter } from "../whiteboard/excalidraw";
import { pageNavigationKey } from "../composables/pageNavigation";
const props = withDefaults(
  defineProps<{ pageId: string; embedded?: boolean; paused?: boolean }>(),
  { embedded: false, paused: false },
);
const host = ref<HTMLElement>(),
  root = ref<HTMLElement>(),
  meta = ref<any>(),
  loading = ref(true),
  denied = ref(false),
  error = ref("");
const status = ref("disconnected"),
  synced = ref(false),
  unsynced = ref(0),
  ready = ref(false),
  interactive = ref(!props.embedded),
  pending = ref(false),
  exporting = ref(false);
const showHistory = ref(false),
  history = ref<any[]>([]),
  historyBefore = ref<number | null>(),
  historyLoading = ref(false);
const navigate = inject(pageNavigationKey),
  config = useRuntimeConfig();
const canWrite = computed(
  () =>
    !!meta.value &&
    meta.value.access_rank >= 30 &&
    status.value === "connected" &&
    synced.value &&
    !denied.value,
);
const editable = computed(
  () =>
    !!meta.value &&
    meta.value.access_rank >= 30 &&
    status.value === "connected" &&
    synced.value &&
    interactive.value &&
    !props.paused &&
    !denied.value,
);
const saveLabel = computed(() =>
  denied.value
    ? "Unavailable"
    : error.value
      ? "Changes need attention"
      : pending.value || unsynced.value
        ? "Saving whiteboard…"
        : status.value !== "connected"
          ? "Reconnecting…"
          : meta.value?.access_rank < 30
            ? "Read-only"
            : "All changes saved",
);
const importInput = ref<HTMLInputElement>(),
  importing = ref(false),
  restoring = ref(false);
let historyRequest = 0;
let resizeObserver: ResizeObserver | undefined;
let adapter: WhiteboardAdapter | undefined,
  provider: HocuspocusProvider | undefined,
  canvasDocument = new Y.Doc(),
  generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  observer: MutationObserver | undefined;
let controller = new AbortController(),
  job: Promise<void> | undefined,
  lastPointer = 0;
let draft: { elements: any[]; state: any; files: any } | undefined;
const uploaded = new Map<string, string>(),
  uploads = new Map<string, Promise<string>>(),
  hydrated = new Set<string>();
const theme = () =>
  getComputedStyle(document.documentElement).colorScheme.includes("dark")
    ? ("dark" as const)
    : ("light" as const);
function cleanup() {
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  restoring.value = false;
  importing.value = false;
  showHistory.value = false;
  history.value = [];
  historyBefore.value = null;
  historyLoading.value = false;
  clearTimeout(timer);
  controller.abort();
  controller = new AbortController();
  provider?.destroy();
  provider = undefined;
  adapter?.destroy();
  adapter = undefined;
  canvasDocument.destroy();
  canvasDocument = new Y.Doc();
  uploaded.clear();
  uploads.clear();
  hydrated.clear();
  draft = undefined;
  job = undefined;
  ready.value = false;
  synced.value = false;
  pending.value = false;
  unsynced.value = 0;
  status.value = "disconnected";
}
function unavailable() {
  generation++;
  denied.value = true;
  meta.value = undefined;
  cleanup();
}
function onChange(elements: readonly any[], state: any, files: any) {
  if (!editable.value || !ready.value) return;
  const scene = {
    elements: JSON.parse(JSON.stringify(elements)),
    backgroundColor: state.viewBackgroundColor,
    gridSize: state.gridModeEnabled ? state.gridSize : null,
  };
  try {
    if (
      JSON.stringify(scene) ===
      JSON.stringify(whiteboardFromYDoc(canvasDocument))
    )
      return;
  } catch {
    /* New image uploads are normalized below. */
  }
  draft = {
    elements: scene.elements,
    state: { backgroundColor: scene.backgroundColor, gridSize: scene.gridSize },
    files,
  };
  pending.value = true;
  clearTimeout(timer);
  timer = setTimeout(() => void commit(), 300);
}
async function upload(id: string, file: any, request: number) {
  if (uploaded.has(id)) return uploaded.get(id)!;
  if (uploads.has(id)) return uploads.get(id)!;
  const currentController = controller;
  const work = (async () => {
    if (
      !file ||
      !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/.test(
        file.dataURL,
      ) ||
      file.dataURL.length > 30 * 1024 * 1024
    )
      throw Error(
        "Whiteboard images must be PNG, JPEG, GIF or WebP and fit the upload limit.",
      );
    const type = file.dataURL.slice(5, file.dataURL.indexOf(";")),
      binary = atob(file.dataURL.slice(file.dataURL.indexOf(",") + 1)),
      bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const body = new FormData();
    body.append(
      "file",
      new Blob([bytes], { type }),
      "whiteboard-image." +
        (type.split("/")[1] === "jpeg" ? "jpg" : type.split("/")[1]),
    );
    const saved = await $fetch<any>(`/api/v1/pages/${props.pageId}/files`, {
      method: "POST",
      body,
      signal: currentController.signal,
    });
    if (request !== generation || !canWrite.value)
      throw Error("Whiteboard access changed before the image was saved.");
    uploaded.set(id, saved.id);
    hydrated.add(saved.id);
    adapter?.api?.addFiles([{ ...file, id: saved.id, mimeType: type }]);
    return saved.id as string;
  })();
  uploads.set(id, work);
  try {
    return await work;
  } finally {
    uploads.delete(id);
  }
}
async function commit() {
  if (job) return job;
  const current = draft,
    request = generation;
  if (!current) return;
  job = Promise.resolve().then(async () => {
    try {
      if (!canWrite.value)
        throw Error(
          "Reconnect with edit access before saving this whiteboard.",
        );
      const known = whiteboardFromYDoc(canvasDocument),
        knownIds = new Set(known.elements.map((element) => element.id));
      const knownFiles = new Set(whiteboardFiles(known));
      const elements = JSON.parse(JSON.stringify(current.elements)).filter(
        (element: any) => !element.isDeleted || knownIds.has(element.id),
      );
      for (const element of elements)
        if (
          element.type === "image" &&
          !knownFiles.has(element.fileId) &&
          !hydrated.has(element.fileId)
        ) {
          element.fileId = await upload(
            element.fileId,
            current.files[element.fileId],
            request,
          );
          element.version++;
          element.versionNonce = Math.floor(Math.random() * 2147483647);
        }
      if (request !== generation) return;
      if (current !== draft) return;
      const scene = validateWhiteboardScene({ elements, ...current.state });
      canvasDocument.transact(() => {
        const map = canvasDocument.getMap("elements"),
          settings = canvasDocument.getMap("settings");
        for (const element of scene.elements)
          if (JSON.stringify(map.get(element.id)) !== JSON.stringify(element))
            map.set(element.id, element);
        if (settings.get("backgroundColor") !== scene.backgroundColor)
          settings.set("backgroundColor", scene.backgroundColor);
        if (settings.get("gridSize") !== scene.gridSize)
          settings.set("gridSize", scene.gridSize);
      }, "local-whiteboard");
      draft = undefined;
      pending.value = false;
      error.value = "";
      // Replace provisional image IDs after their private upload completes.
      adapter?.apply(scene);
    } catch (e: any) {
      if (request === generation)
        error.value =
          e.data?.message || e.message || "The whiteboard could not be saved.";
    } finally {
      if (request === generation) job = undefined;
      if (request === generation && draft && draft !== current) {
        clearTimeout(timer);
        timer = setTimeout(() => void commit(), 0);
      }
    }
  });
  return job;
}
async function hydrate(scene: WhiteboardScene, request: number) {
  for (const id of whiteboardFiles(scene)) {
    if (hydrated.has(id)) continue;
    hydrated.add(id);
    try {
      const blob = await $fetch<Blob>(`/api/v1/files/${id}/preview`, {
        responseType: "blob",
        signal: controller.signal,
      });
      const dataURL = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      if (request !== generation || denied.value) return;
      adapter?.api?.addFiles([
        {
          id: id as any,
          dataURL: dataURL as any,
          mimeType: blob.type as any,
          created: Date.now(),
        },
      ]);
    } catch {
      if (request !== generation) return;
    }
  }
}
function refreshScene() {
  if (!ready.value || denied.value) return;
  try {
    const scene = whiteboardFromYDoc(canvasDocument);
    adapter?.apply(scene);
    void hydrate(scene, generation);
  } catch (e: any) {
    error.value = e.message;
  }
}
function awareness() {
  if (!adapter?.api || !provider?.awareness) return;
  const collaborators = new Map();
  for (const [id, state] of provider.awareness.getStates()) {
    if (id === canvasDocument.clientID || !state.user?.id) continue;
    const cursor = state.cursor,
      point = cursor?.pointer;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y))
      continue;
    collaborators.set(String(id), {
      username: state.user.name,
      color: { background: state.user.color, stroke: state.user.color },
      pointer: { x: point.x, y: point.y, tool: "pointer" },
      button: cursor.button === "down" ? "down" : "up",
      selectedElementIds: cursor.selectedElementIds || {},
      isCurrentUser: false,
    });
  }
  adapter.api.updateScene({ collaborators });
}
async function load() {
  const request = ++generation;
  cleanup();
  meta.value = undefined;
  loading.value = true;
  denied.value = false;
  error.value = "";
  try {
    const data = await $fetch<any>(`/api/v1/pages/${props.pageId}/whiteboard`, {
      signal: controller.signal,
    });
    if (request !== generation) return;
    meta.value = data;
    const url = String(
      config.public.collaborationUrl ||
        new URL("/collaboration", location.href)
          .toString()
          .replace(/^http/, "ws"),
    );
    provider = new HocuspocusProvider({
      url,
      name: props.pageId,
      document: canvasDocument,
      token: "cookie",
      onStatus({ status: value }) {
        status.value = value;
      },
      onSynced({ state }) {
        synced.value = state;
        if (state) refreshScene();
      },
      onUnsyncedChanges({ number }) {
        unsynced.value = number;
      },
      onAuthenticationFailed() {
        unavailable();
      },
      onClose({ event }) {
        if (
          event.code === 4403 ||
          ["Access changed", "Document access denied"].includes(event.reason)
        )
          unavailable();
      },
      onStateless({ payload }) {
        try {
          const message = JSON.parse(payload);
          if (
            message.type === "permissions" &&
            typeof message.accessRank === "number" &&
            meta.value
          ) {
            const previous = meta.value.access_rank;
            meta.value.access_rank = message.accessRank;
            if (previous >= 30 && message.accessRank < 30) void load();
          }
        } catch {}
      },
      onAwarenessChange: awareness,
    });
    canvasDocument.on("update", refreshScene);
    await nextTick();
    (window as any).EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";
    const { mountWhiteboard } = await import("../whiteboard/excalidraw");
    if (request !== generation || !host.value) return;
    if (props.embedded) {
      resizeObserver = new ResizeObserver(() => {
        if (!interactive.value && ready.value)
          requestAnimationFrame(() => {
            if (request === generation) adapter?.fit();
          });
      });
      resizeObserver.observe(host.value);
    }
    adapter = mountWhiteboard(host.value, {
      scene: validateWhiteboardScene(data.scene),
      editable: editable.value,
      theme: theme(),
      onChange,
      onReady() {
        if (request !== generation) return;
        ready.value = true;
        refreshScene();
        if (props.embedded)
          requestAnimationFrame(() => {
            if (request === generation) adapter?.fit();
          });
      },
      onPointer(payload) {
        if (!editable.value || Date.now() - lastPointer < 40) return;
        lastPointer = Date.now();
        provider?.awareness?.setLocalStateField("cursor", {
          pointer: payload.pointer,
          button: payload.button,
          selectedElementIds:
            adapter?.api?.getAppState().selectedElementIds || {},
        });
      },
    });
  } catch (e: any) {
    if (request === generation) {
      error.value =
        e.data?.message ||
        "This whiteboard is unavailable or you do not have access.";
      if ([401, 404].includes(e.status || e.statusCode)) unavailable();
    }
  } finally {
    if (request === generation) loading.value = false;
  }
}
async function flush() {
  clearTimeout(timer);
  if (job) await job;
  await commit();
  if (error.value && pending.value) throw Error(error.value);
  if (draft) throw Error("The whiteboard has unsaved changes.");
  if (!unsynced.value) return;
  await new Promise<void>((resolve, reject) => {
    const stop = watch(unsynced, (value) => {
      if (!value) {
        clearTimeout(timeout);
        stop();
        resolve();
      }
    });
    const timeout = setTimeout(() => {
      stop();
      reject(Error("Wait for the whiteboard to finish saving before leaving."));
    }, 10000);
  });
}
usePendingWrites(flush);
function beforeUnload(event: BeforeUnloadEvent) {
  if (pending.value || unsynced.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
async function download(format: "png" | "svg" | "json") {
  if (!adapter || denied.value) return;
  exporting.value = true;
  try {
    const blob = await adapter.export(format),
      url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download =
      (meta.value?.title || "Whiteboard").replace(/[\\/:*?"<>|]/g, "-") +
      (format === "json" ? ".excalidraw" : "." + format);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    exporting.value = false;
  }
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = "";
  if (!file || !adapter || !editable.value) return;
  importing.value = true;
  error.value = "";
  const request = generation;
  try {
    if (file.size > 35 * 1024 * 1024)
      throw Error("Choose an Excalidraw file smaller than 35 MB.");
    const value = JSON.parse(await file.text());
    if (
      value.type !== "excalidraw" ||
      value.version !== 2 ||
      !Array.isArray(value.elements) ||
      value.elements.length > 2000
    )
      throw Error("This is not a supported Excalidraw file.");
    const normalized = JSON.parse(
      JSON.stringify(adapter.normalize(value.elements)),
    );
    const settings = {
      backgroundColor: value.appState?.viewBackgroundColor || "#ffffff",
      gridSize: value.appState?.gridModeEnabled
        ? value.appState?.gridSize || 20
        : null,
    };
    validateWhiteboardScene({
      ...settings,
      elements: normalized.map((element: any) =>
        element.type === "image"
          ? { ...element, fileId: crypto.randomUUID() }
          : element,
      ),
    });
    const importedFiles = new Map<string, string>();
    for (const element of normalized)
      if (element.type === "image") {
        if (!importedFiles.has(element.fileId))
          importedFiles.set(
            element.fileId,
            await upload(
              "import-" + crypto.randomUUID(),
              value.files?.[element.fileId],
              request,
            ),
          );
        element.fileId = importedFiles.get(element.fileId);
      }
    if (request !== generation || !canWrite.value) return;
    await flush();
    await $fetch(`/api/v1/pages/${props.pageId}/whiteboard/checkpoint`, {
      method: "POST",
      body: {},
    });
    replaceWithRecovery(
      validateWhiteboardScene({ ...settings, elements: normalized }),
    );
  } catch (e: any) {
    if (request === generation)
      error.value =
        e.data?.message || e.message || "The drawing could not be imported.";
  } finally {
    if (request === generation) importing.value = false;
  }
}
function replaceWithRecovery(scene: WhiteboardScene) {
  const current = whiteboardFromYDoc(canvasDocument),
    byId = new Map(current.elements.map((element) => [element.id, element]));
  const elements = scene.elements.map((element) => ({
    ...element,
    version: Math.max(element.version, byId.get(element.id)?.version || 0) + 1,
    versionNonce: Math.floor(Math.random() * 2147483647),
    updated: Date.now(),
  }));
  const ids = new Set(elements.map((element) => element.id));
  for (const element of current.elements)
    if (!ids.has(element.id))
      elements.push({
        ...element,
        isDeleted: true,
        version: element.version + 1,
        versionNonce: Math.floor(Math.random() * 2147483647),
        updated: Date.now(),
      });
  adapter?.replace(validateWhiteboardScene({ ...scene, elements }));
}
async function openHistory(more = false) {
  const request = ++historyRequest,
    source = generation;
  showHistory.value = true;
  historyLoading.value = true;
  if (!more) history.value = [];
  try {
    const data = await $fetch<any>(
      `/api/v1/pages/${props.pageId}/whiteboard/history`,
      {
        signal: controller.signal,
        query:
          more && historyBefore.value ? { before: historyBefore.value } : {},
      },
    );
    if (
      source !== generation ||
      request !== historyRequest ||
      !showHistory.value
    )
      return;
    history.value = more
      ? [...history.value, ...data.revisions]
      : data.revisions;
    historyBefore.value = data.nextBefore;
  } catch (e: any) {
    if (source === generation && request === historyRequest)
      error.value = e.data?.message || "History is unavailable.";
  } finally {
    if (source === generation && request === historyRequest)
      historyLoading.value = false;
  }
}
async function restore(version: number) {
  if (!editable.value || restoring.value) return;
  restoring.value = true;
  const source = generation;
  try {
    await flush();
    await $fetch(`/api/v1/pages/${props.pageId}/whiteboard/checkpoint`, {
      method: "POST",
      body: {},
    });
    const snapshot = await $fetch<any>(
      `/api/v1/pages/${props.pageId}/whiteboard/history/${version}`,
    );
    if (source !== generation || !canWrite.value) return;
    replaceWithRecovery(validateWhiteboardScene(snapshot.scene));
    showHistory.value = false;
  } catch (e: any) {
    if (source === generation) error.value = e.data?.message || e.message;
  } finally {
    if (source === generation) restoring.value = false;
  }
}
watch(editable, (value) => adapter?.setEditable(value));
watch(interactive, (value) => {
  if (!value && props.embedded) requestAnimationFrame(() => adapter?.fit());
});
watch(
  () => props.pageId,
  () => void load(),
);
onMounted(() => {
  void load();
  window.addEventListener("beforeunload", beforeUnload);
  observer = new MutationObserver(() => adapter?.setTheme(theme()));
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
});
onBeforeUnmount(() => {
  generation++;
  observer?.disconnect();
  window.removeEventListener("beforeunload", beforeUnload);
  cleanup();
  canvasDocument.destroy();
});
defineExpose({ flush, openHistory });
</script>
<template>
  <section
    ref="root"
    class="whiteboard"
    :class="{ embedded }"
    aria-label="Whiteboard"
    @keydown.stop
    @pointerdown.stop
    @wheel.stop
  >
    <div v-if="denied" class="whiteboard-unavailable" role="alert">
      <AppIcon name="lock" :size="22" />
      <p>This whiteboard is unavailable or you do not have access.</p>
      <button class="ghost" @click="load">Retry</button>
    </div>
    <template v-else>
      <header class="whiteboard-header">
        <div class="whiteboard-location">
          <AppIcon name="whiteboard" :size="17" /><strong>{{
            embedded ? meta?.title || "Whiteboard" : "Canvas"
          }}</strong
          ><span class="whiteboard-save" role="status">{{ saveLabel }}</span>
        </div>
        <div class="whiteboard-actions">
          <button
            class="icon-button"
            aria-label="Fit drawing"
            title="Fit drawing"
            :disabled="!ready"
            @click="adapter?.fit()"
          >
            <AppIcon name="expand" :size="16" />
          </button>
          <button
            v-if="embedded && meta?.access_rank >= 30"
            class="ghost"
            :aria-pressed="interactive"
            @click="interactive = !interactive"
          >
            {{ interactive ? "Done drawing" : "Edit whiteboard" }}
          </button>
          <button
            v-if="embedded"
            class="icon-button"
            aria-label="Open whiteboard page"
            title="Open whiteboard page"
            @click="navigate?.(pageId)"
          >
            <AppIcon name="external" :size="16" />
          </button>
          <UiMenu label="Whiteboard actions"
            ><button
              role="menuitem"
              :disabled="!ready || exporting"
              @click="download('png')"
            >
              <AppIcon name="image" :size="16" />Export PNG</button
            ><button
              role="menuitem"
              :disabled="!ready || exporting"
              @click="download('svg')"
            >
              <AppIcon name="download" :size="16" />Export SVG</button
            ><button
              role="menuitem"
              :disabled="!ready || exporting"
              @click="download('json')"
            >
              <AppIcon name="download" :size="16" />Export Excalidraw file
            </button>
            <hr />
            <button
              v-if="meta?.access_rank >= 30"
              role="menuitem"
              :disabled="!editable || importing"
              @click="importInput?.click()"
            >
              <AppIcon name="upload" :size="16" />Import Excalidraw file
            </button>
            <button role="menuitem" @click="openHistory()">
              <AppIcon name="history" :size="16" />Canvas history
            </button></UiMenu
          >
        </div>
      </header>
      <input
        ref="importInput"
        type="file"
        accept=".excalidraw,application/json"
        hidden
        @change="importFile"
      />
      <div v-if="error" role="alert" class="whiteboard-error">
        {{ error
        }}<button v-if="pending" class="ghost" @click="commit">
          Retry saving
        </button>
      </div>
      <div class="whiteboard-stage" :class="{ 'view-only': !editable }">
        <div ref="host" class="whiteboard-canvas" />
        <span v-if="loading || !ready" class="whiteboard-loading" role="status"
          >Loading canvas…</span
        >
      </div>
      <footer v-if="!embedded" class="whiteboard-footer">
        Draw, connect and arrange your ideas.
        <span
          >V select · R rectangle · A arrow · T text · P draw · Space to
          pan</span
        >
      </footer>
    </template>
    <UiDialog
      :open="showHistory && !denied"
      title="Canvas history"
      @close="showHistory = false"
      ><p class="hint">
        Recovery checkpoints are saved about every 30 seconds of activity.
        Restoring keeps a recoverable current state.
      </p>
      <p v-if="!history.length && !historyLoading" class="hint">
        No earlier checkpoints yet.
      </p>
      <div class="canvas-history">
        <div v-for="revision in history" :key="revision.version">
          <span
            >Revision {{ revision.version
            }}<small
              >{{ new Date(revision.created_at).toLocaleString() }} ·
              {{ revision.elements }} elements</small
            ></span
          ><button
            v-if="meta?.access_rank >= 30"
            :disabled="!editable || restoring"
            @click="restore(revision.version)"
          >
            Restore
          </button>
        </div>
      </div>
      <button
        v-if="historyBefore"
        :disabled="historyLoading"
        @click="openHistory(true)"
      >
        Load more
      </button></UiDialog
    >
  </section>
</template>
<style>
.whiteboard {
  border: 1px solid var(--line);
  border-radius: 9px;
  overflow: hidden;
  background: var(--bg);
  margin: 16px 0;
}
.whiteboard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 13px;
  border-bottom: 1px solid var(--line-soft);
  min-height: 49px;
}
.whiteboard-location,
.whiteboard-actions {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.whiteboard-location strong {
  font-size: 0.8rem;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.whiteboard-location > .app-icon {
  color: var(--muted);
  flex-shrink: 0;
}
.whiteboard-save {
  color: var(--faint);
  font-size: 0.68rem;
  white-space: nowrap;
}
.whiteboard-actions button {
  font-size: 0.74rem;
}
.whiteboard-actions {
  flex-shrink: 0;
}
.whiteboard-location {
  flex: 1;
}
.whiteboard-stage {
  height: min(760px, 75vh);
  min-height: 450px;
  position: relative;
  isolation: isolate;
}
.whiteboard.embedded .whiteboard-stage {
  height: 500px;
  min-height: 360px;
}
.whiteboard-canvas {
  height: 100%;
  width: 100%;
}
.whiteboard-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--bg);
  color: var(--muted);
  font-size: 0.8rem;
  pointer-events: none;
}
.whiteboard-error {
  border-bottom: 1px solid var(--line);
  padding: 10px 14px;
  color: var(--danger);
  font-size: 0.78rem;
}
.whiteboard-footer {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  border-top: 1px solid var(--line-soft);
  padding: 9px 13px;
  font-size: 0.68rem;
  color: var(--faint);
}
.whiteboard-unavailable {
  padding: 30px 20px;
  text-align: center;
  color: var(--muted);
  font-size: 0.8rem;
}
.whiteboard .excalidraw {
  font-family: "Inter Variable", sans-serif;
}
.whiteboard .excalidraw [data-testid="toolbar-embeddable"],
.whiteboard .excalidraw [data-testid="toolbar-magicframe"] {
  display: none;
}
.canvas-history > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
  padding: 12px 0;
  border-bottom: 1px solid var(--line-soft);
  font-size: 0.8rem;
}
.canvas-history small {
  display: block;
  color: var(--faint);
  font-size: 0.72rem;
  margin-top: 4px;
}
@media (max-width: 760px) {
  .whiteboard-save {
    display: none;
  }
  .whiteboard-location strong {
    max-width: 120px;
  }
  .whiteboard-stage {
    height: 70vh;
  }
  .whiteboard-footer {
    display: none;
  }
  .whiteboard.embedded .whiteboard-stage {
    height: 430px;
  }
}
</style>

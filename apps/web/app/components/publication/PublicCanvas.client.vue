<script setup lang="ts">
import type { WhiteboardScene } from "@orvyn/editor/whiteboards";
import type { WhiteboardAdapter } from "../../whiteboard/excalidraw";
const props = defineProps<{
    scene: WhiteboardScene;
    fileUrl: (id: string) => string;
  }>(),
  host = ref<HTMLElement>(),
  error = ref("");
let readyResolve: () => void = () => {};
const ready = new Promise<void>((resolve) => (readyResolve = resolve));
let adapter: WhiteboardAdapter | undefined,
  observer: ResizeObserver | undefined;
const controller = new AbortController();
let alive = true;
onMounted(async () => {
  try {
    (window as any).EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";
    const { mountWhiteboard } = await import("../../whiteboard/excalidraw");
    if (!alive || !host.value) return;
    adapter = mountWhiteboard(host.value, {
      scene: props.scene,
      editable: false,
      theme:
        document.documentElement.dataset.theme === "light" ? "light" : "dark",
      onChange: () => {},
      onPointer: () => {},
      onReady: () => {
        readyResolve();
        requestAnimationFrame(() => {
          adapter?.fit();
        });
      },
    });
    observer = new ResizeObserver(() => adapter?.fit());
    observer.observe(host.value);
    const ids = [
      ...new Set(
        props.scene.elements
          .filter((e) => e.type === "image" && typeof e.fileId === "string")
          .map((e) => e.fileId as string),
      ),
    ];
    const files = await Promise.all(
      ids.map(async (id) => {
        const response = await fetch(props.fileUrl(id), {
          signal: controller.signal,
        });
        if (!response.ok) throw Error("An image is unavailable.");
        const blob = await response.blob();
        const dataURL = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        return { id, dataURL, mimeType: blob.type, created: 1 };
      }),
    );
    await ready;
    if (alive && files.length) adapter?.api?.addFiles(files as any);
  } catch (e: any) {
    if (alive) error.value = e.message || "The canvas could not be opened.";
  }
});
onBeforeUnmount(() => {
  alive = false;
  readyResolve();
  controller.abort();
  observer?.disconnect();
  adapter?.destroy();
});
</script>
<template>
  <div class="public-canvas">
    <div ref="host" class="public-canvas-host" />
    <p v-if="error" role="alert">{{ error }}</p>
    <button
      type="button"
      class="public-canvas-fit"
      aria-label="Fit drawing"
      @click="adapter?.fit()"
    >
      <AppIcon name="expand" :size="16" />
    </button>
  </div>
</template>
<style scoped>
.public-canvas {
  height: 440px;
  position: relative;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}
.public-canvas-host {
  width: 100%;
  height: 100%;
}
.public-canvas-fit {
  position: absolute;
  right: 12px;
  top: 12px;
  background: var(--panel);
}
p {
  position: absolute;
  bottom: 8px;
  left: 16px;
  color: var(--muted);
  font-size: 12px;
}
.public-canvas :deep(.App-menu_top),
.public-canvas :deep(.layer-ui__wrapper__footer),
.public-canvas :deep(.excalidraw-help-center),
.public-canvas :deep(.welcome-screen-center),
.public-canvas :deep(.main-menu-trigger) {
  display: none !important;
}
@media (max-width: 600px) {
  .public-canvas {
    height: 320px;
  }
}
</style>

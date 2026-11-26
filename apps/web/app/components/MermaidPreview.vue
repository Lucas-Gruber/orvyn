<script setup lang="ts">
import rendererUrl from "../generated/mermaid/renderer.js?url";
const props = defineProps<{ source: string }>();
const emit = defineEmits<{ error: [] }>();
const frame = ref<HTMLIFrameElement>();
const srcdoc = ref("");
const state = ref<"loading" | "ready" | "error">("loading");
const height = ref(180);
const message = ref("");
let ready = false,
  mounted = false,
  sequence = 0,
  id = "";
let timer: ReturnType<typeof setTimeout> | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
let observer: MutationObserver | undefined;
function failure(
  text = "Couldn't render this diagram. Check the Mermaid syntax.",
) {
  clearTimeout(deadline);
  state.value = "error";
  message.value = text;
  emit("error");
}
function send() {
  if (!mounted || !frame.value?.contentWindow) return;
  if (!ready) {
    clearTimeout(deadline);
    deadline = setTimeout(
      () => failure("The diagram renderer couldn't load. Retry the preview."),
      15000,
    );
    return;
  }
  if (!props.source.trim())
    return failure("Add Mermaid code to draw a diagram.");
  if (props.source.length > 20000)
    return failure("Keep a diagram below 20,000 characters to preview it.");
  const styles = getComputedStyle(document.documentElement);
  const colors = Object.fromEntries(
    Object.entries({
      background: "--bg",
      surface: "--surface",
      text: "--text",
      muted: "--muted",
      accent: "--accent",
    }).map(([key, value]) => [key, styles.getPropertyValue(value).trim()]),
  );
  frame.value.contentWindow.postMessage(
    {
      type: "orvyn-mermaid-render",
      id,
      sequence,
      source: props.source,
      dark: document.documentElement.dataset.theme !== "light",
      colors,
    },
    "*",
  );
  clearTimeout(deadline);
  deadline = setTimeout(
    () =>
      failure(
        "The diagram preview couldn't finish. Simplify the diagram or retry.",
      ),
    15000,
  );
}
function schedule() {
  sequence++;
  clearTimeout(timer);
  clearTimeout(deadline);
  state.value = "loading";
  timer = setTimeout(send, 200);
}
function receive(event: MessageEvent) {
  if (event.source !== frame.value?.contentWindow || event.origin !== "null")
    return;
  if (event.data?.type === "orvyn-mermaid-ready") {
    ready = true;
    send();
    return;
  }
  if (event.data?.id !== id || event.data?.sequence !== sequence) return;
  if (
    event.data.type === "orvyn-mermaid-height" &&
    Number.isFinite(event.data.height)
  )
    height.value = Math.max(100, Math.min(720, event.data.height));
  if (event.data.type === "orvyn-mermaid-rendered") {
    clearTimeout(deadline);
    state.value = "ready";
  }
  if (event.data.type === "orvyn-mermaid-error") failure();
}
function start() {
  ready = false;
  sequence++;
  state.value = "loading";
  const nonce = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))),
  );
  const asset = new URL(rendererUrl, location.origin).href
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;");
  srcdoc.value = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;background:transparent}body{padding:16px;box-sizing:border-box}#diagram>svg{display:block;max-width:100%;height:auto;margin:0 auto}#diagram a{pointer-events:none}</style></head><body><main id="diagram"></main><script nonce="${nonce}" src="${asset}"><\/script></body></html>`;
  clearTimeout(deadline);
  deadline = setTimeout(
    () => failure("The diagram renderer couldn't load. Retry the preview."),
    15000,
  );
}
watch(() => props.source, schedule);
onMounted(() => {
  mounted = true;
  id = crypto.randomUUID();
  window.addEventListener("message", receive);
  observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  start();
});
onBeforeUnmount(() => {
  mounted = false;
  clearTimeout(timer);
  clearTimeout(deadline);
  observer?.disconnect();
  window.removeEventListener("message", receive);
});
</script>
<template>
  <div
    class="mermaid-preview"
    :data-render-state="state"
    contenteditable="false"
    :aria-busy="state === 'loading'"
  >
    <iframe
      v-if="srcdoc"
      ref="frame"
      title="Mermaid diagram"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      :srcdoc="srcdoc"
      :style="{ height: height + 'px' }"
      :class="{ 'preview-hidden': state === 'error' }"
    />
    <div v-if="state === 'loading'" class="mermaid-status" role="status">
      <AppIcon name="loading" :size="16" class="spinner" />Preparing diagram…
    </div>
    <div v-if="state === 'error'" class="mermaid-error" role="status">
      <AppIcon name="warning" :size="18" />
      <div>
        <strong>Diagram preview unavailable</strong>
        <p>{{ message }}</p>
        <button type="button" class="ghost" @click="start">
          <AppIcon name="refresh" :size="14" />Retry preview
        </button>
      </div>
    </div>
    <noscript>
      <pre>{{ source }}</pre>
    </noscript>
  </div>
</template>
<style scoped>
.mermaid-preview {
  position: relative;
  min-height: 100px;
  background: var(--bg);
  border-radius: 0 0 8px 8px;
  overflow: hidden;
}
iframe {
  display: block;
  width: 100%;
  border: 0;
  background: transparent;
  transition: opacity 0.15s;
}
[data-render-state="loading"] iframe {
  opacity: 0.3;
}
.preview-hidden {
  display: none;
}
.mermaid-status {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 0.8rem;
  color: var(--muted);
  pointer-events: none;
}
.mermaid-error {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 22px;
  color: var(--muted);
  font-size: 0.8rem;
}
.mermaid-error > .app-icon {
  margin-top: 2px;
  flex: none;
}
.mermaid-error strong {
  font-weight: 500;
  color: var(--text);
}
.mermaid-error p {
  margin: 5px 0 9px;
  line-height: 1.5;
}
.mermaid-error button {
  font-size: 0.75rem;
  min-height: 28px;
  padding: 3px 7px;
}
</style>

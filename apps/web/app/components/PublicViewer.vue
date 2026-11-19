<script setup lang="ts">
import type { PublicationSnapshot } from "@orvyn/shared";
import { documentExcerpt } from "@orvyn/editor/links";
const props = defineProps<{ token: string }>(),
  route = useRoute();
const cookieHeaders = import.meta.server
  ? useRequestHeaders(["cookie"])
  : undefined;
const { data, refresh } = await useAsyncData(
  "public:" + props.token,
  async () => {
    try {
      return {
        state: "ready",
        ...(await $fetch<{
          snapshot: PublicationSnapshot;
          indexable: boolean;
          publishedAt: string;
          version: number;
        }>("/api/v1/publications/" + props.token, { headers: cookieHeaders })),
      };
    } catch (e: any) {
      return {
        state: e.data?.passwordRequired ? "locked" : "missing",
        snapshot: null,
        indexable: false,
        publishedAt: "",
        version: 0,
      };
    }
  },
);
let poll: ReturnType<typeof setInterval> | undefined,
  checking = false,
  checkAgain = false,
  alive = true;
const controller = new AbortController();
async function verify() {
  if (!alive || document.hidden || !data.value?.snapshot) return;
  if (checking) {
    checkAgain = true;
    return;
  }
  checking = true;
  try {
    const status = await $fetch<{ version: number }>(
      "/api/v1/publications/" + props.token + "/status",
      { signal: controller.signal },
    );
    if (alive && status.version !== data.value?.version) await refresh();
  } catch (e: any) {
    if (alive && [401, 404].includes(e.statusCode || e.response?.status))
      data.value = {
        state:
          e.statusCode === 401 || e.response?.status === 401
            ? "locked"
            : "missing",
        snapshot: null,
        indexable: false,
        publishedAt: "",
        version: 0,
      };
  } finally {
    checking = false;
    if (checkAgain && alive) {
      checkAgain = false;
      void verify();
    }
  }
}
onMounted(() => {
  poll = setInterval(verify, 30000);
  window.addEventListener("focus", verify);
  document.addEventListener("visibilitychange", verify);
});
onBeforeUnmount(() => {
  alive = false;
  controller.abort();
  clearInterval(poll);
  window.removeEventListener("focus", verify);
  document.removeEventListener("visibilitychange", verify);
});
if (import.meta.server) {
  useResponseHeader("Referrer-Policy").value = "no-referrer";
  useResponseHeader("Cache-Control").value = "no-store";
  useResponseHeader("X-Robots-Tag").value = data.value?.indexable
    ? "index, follow"
    : "noindex, nofollow, noarchive";
}
const password = ref(""),
  error = ref(""),
  busy = ref(false);
const root = computed(() =>
  data.value?.snapshot?.pages.find(
    (p) => p.id === data.value?.snapshot?.rootId,
  ),
);
const current = computed(() =>
  data.value?.snapshot?.pages.find(
    (p) => p.id === String(route.query.page || data.value?.snapshot?.rootId),
  ),
);
useHead(() => ({
  htmlAttrs: { "data-theme": "light" },
  meta: [{ name: "referrer", content: "no-referrer" }],
}));
useSeoMeta({
  title: () =>
    current.value ? current.value.title + " · Orvyn" : "Shared page · Orvyn",
  description: () =>
    current.value
      ? documentExcerpt(current.value.document)
      : "A shared Orvyn page.",
  ogTitle: () => current.value?.title || "Shared page",
  ogDescription: () =>
    current.value
      ? documentExcerpt(current.value.document)
      : "A shared Orvyn page.",
  ogType: "article",
  robots: () =>
    data.value?.indexable ? "index, follow" : "noindex, nofollow, noarchive",
});
async function unlock() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await $fetch("/api/v1/publications/" + props.token + "/unlock", {
      method: "POST",
      body: { password: password.value },
    });
    password.value = "";
    await refresh();
  } catch (e: any) {
    error.value = e.data?.message || "Could not open this link.";
  } finally {
    busy.value = false;
  }
}
const fileUrl = (id: string) =>
  "/api/v1/publications/" + props.token + "/files/" + id;
</script>
<template>
  <main class="public-reader">
    <header class="public-reader-bar">
      <a href="/" class="public-reader-brand" aria-label="Orvyn home">o.</a
      ><span>{{ root?.title || "Shared page" }}</span
      ><span class="public-reader-readonly"
        ><AppIcon name="globe" :size="13" />Published page</span
      >
    </header>
    <PublicationPublicContent
      v-if="data?.state === 'ready' && data.snapshot"
      :key="data.version"
      :snapshot="data.snapshot"
      :page-id="String(route.query.page || data.snapshot.rootId)"
      :file-url="fileUrl"
    />
    <section v-else-if="data?.state === 'locked'" class="public-reader-state">
      <div class="public-state-icon"><AppIcon name="lock" :size="26" /></div>
      <h1>This page is password protected</h1>
      <p>Enter the password shared with you to continue.</p>
      <form @submit.prevent="unlock">
        <label for="publication-password">Password</label
        ><input
          id="publication-password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          autofocus
          :disabled="busy"
        />
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button class="primary" :disabled="busy">
          {{ busy ? "Opening…" : "Open shared page"
          }}<AppIcon name="arrowRight" :size="16" />
        </button>
      </form>
    </section>
    <section v-else class="public-reader-state">
      <div class="public-state-icon"><AppIcon name="file" :size="26" /></div>
      <h1>This link is unavailable</h1>
      <p>
        It may have expired or been turned off. Ask the person who shared it for
        a new link.
      </p>
    </section>
    <footer class="public-reader-footer">
      Made with <a href="/">orvyn.</a>
    </footer>
  </main>
</template>
<style scoped>
.public-reader {
  min-height: 100dvh;
  background: var(--panel);
  display: flex;
  flex-direction: column;
}
.public-reader-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 57px;
  position: sticky;
  top: 0;
  z-index: 30;
  background: var(--panel);
  padding: 0 24px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}
.public-reader-bar > span:first-of-type {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.public-reader-brand {
  font-weight: 800;
  font-size: 26px;
  letter-spacing: -2px;
  color: var(--text);
  text-decoration: none;
}
.public-reader-readonly {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}
.public-reader-state {
  max-width: 420px;
  padding: 80px 24px;
  margin: 0 auto;
  flex: 1;
  text-align: center;
}
.public-reader-state h1 {
  font-size: 25px;
  line-height: 1.3;
  letter-spacing: -0.5px;
}
.public-reader-state > p {
  color: var(--muted);
  font-size: 14px;
  line-height: 1.7;
}
.public-state-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  color: var(--muted);
  margin-bottom: 8px;
}
form {
  margin-top: 28px;
  display: grid;
  gap: 10px;
  text-align: left;
}
label {
  font-size: 13px;
}
input {
  width: 100%;
  padding: 11px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
}
form button {
  margin-top: 6px;
  width: 100%;
  padding: 10px;
}
.public-reader-footer {
  margin-top: auto;
  text-align: center;
  padding: 24px;
  color: var(--muted);
  font-size: 11px;
}
.public-reader-footer a {
  color: var(--text);
  font-size: 13px;
  font-weight: 700;
  text-decoration: none;
  margin-left: 4px;
}
@media (max-width: 600px) {
  .public-reader-bar {
    padding: 0 16px;
  }
  .public-reader-readonly {
    font-size: 0;
    gap: 0;
  }
  .public-reader-state {
    padding-top: 64px;
  }
}
</style>

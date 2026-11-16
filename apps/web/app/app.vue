<script setup lang="ts">
import { pageNavigationKey } from "./composables/pageNavigation";
import { headingFromHash, validHeadingId } from "@orvyn/editor/links";
const route = useRoute(),
  router = useRouter();
const booting = ref(true),
  signedIn = ref(false),
  me = ref<any>(),
  providers = ref<any[]>([]),
  view = ref("workspace"),
  spaces = ref<any[]>([]),
  space = ref<any>(),
  pages = ref<any[]>([]),
  page = ref<any>(),
  pageLoading = ref(false),
  targetHeading = ref(""),
  headingVisit = ref(0),
  navigating = ref(false),
  pending = ref(0),
  error = ref(""),
  notice = ref("");
const email = ref(""),
  password = ref(""),
  name = ref(""),
  authForm = ref<HTMLFormElement>();
const linkAction = ref(""),
  linkToken = ref(""),
  newPassword = ref("");
const sidebarOpen = ref(true),
  mobile = ref(false),
  showSpaceCreate = ref(false),
  showDatabaseCreate = ref(false),
  databaseName = ref(""),
  includeDatabaseDefaults = ref(true),
  showPermissions = ref(false),
  showHistory = ref(false),
  showMove = ref(false),
  showDelete = ref(false),
  showAppearance = ref(false),
  showAttachments = ref(false),
  fullWidth = ref(false),
  moveParent = ref(""),
  history = ref<any[]>([]),
  revision = ref<any>(),
  trash = ref<any[]>([]),
  nextCursor = ref(""),
  expanded = ref<string[]>([]),
  favorites = ref<string[]>([]),
  recent = ref<string[]>([]);
const searchOpen = ref(false),
  searchTerm = ref(""),
  searchResults = ref<any[]>([]),
  searchLoading = ref(false),
  searchError = ref(""),
  searchIndex = ref(0),
  searchInput = ref<HTMLInputElement>();
const themes = [
    { id: "cybercade", name: "Cybercade" },
    { id: "graphite", name: "Graphite" },
    { id: "midnight", name: "Midnight" },
    { id: "nord", name: "Nord" },
    { id: "carbon", name: "Carbon" },
    { id: "matrix", name: "Matrix" },
    { id: "light", name: "Light" },
  ],
  theme = ref("cybercade");
const titleInput = ref<HTMLInputElement>(),
  editorHandle = ref<{ flush: () => Promise<void> }>(),
  titleConflict = ref<{ title: string; version: number }>(),
  titleStatus = ref(""),
  serverTitle = ref("");
let titleTimer: ReturnType<typeof setTimeout> | undefined,
  searchTimer: ReturnType<typeof setTimeout> | undefined,
  noticeTimer: ReturnType<typeof setTimeout> | undefined,
  titleJob: Promise<void> | undefined,
  searchGeneration = 0;
let viewport: MediaQueryList | undefined;
function viewportChanged(event: { matches: boolean }) {
  mobile.value = event.matches;
  sidebarOpen.value = !event.matches;
}
watch(sidebarOpen, async (open) => {
  if (!mobile.value) return;
  await nextTick();
  (
    document.querySelector(
      open ? ".app-sidebar button" : 'button[aria-label="Toggle sidebar"]',
    ) as HTMLButtonElement | null
  )?.focus();
});
const busy = computed(() => pending.value > 0),
  canCreate = computed(() =>
    ["Owner", "Admin", "Editor"].includes(space.value?.role),
  );
const recentPages = computed(() =>
    recent.value
      .map((id) => pages.value.find((p) => p.id === id))
      .filter((p: any) => p && p.kind !== "record")
      .slice(0, 6),
  ),
  favoritePages = computed(() =>
    favorites.value
      .map((id) => pages.value.find((p) => p.id === id))
      .filter(Boolean),
  );
const roots = computed(() =>
  pages.value
    .filter(
      (p) =>
        !p.parent_id ||
        !pages.value.some((parent) => parent.id === p.parent_id),
    )
    .sort(
      (a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title),
    ),
);
const breadcrumbPages = computed(() => {
  const ancestors: any[] = [];
  let parent = page.value?.parent_id;
  const seen = new Set<string>();
  while (parent && !seen.has(parent) && ancestors.length < 8) {
    seen.add(parent);
    const p = pages.value.find((p) => p.id === parent);
    if (!p) break;
    ancestors.unshift(p);
    parent = p.parent_id;
  }
  return ancestors;
});
const childPages = computed(() =>
  pages.value.filter(
    (p) => p.parent_id === page.value?.id && p.kind !== "record",
  ),
);
const moveTargets = computed(() =>
  pages.value.filter((candidate) => {
    if (candidate.access_rank < 30) return false;
    const seen = new Set<string>();
    let current = candidate;
    while (current && !seen.has(current.id)) {
      if (current.id === page.value?.id) return false;
      seen.add(current.id);
      current = pages.value.find((p) => p.id === current.parent_id);
    }
    return true;
  }),
);
const avatar = computed(
  () => me.value?.email?.slice(0, 2).toUpperCase() || "O",
);
useHead(() => ({
  htmlAttrs: { "data-theme": theme.value },
  title: page.value?.title
    ? `${page.value.title} · Orvyn`
    : "Orvyn — Your knowledge. Organized.",
}));
async function api(path: string, method = "GET", body?: unknown) {
  return $fetch<any>("/api/v1/" + path, {
    method: method as any,
    body: body as any,
  });
}
async function run(fn: () => Promise<void>) {
  error.value = "";
  pending.value++;
  try {
    await fn();
  } catch (e: any) {
    error.value =
      e.data?.message || e.message || "Something went wrong. Please try again.";
    if (e.status === 401 && signedIn.value) {
      signedOut();
      error.value = "Your session expired. Sign in to continue.";
    }
  } finally {
    pending.value--;
  }
}
async function navigate(fn: () => Promise<void>) {
  if (navigating.value) return;
  navigating.value = true;
  try {
    await run(fn);
  } finally {
    navigating.value = false;
  }
}
function preferences() {
  try {
    const data = JSON.parse(
      localStorage.getItem("orvyn.ui." + me.value.id) || "{}",
    );
    favorites.value = Array.isArray(data.favorites)
      ? data.favorites
          .filter((id: unknown) => typeof id === "string")
          .slice(0, 100)
      : [];
    recent.value = Array.isArray(data.recent)
      ? data.recent.filter((id: unknown) => typeof id === "string").slice(0, 30)
      : [];
    fullWidth.value = data.fullWidth === true;
    return data;
  } catch {
    return {};
  }
}
function persist() {
  if (!me.value) return;
  try {
    localStorage.setItem(
      "orvyn.ui." + me.value.id,
      JSON.stringify({
        favorites: favorites.value,
        recent: recent.value,
        spaceId: space.value?.id,
        fullWidth: fullWidth.value,
      }),
    );
  } catch {}
}
function chooseTheme(id: string) {
  if (!themes.some((t) => t.id === id)) return;
  theme.value = id;
  try {
    localStorage.setItem("orvyn.theme", id);
  } catch {}
}
function toggleFavorite() {
  if (!page.value) return;
  const id = page.value.id;
  favorites.value = favorites.value.includes(id)
    ? favorites.value.filter((p) => p !== id)
    : [...favorites.value, id];
  persist();
}
function toggleExpanded(id: string) {
  expanded.value = expanded.value.includes(id)
    ? expanded.value.filter((p) => p !== id)
    : [...expanded.value, id];
}
async function updateLocation() {
  await router.push({
    path: "/",
    hash: targetHeading.value && page.value ? "#h-" + targetHeading.value : "",
    query: space.value
      ? {
          space: space.value.id,
          ...(page.value ? { page: page.value.id } : {}),
        }
      : {},
  });
}
function signedOut() {
  clearTimeout(titleTimer);
  signedIn.value = false;
  spaces.value = [];
  pages.value = [];
  space.value = undefined;
  page.value = undefined;
  me.value = undefined;
  favorites.value = [];
  recent.value = [];
  view.value = "workspace";
  searchOpen.value = false;
  void router.replace({ path: "/", query: {} });
}
async function refreshMe() {
  me.value = await api("auth/me");
}
async function login(action: string) {
  if (busy.value || !authForm.value?.reportValidity()) return;
  const requestedPage = String(route.query.page || ""),
    requestedHeading = headingFromHash(route.hash);
  await run(async () => {
    await api("auth/" + action, "POST", {
      email: email.value,
      password: password.value,
    });
    password.value = "";
    const [account, list] = await Promise.all([api("auth/me"), api("spaces")]);
    me.value = account;
    spaces.value = list;
    signedIn.value = true;
    const pref = preferences();
    if (requestedPage) await openPage(requestedPage, true, requestedHeading);
    else if (list.length) {
      const selected = list.find((s: any) => s.id === pref.spaceId) || list[0];
      await select(selected);
    }
  });
}
async function startOidc(id: string) {
  const result = await api("oidc/" + id + "/start", "POST", {});
  window.location.assign(result.url);
}
async function loadPages(after = "") {
  if (!space.value) return;
  const id = space.value.id;
  const response = await $fetch.raw<any[]>(
    `/api/v1/spaces/${id}/pages?limit=200&after=${encodeURIComponent(after)}`,
  );
  if (space.value?.id !== id) return;
  pages.value = after
    ? [...pages.value, ...(response._data || [])]
    : response._data || [];
  nextCursor.value = response.headers.get("X-Next-Cursor") || "";
}
async function select(s: any, location = true) {
  await beforeNavigate();
  view.value = "workspace";
  space.value = s;
  page.value = undefined;
  pages.value = [];
  expanded.value = [];
  pageLoading.value = true;
  showPermissions.value = false;
  showHistory.value = false;
  try {
    await loadPages();
    persist();
    if (location) await updateLocation();
  } finally {
    pageLoading.value = false;
  }
  if (mobile.value) sidebarOpen.value = false;
}
function edit(p: any) {
  targetHeading.value = "";
  page.value = p;
  serverTitle.value = p.title;
  titleStatus.value = "";
  titleConflict.value = undefined;
  showPermissions.value = false;
  showHistory.value = false;
  showMove.value = false;
  revision.value = undefined;
  moveParent.value = p.parent_id || "";
  showAttachments.value = false;
  const seen = new Set<string>();
  let parent = p.parent_id;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    if (!expanded.value.includes(parent)) expanded.value.push(parent);
    parent = pages.value.find((v) => v.id === parent)?.parent_id;
  }
  recent.value = [p.id, ...recent.value.filter((id) => id !== p.id)].slice(
    0,
    30,
  );
  persist();
}
async function openPage(id: string, location = true, headingId = "") {
  await beforeNavigate();
  pageLoading.value = true;
  try {
    const p = await api("pages/" + id);
    if (space.value?.id !== p.space_id) {
      let s = spaces.value.find((s) => s.id === p.space_id);
      if (!s) {
        spaces.value = await api("spaces");
        s = spaces.value.find((s) => s.id === p.space_id);
      }
      if (!s) throw Error("Space unavailable");
      await select(s, false);
    }
    edit(p);
    targetHeading.value = validHeadingId(headingId) ? headingId : "";
    if (targetHeading.value) headingVisit.value++;
    view.value = "workspace";
    if (location) await updateLocation();
    if (mobile.value) sidebarOpen.value = false;
  } finally {
    pageLoading.value = false;
  }
}
provide(
  pageNavigationKey,
  (id, headingId = "") => void navigate(() => openPage(id, true, headingId)),
);
async function save() {
  clearTimeout(titleTimer);
  if (titleConflict.value) return;
  if (titleJob) {
    await titleJob;
    if (page.value && page.value.title !== serverTitle.value) return save();
    return;
  }
  const current = page.value;
  if (
    !current ||
    current.kind === "database" ||
    current.access_rank < 30 ||
    current.title === serverTitle.value
  )
    return;
  const value = current.title;
  titleStatus.value = "Saving title…";
  titleJob = (async () => {
    try {
      const result = await api("pages/" + current.id + "/title", "PATCH", {
        title: value.trim() ? value : "Untitled",
        titleVersion: current.title_version,
      });
      current.title_version = result.title_version;
      const entry = pages.value.find((p) => p.id === current.id);
      if (entry) entry.title = result.title;
      if (page.value?.id === current.id) {
        const unchanged = current.title === value;
        if (unchanged) current.title = result.title;
        serverTitle.value = result.title;
        titleStatus.value = unchanged ? "Title saved" : "Unsaved title";
      }
    } catch (e: any) {
      titleStatus.value = "Title could not be saved";
      if (e.status === 409) {
        const latest = await api("pages/" + current.id);
        titleConflict.value = {
          title: latest.title,
          version: latest.title_version,
        };
        titleStatus.value = "Title changed in another session";
      }
      error.value =
        e.data?.message || "Your title could not be saved. Try again.";
      throw e;
    } finally {
      titleJob = undefined;
    }
  })();
  await titleJob;
  if (page.value?.id === current.id && current.title !== serverTitle.value)
    await save();
}
async function beforeNavigate() {
  await save();
  if (titleConflict.value)
    throw new Error("Resolve the title conflict before leaving this page.");
  await editorHandle.value?.flush();
}
async function resolveTitle(keepMine: boolean) {
  if (!page.value || !titleConflict.value) return;
  const latest = titleConflict.value;
  page.value.title_version = latest.version;
  serverTitle.value = latest.title;
  if (!keepMine) page.value.title = latest.title;
  titleConflict.value = undefined;
  error.value = "";
  titleStatus.value = "";
  const entry = pages.value.find((p) => p.id === page.value.id);
  if (entry) entry.title = latest.title;
  if (keepMine) await run(save);
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (
    !page.value ||
    page.value.kind === "database" ||
    page.value.title === serverTitle.value
  )
    return;
  event.preventDefault();
  event.returnValue = "";
}
function scheduleTitleSave() {
  clearTimeout(titleTimer);
  titleStatus.value = "Unsaved title";
  titleTimer = setTimeout(() => void save().catch(() => {}), 700);
}
async function createSpace() {
  await navigate(async () => {
    const s = await api("spaces", "POST", { name: name.value });
    spaces.value.push(s);
    name.value = "";
    showSpaceCreate.value = false;
    await select(s);
  });
}
async function createPage(parentId: string | null = null) {
  if (!space.value || !canCreate.value || pageLoading.value) return;
  pageLoading.value = true;
  try {
    await beforeNavigate();
    page.value = undefined;
    view.value = "workspace";
    const p = await api(`spaces/${space.value.id}/pages`, "POST", {
      title: "Untitled",
      parentId,
    });
    await loadPages();
    edit(p);
    await updateLocation();
    if (mobile.value) sidebarOpen.value = false;
  } finally {
    pageLoading.value = false;
  }
  await nextTick();
  titleInput.value?.focus();
  titleInput.value?.select();
}
async function createDatabase() {
  await navigate(async () => {
    await beforeNavigate();
    const result = await api(`spaces/${space.value.id}/databases`, "POST", {
      name: databaseName.value,
      includeDefaults: includeDatabaseDefaults.value,
    });
    databaseName.value = "";
    showDatabaseCreate.value = false;
    await loadPages();
    edit(result.page);
    await updateLocation();
  });
}
async function home() {
  await beforeNavigate();
  page.value = undefined;
  view.value = "workspace";
  await updateLocation();
}
async function refreshSpace() {
  const id = space.value?.id;
  spaces.value = await api("spaces");
  if (id) space.value = spaces.value.find((s) => s.id === id);
  if (space.value) await loadPages();
  else {
    page.value = undefined;
    pages.value = [];
  }
}
async function refreshPage() {
  const id = page.value?.id;
  await loadPages();
  if (id) edit(await api("pages/" + id));
  showPermissions.value = false;
}
async function movePage() {
  await navigate(async () => {
    await beforeNavigate();
    const p = await api("pages/" + page.value.id);
    await api("pages/" + p.id + "/move", "POST", {
      version: p.version,
      parentId: moveParent.value || null,
      sortOrder: 0,
    });
    showMove.value = false;
    await refreshPage();
    notice.value = "Page moved.";
  });
}
async function trashPage() {
  await navigate(async () => {
    await beforeNavigate();
    await api("pages/" + page.value.id, "DELETE", { confirm: true });
    page.value = undefined;
    showDelete.value = false;
    await loadPages();
    await updateLocation();
    notice.value = "Page moved to trash.";
  });
}
async function openTrash() {
  await beforeNavigate();
  trash.value = await api(`spaces/${space.value.id}/trash`);
  view.value = "trash";
  if (mobile.value) sidebarOpen.value = false;
}
async function openSettings(target: string) {
  await beforeNavigate();
  view.value = target;
  if (mobile.value) sidebarOpen.value = false;
}
async function openHistory() {
  history.value = await api("pages/" + page.value.id + "/history");
  showHistory.value = true;
  revision.value = undefined;
}
function documentText(node: any): string {
  return node.text || (node.content || []).map(documentText).join(" ");
}
async function openSearch() {
  searchOpen.value = true;
  searchTerm.value = "";
  searchIndex.value = 0;
  await fetchSearch();
  await nextTick();
  searchInput.value?.focus();
}
async function fetchSearch() {
  const generation = ++searchGeneration;
  searchLoading.value = true;
  searchError.value = "";
  try {
    const results = await api(
      "search?q=" + encodeURIComponent(searchTerm.value),
    );
    if (generation === searchGeneration) {
      searchResults.value = results;
      searchIndex.value = 0;
    }
  } catch {
    if (generation === searchGeneration)
      searchError.value = "Search is unavailable. Try again.";
  } finally {
    if (generation === searchGeneration) searchLoading.value = false;
  }
}
watch(searchTerm, () => {
  clearTimeout(searchTimer);
  searchResults.value = [];
  searchLoading.value = true;
  searchTimer = setTimeout(() => void fetchSearch(), 180);
});
async function openSearchResult(result: any) {
  searchOpen.value = false;
  await navigate(() => openPage(result.id));
}
function searchKeys(event: KeyboardEvent) {
  if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
  event.preventDefault();
  if (searchLoading.value) return;
  if (event.key === "Enter") {
    const result = searchResults.value[searchIndex.value];
    if (result) void openSearchResult(result);
  } else
    searchIndex.value =
      (searchIndex.value +
        (event.key === "ArrowDown" ? 1 : -1) +
        Math.max(searchResults.value.length, 1)) %
      Math.max(searchResults.value.length, 1);
}
function globalKeys(event: KeyboardEvent) {
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "k" &&
    signedIn.value
  ) {
    event.preventDefault();
    void openSearch();
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
    event.preventDefault();
    sidebarOpen.value = !sidebarOpen.value;
  }
  if (event.key === "Escape" && mobile.value) sidebarOpen.value = false;
}
async function fromHistory() {
  if (!signedIn.value) return;
  const query = new URL(window.location.href).searchParams,
    s = spaces.value.find((s) => s.id === query.get("space"));
  if (query.get("page")) {
    await navigate(() =>
      openPage(
        query.get("page")!,
        false,
        headingFromHash(window.location.hash),
      ),
    );
  } else if (s) {
    await run(async () => {
      await select(s, false);
    });
  } else {
    page.value = undefined;
    space.value = undefined;
    pages.value = [];
    view.value = "workspace";
  }
}
async function readAccountLink(hash = route.hash) {
  const params = new URLSearchParams(hash.slice(1)),
    action = params.get("action");
  if (
    !["verify-email", "reset-password", "accept-invitation"].includes(
      action || "",
    )
  )
    return;
  await router.replace({ path: route.path, query: route.query, hash: "" });
  linkAction.value = action!;
  linkToken.value = params.get("token") || "";
}
watch(
  () => route.hash,
  (hash) => {
    if (import.meta.client) {
      void readAccountLink(hash);
      if (page.value?.id === route.query.page)
        targetHeading.value = headingFromHash(hash);
    }
  },
);
async function completeLink() {
  await run(async () => {
    const action = linkAction.value;
    if (action === "accept-invitation") {
      await api("spaces/invitations/accept", "POST", {
        token: linkToken.value,
      });
      await refreshSpace();
      notice.value = "Invitation accepted. Your team space is ready.";
    } else {
      await api("auth/" + action, "POST", {
        token: linkToken.value,
        ...(action === "reset-password" ? { password: newPassword.value } : {}),
      });
      notice.value =
        action === "verify-email"
          ? "Email verified."
          : "Password reset. Sign in with your new password.";
      if (action === "reset-password") signedOut();
    }
    linkAction.value = "";
    linkToken.value = "";
    newPassword.value = "";
    if (signedIn.value) await refreshMe();
  });
}
watch(notice, (value) => {
  clearTimeout(noticeTimer);
  if (value) noticeTimer = setTimeout(() => (notice.value = ""), 4500);
});
onMounted(async () => {
  viewport = window.matchMedia("(max-width: 760px)");
  viewportChanged(viewport);
  viewport.addEventListener("change", viewportChanged);
  try {
    const stored = localStorage.getItem("orvyn.theme");
    if (themes.some((t) => t.id === stored)) theme.value = stored!;
  } catch {}
  window.addEventListener("keydown", globalKeys);
  window.addEventListener("popstate", fromHistory);
  window.addEventListener("beforeunload", beforeUnload);
  await readAccountLink();
  const requestedSpace = String(route.query.space || ""),
    requestedPage = String(route.query.page || "");
  const result = await Promise.allSettled([
    api("auth/me"),
    api("spaces"),
    api("oidc/providers"),
  ]);
  if (result[2].status === "fulfilled") providers.value = result[2].value;
  if (result[0].status === "fulfilled" && result[1].status === "fulfilled") {
    me.value = result[0].value;
    spaces.value = result[1].value;
    signedIn.value = true;
    const pref = preferences(),
      s =
        spaces.value.find((s) => s.id === requestedSpace) ||
        spaces.value.find((s) => s.id === pref.spaceId) ||
        spaces.value[0];
    if (s || requestedPage)
      await run(async () => {
        if (s) await select(s, false);
        if (requestedPage)
          await openPage(
            requestedPage,
            false,
            headingFromHash(window.location.hash),
          );
      });
  }
  booting.value = false;
});
onBeforeUnmount(() => {
  clearTimeout(titleTimer);
  clearTimeout(searchTimer);
  clearTimeout(noticeTimer);
  window.removeEventListener("keydown", globalKeys);
  window.removeEventListener("popstate", fromHistory);
  window.removeEventListener("beforeunload", beforeUnload);
  viewport?.removeEventListener("change", viewportChanged);
});
</script>
<template>
  <div v-if="booting" class="startup-screen">
    <div class="brand-mark">o.</div>
    <p>Opening your workspace…</p>
  </div>
  <div v-else-if="!signedIn || linkAction" class="auth-shell">
    <div class="auth-story">
      <a class="auth-brand" href="/"
        ><span class="brand-mark">o.</span
        ><span class="brand-word">orvyn<span>.</span></span></a
      >
      <div class="auth-story-copy">
        <div class="eyebrow">Your knowledge. Organized.</div>
        <h1>A little less noise.<br />A lot more <span>clarity.</span></h1>
        <p>
          Bring your notes, ideas and projects together. Make space for the work
          that matters.
        </p>
        <div class="auth-preview" aria-hidden="true">
          <div class="auth-preview-header">
            <i /><i /><i /><span>Your workspace</span>
          </div>
          <div class="auth-preview-title">
            <AppIcon name="file" :size="18" />Room for your next idea
          </div>
          <div class="auth-preview-lines"><i /><i /><i /></div>
          <div class="auth-preview-tabs">
            <span>Write</span><span>Organize</span><span>Collaborate</span>
          </div>
        </div>
      </div>
      <div class="auth-story-footer">
        <AppIcon name="lock" :size="13" />Private by default. Yours to shape.
      </div>
    </div>
    <main class="auth-main">
      <button
        class="icon-button auth-top-actions"
        aria-label="Appearance"
        title="Appearance"
        @click="showAppearance = true"
      >
        <AppIcon name="palette" />
      </button>
      <section class="auth-panel">
        <template v-if="linkAction"
          ><h2>
            {{
              linkAction === "verify-email"
                ? "Verify your email"
                : linkAction === "reset-password"
                  ? "Reset your password"
                  : "Accept space invitation"
            }}
          </h2>
          <form
            v-if="linkAction !== 'accept-invitation' || signedIn"
            @submit.prevent="completeLink"
          >
            <template v-if="linkAction === 'reset-password'"
              ><label for="new-password"
                >New password · at least 12 characters</label
              ><input
                id="new-password"
                v-model="newPassword"
                type="password"
                minlength="12"
                maxlength="256"
                required
                autocomplete="new-password"
            /></template>
            <p v-if="linkAction === 'accept-invitation'">
              Join with your invited, verified email address. Private pages
              remain restricted.
            </p>
            <button class="primary" :disabled="busy">
              {{
                linkAction === "verify-email"
                  ? "Confirm email address"
                  : linkAction === "reset-password"
                    ? "Reset password"
                    : "Accept invitation"
              }}
            </button>
          </form>
          <form v-else ref="authForm" @submit.prevent="login('login')">
            <p>Sign in with the invited account to continue.</p>
            <label for="invite-email">Email</label
            ><input
              id="invite-email"
              v-model="email"
              type="email"
              required
              autocomplete="username"
            /><label for="invite-password">Password</label
            ><input
              id="invite-password"
              v-model="password"
              type="password"
              minlength="12"
              required
              autocomplete="current-password"
            /><button class="primary" :disabled="busy">Sign in</button>
          </form>
          <button
            class="ghost auth-forgot"
            @click="
              linkAction = '';
              linkToken = '';
            "
          >
            Cancel
          </button></template
        >
        <template v-else
          ><h2>Welcome to Orvyn</h2>
          <p>A clear space for everything you’re working on.</p>
          <form ref="authForm" @submit.prevent="login('login')">
            <label for="email">Email</label
            ><input
              id="email"
              v-model="email"
              type="email"
              required
              autocomplete="username"
              placeholder="you@example.com"
            /><label for="password">Password · at least 12 characters</label
            ><input
              id="password"
              v-model="password"
              type="password"
              minlength="12"
              maxlength="256"
              required
              autocomplete="current-password"
              placeholder="Enter your password"
            />
            <div class="auth-actions">
              <button class="primary" :disabled="busy">
                <AppIcon
                  v-if="busy"
                  class="spinner"
                  name="loading"
                  :size="16"
                />Sign in</button
              ><button
                type="button"
                :disabled="busy"
                @click="login('register')"
              >
                Create account
              </button>
            </div>
          </form>
          <button
            class="ghost auth-forgot"
            @click="
              run(async () => {
                await api('auth/request-password-reset', 'POST', { email });
                notice =
                  'If this account supports password sign-in, a reset email has been sent.';
              })
            "
          >
            Forgot password?
          </button>
          <div v-if="providers.length" class="auth-sso">
            <h3>Or continue with your organization</h3>
            <button
              v-for="provider in providers"
              :key="provider.id"
              @click="run(() => startOidc(provider.id))"
            >
              <AppIcon name="shield" :size="16" />Continue with
              {{ provider.name }}
            </button>
          </div>
          <p class="auth-footnote">
            Your pages start private.<br />You choose what to share, and with
            whom.
          </p></template
        >
      </section>
    </main>
  </div>
  <div v-else class="app-shell">
    <button
      v-if="mobile && sidebarOpen"
      class="mobile-scrim"
      aria-label="Close sidebar"
      @click="sidebarOpen = false"
    />
    <aside
      class="app-sidebar"
      :class="{ collapsed: !sidebarOpen }"
      :inert="!sidebarOpen"
      aria-label="Workspace navigation"
    >
      <div class="sidebar-brand">
        <span class="brand-mark">o.</span
        ><a class="brand-word" href="/" @click.prevent="navigate(home)"
          >orvyn<span>.</span></a
        ><button
          class="icon-button"
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
          @click="sidebarOpen = false"
        >
          <AppIcon name="sidebarClose" :size="16" />
        </button>
      </div>
      <UiMenu label="Switch space" align="left" wide
        ><template #trigger
          ><span class="space-letter">{{
            space?.name?.slice(0, 1).toUpperCase() || "W"
          }}</span
          ><strong>{{ space?.name || "Your workspace" }}</strong
          ><AppIcon name="chevronDown" :size="14"
        /></template>
        <div class="menu-caption">Your spaces</div>
        <button
          v-for="s in spaces"
          :key="s.id"
          role="menuitem"
          @click="navigate(() => select(s))"
        >
          <AppIcon
            :name="s.kind === 'team' ? 'users' : 'lock'"
            :size="15"
          /><span>{{ s.name }}</span
          ><AppIcon v-if="space?.id === s.id" name="check" :size="14" />
        </button>
        <hr />
        <button role="menuitem" @click="showSpaceCreate = true">
          <AppIcon name="plus" :size="16" />New space
        </button></UiMenu
      >
      <nav class="sidebar-nav" aria-label="Workspace">
        <button @click="openSearch">
          <AppIcon name="search" :size="17" />Search<kbd>Ctrl K</kbd></button
        ><button
          :class="{ active: view === 'workspace' && !page }"
          @click="navigate(home)"
        >
          <AppIcon name="home" :size="17" />Workspace
        </button>
      </nav>
      <div class="sidebar-scroll">
        <section v-if="favoritePages.length" class="sidebar-section">
          <div class="sidebar-section-title">Favorites</div>
          <button
            v-for="p in favoritePages"
            :key="p.id"
            class="sidebar-link"
            @click="navigate(() => openPage(p.id))"
          >
            <AppIcon
              :name="p.kind === 'database' ? 'database' : 'file'"
              :size="15"
            /><span>{{ p.title }}</span>
          </button>
        </section>
        <section v-if="recentPages.length" class="sidebar-section">
          <div class="sidebar-section-title">Recently opened</div>
          <button
            v-for="p in recentPages.slice(0, 3)"
            :key="p.id"
            class="sidebar-link"
            @click="navigate(() => openPage(p.id))"
          >
            <AppIcon
              :name="p.kind === 'database' ? 'database' : 'file'"
              :size="15"
            /><span>{{ p.title }}</span>
          </button>
        </section>
        <section v-if="space" class="sidebar-section">
          <div class="sidebar-section-title">
            <span>{{
              space.kind === "team" ? "Team pages" : "Private pages"
            }}</span><UiMenu v-if="canCreate" label="Create in this space"
              ><button role="menuitem" @click="navigate(() => createPage())">
                <AppIcon name="file" :size="16" />New page</button
              ><button role="menuitem" @click="showDatabaseCreate = true">
                <AppIcon name="database" :size="16" />New database
              </button></UiMenu
            >
          </div>
          <div v-if="pageLoading && !pages.length">
            <div v-for="i in 4" :key="i" class="skeleton skeleton-row" />
          </div>
          <WorkspaceTree
            v-else
            :pages="pages"
            :active-id="page?.id"
            :can-create="canCreate"
            :expanded="expanded"
            @toggle="toggleExpanded"
            @open="navigate(() => openPage($event))"
            @create="navigate(() => createPage($event))"
          /><button
            v-if="nextCursor"
            class="sidebar-link"
            @click="run(() => loadPages(nextCursor))"
          >
            Load more pages</button
          ><button
            v-if="canCreate"
            class="sidebar-link"
            @click="navigate(() => createPage())"
          >
            <AppIcon name="plus" :size="16" />New page
          </button>
        </section>
        <section v-else class="sidebar-section">
          <div class="sidebar-section-title">Your spaces</div>
          <p class="tree-empty">
            Create a space to start collecting your ideas.
          </p>
        </section>
      </div>
      <div class="sidebar-footer">
        <button
          v-if="space && ['Owner', 'Admin'].includes(space.role)"
          class="sidebar-link subtle-link"
          @click="navigate(() => openSettings('space-settings'))"
        >
          <AppIcon name="settings" :size="15" />Space settings</button
        ><button
          v-if="space"
          class="sidebar-link subtle-link"
          @click="navigate(openTrash)"
        >
          <AppIcon name="trash" :size="15" />Trash</button
        ><button
          v-if="me?.isAdmin"
          class="sidebar-link subtle-link"
          @click="navigate(() => openSettings('oidc'))"
        >
          <AppIcon name="shield" :size="15" />SSO administration</button
        ><UiMenu label="Account menu" align="left" up wide
          ><template #trigger
            ><span class="avatar">{{ avatar }}</span
            ><span class="profile-copy"
              ><strong>{{ me?.email }}</strong
              ><small>Your account</small></span
            ><AppIcon name="chevronDown" :size="13" /></template
          ><button
            role="menuitem"
            @click="navigate(() => openSettings('account'))"
          >
            <AppIcon name="settings" :size="16" />Account &amp; security</button
          ><button role="menuitem" @click="showAppearance = true">
            <AppIcon name="palette" :size="16" />Appearance
          </button>
          <hr />
          <button
            role="menuitem"
            @click="
              run(async () => {
                await beforeNavigate();
                await api('auth/logout', 'POST', {});
                signedOut();
              })
            "
          >
            <AppIcon name="logout" :size="16" />Sign out
          </button></UiMenu
        >
      </div>
    </aside>
    <main class="workspace-main" :inert="mobile && sidebarOpen">
      <header class="workspace-topbar">
        <button
          class="icon-button"
          aria-label="Toggle sidebar"
          title="Toggle sidebar"
          @click="sidebarOpen = !sidebarOpen"
        >
          <AppIcon name="sidebar" :size="18" />
        </button>
        <nav class="breadcrumbs" aria-label="Breadcrumbs">
          <button v-if="space" @click="navigate(home)">
            {{ space.name }}</button><span v-else>Your workspace</span
          ><template v-if="view === 'workspace' && page"
            ><template v-for="ancestor in breadcrumbPages" :key="ancestor.id"
              ><AppIcon name="chevronRight" :size="13" /><button
                @click="navigate(() => openPage(ancestor.id))"
              >
                {{ ancestor.title }}
              </button></template
            ><AppIcon name="chevronRight" :size="13" /><AppIcon
              :name="page.kind === 'database' ? 'database' : 'file'"
              :size="14"
            /><span>{{ page.title }}</span></template
          ><template v-else-if="view !== 'workspace'"
            ><AppIcon name="chevronRight" :size="13" /><span>{{
              view === "account"
                ? "Account & security"
                : view === "space-settings"
                  ? "Space settings"
                  : view === "trash"
                    ? "Trash"
                    : "SSO administration"
            }}</span></template
          >
        </nav>
        <div v-if="view === 'workspace' && page" class="topbar-actions">
          <span v-if="page.access_rank < 30" class="badge"
            ><AppIcon name="lock" :size="12" />Read-only</span
          ><button
            class="icon-button"
            :class="{ 'favorite-active': favorites.includes(page.id) }"
            :aria-label="
              favorites.includes(page.id)
                ? 'Remove from favorites'
                : 'Add to favorites'
            "
            :aria-pressed="favorites.includes(page.id)"
            @click="toggleFavorite"
          >
            <AppIcon name="star" :size="17" /></button
          ><button
            v-if="page.access_rank >= 40 && page.kind !== 'database'"
            class="ghost desktop-action"
            @click="showPermissions = true"
          >
            <AppIcon name="users" :size="15" />Page permissions</button
          ><UiMenu label="Page actions"
            ><button
              v-if="page.kind === 'record' && page.parent_id"
              role="menuitem"
              @click="navigate(() => openPage(page.parent_id))"
            >
              <AppIcon name="back" :size="16" />Back to database</button
            ><button
              v-if="page.kind !== 'database'"
              role="menuitem"
              @click="
                fullWidth = !fullWidth;
                persist();
              "
            >
              <AppIcon name="arrowRight" :size="16" />{{
                fullWidth ? "Standard width" : "Full width"
              }}</button
            ><button
              v-if="page.kind !== 'database'"
              role="menuitem"
              @click="showAttachments = !showAttachments"
            >
              <AppIcon name="paperclip" :size="16" />Attachments</button
            ><button role="menuitem" @click="run(openHistory)">
              <AppIcon name="history" :size="16" />Version history</button
            ><button
              v-if="page.access_rank >= 40 && page.kind !== 'database'"
              role="menuitem"
              @click="showPermissions = true"
            >
              <AppIcon name="users" :size="16" />Page permissions</button
            ><button
              v-if="page.access_rank >= 30 && page.kind !== 'record'"
              role="menuitem"
              @click="
                moveParent = page.parent_id || '';
                showMove = true;
              "
            >
              <AppIcon name="folder" :size="16" />Move page
            </button>
            <hr v-if="page.access_rank >= 30" />
            <button
              v-if="page.access_rank >= 30"
              role="menuitem"
              class="danger"
              @click="showDelete = true"
            >
              <AppIcon name="trash" :size="16" />Move to trash
            </button></UiMenu
          >
        </div>
      </header>
      <div class="content-area">
        <div v-if="view === 'account'" class="settings-page">
          <AccountSettings
            v-if="me"
            :me="me"
            @changed="run(refreshMe)"
            @signed-out="signedOut"
          /><button class="ghost" @click="showAppearance = true">
            <AppIcon name="palette" :size="16" />Appearance
          </button>
        </div>
        <div v-else-if="view === 'oidc' && me?.isAdmin" class="settings-page">
          <OidcAdministration />
        </div>
        <div
          v-else-if="view === 'space-settings' && space"
          class="settings-page"
        >
          <SpaceSettings :space="space" @changed="run(refreshSpace)" />
        </div>
        <section v-else-if="view === 'trash'" class="settings-page">
          <div class="home-overline"><AppIcon name="trash" />Deleted pages</div>
          <h1>Trash · {{ space?.name }}</h1>
          <p>Restore a page to return it and its subpages to your space.</p>
          <ul class="trash-list">
            <li v-for="p in trash" :key="p.id">
              <AppIcon name="file" /><span>{{ p.title }}</span
              ><button
                v-if="p.access_rank >= 30"
                @click="
                  run(async () => {
                    await api('pages/' + p.id + '/restore', 'POST', {});
                    trash = await api('spaces/' + space.id + '/trash');
                    await loadPages();
                  })
                "
              >
                Restore page
              </button>
            </li>
          </ul>
          <div v-if="!trash.length" class="home-empty">
            <AppIcon name="trash" :size="26" />
            <h2>The trash is empty</h2>
            <p>Deleted pages you can access will appear here.</p>
          </div>
          <button class="ghost" @click="view = 'workspace'">
            Back to workspace
          </button>
        </section>
        <section v-else-if="!space" class="empty-workspace">
          <div class="empty-illustration">
            <AppIcon name="folder" :size="28" />
          </div>
          <div class="eyebrow">A fresh start</div>
          <h1>Your ideas deserve<br />a place of their own.</h1>
          <p>
            Create your first private space for notes, documents and projects.
            Invite others when you’re ready.
          </p>
          <form v-if="!spaces.length" @submit.prevent="createSpace">
            <label for="space-name">New private space</label
            ><input
              id="space-name"
              v-model="name"
              placeholder="e.g. My workspace"
              maxlength="120"
              required
            /><button class="primary" :disabled="busy">
              <AppIcon name="plus" :size="16" />Create space
            </button>
          </form>
          <button v-else class="primary" @click="showSpaceCreate = true">
            Create a space
          </button>
        </section>
        <div v-else-if="pageLoading && !page" class="document-page">
          <div class="skeleton skeleton-title" />
          <div
            v-for="i in 5"
            :key="i"
            class="skeleton skeleton-line"
            :style="{ width: 95 - i * 6 + '%' }"
          />
        </div>
        <LazyDatabaseWorkspace
          v-else-if="page?.kind === 'database'"
          :key="page.id"
          :database-id="page.id"
          :initial-title="page.title"
          @open="navigate(() => openPage($event))"
          @changed="run(refreshSpace)"
        />
        <article
          v-else-if="page"
          class="document-page"
          :class="{ 'full-width': fullWidth }"
        >
          <button
            v-if="page.kind === 'record' && page.parent_id"
            class="ghost record-back"
            @click="navigate(() => openPage(page.parent_id))"
          >
            <AppIcon name="back" :size="15" />Back to database
          </button>
          <div class="page-symbol"><AppIcon name="file" :size="48" /></div>
          <div class="page-heading">
            <label for="page-title" class="sr-only">Page title</label
            ><input
              id="page-title"
              ref="titleInput"
              v-model="page.title"
              class="page-title"
              maxlength="300"
              :readonly="navigating || pageLoading || page.access_rank < 30"
              placeholder="Untitled"
              @input="scheduleTitleSave"
              @blur="save().catch(() => {})"
            />
            <div class="page-title-state">
              <span v-if="titleStatus" role="status">{{
                titleStatus
              }}</span><button
                v-if="
                  titleStatus === 'Title could not be saved' ||
                  titleStatus === 'Unsaved title'
                "
                class="ghost"
                @click="run(save)"
              >
                Save title
              </button>
            </div>
          </div>
          <div v-if="titleConflict" class="title-conflict" role="alert">
            <p>
              This page was renamed to “{{ titleConflict.title }}” in another
              session. Your title is still here.
            </p>
            <div class="actions">
              <button @click="resolveTitle(false)">Use saved title</button
              ><button @click="resolveTitle(true)">Keep my title</button>
            </div>
          </div>
          <LazyBlockEditor
            v-if="me"
            ref="editorHandle"
            :key="page.id"
            :page-id="page.id"
            :space-id="page.space_id"
            :paused="navigating || pageLoading"
            :target-heading="targetHeading"
            :heading-visit="headingVisit"
            :user="me"
          />
          <section v-if="childPages.length" class="page-subpages">
            <h2>In this page</h2>
            <button
              v-for="child in childPages"
              :key="child.id"
              @click="navigate(() => openPage(child.id))"
            >
              <AppIcon
                :name="child.kind === 'database' ? 'database' : 'file'"
                :size="17"
              />{{ child.title }}
            </button>
          </section>
          <details
            class="page-attachments-disclosure"
            :open="showAttachments"
            @toggle="
              showAttachments = ($event.target as HTMLDetailsElement).open
            "
          >
            <summary>
              <AppIcon name="paperclip" :size="15" />Attachments<AppIcon
                :name="showAttachments ? 'chevronDown' : 'chevronRight'"
                :size="13"
              />
            </summary>
            <PageAttachments
              v-if="showAttachments"
              :key="page.id"
              :page="page"
            />
          </details>
        </article>
        <section v-else class="space-home">
          <div class="home-overline">
            <AppIcon
              :name="space.kind === 'team' ? 'users' : 'lock'"
              :size="15"
            />{{
              space.kind === "team"
                ? "A shared space for your team"
                : "Only you, until you decide otherwise"
            }}
          </div>
          <div class="home-header">
            <div>
              <h1>{{ space.name }}</h1>
              <p>
                {{
                  pages.length
                    ? "Pick up where you left off, or start something new."
                    : "Every great idea starts with a blank page."
                }}
              </p>
            </div>
            <button
              v-if="canCreate && pages.length"
              class="primary"
              aria-label="Create new page"
              @click="navigate(() => createPage())"
            >
              <AppIcon name="plus" :size="16" />New page
            </button>
          </div>
          <template v-if="pages.length"
            ><div class="home-section-title">
              <AppIcon
                :name="recentPages.length ? 'clock' : 'folder'"
                :size="15"
              />{{ recentPages.length ? "Recently opened" : "In this space" }}
            </div>
            <div class="page-cards">
              <button
                v-for="p in (recentPages.length ? recentPages : roots).slice(
                  0,
                  3,
                )"
                :key="p.id"
                class="page-card"
                :aria-label="'Open ' + p.title"
                @click="navigate(() => openPage(p.id))"
              >
                <span class="card-symbol"
                  ><AppIcon
                    :name="p.kind === 'database' ? 'database' : 'file'"
                    :size="20" /></span
                ><strong>{{ p.title }}</strong
                ><small
                  ><AppIcon
                    :name="p.visibility === 'restricted' ? 'lock' : 'file'"
                    :size="12"
                  />{{
                    p.kind === "database"
                      ? "Database"
                      : p.kind === "record"
                        ? "Record"
                        : "Page"
                  }}</small
                >
              </button>
            </div>
            <div class="home-section-title">
              <AppIcon name="folder" :size="15" />Pages &amp; databases
            </div>
            <div class="home-page-list">
              <button
                v-for="p in roots"
                :key="p.id"
                class="home-page-row"
                :aria-label="'Open ' + p.title"
                @click="navigate(() => openPage(p.id))"
              >
                <AppIcon
                  :name="p.kind === 'database' ? 'database' : 'file'"
                  :size="17"
                /><span>{{ p.title }}</span
                ><small>{{ p.kind === "database" ? "Database" : "Page" }}</small
                ><AppIcon name="arrowRight" :size="14" />
              </button></div
          ></template>
          <div v-else class="home-empty">
            <div class="empty-illustration">
              <AppIcon name="file" :size="25" />
            </div>
            <h2>Make this space yours</h2>
            <p>
              Start with a page for your thoughts, or a database to organize the
              details.
            </p>
            <div v-if="canCreate" class="empty-actions">
              <button class="primary" @click="navigate(() => createPage())">
                <AppIcon name="plus" :size="16" />Create your first page</button
              ><button @click="showDatabaseCreate = true">
                <AppIcon name="database" :size="16" />New database
              </button>
            </div>
          </div>
          <div class="home-tip">
            <AppIcon name="command" :size="15" /><span
              >Find any page with <kbd>Ctrl K</kbd>. Your changes save as you
              work.</span
            >
          </div>
        </section>
      </div>
    </main>
  </div>
  <div v-if="error || notice" class="toast-stack">
    <div v-if="error" class="toast error" role="alert">
      <AppIcon name="shield" :size="17" /><span>{{ error }}</span
      ><button
        class="icon-button"
        aria-label="Dismiss error"
        @click="error = ''"
      >
        <AppIcon name="x" :size="15" />
      </button>
    </div>
    <div v-else class="toast success" role="status">
      <AppIcon name="check" :size="17" /><span>{{ notice }}</span
      ><button
        class="icon-button"
        aria-label="Dismiss notification"
        @click="notice = ''"
      >
        <AppIcon name="x" :size="15" />
      </button>
    </div>
  </div>
  <UiDialog
    :open="showSpaceCreate"
    :error="error"
    title="Create a space"
    @close="showSpaceCreate = false"
    ><p>
      A private place for your pages. You can turn it into a team space later.
    </p>
    <form @submit.prevent="createSpace">
      <label for="dialog-space-name">New private space</label
      ><input
        id="dialog-space-name"
        v-model="name"
        required
        maxlength="120"
        autofocus
        placeholder="e.g. Product workspace"
      />
      <div class="actions">
        <button type="button" @click="showSpaceCreate = false">Cancel</button
        ><button class="primary" :disabled="busy">Create space</button>
      </div>
    </form></UiDialog
  >
  <UiDialog
    :open="showDatabaseCreate"
    :error="error"
    title="Create a database"
    @close="showDatabaseCreate = false"
    ><p>
      Organize information in tables, boards and other views. Every record has
      its own page.
    </p>
    <form @submit.prevent="createDatabase">
      <label for="database-name">Database name</label
      ><input
        id="database-name"
        v-model="databaseName"
        required
        maxlength="120"
        autofocus
        placeholder="e.g. Projects"
      /><label class="check-label"
        ><input v-model="includeDatabaseDefaults" type="checkbox" />Include
        status and date properties</label
      >
      <div class="actions">
        <button type="button" @click="showDatabaseCreate = false">Cancel</button
        ><button class="primary" :disabled="busy">Create database</button>
      </div>
    </form></UiDialog
  >
  <UiDialog
    :open="searchOpen"
    title="Search your workspace"
    wide
    @close="searchOpen = false"
    ><div class="command-search">
      <AppIcon name="search" :size="21" /><input
        ref="searchInput"
        v-model="searchTerm"
        aria-label="Search pages"
        placeholder="Search pages and databases…"
        autofocus
        autocomplete="off"
        @keydown="searchKeys"
      />
    </div>
    <p v-if="searchError" class="error" role="alert">{{ searchError }}</p>
    <p v-if="searchLoading" class="hint" role="status">Searching…</p>
    <div class="command-results">
      <button
        v-for="(result, index) in searchResults"
        :key="result.id"
        :class="{ 'command-active': index === searchIndex }"
        @click="openSearchResult(result)"
      >
        <AppIcon
          :name="result.kind === 'database' ? 'database' : 'file'"
          :size="18"
        /><span
          >{{ result.title
          }}<small
            >{{ result.space_name }} ·
            {{
              result.kind === "database"
                ? "Database"
                : result.kind === "record"
                  ? "Record"
                  : "Page"
            }}</small
          ></span
        ><AppIcon v-if="index === searchIndex" name="enter" :size="15" />
      </button>
    </div>
    <p
      v-if="!searchLoading && !searchResults.length && !searchError"
      class="hint"
    >
      {{
        searchTerm
          ? "No pages found. Try a different search."
          : "Your accessible pages will appear here."
      }}
    </p>
    <div class="command-footer">
      <span><kbd>↑</kbd> <kbd>↓</kbd> Navigate</span
      ><span><kbd>Enter</kbd> Open</span><span><kbd>Esc</kbd> Close</span>
    </div></UiDialog
  >
  <UiDialog
    :open="showAppearance"
    title="Appearance"
    @close="showAppearance = false"
    ><p>Choose a theme that feels right for your workspace.</p>
    <div class="theme-grid">
      <button
        v-for="option in themes"
        :key="option.id"
        class="theme-option"
        :aria-pressed="theme === option.id"
        @click="chooseTheme(option.id)"
      >
        <span class="theme-preview" :data-theme="option.id" aria-hidden="true"
          ><span />
          <div><i /><i /><i /></div></span
        ><span
          >{{ option.name
          }}<AppIcon v-if="theme === option.id" name="check" :size="15"
        /></span>
      </button>
    </div>
    <p class="hint" style="margin: 18px 0 0">
      Your choice is saved on this device.
    </p></UiDialog
  >
  <UiDialog
    :open="showPermissions && !!page"
    title="Page permissions"
    drawer
    @close="showPermissions = false"
    ><PagePermissions
      v-if="page && showPermissions"
      :key="page.id"
      :page="page"
      @changed="run(refreshPage)"
  /></UiDialog>
  <UiDialog
    :open="showHistory && !!page"
    title="Version history"
    drawer
    @close="showHistory = false"
    ><p class="hint">Saved versions of this page’s content.</p>
    <div class="history-list">
      <button
        v-for="h in history"
        :key="h.version"
        @click="
          run(
            async () =>
              (revision = await api(
                'pages/' + page.id + '/history/' + h.version,
              )),
          )
        "
      >
        <AppIcon name="clock" :size="16" /><span
          >Revision {{ h.version }} · {{ h.title }}</span
        >
      </button>
    </div>
    <pre v-if="revision" class="revision">{{
      documentText(revision.document)
    }}</pre>
  </UiDialog>
  <UiDialog
    :open="showMove && !!page"
    :error="error"
    title="Move page"
    @close="showMove = false"
    ><p>
      The page keeps its current audience. Parent restrictions can reduce access
      further.
    </p>
    <form @submit.prevent="movePage">
      <label for="move-parent">New parent</label
      ><select id="move-parent" v-model="moveParent">
        <option value="">Space root</option>
        <option v-for="p in moveTargets" :key="p.id" :value="p.id">
          {{ p.title }}
        </option>
      </select>
      <div class="actions">
        <button type="button" @click="showMove = false">Cancel</button
        ><button class="primary" :disabled="busy">Move page</button>
      </div>
    </form></UiDialog
  >
  <UiDialog
    :open="showDelete && !!page"
    :error="error"
    title="Move to trash?"
    @close="showDelete = false"
    ><p>
      “{{ page?.title }}” and its subpages will move to the trash. You can
      restore them later.
    </p>
    <div class="actions">
      <button @click="showDelete = false">Cancel</button
      ><button class="danger" :disabled="busy" @click="trashPage">
        Move to trash
      </button>
    </div></UiDialog
  >
</template>

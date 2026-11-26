<script setup lang="ts">
import { pageNavigationKey } from "../composables/pageNavigation";
import { recordNavigationKey } from "../composables/recordNavigation";
import {
  pendingWritesKey,
  type WriteFlusher,
} from "../composables/pendingWrites";
import {
  z,
  oidcFeedback,
  type RecordOpenMode,
  type OidcFeedbackCode,
} from "@orvyn/shared";
import type { DatabaseRecord } from "@orvyn/shared";
import { shortcutLabel } from "../utils/shortcuts";
import { headingFromHash, validHeadingId, pageLink } from "@orvyn/editor/links";
import { copyText } from "../utils/clipboard";
import type { CommentAnchor } from "@orvyn/editor/comments";
import { pageOrder } from "../utils/pageTree";
import {
  commentDraftsKey,
  type CommentDraftState,
} from "../composables/commentDrafts";
const commentDrafts = new Map<string, CommentDraftState>();
provide(commentDraftsKey, commentDrafts);
const pendingWrites = new Set<WriteFlusher>();
provide(pendingWritesKey, pendingWrites);
const route = useRoute(),
  router = useRouter();
const booting = ref(true),
  signedIn = ref(false),
  me = ref<any>(),
  providers = ref<any[]>([]),
  registration = ref({ enabled: false, allowedEmailDomains: [] as string[] }),
  registrationOptionsAvailable = ref(false),
  view = ref("workspace"),
  spaces = ref<any[]>([]),
  space = ref<any>(),
  pages = ref<any[]>([]),
  page = ref<any>(),
  pageLoading = ref(false),
  targetHeading = ref(""),
  headingVisit = ref(0),
  targetPerson = ref(""),
  personVisit = ref(0),
  navigating = ref(false),
  pending = ref(0),
  error = ref(""),
  notice = ref("");
const email = ref(""),
  password = ref(""),
  name = ref(""),
  authForm = ref<HTMLFormElement>();
const peekId = ref(""),
  peekMode = ref<"side" | "modal">("side"),
  peekHandle = ref<any>(),
  databaseHandle = ref<any>(),
  recordPropertiesHandle = ref<any>(),
  canSaveRecordTemplate = ref(false),
  recordTemplateDialog = ref<{ open: () => void }>();
let peekReturnFocus: HTMLElement | undefined;
const shortcutHelp = ref<{ open: () => void }>();
const databaseTemplates = ref<{ open: (parentId?: string | null) => void }>();
const markdownImport = ref<{ open: (parentId?: string) => void }>();
const markdownExport = ref<{ open: () => void }>();
const markdownBundle = ref<{ open: () => void }>();
const sidebarMenu = ref<any>(),
  sidebarTarget = ref<any>();
const sidebarActions = computed(() => [
  { id: "open", label: "Open page", icon: "file" },
  ...(["page", "record"].includes(sidebarTarget.value?.kind)
    ? [
        { id: "side", label: "Open to side", icon: "sidePeek" },
        { id: "modal", label: "Open as modal", icon: "gallery" },
      ]
    : []),
  { id: "copy", label: "Copy link", icon: "link", separator: true },
  ...(canCreate.value &&
  sidebarTarget.value?.access_rank >= 30 &&
  sidebarTarget.value?.kind === "page"
    ? [{ id: "create", label: "New subpage", icon: "plus" }]
    : []),
]);
function sidebarContext(event: MouseEvent | KeyboardEvent, target: any) {
  if (event.type === "contextmenu" && event.shiftKey) return;
  sidebarTarget.value = target;
  void sidebarMenu.value?.open(event);
}
async function sidebarAction(action: string) {
  const target = sidebarTarget.value;
  if (!target) return;
  if (action === "open") await navigate(() => openPage(target.id));
  else if (action === "side" || action === "modal")
    await openRecord(target.id, action);
  else if (action === "create") await navigate(() => createPage(target.id));
  else if (action === "copy") {
    try {
      await copyText(new URL(pageLink(target.id), location.origin).toString());
      notice.value = "Link copied";
    } catch (e: any) {
      error.value = e.message || "Link could not be copied.";
    }
  }
}
const linkAction = ref(""),
  linkToken = ref(""),
  authFeedback = ref(""),
  newPassword = ref("");
let authOptionsTimer: ReturnType<typeof setInterval> | undefined;
const sidebarOpen = ref(true),
  mobile = ref(false),
  showSpaceCreate = ref(false),
  showDatabaseCreate = ref(false),
  databaseParentId = ref<string | null>(null),
  databaseName = ref(""),
  includeDatabaseDefaults = ref(true),
  showPermissions = ref(false),
  showHistory = ref(false),
  showMove = ref(false),
  showDelete = ref(false),
  showAppearance = ref(false),
  showPageAppearance = ref(false),
  showComments = ref(false),
  showActivity = ref(false),
  activityPageId = ref(""),
  commentsInline = ref(false),
  pendingCommentAnchor = ref<CommentAnchor | null>(null),
  requestedCommentThread = ref(""),
  commentVisit = ref(0),
  focusedComment = ref<any>(),
  commentAnchorStatus = ref<"active" | "changed" | "missing">("active"),
  movingPage = ref(false),
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
const workspaceSearch = ref<{ open: () => Promise<void>; close: () => void }>();
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
const titleInput = ref<HTMLTextAreaElement>(),
  editorHandle = ref<{
    flush: () => Promise<void>;
    refreshComments: () => Promise<void>;
    focusComment: () => void;
    focusStart: () => void;
  }>(),
  titleConflict = ref<{ title: string; version: number }>(),
  titleStatus = ref(""),
  serverTitle = ref("");
function resizePageTitle() {
  const input = titleInput.value;
  if (!input) return;
  input.style.height = "auto";
  input.style.height = input.scrollHeight + "px";
}
watch([titleInput, () => page.value?.title, fullWidth, sidebarOpen], () =>
  nextTick(resizePageTitle),
);
let titleTimer: ReturnType<typeof setTimeout> | undefined,
  noticeTimer: ReturnType<typeof setTimeout> | undefined,
  titleJob: Promise<void> | undefined;
let viewport: MediaQueryList | undefined,
  commentViewport: MediaQueryList | undefined;
watch(
  () => space.value?.id,
  () => {
    showActivity.value = false;
    activityPageId.value = "";
  },
);
function commentViewportChanged(event: { matches: boolean }) {
  commentsInline.value = event.matches;
}
function closeComments() {
  showComments.value = false;
  pendingCommentAnchor.value = null;
  requestedCommentThread.value = "";
  focusedComment.value = undefined;
}
function commentOnText(anchor: CommentAnchor) {
  pendingCommentAnchor.value = anchor;
  requestedCommentThread.value = "";
  focusedComment.value = undefined;
  showComments.value = true;
}
function openCommentThread(id: string) {
  pendingCommentAnchor.value = null;
  requestedCommentThread.value = id;
  commentVisit.value++;
  showComments.value = true;
}
async function visitNotification(item: any) {
  if (navigating.value)
    throw new Error("Wait for the current page to finish opening.");
  navigating.value = true;
  try {
    await openPage(item.pageId);
    view.value = "workspace";
    if (item.threadId) openCommentThread(item.threadId);
    else {
      targetPerson.value = me.value.id;
      personVisit.value++;
    }
    if (mobile.value) sidebarOpen.value = false;
  } finally {
    navigating.value = false;
  }
}
function openActivity(forPage = false) {
  activityPageId.value = forPage ? page.value?.id || "" : "";
  showActivity.value = true;
}
async function visitActivity(id: string) {
  if (navigating.value)
    throw new Error("Wait for the current page to finish opening.");
  navigating.value = true;
  try {
    await openPage(id);
    view.value = "workspace";
  } finally {
    navigating.value = false;
  }
}
function selectComment(value: { pageId: string; thread: any | null }) {
  if (value.pageId !== page.value?.id) return;
  commentAnchorStatus.value = "active";
  focusedComment.value = value.thread || undefined;
}
async function jumpToComment(thread: any) {
  focusedComment.value = thread;
  if (!commentsInline.value) showComments.value = false;
  await nextTick();
  editorHandle.value?.focusComment();
}
function editorAccess(value: { pageId: string; rank: number }) {
  if (value.pageId !== page.value?.id) return;
  page.value.access_rank = value.rank;
  const known = pages.value.find((p) => p.id === value.pageId);
  if (known) known.access_rank = value.rank;
}
function anchorStatusChanged(value: {
  pageId: string;
  id: string;
  status: "active" | "changed" | "missing";
}) {
  if (value.pageId === page.value?.id && value.id === focusedComment.value?.id)
    commentAnchorStatus.value = value.status;
}
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
const knownPageIds = computed(() => new Set(pages.value.map((p) => p.id)));
const roots = computed(() =>
  pages.value
    .filter((p) => !p.parent_id || !knownPageIds.value.has(p.parent_id))
    .sort(pageOrder),
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
  pages.value
    .filter((p) => p.parent_id === page.value?.id && p.kind !== "record")
    .sort(pageOrder),
);
const moveTargets = computed(() =>
  pages.value.filter((candidate) => {
    if (candidate.access_rank < 30 || candidate.kind === "database")
      return false;
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
  () => me.value?.displayName?.slice(0, 2).toUpperCase() || "O",
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
          ...(peekId.value
            ? { peek: peekId.value, peekMode: peekMode.value }
            : {}),
        }
      : {},
  });
}
function signedOut() {
  peekId.value = "";
  commentDrafts.clear();
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
  workspaceSearch.value?.close();
  void router.replace({ path: "/", query: {} });
}
watch(
  () => me.value?.id,
  () => commentDrafts.clear(),
);
async function refreshMe() {
  me.value = await api("auth/me");
}
async function loadRegistrationOptions() {
  try {
    const options = (await api("auth/options")).registration;
    if (
      typeof options?.enabled !== "boolean" ||
      !Array.isArray(options.allowedEmailDomains) ||
      options.allowedEmailDomains.some(
        (domain: unknown) => typeof domain !== "string",
      )
    )
      throw Error("Invalid account options");
    registration.value = options;
    registrationOptionsAvailable.value = true;
  } catch {
    registrationOptionsAvailable.value = false;
    registration.value = { enabled: false, allowedEmailDomains: [] };
  }
}
async function login(action: string) {
  if (busy.value || !authForm.value?.reportValidity()) return;
  if (
    action === "register" &&
    (!registrationOptionsAvailable.value || !registration.value.enabled)
  ) {
    error.value =
      "Account creation is unavailable. Sign in with an existing account or contact your administrator.";
    return;
  }
  const requestedPage = String(route.query.page || ""),
    requestedHeading = headingFromHash(route.hash),
    requestedPeek = { ...route.query };
  await run(async () => {
    authFeedback.value = "";
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
    if (requestedPage) {
      await openPage(requestedPage, true, requestedHeading);
      restorePeek(requestedPeek);
      await updateLocation();
    } else if (list.length) {
      const selected = list.find((s: any) => s.id === pref.spaceId) || list[0];
      await select(selected);
    }
  });
}
async function startOidc(id: string) {
  authFeedback.value = "";
  const result = await api(
    "oidc/" + id + "/start",
    "POST",
    linkAction.value === "accept-invitation"
      ? { invitationToken: linkToken.value }
      : {},
  );
  window.location.assign(result.url);
}
async function refreshAuthOptions() {
  if (signedIn.value && linkAction.value !== "accept-invitation") return;
  await Promise.allSettled([
    api("oidc/providers").then((list) => {
      providers.value = list;
    }),
    loadRegistrationOptions(),
  ]);
}
async function cancelAccountLink() {
  await run(async () => {
    if (linkAction.value === "accept-invitation")
      await api("oidc/invitation/resume", "DELETE", {});
    linkAction.value = "";
    linkToken.value = "";
    authFeedback.value = "";
  });
}
async function switchInvitationAccount() {
  await run(async () => {
    await api("auth/logout", "POST", {});
    await api("oidc/invitation/resume", "DELETE", {});
    signedOut();
  });
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
  peekId.value = "";
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
  canSaveRecordTemplate.value = false;
  peekId.value = "";
  closeComments();
  showActivity.value = false;
  showPageAppearance.value = false;
  targetHeading.value = "";
  targetPerson.value = "";
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
provide(recordNavigationKey, (id, mode) => void openRecord(id, mode));
async function openRecord(id: string, mode: RecordOpenMode = "side") {
  if (mode === "page") {
    await navigate(() => openPage(id));
    return;
  }
  await navigate(async () => {
    await beforeNavigate();
    peekReturnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    closeComments();
    peekMode.value = mode;
    peekId.value = id;
    await updateLocation();
  });
}
async function closePeek() {
  const returnFocus = peekReturnFocus;
  peekReturnFocus = undefined;
  peekId.value = "";
  await nextTick();
  // Restore focus as the preview disappears, before asynchronous routing.
  // A user may already have focused another row or field in the meantime.
  if (
    !peekId.value &&
    (!document.activeElement || document.activeElement === document.body)
  ) {
    if (returnFocus?.isConnected) returnFocus.focus();
    else
      document
        .querySelector<HTMLInputElement>(".database-search input")
        ?.focus();
  }
  await updateLocation();
}
function restorePeek(query: Record<string, unknown>) {
  peekId.value = "";
  const id = String(query.peek || "").toLowerCase();
  if (z.uuid().safeParse(id).success) {
    peekId.value = id;
    peekMode.value = query.peekMode === "modal" ? "modal" : "side";
  }
}
function updateRecordSnapshot(record: DatabaseRecord) {
  if (page.value?.id !== record.pageId) return;
  if (page.value.title === serverTitle.value && !titleJob) {
    page.value.title = record.title;
    page.value.title_version = record.titleVersion;
    serverTitle.value = record.title;
  }
  page.value.access_rank = record.accessRank;
}
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
function pageAppearanceChanged(value: any) {
  const entry = pages.value.find((p) => p.id === value.id);
  if (entry) Object.assign(entry, value);
  if (page.value?.id === value.id) Object.assign(page.value, value);
}
async function flushCurrentDocument() {
  await save();
  if (titleConflict.value)
    throw new Error("Resolve the title conflict before leaving this page.");
  await editorHandle.value?.flush();
  await recordPropertiesHandle.value?.flush();
}
async function flushSource(id: string) {
  if (id === peekId.value) await peekHandle.value?.flush();
  if (id === page.value?.id) await flushCurrentDocument();
}
async function beforeNavigate() {
  await flushCurrentDocument();
  await Promise.all([...pendingWrites].map((flush) => flush()));
  await databaseHandle.value?.flush();
  await peekHandle.value?.flush();
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
const whiteboardHandle = ref<{
  flush: () => Promise<void>;
  openHistory: () => Promise<void>;
}>();
async function createPage(
  parentId: string | null = null,
  kind: "page" | "folder" | "whiteboard" = "page",
) {
  if (!space.value || !canCreate.value || pageLoading.value) return;
  pageLoading.value = true;
  try {
    await beforeNavigate();
    page.value = undefined;
    view.value = "workspace";
    const p = await api(`spaces/${space.value.id}/pages`, "POST", {
      title:
        kind === "folder"
          ? "Untitled folder"
          : kind === "whiteboard"
            ? "Untitled whiteboard"
            : "Untitled",
      parentId,
      kind,
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
      parentId: databaseParentId.value,
      includeDefaults: includeDatabaseDefaults.value,
    });
    databaseName.value = "";
    showDatabaseCreate.value = false;
    await loadPages();
    edit(result.page);
    await updateLocation();
  });
}
function createItem(
  kind: "page" | "whiteboard" | "database" | "folder",
  parentId: string | null = null,
) {
  if (kind === "database") {
    databaseParentId.value = parentId;
    showDatabaseCreate.value = true;
  } else {
    void navigate(() => createPage(parentId, kind));
  }
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
async function moveHierarchy(value: {
  id: string;
  placement: "before" | "after" | "inside" | "root";
  targetId: string | null;
  targetParentId?: string | null;
}) {
  if (movingPage.value || navigating.value) return;
  movingPage.value = true;
  try {
    await navigate(async () => {
      await beforeNavigate();
      const current = await api("pages/" + value.id),
        moved = await api("pages/" + value.id + "/move", "POST", {
          ...value,
          structureVersion: current.structure_version,
        });
      await loadPages();
      if (page.value?.id === moved.id) Object.assign(page.value, moved);
      if (moved.parent_id && !expanded.value.includes(moved.parent_id))
        expanded.value.push(moved.parent_id);
      if (
        value.placement === "inside" &&
        !expanded.value.includes(value.targetId!)
      )
        expanded.value.push(value.targetId!);
      notice.value =
        moved.parent_id !== current.parent_id
          ? "Page moved. Its previous audience is preserved; parent restrictions still apply."
          : "Page order updated.";
      await nextTick();
      document
        .querySelector<HTMLButtonElement>(
          '.workspace-tree [data-page="' + CSS.escape(moved.id) + '"]',
        )
        ?.focus();
    });
  } finally {
    movingPage.value = false;
  }
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
  if (page.value?.kind === "whiteboard") {
    await whiteboardHandle.value?.openHistory();
    return;
  }
  history.value = await api("pages/" + page.value.id + "/history");
  showHistory.value = true;
  revision.value = undefined;
}
function documentText(node: any): string {
  return node.text || (node.content || []).map(documentText).join(" ");
}
async function openSearch() {
  await workspaceSearch.value?.open();
}
async function openSearchResult(id: string) {
  await navigate(() => openPage(id));
}
function globalKeys(event: KeyboardEvent) {
  if (
    event.defaultPrevented ||
    !signedIn.value ||
    event.getModifierState("AltGraph")
  )
    return;
  const mod = event.metaKey || event.ctrlKey,
    key = event.key.toLowerCase(),
    modal = !!document.querySelector("dialog:modal");
  if (mod && !event.altKey && !event.shiftKey && ["k", "p"].includes(key)) {
    event.preventDefault();
    void openSearch();
    return;
  }
  if (mod && key === "/") {
    event.preventDefault();
    shortcutHelp.value?.open();
    return;
  }
  if (mod && event.shiftKey && key === "l") {
    event.preventDefault();
    chooseTheme(theme.value === "light" ? "cybercade" : "light");
    return;
  }
  if (modal) return;
  if (mod && key === "\\") {
    event.preventDefault();
    sidebarOpen.value = !sidebarOpen.value;
    return;
  }
  if (mod && event.altKey && key === "n" && canCreate.value) {
    event.preventDefault();
    void navigate(() => createPage());
    return;
  }
  if (mod && event.altKey && key === "d" && canCreate.value) {
    event.preventDefault();
    createItem("database");
    return;
  }
  if (mod && event.altKey && key === "r" && databaseHandle.value) {
    event.preventDefault();
    databaseHandle.value.newRecord();
    return;
  }
  if (mod && event.altKey && key === "f" && databaseHandle.value) {
    event.preventDefault();
    databaseHandle.value.filters();
    return;
  }
  const editing = (event.target as HTMLElement).closest(
    'input,textarea,[contenteditable="true"]',
  );
  if (
    key === "/" &&
    !mod &&
    !event.altKey &&
    !editing &&
    databaseHandle.value
  ) {
    event.preventDefault();
    databaseHandle.value.search();
    return;
  }
  if (event.key === "Escape" && peekId.value && !editing) {
    event.preventDefault();
    void peekHandle.value?.requestClose();
    return;
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
  restorePeek(Object.fromEntries(query));
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
      await api("oidc/invitation/resume", "DELETE", {}).catch(() => {});
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
  commentViewport = window.matchMedia("(min-width: 1200px)");
  commentViewportChanged(commentViewport);
  commentViewport.addEventListener("change", commentViewportChanged);
  try {
    const stored = localStorage.getItem("orvyn.theme");
    if (themes.some((t) => t.id === stored)) theme.value = stored!;
  } catch {}
  window.addEventListener("keydown", globalKeys);
  window.addEventListener("popstate", fromHistory);
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("resize", resizePageTitle);
  await readAccountLink();
  if (
    typeof route.query.authError === "string" &&
    Object.hasOwn(oidcFeedback, route.query.authError)
  )
    authFeedback.value =
      oidcFeedback[route.query.authError as OidcFeedbackCode];
  if (route.query.authError || route.query.resume) {
    const query = { ...route.query };
    delete query.authError;
    delete query.resume;
    await router.replace({ path: route.path, hash: route.hash, query });
  }
  const requestedSpace = String(route.query.space || ""),
    requestedPage = String(route.query.page || "");
  const result = await Promise.allSettled([
    api("auth/me"),
    api("spaces"),
    api("oidc/providers"),
    loadRegistrationOptions(),
    api("oidc/invitation/resume", "POST", {}),
  ]);
  const continuation = result[4];
  if (
    !linkAction.value &&
    continuation.status === "fulfilled" &&
    continuation.value.invitationToken
  ) {
    linkAction.value = "accept-invitation";
    linkToken.value = continuation.value.invitationToken;
  }
  if (continuation.status === "rejected")
    authFeedback.value ||=
      "Your invitation sign-in context could not be resumed. Sign in with the same account or reopen the original invitation link.";
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
        restorePeek(route.query);
      });
  }
  booting.value = false;
  window.addEventListener("focus", refreshAuthOptions);
  authOptionsTimer = setInterval(() => {
    void refreshAuthOptions();
  }, 15000);
});
onBeforeUnmount(() => {
  clearInterval(authOptionsTimer);
  window.removeEventListener("focus", refreshAuthOptions);
  clearTimeout(titleTimer);
  clearTimeout(noticeTimer);
  window.removeEventListener("keydown", globalKeys);
  window.removeEventListener("popstate", fromHistory);
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener("resize", resizePageTitle);
  viewport?.removeEventListener("change", viewportChanged);
  commentViewport?.removeEventListener("change", commentViewportChanged);
});
</script>
<template>
  <div v-if="booting" class="startup-screen">
    <div class="brand-mark">
      <img src="/branding/icon-192.png" alt="" width="28" height="28" />
    </div>
    <p>Opening your workspace…</p>
  </div>
  <div v-else-if="!signedIn || linkAction" class="auth-shell">
    <div class="auth-story">
      <a class="auth-brand" href="/"
        ><span class="brand-mark"
          ><img
            src="/branding/icon-192.png"
            alt=""
            width="28"
            height="28" /></span
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
        <div v-if="authFeedback" class="auth-feedback" role="alert">
          <AppIcon name="shield" :size="19" />
          <div>
            <strong>We couldn’t complete sign-in</strong>
            <p>{{ authFeedback }}</p>
          </div>
        </div>
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
            <div
              v-if="linkAction === 'accept-invitation' && me"
              class="invite-account"
            >
              <AppIcon name="users" :size="18" />
              <div>
                <strong>{{ me.displayName }}</strong><span>{{ me.email }}</span>
              </div>
              <button
                type="button"
                class="ghost"
                :disabled="busy"
                @click="switchInvitationAccount"
              >
                Switch account
              </button>
            </div>
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
          <AuthProviders
            v-if="linkAction === 'accept-invitation' && !signedIn"
            :providers="providers"
            :disabled="busy"
            invitation
            @select="(id) => run(() => startOidc(id))"
          />
          <button
            class="ghost auth-forgot"
            :disabled="busy"
            @click="cancelAccountLink"
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
                v-if="registrationOptionsAvailable && registration.enabled"
                type="button"
                :disabled="busy"
                @click="login('register')"
              >
                Create account
              </button>
            </div>
          </form>
          <div
            v-if="!registrationOptionsAvailable"
            class="auth-registration-note"
            role="status"
          >
            <AppIcon name="info" :size="16" />
            <div>
              <p>
                Account creation options could not be loaded. You can still sign
                in.
              </p>
              <button
                class="ghost"
                :disabled="busy"
                @click="run(loadRegistrationOptions)"
              >
                Try again
              </button>
            </div>
          </div>
          <div v-else-if="!registration.enabled" class="auth-registration-note">
            <AppIcon name="shield" :size="16" />
            <p>
              Sign in with an existing account.
              <template v-if="providers.length"
                >You can also use your organization’s sign-in below.</template
              >
              Contact your administrator if you need access.
            </p>
          </div>
          <div
            v-else-if="registration.allowedEmailDomains.length"
            class="auth-registration-note"
          >
            <AppIcon name="info" :size="16" />
            <p>
              New accounts require an email address at
              {{ registration.allowedEmailDomains.join(", ") }}.
            </p>
          </div>
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
          <AuthProviders
            :providers="providers"
            :disabled="busy"
            @select="(id) => run(() => startOidc(id))"
          />
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
        <span class="brand-mark"
          ><img
            src="/branding/icon-192.png"
            alt=""
            width="28"
            height="28" /></span
        ><a class="brand-word" href="/" @click.prevent="navigate(home)"
          >orvyn<span>.</span></a
        ><button
          class="icon-button"
          :title="'Collapse sidebar · ' + shortcutLabel('Mod+\\')"
          aria-label="Collapse sidebar"
          @click="sidebarOpen = false"
        >
          <AppIcon name="sidebarClose" :size="16" />
        </button>
      </div>
      <UiMenu label="Switch space" align="left" wide
        ><template #trigger
          ><span class="space-letter"
            ><PageSymbol
              v-if="space?.icon"
              :icon="space.icon"
              :size="19"
            /><template v-else>{{
              space?.name?.slice(0, 1).toUpperCase() || "W"
            }}</template></span
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
          <PageSymbol v-if="s.icon" :icon="s.icon" :size="15" /><AppIcon
            v-else
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
        <NotificationInbox :key="me?.id" :visit="visitNotification" />
        <button :disabled="!space" @click="openActivity()">
          <AppIcon name="history" :size="17" />Activity
        </button>
        <button
          :title="'Search pages · ' + shortcutLabel('Mod+P')"
          @click="openSearch"
        >
          <AppIcon name="search" :size="17" />Search<kbd>{{
            shortcutLabel("Mod+P")
          }}</kbd></button
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
            <PageSymbol :icon="p.icon" :kind="p.kind" :size="15" /><span>{{
              p.title
            }}</span>
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
            <PageSymbol :icon="p.icon" :kind="p.kind" :size="15" /><span>{{
              p.title
            }}</span>
          </button>
        </section>
        <section v-if="space" class="sidebar-section">
          <div class="sidebar-section-title">
            <span>{{
              space.kind === "team" ? "Team pages" : "Private pages"
            }}</span>
            <PageCreateMenu
              v-if="canCreate"
              label="Create in this space"
              @create="createItem($event)"
              @import="markdownImport?.open()"
            />
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
            :moving="movingPage || navigating"
            @toggle="toggleExpanded"
            @open="navigate(() => openPage($event))"
            @create="(parentId, kind) => createItem(kind, parentId)"
            @import="markdownImport?.open($event)"
            @move="moveHierarchy"
            @context="sidebarContext"
          /><button
            v-if="nextCursor"
            class="sidebar-link"
            @click="run(() => loadPages(nextCursor))"
          >
            Load more pages</button
          ><PageCreateMenu
            v-if="canCreate"
            label="Create new item"
            trigger-class="sidebar-link"
            trigger-text="New"
            align="left"
            class="sidebar-create"
            @create="createItem($event)"
            @import="markdownImport?.open()"
          />
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
          v-if="space"
          class="sidebar-link subtle-link"
          @click="databaseTemplates?.open()"
        >
          <AppIcon name="copy" :size="15" />Templates
        </button>
        <button
          class="sidebar-link subtle-link"
          aria-label="Keyboard shortcuts"
          :title="shortcutLabel('Mod+/')"
          @click="shortcutHelp?.open()"
        >
          <AppIcon name="keyboard" :size="15" />Keyboard shortcuts<kbd
            class="sidebar-shortcut"
            >{{ shortcutLabel("Mod+/") }}</kbd
          >
        </button>
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
              ><strong>{{ me?.displayName }}</strong
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
    <main
      class="workspace-main"
      :class="{
        'comments-inline': showComments && commentsInline,
        'side-peek-open': !!peekId && peekMode === 'side',
      }"
      :inert="mobile && sidebarOpen"
    >
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
              :name="
                page.kind === 'database'
                  ? 'database'
                  : page.kind === 'whiteboard'
                    ? 'whiteboard'
                    : 'file'
              "
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
          <div id="page-editor-tools" />
          <span v-if="page.access_rank < 30" class="badge"
            ><AppIcon name="lock" :size="12" />{{
              page.access_rank >= 20 ? "Can comment" : "Read-only"
            }}</span
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
            v-if="page.access_rank >= 40"
            class="ghost desktop-action"
            @click="showPermissions = true"
          >
            <AppIcon name="users" :size="15" />Share</button
          ><button
            class="ghost"
            aria-label="Comments"
            @click="showComments = true"
          >
            <AppIcon name="comments" :size="16" /><span class="desktop-action"
              >Comments</span
            ></button
          ><UiMenu label="Page actions"
            ><button
              v-if="['page', 'folder'].includes(page.kind)"
              role="menuitem"
              @click="markdownBundle?.open()"
            >
              <AppIcon name="folder" :size="16" />Export pages as ZIP</button
            ><button
              v-if="['page', 'record'].includes(page.kind)"
              role="menuitem"
              @click="markdownExport?.open()"
            >
              <AppIcon name="download" :size="16" />Export Markdown</button
            ><button
              v-if="
                canCreate &&
                ['page', 'folder'].includes(page.kind) &&
                page.access_rank >= 30
              "
              role="menuitem"
              @click="markdownImport?.open(page.id)"
            >
              <AppIcon name="upload" :size="16" />Import Markdown as subpage</button
            ><button role="menuitem" @click="openActivity(true)">
              <AppIcon name="history" :size="16" />Page activity</button
            ><button
              v-if="page.access_rank >= 30"
              role="menuitem"
              @click="showPageAppearance = true"
            >
              <AppIcon name="palette" :size="16" />Icon and cover</button
            ><button
              v-if="
                canCreate &&
                ['page', 'folder'].includes(page.kind) &&
                page.access_rank >= 30
              "
              role="menuitem"
              @click="navigate(() => createPage(page.id, 'folder'))"
            >
              <AppIcon name="folder" :size="16" />New subfolder</button
            ><button
              v-if="page.kind === 'record' && page.parent_id"
              role="menuitem"
              @click="navigate(() => openPage(page.parent_id))"
            >
              <AppIcon name="back" :size="16" />Back to database</button
            ><button
              v-if="page.kind === 'record' && canSaveRecordTemplate"
              role="menuitem"
              @click="recordTemplateDialog?.open()"
            >
              <AppIcon name="copy" :size="16" />Save as template</button
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
              v-if="page.access_rank >= 40"
              role="menuitem"
              @click="showPermissions = true"
            >
              <AppIcon name="users" :size="16" />Share page</button
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
          ref="databaseHandle"
          :key="page.id"
          :database-id="page.id"
          :initial-title="page.title"
          :appearance="page"
          @open="openRecord"
          @changed="run(refreshSpace)"
        />
        <article
          v-else-if="page"
          class="document-page"
          :class="{ 'full-width': fullWidth || page.kind === 'whiteboard' }"
        >
          <button
            v-if="page.kind === 'record' && page.parent_id"
            class="ghost record-back"
            @click="navigate(() => openPage(page.parent_id))"
          >
            <AppIcon name="back" :size="15" />Back to database
          </button>
          <CoverBanner
            :preset="page.cover_preset"
            :file-id="page.cover_file_id"
          />
          <div class="page-decoration-controls">
            <button
              v-if="page.icon && page.access_rank >= 30"
              class="page-symbol page-symbol-button"
              aria-label="Change page icon and cover"
              @click="showPageAppearance = true"
            >
              <PageSymbol :icon="page.icon" :kind="page.kind" :size="48" />
            </button>
            <div v-else-if="page.icon" class="page-symbol">
              <PageSymbol :icon="page.icon" :kind="page.kind" :size="48" />
            </div>
            <button
              v-if="page.access_rank >= 30"
              class="ghost page-cover-action"
              @click="showPageAppearance = true"
            >
              <AppIcon :name="page.icon ? 'palette' : 'plus'" :size="14" />{{
                page.icon ? "Icon and cover" : "Add icon or cover"
              }}
            </button>
          </div>
          <div class="page-heading">
            <label for="page-title" class="sr-only">Page title</label
            ><textarea
              id="page-title"
              ref="titleInput"
              v-model="page.title"
              class="page-title"
              rows="1"
              maxlength="300"
              :readonly="navigating || pageLoading || page.access_rank < 30"
              placeholder="Untitled"
              @input="
                scheduleTitleSave();
                resizePageTitle();
              "
              @keydown.enter.prevent="editorHandle?.focusStart()"
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
          <RecordProperties
            v-if="page.kind === 'record' && page.parent_id"
            :key="'properties-' + page.id"
            ref="recordPropertiesHandle"
            :database-id="page.parent_id"
            :record-id="page.id"
            :editable="page.access_rank >= 30 && !navigating"
            @snapshot="updateRecordSnapshot"
            @denied="editorAccess({ pageId: $event, rank: 0 })"
            @template-access="canSaveRecordTemplate = $event"
            @manage="showAttachments = true"
          />
          <LazyWhiteboard
            v-if="page.kind === 'whiteboard'"
            :key="page.id"
            ref="whiteboardHandle"
            :page-id="page.id"
            :paused="navigating || pageLoading"
          />
          <LazyBlockEditor
            v-else-if="me"
            ref="editorHandle"
            :key="page.id"
            :page-id="page.id"
            :space-id="page.space_id"
            :access-rank="page.access_rank"
            :focused-comment="focusedComment"
            @comment="commentOnText"
            @thread="openCommentThread"
            @access="editorAccess"
            @anchor-status="anchorStatusChanged"
            :paused="navigating || pageLoading"
            :target-heading="targetHeading"
            :heading-visit="headingVisit"
            :target-person="targetPerson"
            :person-visit="personVisit"
            :user="me"
            chrome-target="#page-editor-tools"
          />
          <section
            v-if="childPages.length || page.kind === 'folder'"
            class="page-subpages"
          >
            <h2>
              {{
                page.kind === "folder" ? "Pages in this folder" : "In this page"
              }}
            </h2>
            <p v-if="page.kind === 'folder' && !childPages.length" class="hint">
              {{
                page.access_rank >= 30
                  ? "Add a page, or drag one here from the sidebar."
                  : "No pages to show."
              }}
            </p>
            <button
              v-for="child in childPages"
              :key="child.id"
              @click="navigate(() => openPage(child.id))"
            >
              <PageSymbol :icon="child.icon" :kind="child.kind" :size="17" />{{
                child.title
              }}
            </button>
            <div
              v-if="
                page.kind === 'folder' && canCreate && page.access_rank >= 30
              "
              class="actions"
            >
              <button
                class="ghost"
                @click="navigate(() => createPage(page.id))"
              >
                <AppIcon name="plus" :size="16" />New page in this folder</button
              ><button
                class="ghost"
                @click="navigate(() => createPage(page.id, 'folder'))"
              >
                <AppIcon name="folder" :size="16" />New subfolder
              </button>
            </div>
          </section>
          <PageBacklinks :key="page.id" :page-id="page.id" />
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
          <CoverBanner :preset="space.cover_preset" />
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
              <h1>
                <PageSymbol v-if="space.icon" :icon="space.icon" :size="34" />{{
                  space.name
                }}
              </h1>
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
                  ><PageSymbol :icon="p.icon" :kind="p.kind" :size="20" /></span
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
                        : p.kind === "folder"
                          ? "Folder"
                          : "Page"
                  }}</small
                >
              </button>
            </div>
            <div class="home-section-title">
              <AppIcon name="folder" :size="15" />Pages, folders &amp; databases
            </div>
            <div class="home-page-list">
              <button
                v-for="p in roots"
                :key="p.id"
                class="home-page-row"
                :aria-label="'Open ' + p.title"
                @click="navigate(() => openPage(p.id))"
              >
                <PageSymbol :icon="p.icon" :kind="p.kind" :size="17" /><span>{{
                  p.title
                }}</span
                ><small>{{
                  p.kind === "database"
                    ? "Database"
                    : p.kind === "folder"
                      ? "Folder"
                      : "Page"
                }}</small
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
              ><button @click="createItem('database')">
                <AppIcon name="database" :size="16" />New database
              </button>
            </div>
          </div>
          <div class="home-tip">
            <AppIcon name="command" :size="15" /><span
              >Find any page with <kbd>{{ shortcutLabel("Mod+P") }}</kbd>. Your
              changes save as you work.</span
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
    <button
      type="button"
      class="ghost"
      @click="
        showDatabaseCreate = false;
        databaseTemplates?.open(databaseParentId);
      "
    >
      <AppIcon name="copy" :size="16" />Start with a saved template
    </button>
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
  <WorkspaceSearch
    v-if="signedIn"
    :key="'search-' + me?.id"
    ref="workspaceSearch"
    :spaces="spaces"
    @select="openSearchResult"
  />
  <LazyActivityPanel
    v-if="space"
    :key="'activity-' + me?.id + '-' + space.id"
    :open="showActivity"
    :space-id="space.id"
    :page-id="activityPageId"
    :visit="visitActivity"
    @close="showActivity = false"
  />
  <LazyPageComments
    v-if="page"
    :key="'comments-' + page.id"
    :open="showComments"
    :page-id="page.id"
    :modal="!commentsInline"
    :anchor="pendingCommentAnchor"
    :requested-thread="requestedCommentThread"
    :request-visit="commentVisit"
    :anchor-status="commentAnchorStatus"
    @close="closeComments"
    @select="selectComment"
    @jump="jumpToComment"
    @changed="(id) => id === page?.id && editorHandle?.refreshComments()"
  />
  <PageAppearanceDialog
    v-if="page"
    :key="page.id"
    :open="showPageAppearance"
    title="Page appearance"
    :resource-path="'pages/' + page.id"
    :appearance="page"
    :page-id="page.id"
    @close="showPageAppearance = false"
    @changed="pageAppearanceChanged"
  />
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
    title="Share page"
    drawer
    @close="showPermissions = false"
    ><PageSharing
      v-if="page && showPermissions"
      :key="page.id"
      :page="page"
      :flush="beforeNavigate"
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
  <LazyPagePeek
    v-if="peekId && me"
    :key="peekId"
    ref="peekHandle"
    :page-id="peekId"
    :mode="peekMode"
    :user="me"
    :paused="navigating"
    @close="closePeek"
    @fullpage="(id, heading) => navigate(() => openPage(id, true, heading))"
    @mode="
      peekMode = $event;
      updateLocation();
    "
    @changed="
      databaseHandle?.reload?.();
      loadPages();
    "
  />
  <SaveDatabaseTemplate
    v-if="page?.kind === 'record' && page.parent_id"
    :key="'record-template-' + page.id"
    ref="recordTemplateDialog"
    :database-id="page.parent_id"
    :record-id="page.id"
    :title="page.title"
    :before-save="flushCurrentDocument"
    @saved="notice = 'Template saved'"
  />
  <KeyboardShortcuts ref="shortcutHelp" />
  <MarkdownExport
    v-if="page && ['page', 'record'].includes(page.kind)"
    :key="'markdown-export-' + page.id"
    ref="markdownExport"
    :page-id="page.id"
    :before-export="flushCurrentDocument"
  />
  <MarkdownBundle
    v-if="page && ['page', 'folder'].includes(page.kind)"
    :key="'markdown-bundle-' + page.id"
    ref="markdownBundle"
    :page-id="page.id"
    :before-export="flushCurrentDocument"
  />
  <MarkdownImport
    v-if="space && canCreate"
    :key="'markdown-' + space.id"
    ref="markdownImport"
    :space="space"
    :pages="pages"
    :before-import="flushCurrentDocument"
    @created="
      (id) =>
        navigate(async () => {
          await loadPages();
          await openPage(id);
        })
    "
  />
  <UiContextMenu
    ref="sidebarMenu"
    label="Page actions"
    :items="sidebarActions"
    @select="sidebarAction"
  />
  <DatabaseTemplateLibrary
    v-if="space"
    :key="space.id"
    ref="databaseTemplates"
    kind="database"
    :space-id="space.id"
    :can-create="canCreate"
    :flush-source="flushSource"
    @created="
      (id) =>
        navigate(async () => {
          await loadPages();
          await openPage(id);
        })
    "
  />
</template>

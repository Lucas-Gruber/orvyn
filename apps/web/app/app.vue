<script setup lang="ts">
const view = ref("workspace"),
  me = ref<any>(null),
  providers = ref<any[]>([]),
  linkAction = ref(""),
  linkToken = ref(""),
  newPassword = ref(""),
  notice = ref("");
const email = ref(""),
  password = ref(""),
  error = ref(""),
  spaces = ref<any[]>([]),
  pages = ref<any[]>([]),
  space = ref<any>(),
  page = ref<any>(),
  content = ref(""),
  name = ref(""),
  title = ref(""),
  signedIn = ref(false);
async function api(path: string, method = "GET", body?: unknown) {
  return await $fetch<any>("/api/v1/" + path, {
    method: method as any,
    body: body as any,
  });
}
async function run(fn: () => Promise<void>) {
  error.value = "";
  try {
    await fn();
  } catch (e: any) {
    error.value = e.data?.message || "Request failed. Please try again.";
  }
}
async function startOidc(id: string) {
  const result = await api("oidc/" + id + "/start", "POST", {});
  window.location.assign(result.url);
}
async function refreshMe() {
  me.value = await api("auth/me");
}
function signedOut() {
  signedIn.value = false;
  spaces.value = [];
  pages.value = [];
  space.value = null;
  page.value = null;
  me.value = null;
  view.value = "workspace";
}
async function login(action: string) {
  await run(async () => {
    await api("auth/" + action, "POST", {
      email: email.value,
      password: password.value,
    });
    password.value = "";
    signedIn.value = true;
    spaces.value = await api("spaces");
    await refreshMe();
  });
}
async function select(s: any) {
  await run(async () => {
    view.value = "workspace";
    space.value = s;
    page.value = null;
    search.value = "";
    createParent.value = "";
    await loadPages();
  });
}
function edit(p: any) {
  page.value = p;
  showPermissions.value = false;
  showHistory.value = false;
  revision.value = null;
  moveParent.value = p.parent_id || "";
  content.value = p.document.content.map((n: any) => n.text).join("\n");
}
async function save() {
  await run(async () => {
    const p = await api("pages/" + page.value.id, "PUT", {
      title: page.value.title,
      version: page.value.version,
      document: {
        type: "doc",
        content: content.value
          .split("\n")
          .map((text) => ({ type: "paragraph", text })),
      },
    });
    Object.assign(page.value, p);
  });
}
const createParent = ref(""),
  moveParent = ref(""),
  showPermissions = ref(false),
  showHistory = ref(false),
  history = ref<any[]>([]),
  revision = ref<any>(),
  trash = ref<any[]>([]),
  search = ref(""),
  nextCursor = ref("");
const canCreate = computed(() =>
  ["Owner", "Admin", "Editor"].includes(space.value?.role),
);
const orderedPages = computed(() => {
  const result: any[] = [],
    seen = new Set<string>(),
    ids = new Set(pages.value.map((p) => p.id));
  const visit = (parent: string | null, depth: number) => {
    for (const p of pages.value
      .filter((p) => (p.parent_id || null) === parent)
      .sort(
        (a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title),
      )) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      result.push({ ...p, depth });
      visit(p.id, depth + 1);
    }
  };
  visit(null, 0);
  for (const p of pages.value) {
    if (!seen.has(p.id) && !ids.has(p.parent_id)) {
      result.push({ ...p, depth: 0 });
      seen.add(p.id);
      visit(p.id, 1);
    }
  }
  return result;
});
async function loadPages(after = "") {
  const response = await $fetch.raw<any[]>(
    `/api/v1/spaces/${space.value.id}/pages?limit=200&after=${encodeURIComponent(after)}&q=${encodeURIComponent(search.value)}`,
  );
  pages.value = after
    ? [...pages.value, ...(response._data || [])]
    : response._data || [];
  nextCursor.value = response.headers.get("X-Next-Cursor") || "";
}
async function refreshSpace() {
  const id = space.value?.id;
  spaces.value = await api("spaces");
  if (id) space.value = spaces.value.find((s) => s.id === id);
  if (space.value) await loadPages();
}
async function createPage() {
  await run(async () => {
    const p = await api(`spaces/${space.value.id}/pages`, "POST", {
      title: title.value,
      parentId: createParent.value || null,
    });
    title.value = "";
    await loadPages();
    edit(p);
  });
}
async function refreshPage() {
  const id = page.value?.id;
  await loadPages();
  if (id) edit(await api("pages/" + id));
  showPermissions.value = false;
}
async function movePage() {
  await run(async () => {
    await api("pages/" + page.value.id + "/move", "POST", {
      version: page.value.version,
      parentId: moveParent.value || null,
      sortOrder: 0,
    });
    await refreshPage();
  });
}
async function trashPage() {
  await run(async () => {
    await api("pages/" + page.value.id, "DELETE", { confirm: true });
    page.value = null;
    await loadPages();
  });
}
async function openTrash() {
  await run(async () => {
    trash.value = await api(`spaces/${space.value.id}/trash`);
    view.value = "trash";
  });
}
async function openHistory() {
  await run(async () => {
    history.value = await api("pages/" + page.value.id + "/history");
    showHistory.value = !showHistory.value;
    revision.value = null;
  });
}
async function completeLink() {
  await run(async () => {
    const action = linkAction.value;
    if (action === "accept-invitation") {
      await api("spaces/invitations/accept", "POST", {
        token: linkToken.value,
      });
      await refreshSpace();
      notice.value = "Invitation accepted. Select your team space to begin.";
    } else {
      await api("auth/" + action, "POST", {
        token: linkToken.value,
        ...(action === "reset-password" ? { password: newPassword.value } : {}),
      });
      notice.value =
        action === "verify-email"
          ? "Email verified. You can now sign in."
          : "Password reset. Sign in with your new password.";
      if (action === "reset-password") signedOut();
    }
    linkAction.value = "";
    linkToken.value = "";
    newPassword.value = "";
    if (signedIn.value) await refreshMe();
  });
}
const route = useRoute(),
  router = useRouter();
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
    if (import.meta.client) void readAccountLink(hash);
  },
);
onMounted(async () => {
  await readAccountLink();
  try {
    providers.value = await api("oidc/providers");
  } catch {}
  try {
    spaces.value = await api("spaces");
    signedIn.value = true;
    await refreshMe();
  } catch {}
});
</script>
<template>
  <div class="shell">
    <aside>
      <a class="brand" href="/">orvyn<span>.</span></a>
      <p class="tagline">Your knowledge. Organized.</p>
      <template v-if="signedIn"
        ><button @click="view = 'workspace'">Workspace</button
        ><button @click="view = 'account'">Account &amp; security</button
        ><button v-if="me?.isAdmin" @click="view = 'oidc'">
          SSO administration
        </button>
        <h2>Your spaces</h2>
        <button
          v-for="s in spaces"
          :key="s.id"
          :aria-pressed="space?.id === s.id"
          @click="select(s)"
        >
          {{ s.kind === "team" ? "Team · " : "" }}{{ s.name }}
        </button>
        <form
          @submit.prevent="
            run(async () => {
              const s = await api('spaces', 'POST', { name });
              spaces.push(s);
              name = '';
              await select(s);
            })
          "
        >
          <label for="space">New private space</label
          ><input id="space" v-model="name" required maxlength="120" /><button>
            Create space
          </button>
        </form>
        <button
          @click="
            run(async () => {
              await api('auth/logout', 'POST', {});
              signedOut();
            })
          "
        >
          Sign out
        </button></template
      ><small>orvyn. · Your knowledge. Organized.</small>
    </aside>
    <main>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <section v-if="linkAction" class="auth">
        <h1>
          {{
            linkAction === "verify-email"
              ? "Verify your email"
              : linkAction === "reset-password"
                ? "Reset your password"
                : "Accept space invitation"
          }}
        </h1>
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
              autocomplete="new-password"
              minlength="12"
              maxlength="256"
              required
          /></template>
          <p v-if="linkAction === 'accept-invitation'">
            Accept using your invited, verified email address. Existing private
            pages remain restricted.
          </p>
          <button>
            {{
              linkAction === "verify-email"
                ? "Confirm email address"
                : linkAction === "reset-password"
                  ? "Reset password"
                  : "Accept invitation"
            }}
          </button>
        </form>
        <form v-else @submit.prevent="login('login')">
          <p>
            Sign in with the invited account, then accept the invitation. If you
            need an account, register and verify your email first, then reopen
            this invitation.
          </p>
          <label for="invite-signin-email">Email</label
          ><input
            id="invite-signin-email"
            v-model="email"
            type="email"
            required
            autocomplete="username"
          /><label for="invite-signin-password">Password</label
          ><input
            id="invite-signin-password"
            v-model="password"
            type="password"
            required
            autocomplete="current-password"
          /><button>Sign in</button>
        </form>
        <button
          type="button"
          @click="
            linkAction = '';
            linkToken = '';
          "
        >
          Cancel
        </button>
      </section>
      <section v-else-if="!signedIn" class="auth">
        <p class="eyebrow">A place for your ideas</p>
        <h1>Make room for<br />what you know.</h1>
        <p>Your private workspace starts here.</p>
        <form @submit.prevent="login('login')">
          <label for="email">Email</label
          ><input
            id="email"
            v-model="email"
            type="email"
            required
            autocomplete="username"
          /><label for="password">Password · at least 12 characters</label
          ><input
            id="password"
            v-model="password"
            type="password"
            minlength="12"
            maxlength="256"
            required
            autocomplete="current-password"
          />
          <div class="actions">
            <button>Sign in</button
            ><button type="button" @click="login('register')">
              Create account
            </button>
          </div>
        </form>
        <button
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
        <div v-if="providers.length">
          <h2>Single sign-on</h2>
          <button
            v-for="p in providers"
            :key="p.id"
            @click="run(() => startOidc(p.id))"
          >
            Continue with {{ p.name }}
          </button>
        </div>
      </section>
      <AccountSettings
        v-else-if="view === 'account' && me"
        :me="me"
        @changed="run(refreshMe)"
        @signed-out="signedOut"
      />
      <OidcAdministration v-else-if="view === 'oidc' && me?.isAdmin" />
      <SpaceSettings
        v-else-if="
          view === 'space-settings' &&
          space &&
          ['Owner', 'Admin'].includes(space.role)
        "
        :space="space"
        @changed="run(refreshSpace)"
      />
      <section v-else-if="view === 'trash' && space">
        <h1>Trash · {{ space.name }}</h1>
        <p>
          Restoring a page also restores descendants that were not independently
          deleted.
        </p>
        <ul>
          <li v-for="p in trash" :key="p.id">
            {{ p.title }}
            <button
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
        <p v-if="!trash.length">No deleted pages you can access.</p>
        <button @click="view = 'workspace'">Back to workspace</button>
      </section>
      <template v-else
        ><header>
          <span>{{ space?.name || "Your workspace" }}</span><span
            class="badge"
            >{{ space?.kind === "team" ? "Team space" : "Private" }}</span
          >
        </header>
        <section v-if="!space">
          <h1>Your knowledge.<br />Your space.</h1>
          <p>Create or select a space to begin.</p>
        </section>
        <template v-else
          ><div class="actions">
            <button
              v-if="['Owner', 'Admin'].includes(space.role)"
              @click="view = 'space-settings'"
            >
              Space settings</button
            ><button @click="openTrash">Trash</button>
          </div>
          <form
            class="newpage"
            @submit.prevent="
              run(async () => {
                page = null;
                await loadPages();
              })
            "
          >
            <label for="page-search">Search pages in this space</label
            ><input
              id="page-search"
              v-model="search"
              maxlength="200"
              type="search"
            /><button>Search</button>
          </form>
          <nav class="page-tree" aria-label="Pages">
            <button
              v-for="p in orderedPages"
              :key="p.id"
              :style="{ marginLeft: Math.min(p.depth, 8) + 'rem' }"
              :aria-pressed="page?.id === p.id"
              @click="edit(p)"
            >
              {{ p.title
              }}<small v-if="p.visibility === 'restricted'">
                · Restricted</small
              ></button
            ><button
              v-if="nextCursor"
              @click="run(() => loadPages(nextCursor))"
            >
              Load more pages
            </button>
          </nav>
          <form v-if="canCreate" class="newpage" @submit.prevent="createPage">
            <label for="newpage">New page</label
            ><input
              id="newpage"
              v-model="title"
              required
              maxlength="300"
            /><label for="newpage-parent">Parent page</label
            ><select id="newpage-parent" v-model="createParent">
              <option value="">Space root</option>
              <option
                v-for="p in pages.filter((p) => p.access_rank >= 30)"
                :key="p.id"
                :value="p.id"
              >
                {{ p.title }}
              </option></select
            ><button>Create page</button>
          </form>
          <section v-if="page">
            <label for="title">Page title</label
            ><input
              id="title"
              class="title"
              v-model="page.title"
              maxlength="300"
              :readonly="page.access_rank < 30"
            /><label for="document">Document</label
            ><textarea
              id="document"
              v-model="content"
              placeholder="Start writing…"
              :readonly="page.access_rank < 30"
            /><button v-if="page.access_rank >= 30" @click="save">
              Save changes
            </button>
            <p class="hint">
              Revision {{ page.version }} · Explicit save · Plain paragraphs
            </p>
            <div class="actions">
              <button @click="openHistory">Version history</button
              ><button
                v-if="page.access_rank >= 40"
                @click="showPermissions = !showPermissions"
              >
                Page permissions</button
              ><button v-if="page.access_rank >= 30" @click="trashPage">
                Trash page and subpages
              </button>
            </div>
            <PagePermissions
              v-if="showPermissions && page.access_rank >= 40"
              :key="page.id"
              :page="page"
              @changed="run(refreshPage)"
            />
            <div v-if="showHistory">
              <h2>Saved content versions</h2>
              <button
                v-for="h in history"
                :key="h.version"
                @click="
                  run(async () => {
                    revision = await api(
                      'pages/' + page.id + '/history/' + h.version,
                    );
                  })
                "
              >
                Revision {{ h.version }} · {{ h.title }}
              </button>
              <pre v-if="revision" class="revision">{{
                revision.document.content.map((n: any) => n.text).join("\n")
              }}</pre>
            </div>
            <form v-if="page.access_rank >= 30" @submit.prevent="movePage">
              <h2>Move page</h2>
              <p>
                The current audience is preserved on the moved page. Parent
                restrictions can reduce access further. Save content changes
                before moving.
              </p>
              <label for="move-parent">New parent</label
              ><select id="move-parent" v-model="moveParent">
                <option value="">Space root</option>
                <option
                  v-for="p in pages.filter(
                    (p) => p.access_rank >= 30 && p.id !== page.id,
                  )"
                  :key="p.id"
                  :value="p.id"
                >
                  {{ p.title }}
                </option></select
              ><button>Move page</button>
            </form>
          </section></template
        ></template
      >
    </main>
  </div>
</template>
<style>
:root {
  --bg: #101119;
  --panel: #171822;
  --line: #2b2d3e;
  --text: #ececf5;
  --muted: #a5a7bc;
  --accent: #b69bff;
  --error: #ffb3b3;
  font:
    14px system-ui,
    sans-serif;
  color: var(--text);
  background: var(--bg);
  color-scheme: dark;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
}
button,
input,
textarea,
select {
  font: inherit;
}
button {
  cursor: pointer;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
  padding: 0.65rem 1rem;
  border-radius: 0.5rem;
}
button:hover,
button[aria-pressed="true"] {
  border-color: var(--accent);
}
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.shell {
  display: flex;
  min-height: 100vh;
}
aside {
  width: 260px;
  background: var(--panel);
  padding: 2rem 1.5rem;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.brand {
  font-size: 2.2rem;
  font-weight: 800;
  text-decoration: none;
  color: var(--text);
}
.brand span {
  color: var(--accent);
}
.tagline,
small,
.hint,
p {
  color: var(--muted);
}
small {
  margin-top: auto;
}
h2,
.eyebrow {
  font-size: 0.85rem;
  color: var(--accent);
}
main {
  flex: 1;
  padding: 3rem 6%;
  min-width: 0;
}
section {
  max-width: 780px;
  margin: 4rem auto;
}
h1 {
  font-size: clamp(2rem, 5vw, 3.8rem);
  letter-spacing: -0.045em;
  line-height: 1.1;
}
form {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}
input,
textarea,
select {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  padding: 0.8rem;
  color: var(--text);
}
label {
  font-size: 0.85rem;
  color: var(--muted);
}
textarea {
  min-height: 320px;
  resize: vertical;
  line-height: 1.8;
  margin: 0.8rem 0;
}
.auth {
  max-width: 480px;
}
.actions,
header,
nav {
  display: flex;
  gap: 1rem;
  align-items: center;
}
header {
  justify-content: space-between;
  border-bottom: 1px solid var(--line);
  padding-bottom: 1.5rem;
}
.badge {
  font-size: 0.8rem;
  color: var(--accent);
}
nav {
  flex-wrap: wrap;
  margin: 1.5rem 0;
}
.newpage {
  max-width: 400px;
}
.title {
  font-size: 2rem;
  margin: 0.7rem 0 1.5rem;
}
.error {
  color: var(--error);
}
@media (max-width: 700px) {
  .shell {
    flex-direction: column;
  }
  aside {
    width: 100%;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  main {
    padding: 2rem;
  }
  section {
    margin: 2rem auto;
  }
}
.page-tree {
  display: flex;
  flex-direction: column;
  align-items: stretch;
}
.actions {
  flex-wrap: wrap;
  margin: 1rem 0;
}
.revision {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.page-tree button {
  text-align: left;
}
select {
  font: inherit;
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  padding: 0.8rem;
}
</style>

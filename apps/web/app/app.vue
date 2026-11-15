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
    pages.value = await api(`spaces/${s.id}/pages`);
  });
}
function edit(p: any) {
  page.value = p;
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
async function completeLink() {
  await run(async () => {
    await api("auth/" + linkAction.value, "POST", {
      token: linkToken.value,
      ...(linkAction.value === "reset-password"
        ? { password: newPassword.value }
        : {}),
    });
    notice.value =
      linkAction.value === "verify-email"
        ? "Email verified. You can now sign in."
        : "Password reset. Sign in with your new password.";
    if (linkAction.value === "reset-password") signedOut();
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
  if (!["verify-email", "reset-password"].includes(action || "")) return;
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
        <h2>Private spaces</h2>
        <button
          v-for="s in spaces"
          :key="s.id"
          :aria-pressed="space?.id === s.id"
          @click="select(s)"
        >
          {{ s.name }}
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
      ><small>Foundation · Local accounts and private pages</small>
    </aside>
    <main>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <section v-if="linkAction" class="auth">
        <h1>
          {{
            linkAction === "verify-email"
              ? "Verify your email"
              : "Reset your password"
          }}
        </h1>
        <form @submit.prevent="completeLink">
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
              required /></template
          ><button>
            {{
              linkAction === "verify-email"
                ? "Confirm email address"
                : "Reset password"
            }}</button
          ><button
            type="button"
            @click="
              linkAction = '';
              linkToken = '';
            "
          >
            Cancel
          </button>
        </form>
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
            @click="
              run(async () => {
                await startOidc(p.id);
              })
            "
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
      /><OidcAdministration
        v-else-if="view === 'oidc' && me?.isAdmin"
      /><template v-else
        ><header>
          <span>{{ space?.name || "Your workspace" }}</span
          ><span class="badge">Private</span>
        </header>
        <section v-if="!space">
          <h1>Your knowledge.<br />Your space.</h1>
          <p>Create or select a private space to begin.</p>
        </section>
        <template v-else
          ><nav aria-label="Pages">
            <button v-for="p in pages" :key="p.id" @click="edit(p)">
              {{ p.title }}
            </button>
          </nav>
          <form
            class="newpage"
            @submit.prevent="
              run(async () => {
                const p = await api(`spaces/${space.id}/pages`, 'POST', {
                  title,
                });
                pages.push(p);
                edit(p);
                title = '';
              })
            "
          >
            <label for="newpage">New page</label
            ><input
              id="newpage"
              v-model="title"
              required
              maxlength="300"
            /><button>Create page</button>
          </form>
          <section v-if="page">
            <label for="title">Page title</label
            ><input
              id="title"
              class="title"
              v-model="page.title"
              maxlength="300"
            /><label for="document">Document</label
            ><textarea
              id="document"
              v-model="content"
              placeholder="Start writing…"
            /><button @click="save">Save changes</button>
            <p class="hint">
              Revision {{ page.version }} · Explicit save · Plain paragraphs
            </p>
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
textarea {
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
textarea {
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
</style>

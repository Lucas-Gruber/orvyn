<script setup lang="ts">
const props = defineProps<{
  me: {
    id: string;
    email: string;
    displayName: string;
    displayNameSource: string;
    emailVerified: boolean;
    isAdmin: boolean;
  };
}>();
const emit = defineEmits<{ changed: []; signedOut: [] }>();
const sessions = ref<any[]>([]),
  displayName = ref(props.me.displayName),
  error = ref(""),
  notice = ref(""),
  busy = ref(false);
async function call(path: string, method = "GET") {
  return $fetch<any>("/api/v1/auth/" + path, {
    method: method as any,
    ...(method === "GET" ? {} : { body: {} }),
  });
}
async function run(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await fn();
  } catch (e: any) {
    error.value = e.data?.message || "Request failed";
  } finally {
    busy.value = false;
  }
}
async function load() {
  sessions.value = await call("sessions");
}
async function revoke(s: any) {
  await run(async () => {
    await call("sessions/" + s.id, "DELETE");
    if (s.current) emit("signedOut");
    else await load();
  });
}
onMounted(() => run(load));
watch(
  () => props.me.displayName,
  (value) => {
    displayName.value = value;
  },
);
async function saveProfile() {
  await run(async () => {
    const profile = await $fetch<{ displayName: string }>(
      "/api/v1/auth/profile",
      {
        method: "PATCH",
        body: { displayName: displayName.value },
      },
    );
    displayName.value = profile.displayName;
    emit("changed");
    notice.value = "Display name saved.";
  });
}
</script>
<template>
  <section class="settings">
    <h1>Account &amp; security</h1>
    <p>{{ props.me.email }}</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <form class="settings-card profile-card" @submit.prevent="saveProfile">
      <div class="profile-avatar" aria-hidden="true">
        {{ displayName.slice(0, 2).toUpperCase() }}
      </div>
      <div class="profile-fields">
        <h2>Your profile</h2>
        <label for="profile-display-name">Display name</label>
        <input
          id="profile-display-name"
          v-model="displayName"
          required
          maxlength="160"
          autocomplete="nickname"
          aria-describedby="profile-name-hint"
        />
        <p id="profile-name-hint">
          How you appear to your team, in comments and in the editor. Up to 80
          characters.
        </p>
        <p
          v-if="props.me.displayNameSource === 'provider'"
          class="profile-source"
        >
          Provided by your sign-in provider. Saving a name here keeps your
          choice on future sign-ins.
        </p>
        <button
          class="primary"
          :disabled="
            busy || !displayName.trim() || displayName === props.me.displayName
          "
        >
          Save display name
        </button>
      </div>
    </form>
    <div v-if="!props.me.emailVerified" class="settings-card">
      <h2>Verify your email</h2>
      <p>
        Check your inbox for the verification link. It expires after 30 minutes.
      </p>
      <button
        :disabled="busy"
        @click="
          run(async () => {
            await call('request-verification', 'POST');
            notice = 'Verification email requested. Check your inbox.';
          })
        "
      >
        Send verification email</button
      ><button :disabled="busy" @click="emit('changed')">
        Refresh verification status
      </button>
    </div>
    <p v-else>Email verified</p>
    <h2>Active sessions</h2>
    <ul class="session-list">
      <li v-for="s in sessions" :key="s.id">
        <div>
          <strong>{{ s.current ? "This session" : "Other session" }}</strong>
          <p>
            Created {{ new Date(s.createdAt).toLocaleString() }} · Expires
            {{ new Date(s.expiresAt).toLocaleString() }}
          </p>
        </div>
        <button :disabled="busy" @click="revoke(s)">
          Revoke {{ s.current ? "this" : "other" }} session
        </button>
      </li>
    </ul>
    <button
      :disabled="busy"
      @click="
        run(async () => {
          await call('logout-all', 'POST');
          emit('signedOut');
        })
      "
    >
      Sign out all sessions
    </button>
    <h2>Password recovery</h2>
    <p>
      Request a one-time password reset link. Completing the reset signs out all
      sessions.
    </p>
    <button
      :disabled="busy"
      @click="
        run(async () => {
          await $fetch('/api/v1/auth/request-password-reset', {
            method: 'POST',
            body: { email: props.me.email },
          });
          notice =
            'If password sign-in is available, a reset email has been sent.';
        })
      "
    >
      Send password reset email
    </button>
  </section>
</template>
<style scoped>
.settings-card {
  border: 1px solid var(--line);
  padding: 1.5rem;
  border-radius: 0.6rem;
}
.settings-card button + button {
  margin-left: 0.6rem;
}
.profile-card {
  display: flex;
  flex-direction: row;
  width: 100%;
  max-width: none;
  align-items: flex-start;
  gap: 1.25rem;
  margin: 1.5rem 0 2rem;
}
.profile-avatar {
  flex: 0 0 48px;
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.profile-fields {
  flex: 1;
  min-width: 0;
}
.profile-fields h2 {
  margin: 0 0 1rem;
}
.profile-fields label {
  display: block;
  font-weight: 500;
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
}
.profile-fields input {
  width: 100%;
  max-width: 360px;
}
.profile-fields p {
  font-size: 0.8rem;
  color: var(--muted);
  line-height: 1.5;
  max-width: 480px;
}
@media (max-width: 520px) {
  .profile-card {
    padding: 1rem;
    gap: 0.75rem;
  }
  .profile-avatar {
    flex-basis: 36px;
    width: 36px;
    height: 36px;
    font-size: 0.8rem;
  }
}
.session-list {
  padding: 0;
  list-style: none;
}
.session-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 0;
  border-bottom: 1px solid var(--line);
}
.session-list p {
  font-size: 0.85rem;
}
h2 {
  margin-top: 2rem;
}
</style>

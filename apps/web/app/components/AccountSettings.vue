<script setup lang="ts">
const props = defineProps<{
  me: { id: string; email: string; emailVerified: boolean; isAdmin: boolean };
}>();
const emit = defineEmits<{ changed: []; signedOut: [] }>();
const sessions = ref<any[]>([]),
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
</script>
<template>
  <section class="settings">
    <h1>Account &amp; security</h1>
    <p>{{ props.me.email }}</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
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

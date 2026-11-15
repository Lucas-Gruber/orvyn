<script setup lang="ts">
const providers = ref<any[]>([]),
  selected = ref(""),
  error = ref(""),
  notice = ref(""),
  busy = ref(false);
const defaults = () => ({
  name: "",
  issuer: "",
  clientId: "",
  scopes: "openid email profile",
  clientSecret: "",
  enabled: false,
  autoProvision: false,
});
const form = reactive(defaults());
async function load() {
  providers.value = await $fetch<any[]>("/api/v1/admin/oidc/providers");
}
function choose(p?: any) {
  selected.value = p?.id || "";
  Object.assign(form, p ? { ...p, clientSecret: "" } : defaults());
  notice.value = "";
}
async function save() {
  busy.value = true;
  error.value = "";
  try {
    const body: any = { ...form };
    if (!body.clientSecret) delete body.clientSecret;
    await $fetch(
      "/api/v1/admin/oidc/providers" +
        (selected.value ? "/" + selected.value : ""),
      { method: selected.value ? "PUT" : "POST", body },
    );
    await load();
    notice.value = "Provider saved";
    choose();
    notice.value = "Provider saved";
  } catch (e: any) {
    error.value = e.data?.message || "Unable to save provider";
  } finally {
    busy.value = false;
  }
}
onMounted(async () => {
  try {
    await load();
  } catch {
    error.value = "Unable to load providers";
  }
});
</script>
<template>
  <section>
    <h1>Single sign-on</h1>
    <p>
      Configure OpenID Connect providers. New providers are disabled until you
      enable them. Existing accounts are never linked by email automatically.
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <ul class="providers">
      <li v-for="p in providers" :key="p.id">
        <button @click="choose(p)">
          {{ p.name }} · {{ p.enabled ? "Enabled" : "Disabled" }}
        </button>
        <p>
          Redirect URI: <code>{{ p.redirectUri }}</code>
        </p>
        <p>
          Client secret:
          {{ p.hasClientSecret ? "Configured" : "Not configured" }}
        </p>
      </li>
    </ul>
    <button @click="choose()">New provider</button>
    <form @submit.prevent="save">
      <h2>{{ selected ? "Edit provider" : "Add provider" }}</h2>
      <label for="oidc-name">Display name</label
      ><input
        id="oidc-name"
        v-model="form.name"
        required
        maxlength="120"
      /><label for="oidc-issuer">Issuer URL</label
      ><input
        id="oidc-issuer"
        v-model="form.issuer"
        type="url"
        :disabled="!!selected"
        required
      /><label for="oidc-client">Client ID</label
      ><input
        id="oidc-client"
        v-model="form.clientId"
        :disabled="!!selected"
        required
      /><label for="oidc-secret"
        >Client secret
        {{
          selected
            ? "(leave empty to keep the current secret)"
            : "(optional for public clients)"
        }}</label
      ><input
        id="oidc-secret"
        v-model="form.clientSecret"
        type="password"
        autocomplete="new-password"
      /><label for="oidc-scopes">Scopes</label
      ><input id="oidc-scopes" v-model="form.scopes" required /><label
        class="check"
        ><input v-model="form.autoProvision" type="checkbox" /> Allow creation
        of accounts with a verified provider email</label
      ><label class="check"
        ><input v-model="form.enabled" type="checkbox" /> Enable sign-in</label
      >
      <p>
        Disabling a provider revokes its active Orvyn sessions. Saving any
        change invalidates in-progress sign-ins.
      </p>
      <button :disabled="busy">{{ busy ? "Saving…" : "Save provider" }}</button>
    </form>
  </section>
</template>
<style scoped>
.providers {
  list-style: none;
  padding: 0;
}
.providers li {
  padding: 1rem 0;
  border-bottom: 1px solid var(--line);
}
code {
  overflow-wrap: anywhere;
}
.check {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.check input {
  width: auto;
}
form {
  margin-top: 2rem;
}
</style>

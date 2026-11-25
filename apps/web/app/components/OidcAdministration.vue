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
  clientAuthMethod: "client_secret_post",
  repairLegacyIssuer: false,
  legacyIssuerNormalized: false,
});
const form = reactive(defaults());
const managed = computed(
  () => !!providers.value.find((p) => p.id === selected.value)?.managed,
);
async function load() {
  providers.value = await $fetch<any[]>("/api/v1/admin/oidc/providers");
}
function choose(p?: any) {
  selected.value = p?.id || "";
  Object.assign(form, defaults(), p ? { ...p, clientSecret: "" } : {});
  notice.value = "";
}
async function save() {
  if (managed.value) return;
  busy.value = true;
  error.value = "";
  try {
    const body: any = { ...form };
    if (body.repairLegacyIssuer) body.issuer = form.issuer + "/";
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
        <p v-if="p.managed" class="managed-note">Managed by deployment</p>
      </li>
    </ul>
    <button @click="choose()">New provider</button>
    <form @submit.prevent="save">
      <h2>{{ selected ? "Edit provider" : "Add provider" }}</h2>
      <p v-if="managed" class="managed-note" role="note">
        This provider is configured through Helm or environment settings. Apply
        changes there; its client secret stays hidden.
      </p>
      <fieldset :disabled="managed">
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
        /><label for="oidc-method">Client authentication</label>
        <label
          v-if="
            selected &&
            form.legacyIssuerNormalized &&
            !form.issuer.endsWith('/')
          "
          class="check"
        >
          <input v-model="form.repairLegacyIssuer" type="checkbox" />
          Repair the trailing slash removed by older Orvyn versions. Verify
          {{ form.issuer }}/ against this provider's metadata, preserve linked
          identities and sign out existing provider sessions. Other issuer or
          client changes are not allowed.
        </label>
        <select id="oidc-method" v-model="form.clientAuthMethod">
          <option value="client_secret_post">
            Client secret in token request (POST)
          </option>
          <option value="client_secret_basic">
            Client secret with HTTP Basic
          </option>
          <option value="none">Public client with PKCE</option>
        </select>
        <label v-if="form.clientAuthMethod !== 'none'" for="oidc-secret"
          >Client secret
          {{
            selected
              ? "(leave empty to keep the current secret)"
              : "(required for confidential clients)"
          }}</label
        ><input
          v-if="form.clientAuthMethod !== 'none'"
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
          ><input v-model="form.enabled" type="checkbox" /> Enable
          sign-in</label
        >
        <p>
          Disabling a provider revokes its active Orvyn sessions. Saving any
          change invalidates in-progress sign-ins.
        </p>
        <button :disabled="busy">
          {{ busy ? "Saving…" : "Save provider" }}
        </button>
      </fieldset>
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
fieldset {
  border: 0;
  padding: 0;
  min-width: 0;
}
.managed-note {
  color: var(--muted);
  font-size: 0.88rem;
}
</style>

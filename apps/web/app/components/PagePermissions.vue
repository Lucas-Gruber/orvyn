<script setup lang="ts">
const props = defineProps<{ page: any }>(),
  emit = defineEmits<{ changed: [] }>();
const visibility = ref("space"),
  members = ref<any[]>([]),
  grants = reactive<Record<string, string>>({}),
  version = ref(0),
  error = ref(""),
  busy = ref(false);
async function load() {
  try {
    const permissions = await $fetch<any>(
      "/api/v1/pages/" + props.page.id + "/permissions",
    );
    version.value = permissions.version;
    visibility.value = permissions.visibility;
    members.value = (
      await $fetch<any[]>("/api/v1/spaces/" + props.page.space_id + "/members")
    ).filter((m) => m.role !== "Owner");
    for (const m of members.value)
      grants[m.id] =
        permissions.grants.find((g: any) => g.userId === m.id)?.role || "";
  } catch (e: any) {
    error.value = e.data?.message || "Could not load permissions";
  }
}
async function save() {
  busy.value = true;
  error.value = "";
  try {
    await $fetch("/api/v1/pages/" + props.page.id + "/permissions", {
      method: "PUT",
      body: {
        visibility: visibility.value,
        version: version.value,
        confirm: true,
        grants:
          visibility.value === "restricted"
            ? Object.entries(grants)
                .filter(([, role]) => role)
                .map(([userId, role]) => ({ userId, role }))
            : [],
      },
    });
    emit("changed");
  } catch (e: any) {
    error.value = e.data?.message || "Could not save permissions";
  } finally {
    busy.value = false;
  }
}
onMounted(load);
const roles = ["Admin", "Editor", "Commenter", "Viewer"],
  rank = (r: string) => roles.indexOf(r);
</script>
<template>
  <div class="permissions">
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <label for="page-visibility">Access</label
    ><select id="page-visibility" v-model="visibility">
      <option value="space">Inherit from space and parent</option>
      <option value="restricted">Restrict to selected members</option>
    </select>
    <p>
      Restrictions on parent pages always apply. A child cannot override them.
      The space owner retains access.
    </p>
    <template v-if="visibility === 'restricted'"
      ><label v-for="m in members" :key="m.id"
        >{{ m.email
        }}<select v-model="grants[m.id]">
          <option value="">No access</option>
          <option
            v-for="role in roles.filter((r) => rank(r) >= rank(m.role))"
            :key="role"
          >
            {{ role }}
          </option>
        </select></label
      ></template
    ><button :disabled="busy" @click="save">Confirm page permissions</button>
  </div>
</template>
<style scoped>
.permissions {
  margin: 0;
}
label {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  margin: 1rem 0;
}
select {
  padding: 0.6rem;
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 0.5rem;
}
</style>

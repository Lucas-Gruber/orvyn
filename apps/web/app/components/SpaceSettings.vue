<script setup lang="ts">
const props = defineProps<{ space: any }>(),
  emit = defineEmits<{ changed: [] }>();
const preview = ref<any>(),
  members = ref<any[]>([]),
  email = ref(""),
  role = ref("Viewer"),
  error = ref(""),
  notice = ref(""),
  busy = ref(false);
const roles = ["Admin", "Editor", "Commenter", "Viewer"];
async function call(path: string, method = "GET", body?: unknown) {
  return $fetch<any>("/api/v1/spaces/" + props.space.id + "/" + path, {
    method: method as any,
    body: body as any,
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
  if (props.space.kind === "personal")
    preview.value = await call("team-preview");
  else members.value = await call("members");
}
async function convert() {
  await run(async () => {
    await call("convert-to-team", "POST", {
      version: preview.value.version,
      confirm: true,
    });
    preview.value = null;
    emit("changed");
    notice.value = "Space converted. Existing pages remain restricted.";
  });
}
async function refresh() {
  await run(load);
}
watch(() => props.space.version, refresh);
onMounted(refresh);
</script>
<template>
  <section>
    <h1>{{ space.name }}</h1>
    <p>
      {{
        space.kind === "personal"
          ? "Personal space · Only you have access"
          : "Team space · Access is controlled by membership and page permissions"
      }}
    </p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="space.kind === 'personal'"
      ><h2>Convert to a team space</h2>
      <p>
        Existing pages and their descendants remain private to their current
        audience. Invitations only grant access to new shared pages unless you
        explicitly change page permissions.
      </p>
      <template v-if="preview"
        ><h3>Pages that will stay restricted</h3>
        <ul>
          <li v-for="p in preview.privateRoots" :key="p.id">{{ p.title }}</li>
        </ul>
        <p v-if="!preview.privateRoots.length">This space has no pages yet.</p>
        <button :disabled="busy" @click="convert">
          Confirm conversion to a team space
        </button></template
      ><button :disabled="busy" @click="refresh">
        Refresh permission preview
      </button></template
    >
    <template v-else
      ><h2>Members</h2>
      <ul class="members">
        <li v-for="member in members" :key="member.id">
          <div>
            <strong>{{ member.email }}</strong>
            <p>{{ member.role }}</p>
          </div>
          <template v-if="member.role !== 'Owner'"
            ><select
              v-if="space.role === 'Owner'"
              :aria-label="'Role for ' + member.email"
              :value="member.role"
              @change="
                run(async () => {
                  await call('members/' + member.id, 'PUT', {
                    role: ($event.target as HTMLSelectElement).value,
                  });
                  await load();
                  emit('changed');
                })
              "
            >
              <option v-for="r in roles" :key="r">{{ r }}</option></select
            ><button
              :disabled="busy"
              @click="
                run(async () => {
                  await call('members/' + member.id, 'DELETE', {});
                  await load();
                  emit('changed');
                })
              "
            >
              Remove member
            </button></template
          >
        </li>
      </ul>
      <form
        @submit.prevent="
          run(async () => {
            await call('invitations', 'POST', { email, role });
            email = '';
            notice = 'Invitation queued for delivery.';
          })
        "
      >
        <h2>Invite a member</h2>
        <label for="invite-email">Email address</label
        ><input id="invite-email" v-model="email" type="email" required /><label
          for="invite-role"
          >Role</label
        ><select id="invite-role" v-model="role">
          <option
            v-for="r in roles.filter(
              (r) => space.role === 'Owner' || r !== 'Admin',
            )"
            :key="r"
          >
            {{ r }}
          </option>
        </select>
        <p>
          The recipient must accept using the invited, verified email address.
        </p>
        <button :disabled="busy">Send invitation</button>
      </form></template
    >
  </section>
</template>
<style scoped>
.members {
  list-style: none;
  padding: 0;
}
.members li {
  display: flex;
  align-items: center;
  gap: 1rem;
  border-bottom: 1px solid var(--line);
  padding: 1rem 0;
}
.members li > div {
  flex: 1;
}
select {
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  padding: 0.6rem;
}
h2 {
  margin-top: 2rem;
}
</style>

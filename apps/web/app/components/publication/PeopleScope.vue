<script setup lang="ts">
import type { PublicationScope } from "@orvyn/shared";
const props = defineProps<{
    rootId: string;
    scope: PublicationScope;
    busy: boolean;
  }>(),
  emit = defineEmits<{ change: [value: PublicationScope["people"]] }>(),
  open = ref(false),
  loading = ref(false),
  error = ref(""),
  candidates = ref<{ id: string; privateLabel: string }[]>([]),
  selected = ref<string[]>([]),
  labels = ref<Record<string, string>>({});
let alive = true;
async function load() {
  if (props.busy || loading.value) return;
  loading.value = true;
  error.value = "";
  const scope = JSON.stringify(props.scope);
  try {
    const result = await $fetch<{
      people: { id: string; privateLabel: string }[];
    }>("/api/v1/pages/" + props.rootId + "/publications/people", {
      method: "POST",
      body: JSON.parse(scope),
    });
    if (!alive) return;
    if (scope !== JSON.stringify(props.scope)) {
      error.value = "The selection changed. Open public names again.";
      return;
    }
    candidates.value = result.people;
    const known = new Map(
      props.scope.people.map((person) => [person.userId, person.label]),
    );
    labels.value = Object.fromEntries(
      result.people.map((person) => [person.id, known.get(person.id) || ""]),
    );
    selected.value = result.people
      .filter((person) => known.has(person.id))
      .map((person) => person.id);
    open.value = true;
  } catch (e: any) {
    if (alive)
      error.value =
        e.data?.message || "Could not load people from the selected content.";
  } finally {
    if (alive) loading.value = false;
  }
}
function save() {
  error.value = "";
  if (selected.value.length > 100) {
    error.value = "Choose at most 100 public names.";
    return;
  }
  const people = selected.value.map((userId) => ({
    userId,
    label: (labels.value[userId] || "").trim(),
  }));
  if (
    people.some(
      (person) =>
        !person.label ||
        person.label.length > 80 ||
        /[\u0000-\u001f\u007f]/.test(person.label),
    )
  ) {
    error.value =
      "Enter a public name of 1–80 characters for each checked person.";
    return;
  }
  open.value = false;
  emit("change", people);
}
watch(
  () => props.scope,
  () => {
    if (open.value) {
      open.value = false;
      error.value = "The selection changed. Review public names again.";
    }
  },
  { deep: true },
);
onBeforeUnmount(() => {
  alive = false;
});
</script>
<template>
  <section class="publication-people-scope">
    <div>
      <AppIcon name="users" :size="17" /><span
        ><strong>Public names</strong
        ><small>{{
          scope.people.length
            ? scope.people.length +
              (scope.people.length === 1 ? " name chosen" : " names chosen")
            : "People stay anonymous by default"
        }}</small></span
      >
      <button
        type="button"
        class="ghost"
        :disabled="busy || loading"
        @click="load"
      >
        {{ loading ? "Loading…" : "Choose names" }}
      </button>
    </div>
    <p v-if="error && !open" class="error" role="alert">{{ error }}</p>
    <Teleport to="body"
      ><UiDialog
        :open="open"
        title="Choose public names"
        :error="error"
        @close="
          open = false;
          error = '';
        "
      >
        <form @submit.stop.prevent="save">
          <p class="public-names-intro">
            Choose the names readers may see in selected people fields and
            @mentions. Unchecked people stay anonymous. Account addresses below
            are visible only to you.
          </p>
          <div v-if="!candidates.length" class="public-names-empty">
            <AppIcon name="users" :size="24" />
            <p>No people in the selected content.</p>
            <small
              >Select people properties or pages containing @mentions
              first.</small
            >
          </div>
          <div
            v-for="person in candidates"
            :key="person.id"
            class="public-name-row"
          >
            <label
              ><input
                v-model="selected"
                type="checkbox"
                :value="person.id"
                :aria-label="'Share public name for ' + person.privateLabel"
              /><span
                ><AppIcon name="users" :size="15" />{{
                  person.privateLabel
                }}</span
              ></label
            >
            <input
              v-if="selected.includes(person.id)"
              v-model="labels[person.id]"
              :aria-label="'Public name for ' + person.privateLabel"
              placeholder="Enter a public name"
              maxlength="80"
              required
              autocomplete="off"
            />
          </div>
          <footer>
            <button
              type="button"
              class="ghost"
              @click="
                open = false;
                error = '';
              "
            >
              Cancel</button
            ><button type="submit" class="primary">
              Use these names<AppIcon name="check" :size="15" />
            </button>
          </footer>
        </form> </UiDialog
    ></Teleport>
  </section>
</template>
<style scoped>
.publication-people-scope {
  margin: 20px 0;
  border-block: 1px solid var(--line);
  padding-block: 14px;
}
.publication-people-scope > div {
  display: flex;
  align-items: center;
  gap: 10px;
}
.publication-people-scope > div > span {
  flex: 1;
  min-width: 0;
}
strong {
  font-size: 12px;
  font-weight: 500;
}
small {
  display: block;
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
}
.publication-people-scope > div button {
  font-size: 11px;
}
.public-names-intro {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
  margin: 0 0 20px;
}
.public-name-row {
  padding: 14px 0;
  border-top: 1px solid var(--line);
}
.public-name-row label {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  cursor: pointer;
}
.public-name-row label span {
  display: flex;
  align-items: center;
  gap: 7px;
  overflow-wrap: anywhere;
  min-width: 0;
}
.public-name-row label input {
  margin: 3px 0 0;
  accent-color: var(--accent);
  flex-shrink: 0;
}
.public-name-row > input {
  margin: 10px 0 0 22px;
  width: calc(100% - 22px);
  font-size: 12px;
}
.public-names-empty {
  padding: 25px 10px;
  text-align: center;
  color: var(--muted);
}
.public-names-empty p {
  font-size: 13px;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid var(--line);
  padding-top: 18px;
  margin-top: 14px;
}
</style>

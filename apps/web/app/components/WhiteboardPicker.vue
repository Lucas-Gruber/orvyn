<script setup lang="ts">
const props = defineProps<{
    open: boolean;
    spaceId: string;
    parentId?: string;
  }>(),
  emit = defineEmits<{ close: []; insert: [id: string] }>();
const spaces = ref<any[]>([]),
  spaceId = ref(props.spaceId),
  boards = ref<any[]>([]),
  search = ref(""),
  name = ref(""),
  loading = ref(false),
  creating = ref(false),
  error = ref("");
let generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
async function load() {
  const request = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const all = await $fetch<any[]>(`/api/v1/spaces/${spaceId.value}/pages`);
    if (request === generation)
      boards.value = all
        .filter(
          (p) =>
            p.kind === "whiteboard" &&
            p.title.toLowerCase().includes(search.value.toLowerCase()),
        )
        .slice(0, 50);
  } catch (e: any) {
    if (request === generation) {
      boards.value = [];
      error.value = e.data?.message || "Whiteboards could not be loaded.";
    }
  } finally {
    if (request === generation) loading.value = false;
  }
}
async function initialize() {
  creating.value = false;
  spaceId.value = props.spaceId;
  search.value = "";
  name.value = "";
  boards.value = [];
  error.value = "";
  try {
    spaces.value = await $fetch<any[]>("/api/v1/spaces");
    await load();
  } catch {
    error.value = "Spaces could not be loaded.";
  }
}
async function create() {
  const request = generation;
  creating.value = true;
  error.value = "";
  try {
    const page = await $fetch<any>(`/api/v1/spaces/${props.spaceId}/pages`, {
      method: "POST",
      body: {
        title: name.value.trim() || "Untitled whiteboard",
        kind: "whiteboard",
        parentId: props.parentId || null,
      },
    });
    if (request === generation && props.open) {
      emit("insert", page.id);
      emit("close");
    }
  } catch (e: any) {
    error.value = e.data?.message || "The whiteboard could not be created.";
  } finally {
    if (request === generation) creating.value = false;
  }
}
watch(
  () => props.open,
  (open) => {
    if (open) void initialize();
    else generation++;
  },
);
watch(spaceId, () => {
  if (props.open) void load();
});
watch(search, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (props.open) void load();
  }, 180);
});
onBeforeUnmount(() => {
  generation++;
  clearTimeout(timer);
});
</script>
<template>
  <UiDialog
    :open="open"
    title="Embed a whiteboard"
    :error="error"
    @close="emit('close')"
  >
    <p class="hint">
      Embed an existing canvas or create a new one. Its own permissions
      determine who can view and edit it.
    </p>
    <form class="whiteboard-create" @submit.prevent="create">
      <label for="whiteboard-name">New whiteboard</label>
      <div>
        <input
          id="whiteboard-name"
          v-model="name"
          placeholder="Whiteboard name"
          maxlength="300"
        /><button class="primary" :disabled="creating" type="submit">
          <AppIcon name="plus" :size="15" />Create and embed
        </button>
      </div>
    </form>
    <hr />
    <div class="whiteboard-find">
      <label
        >Space<select v-model="spaceId">
          <option v-for="space in spaces" :key="space.id" :value="space.id">
            {{ space.name }}
          </option>
        </select></label
      ><label
        >Find a whiteboard<input
          v-model="search"
          type="search"
          placeholder="Search whiteboards…"
      /></label>
    </div>
    <p v-if="loading" class="hint" role="status">Loading whiteboards…</p>
    <p v-else-if="!boards.length" class="hint">
      No matching whiteboards in this space.
    </p>
    <div class="whiteboard-options">
      <button
        v-for="board in boards"
        :key="board.id"
        @click="
          emit('insert', board.id);
          emit('close');
        "
      >
        <AppIcon name="whiteboard" :size="18" /><span>{{ board.title }}</span
        ><AppIcon name="plus" :size="15" />
      </button>
    </div>
  </UiDialog>
</template>
<style scoped>
.whiteboard-create {
  padding: 14px 0;
}
.whiteboard-create > div {
  display: flex;
  gap: 8px;
}
.whiteboard-create input {
  min-width: 0;
  flex: 1;
}
.whiteboard-create button {
  white-space: nowrap;
  font-size: 0.76rem;
}
.whiteboard-find {
  display: grid;
  grid-template-columns: 1fr 1.5fr;
  gap: 12px;
  margin: 18px 0;
}
.whiteboard-options {
  max-height: 270px;
  overflow: auto;
}
.whiteboard-options button {
  display: flex;
  gap: 10px;
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  padding: 10px 7px;
  font-size: 0.82rem;
}
.whiteboard-options button span {
  flex: 1;
}
@media (max-width: 600px) {
  .whiteboard-create > div {
    flex-direction: column;
  }
  .whiteboard-find {
    grid-template-columns: 1fr;
  }
}
</style>

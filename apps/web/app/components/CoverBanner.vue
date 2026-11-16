<script setup lang="ts">
import { coverBackground } from "@orvyn/shared";
const props = defineProps<{
    preset?: string | null;
    fileId?: string | null;
    compact?: boolean;
  }>(),
  failed = ref(false);
watch(
  () => props.fileId,
  () => (failed.value = false),
);
</script>
<template>
  <div
    v-if="preset || fileId"
    class="cover-banner"
    :class="{ compact }"
    :style="{ background: coverBackground(preset) || 'var(--surface)' }"
  >
    <img
      v-if="fileId && !failed"
      :key="fileId"
      :src="'/api/v1/files/' + fileId + '/preview'"
      alt=""
      @error="failed = true"
    />
    <span v-if="fileId && failed" class="cover-unavailable"
      >Cover unavailable</span
    >
  </div>
</template>
<style scoped>
.cover-banner {
  position: relative;
  height: 220px;
  border-radius: 10px;
  overflow: hidden;
  margin: 0 0 28px;
}
.cover-banner img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.cover-banner.compact {
  height: 100px;
  margin: 12px 0;
}
.cover-unavailable {
  position: absolute;
  bottom: 12px;
  right: 14px;
  font-size: 0.75rem;
  color: var(--muted);
}
@media (max-width: 760px) {
  .cover-banner {
    height: 150px;
    border-radius: 7px;
  }
  .cover-banner.compact {
    height: 90px;
  }
}
</style>

<script setup lang="ts">
defineProps<{
  providers: { id: string; name: string }[];
  disabled?: boolean;
  invitation?: boolean;
}>();
defineEmits<{ select: [id: string] }>();
</script>
<template>
  <div v-if="providers.length" class="auth-sso">
    <h3>
      {{
        invitation
          ? "Or sign in with your organization"
          : "Or continue with your organization"
      }}
    </h3>
    <button
      v-for="provider in providers"
      :key="provider.id"
      :disabled="disabled"
      @click="$emit('select', provider.id)"
    >
      <AppIcon name="shield" :size="16" />Continue with {{ provider.name }}
    </button>
  </div>
</template>

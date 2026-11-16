import type { InjectionKey } from "vue";
export type WriteFlusher = () => Promise<void>;
export const pendingWritesKey: InjectionKey<Set<WriteFlusher>> =
  Symbol("pending-writes");
export function usePendingWrites(flush: WriteFlusher) {
  const registry = inject(pendingWritesKey);
  onMounted(() => registry?.add(flush));
  onBeforeUnmount(() => registry?.delete(flush));
}

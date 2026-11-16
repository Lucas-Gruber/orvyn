import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
export function useDatabaseEvents(id: string, changed: () => void) {
  const live = ref(false),
    denied = ref(false),
    document = new Y.Doc();
  let provider: HocuspocusProvider | undefined;
  let watchedIds: string[] = [],
    watchedScope:
      { relationProperties: string[]; fingerprint: string } | undefined;
  const config = useRuntimeConfig();
  function watchRecords(
    ids: string[],
    scope?: { relationProperties: string[]; fingerprint: string },
  ) {
    watchedIds = ids;
    watchedScope = scope;
    if (provider?.isAuthenticated)
      provider.sendStateless(
        JSON.stringify({ type: "watch-records", recordIds: ids, ...scope }),
      );
  }
  onMounted(() => {
    const url = String(
      config.public.collaborationUrl ||
        new URL("/collaboration", window.location.href)
          .toString()
          .replace(/^http/, "ws"),
    );
    provider = new HocuspocusProvider({
      url,
      name: id,
      document,
      token: "cookie",
      onSynced({ state }) {
        live.value = state && !!provider?.isAuthenticated;
        if (state) watchRecords(watchedIds, watchedScope);
        changed();
      },
      onStatus({ status }) {
        if (status !== "connected") live.value = false;
      },
      onAuthenticationFailed() {
        live.value = false;
        denied.value = true;
        provider?.disconnect();
        changed();
      },
      onStateless({ payload }) {
        try {
          if (
            ["database-changed", "permissions"].includes(
              JSON.parse(payload).type,
            )
          )
            changed();
        } catch {}
      },
      onClose({ event }) {
        live.value = false;
        if (
          ["Access changed", "Document access denied"].includes(event.reason)
        ) {
          denied.value = true;
          provider?.disconnect();
        }
        changed();
      },
    });
  });
  onBeforeUnmount(() => {
    provider?.destroy();
    document.destroy();
  });
  return {
    live,
    denied,
    watchRecords,
    reconnect() {
      if (provider && denied.value) {
        denied.value = false;
        void provider.connect();
      }
    },
  };
}

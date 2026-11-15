export default defineNuxtConfig({
  compatibilityDate: "2026-11-15",
  devtools: { enabled: false },
  nitro: { experimental: { websocket: true } },
  runtimeConfig: {
    apiUrl: "http://127.0.0.1:3001",
    collaborationUpstream: "ws://127.0.0.1:3002",
    public: { collaborationUrl: "" },
  },
});

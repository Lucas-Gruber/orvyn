export default defineNuxtConfig({
  compatibilityDate: "2026-11-15",
  devtools: { enabled: false },
  runtimeConfig: {
    apiUrl: "http://127.0.0.1:3001",
    public: { collaborationUrl: "" },
  },
});

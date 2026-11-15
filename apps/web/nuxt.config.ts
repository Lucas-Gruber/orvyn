export default defineNuxtConfig({
  compatibilityDate: "2026-11-15",
  devtools: { enabled: false },
  css: [
    "@fontsource-variable/inter",
    "@fontsource-variable/jetbrains-mono",
    "~/assets/css/app.css",
  ],
  app: {
    head: {
      title: "Orvyn — Your knowledge. Organized.",
      meta: [
        {
          name: "description",
          content: "A calm place for your notes, documents and team knowledge.",
        },
      ],
    },
  },
  nitro: { experimental: { websocket: true } },
  runtimeConfig: {
    apiUrl: "http://127.0.0.1:3001",
    collaborationUpstream: "ws://127.0.0.1:3002",
    public: { collaborationUrl: "" },
  },
});

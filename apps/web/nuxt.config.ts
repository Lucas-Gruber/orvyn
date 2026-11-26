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
      link: [
        {
          rel: "icon",
          type: "image/png",
          sizes: "32x32",
          href: "/branding/favicon-32.png",
        },
        {
          rel: "apple-touch-icon",
          sizes: "180x180",
          href: "/branding/apple-touch-icon.png",
        },
      ],
      meta: [
        {
          name: "description",
          content: "A calm place for your notes, documents and team knowledge.",
        },
      ],
    },
  },
  nitro: { experimental: { websocket: true }, compressPublicAssets: true },
  runtimeConfig: {
    apiUrl: "http://127.0.0.1:3001",
    collaborationUpstream: "ws://127.0.0.1:3002",
    public: { collaborationUrl: "" },
  },
});

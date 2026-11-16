export type VideoProvider = "youtube" | "vimeo" | "loom";
export const providerNames: Record<VideoProvider, string> = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  loom: "Loom",
};
export function validVideo(
  provider: unknown,
  id: unknown,
): provider is VideoProvider {
  return (
    typeof id === "string" &&
    (provider === "youtube"
      ? /^[A-Za-z0-9_-]{11}$/.test(id)
      : provider === "vimeo"
        ? /^[0-9]{1,15}$/.test(id)
        : provider === "loom" && /^[a-f0-9]{32}$/.test(id))
  );
}
export function videoSource(provider: VideoProvider, id: string) {
  if (!validVideo(provider, id)) return "";
  return provider === "youtube"
    ? "https://www.youtube-nocookie.com/embed/" + id
    : provider === "vimeo"
      ? "https://player.vimeo.com/video/" + id
      : "https://www.loom.com/embed/" + id;
}
export function parseVideoUrl(
  input: string,
): { provider: VideoProvider; resourceId: string } | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return null;
    let provider: VideoProvider, resourceId: string | undefined;
    if (
      [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "www.youtube-nocookie.com",
      ].includes(url.hostname)
    ) {
      provider = "youtube";
      resourceId =
        url.pathname === "/watch"
          ? url.searchParams.get("v") || undefined
          : url.pathname.match(
              /^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})\/?$/,
            )?.[1];
    } else if (url.hostname === "youtu.be") {
      provider = "youtube";
      resourceId = url.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
    } else if (
      ["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(url.hostname)
    ) {
      if (url.searchParams.has("h")) return null;
      provider = "vimeo";
      resourceId = url.pathname.match(/^\/(?:video\/)?([0-9]{1,15})\/?$/)?.[1];
    } else if (["loom.com", "www.loom.com"].includes(url.hostname)) {
      provider = "loom";
      resourceId = url.pathname.match(
        /^\/(?:share|embed)\/([a-f0-9]{32})\/?$/,
      )?.[1];
    } else return null;
    return resourceId && validVideo(provider, resourceId)
      ? { provider, resourceId }
      : null;
  } catch {
    return null;
  }
}

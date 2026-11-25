import { createDiagnostics } from "@orvyn/shared/server";
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const url = getRequestURL(event);
  try {
    return await proxyRequest(
      event,
      `${config.apiUrl}${url.pathname}${url.search}`,
      {
        // h3 omits Accept by default; preserve browser/JSON callback negotiation.
        headers: {
          accept: getRequestHeader(event, "accept") || "application/json",
        },
        fetchOptions: { redirect: "manual" },
      },
    );
  } catch (error) {
    createDiagnostics("web", process.env).error("proxy.upstream_failed", {
      stage: "api_proxy",
      error,
    });
    if (event.node.res.headersSent) {
      event.node.res.destroy();
      return;
    }
    setResponseHeader(event, "Cache-Control", "no-store");
    setResponseHeader(event, "Referrer-Policy", "no-referrer");
    if (
      /^\/api\/v1\/oidc\/(?:deployment|[a-f0-9-]{36})\/callback$/.test(
        url.pathname,
      ) &&
      (getRequestHeader(event, "accept") || "").includes("text/html")
    )
      return sendRedirect(event, "/?authError=provider_unavailable", 303);
    // Never retain a fetch cause containing the original callback/query URL.
    setResponseStatus(event, 502);
    return { message: "API is temporarily unavailable" };
  }
});

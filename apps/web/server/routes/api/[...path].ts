export default defineEventHandler((event) => {
  const config = useRuntimeConfig();
  const url = getRequestURL(event);
  return proxyRequest(event, `${config.apiUrl}${url.pathname}${url.search}`, {
    // h3 omits Accept by default; preserve browser/JSON callback negotiation.
    headers: {
      accept: getRequestHeader(event, "accept") || "application/json",
    },
    fetchOptions: { redirect: "manual" },
  });
});

export default defineEventHandler((event) => {
  const config = useRuntimeConfig();
  const url = getRequestURL(event);
  return proxyRequest(event, `${config.apiUrl}${url.pathname}${url.search}`, {
    fetchOptions: { redirect: "manual" },
  });
});

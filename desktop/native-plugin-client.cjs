function createNativePluginClient({ baseURL, request = fetch }) {
  const url = new URL(baseURL);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("Native gateway must be an explicit loopback HTTP origin");
  async function call(route, body) {
    const response = await request(new URL(`/api/v1/plugins${route}`, url), {
      method: body === undefined ? "GET" : "POST",
      headers: { "X-CodeBuddy-Request": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (!response.ok) throw new Error(`Native plugin request failed (${response.status}): ${text.slice(0, 500)}`);
    let result;
    try { result = JSON.parse(text); } catch { throw new Error("Native plugin response is not JSON"); }
    return result.data;
  }
  function pluginId(value) {
    if (typeof value !== "string" || !/^[^\s@]+@[^\s@]+$/.test(value))
      throw new Error("Native plugin ID must include its marketplace");
    return value;
  }
  return {
    list: () => call(""),
    validate: (pluginPath) => {
      if (typeof pluginPath !== "string" || !require("node:path").isAbsolute(pluginPath))
        throw new Error("Plugin path must be absolute");
      return call("/validate", { path: pluginPath });
    },
    enable: (id) => call("/enable", { plugin: pluginId(id) }),
    disable: (id) => call("/disable", { plugin: pluginId(id) }),
  };
}
module.exports = { createNativePluginClient };

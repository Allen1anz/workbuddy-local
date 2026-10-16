/** Retain one connection per configured server; replaced connections cannot escape cleanup. */
export function createMcpPool({ connect }) {
  const entries = new Map();
  function bindClient(id, entry, client) {
    entry.client = client;
    entry.status = "connected";
    const onclose = client.onclose;
    client.onclose = () => {
      if (entries.get(id) === entry) entry.status = "disconnected";
      onclose?.();
    };
    return client;
  }
  async function invalidate(id) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    entry.controller.abort();
    if (entry.client) await entry.client.close();
  }
  function waitFor(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason || Error("MCP wait cancelled"));
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(signal.reason || Error("MCP wait cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }
  async function acquire(id, key, signal) {
    if (signal?.aborted) throw signal.reason || Error("MCP wait cancelled");

    const previous = entries.get(id);
    if (previous?.key === key && ["connecting", "connected"].includes(previous.status))
      return waitFor(previous.promise, signal);
    if (previous) {
      await invalidate(id);
      return acquire(id, key, signal);
    }
    const entry = { key, controller: new AbortController(), status: "connecting" };
    entries.set(id, entry);
    entry.promise = Promise.resolve()
      .then(() => connect(id, entry.controller.signal))
      .then(async (client) => {
        if (entries.get(id) !== entry || entry.controller.signal.aborted) {
          await client.close();
          throw Error("MCP connection replaced");
        }
        return bindClient(id, entry, client);
      })
      .catch((error) => {
        if (entries.get(id) === entry) {
          entry.status = "disconnected";
          entry.error = error.message;
        }
        throw error;
      });
    return waitFor(entry.promise, signal);
  }
  return {
    async adopt(id, key, client) {
      const previous = entries.get(id);
      if (previous && ["connecting", "connected"].includes(previous.status)) return false;
      if (previous) await invalidate(id);
      if (entries.has(id)) return false;
      const entry = {
        key,
        controller: new AbortController(),
        status: "connected",
        promise: Promise.resolve(client),
      };
      entries.set(id, entry);
      bindClient(id, entry, client);
      return true;
    },
    acquire,
    owns: (id, client) =>
      entries.get(id)?.client === client && entries.get(id)?.status === "connected",
    invalidate,
    state: (id) => ({
      status: entries.get(id)?.status || "disconnected",
      ...(entries.get(id)?.error ? { error: entries.get(id).error } : {}),
    }),
    close: async () => {
      await Promise.all([...entries.keys()].map(invalidate));
    },
  };
}

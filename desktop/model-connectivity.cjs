"use strict";

/** Probe the supplied model without saving configuration or returning provider secrets. */
async function testModelConnectivity(model, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  let endpoint;
  try {
    endpoint = new URL(model?.url);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || !model?.id)
      return { ok: false, errorCode: "INVALID_ARGUMENT" };
  } catch {
    return { ok: false, errorCode: "INVALID_ARGUMENT" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint.href, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Reply OK." }], max_tokens: 1, stream: false }),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, errorCode: response.status === 401 || response.status === 403 ? "NOT_AUTHENTICATED" : response.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR" };
    }
    // A proxy's HTML success page is not a successful OpenAI completion.
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, errorCode: "INVALID_RESPONSE" };
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) {
          await reader.cancel();
          return { ok: false, errorCode: "INVALID_RESPONSE" };
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return { ok: false, errorCode: "INVALID_RESPONSE" }; }
    return Array.isArray(result?.choices) && result.choices.length > 0
      ? { ok: true }
      : { ok: false, errorCode: "INVALID_RESPONSE" };
  } catch {
    return { ok: false, errorCode: controller.signal.aborted ? "TIMEOUT" : "NETWORK" };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { testModelConnectivity };

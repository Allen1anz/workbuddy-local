/** Legacy SSE transport for servers that advertise a POST endpoint over SSE. */
export class LegacySSETransport {
  constructor(url, { headers = {}, requestInit, timeout = 15000 } = {}) {
    this.url = new URL(url);
    this.headers = requestInit?.headers || headers;
    this.timeout = timeout;
    this.closed = false;
  }
  notifyClosed() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  async start() {
    if (this.controller || this.closed) throw Error("SSE transport already started or closed");
    this.controller = new AbortController();
    const timer = setTimeout(() => {
      this.readyReject?.(Error("SSE endpoint timeout"));
      this.controller.abort();
    }, this.timeout);
    try {
      const response = await fetch(this.url, {
        headers: { ...this.headers, Accept: "text/event-stream" },
        signal: this.controller.signal,
      });
      if (!response.ok || !response.body)
        throw Error(`SSE connection failed: HTTP ${response.status}`);
      if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream"))
        throw Error("SSE response has invalid content type");
      const ready = new Promise((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
      this.reading = this.read(response.body).catch((error) => {
        this.readyReject?.(error);
        if (error.name !== "AbortError") this.onerror?.(error);
        this.notifyClosed();
      });
      await ready;
    } catch (error) {
      this.controller.abort();
      await this.reading;
      this.notifyClosed();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async read(body) {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (!data.length) continue;
        const value = data.join("\n");
        if (event === "endpoint") {
          const endpoint = new URL(value, this.url);
          if (endpoint.origin !== this.url.origin) throw Error("SSE POST endpoint changed origin");
          this.endpoint = endpoint;
          this.readyResolve?.();
          this.readyResolve = null;
        } else if (event === "message") this.onmessage?.(JSON.parse(value));
      }
    }
    this.readyReject?.(Error("SSE stream ended"));
    this.notifyClosed();
  }
  async send(message) {
    if (!this.endpoint || this.closed) throw Error("SSE POST endpoint unavailable");
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: this.controller.signal,
    });
    if (!response.ok) throw Error(`SSE message failed: HTTP ${response.status}`);
  }
  async close() {
    this.readyReject?.(Error("SSE transport closed"));
    this.controller?.abort();
    await this.reading;
    this.notifyClosed();
  }
}

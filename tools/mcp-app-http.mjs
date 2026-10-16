function sanitizeCspDomains(domains) {
  if (!Array.isArray(domains)) return [];
  return domains.filter((d) => typeof d === "string" && !/[;\r\n'" ]/.test(d));
}
/**
 * Build a CSP header that matches the MCP Apps reference host
 * (`ext-apps/examples/basic-host/serve.ts`). Directive rationale:
 *
 * - `default-src 'self' 'unsafe-inline'`: directives we don't name (e.g.
 *   `manifest-src`, `prefetch-src`) inherit these.
 * - `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: [resourceDomains]`:
 *     * `'unsafe-inline'` works because no nonce/hash source is present
 *       (CSP3 would otherwise ignore it). Required for Vite singlefile
 *       bundles and runtime-injected inline scripts.
 *     * `'unsafe-eval'` covers Vega / Cesium expression compilers and
 *       (for back-compat) wasm instantiation.
 *     * `blob:`/`data:` cover workers and base64-encoded module scripts.
 * - `style-src 'self' 'unsafe-inline' blob: data: [resourceDomains]`: same
 *   shape for `<style>` + CSS-in-JS + runtime-injected stylesheets.
 * - `worker-src 'self' blob: [resourceDomains]`: CRITICAL for WebGL apps
 *   like CesiumJS and libraries like PDF.js that spawn workers from the
 *   app's declared resource hosts. Omitting `resourceDomains` here was
 *   the root cause of `map-server` hanging on "Loading globe...".
 * - `connect-src 'self' [connectDomains]`: fetch / XHR / WebSocket.
 *   Intentionally NOT merged with `resourceDomains` — those two fields
 *   are distinct in the MCP Apps spec.
 * - `img-src` / `media-src` / `font-src`: same permissive baseline plus
 *   the app's declared resource hosts.
 * - `frame-src`: driven by `frameDomains`; otherwise denied.
 * - `base-uri`: driven by `baseUriDomains`; otherwise denied to prevent
 *   relative-URL hijacking.
 * - `object-src 'none'`: legacy plugin surface fully blocked.
 *
 * Every host entry passed through `sanitizeCspDomains` so that a server
 * declaring something like `"https://evil.com; script-src *"` can't
 * inject new directives.
 */
export function buildMcpAppCsp(ui) {
  const resourceDomains = sanitizeCspDomains(ui?.csp?.resourceDomains).join(" ");
  const connectDomains = sanitizeCspDomains(ui?.csp?.connectDomains).join(" ");
  const frameDomains = sanitizeCspDomains(ui?.csp?.frameDomains).join(" ");
  const baseUriDomains = sanitizeCspDomains(ui?.csp?.baseUriDomains).join(" ");
  return [
    "default-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resourceDomains}`.trim(),
    `style-src 'self' 'unsafe-inline' blob: data: ${resourceDomains}`.trim(),
    `img-src 'self' data: blob: ${resourceDomains}`.trim(),
    `font-src 'self' data: blob: ${resourceDomains}`.trim(),
    `media-src 'self' data: blob: ${resourceDomains}`.trim(),
    `connect-src 'self' ${connectDomains}`.trim(),
    `worker-src 'self' blob: ${resourceDomains}`.trim(),
    frameDomains ? `frame-src ${frameDomains}` : "frame-src 'none'",
    "object-src 'none'",
    baseUriDomains ? `base-uri ${baseUriDomains}` : "base-uri 'none'",
  ].join("; ");
}

export function createMcpAppHttpHandler({ getInstance, sandboxHtml }) {
  return (req, res, url) => {
    if (!url.pathname.startsWith("/mcp-apps/")) return false;
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return true;
    }
    let html, ui;
    if (url.pathname === "/mcp-apps/sandbox-proxy.html") {
      let csp;
      try {
        const raw = url.searchParams.get("csp");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") csp = parsed;
        }
      } catch {
        res.writeHead(400);
        res.end("Invalid MCP Apps CSP");
        return true;
      }
      html = sandboxHtml;
      ui = { csp };
    } else {
      const match = /^\/mcp-apps\/([^/]+)\/app\.html$/.exec(url.pathname);
      let instance;
      try {
        instance = match && getInstance(match[1]);
      } catch {}
      if (!instance?.html) {
        res.writeHead(404);
        res.end("MCP App instance not found or not loaded");
        return true;
      }
      html = instance.html;
      ui = instance.uiMetadata;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": buildMcpAppCsp(ui),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
    res.end(html);
    return true;
  };
}

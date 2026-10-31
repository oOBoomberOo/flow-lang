import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const RUNTIME_DIR = path.join(import.meta.dirname, "runtime");

export interface HostOptions {
  /** directory containing app.js and server.js */
  outDir: string;
  port: number;
  secrets?: Record<string, string>;
  /** appended to the server bundle import so `watch --run` picks up rebuilds */
  cacheBust?: string;
}

export interface Host {
  url: string;
  close: () => Promise<void>;
  server: http.Server;
}

export async function createHost(opts: HostOptions): Promise<Host> {
  process.env.FLOW_OPTS = JSON.stringify({ secrets: opts.secrets ?? {} });

  const serverBundle = path.join(opts.outDir, "server.js");
  const serverModule = await import(
    pathToFileUrl(serverBundle) + (opts.cacheBust ? `?v=${encodeURIComponent(opts.cacheBust)}` : "")
  );
  const { R } = serverModule;
  const { createHub, attachServerTransport } = await import(
    pathToFileUrl(path.join(opts.outDir, "runtime", "server.js"))
  );

  const hub = createHub();
  attachServerTransport(R, hub);

  // `main :: ()` is the server startup hook: it runs exactly once, before any
  // request, so it can initialise server-side state.
  if (typeof serverModule.__flow_entry === "function") {
    try {
      const started = (serverModule.__flow_entry as () => unknown)();
      if (started && typeof (started as { next?: unknown }).next === "function") {
        (R as { run: (value: unknown) => unknown }).run(started);
      } else {
        await started;
      }
    } catch (e) {
      console.error("[flow] main() failed:", e);
      throw e;
    }
  }

  // Legacy: old programs export a `routes()` function. New programs pass a
  // plain `{ page, routes }` object to `serve`; its routes are registered
  // during `main` and are already in R._routes() here.
  if (typeof serverModule.routes === "function") {
    try {
      const started = serverModule.routes();
      // A routes() function that handles algebraic effects is a generator.
      if (started && typeof (started as { next?: unknown }).next === "function") {
        (R as { run: (value: unknown) => unknown }).run(started);
      } else {
        await started;
      }
    }
    catch (e) { console.error("[flow] routes() failed:", e); }
  }
  const routes: HttpRoute[] = typeof R._routes === "function" ? R._routes() : [];
  const notFound: HttpHandler | null = typeof R._notFound === "function" ? R._notFound() : null;
  /** the program called `serve`: every page request gets the shell */
  const serve = serverModule.__flow_serve === true;

  const clientBundle = fs.readFileSync(path.join(opts.outDir, "app.js"), "utf8");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const internal = url.pathname === "/app.js" ||
      url.pathname.startsWith("/runtime/") ||
      url.pathname.startsWith("/modules/") ||
      url.pathname.startsWith("/__flow/");

    let requestBody = "";
    if (!internal) {
      requestBody = await readBody(req);
      const match = matchRoute(routes, req.method ?? "GET", url.pathname);
      if (match) {
        await handleRoute(R, match.route, makeRequest(req, url, requestBody, match.params), res);
        return;
      }
      if (serve) {
        // The page app routes in the browser: serve the shell with this exact
        // request, so the handler sees the method, path, query, body and headers.
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(shell(makeRequest(req, url, requestBody, [])));
        return;
      }
      if (notFound) {
        await handleRoute(R, { handler: notFound }, makeRequest(req, url, requestBody, []), res);
        return;
      }
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(shell());
      return;
    }

    if (req.method === "GET" && url.pathname === "/app.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(clientBundle);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/modules/")) {
      const name = url.pathname.slice("/modules/".length);
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) { res.writeHead(400); res.end("bad path"); return; }
      const file = path.join(opts.outDir, "modules", name);
      if (!fs.existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
      const type = name.endsWith(".ts") ? "text/typescript; charset=utf-8" : "text/javascript; charset=utf-8";
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(fs.readFileSync(file));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/runtime/")) {
      const name = url.pathname.slice("/runtime/".length);
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) { res.writeHead(400); res.end("bad path"); return; }
      const file = path.join(RUNTIME_DIR, name);
      if (!fs.existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(fs.readFileSync(file, "utf8"));
      return;
    }

    if (req.method === "GET" && url.pathname === "/__flow/sse") {
      const sid = url.searchParams.get("sid") ?? "anon";
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write("retry: 500\n\n");
      hub.add(sid, res);
      res.write(`data: ${JSON.stringify({ t: "hello", sid })}\n\n`);
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* gone */ } }, 15000);
      req.on("close", () => { clearInterval(ping); hub.remove(sid, res); });
      return;
    }

    if (req.method === "POST" && url.pathname === "/__flow/msg") {
      const body = await readBody(req);
      let envelope: { sid?: string; msg?: unknown };
      try { envelope = JSON.parse(body); } catch { res.writeHead(400); res.end("bad json"); return; }
      const sid = envelope.sid ?? "anon";
      R._enter(sid);
      try {
        await R._receive(envelope.msg);
      } catch (e) {
        console.error("[flow] message error:", e);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/__flow/cuts") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(R._stats()));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(opts.port);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;

  return {
    url: `http://localhost:${port}`,
    server,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

interface HttpRequest {
  method: string;
  path: string;
  query: string;
  body: string;
  headers: [string, string][];
  params: [string, string][];
}

type HttpHandler = (request: HttpRequest) => unknown;

interface HttpRoute {
  method?: string;
  path?: string;
  handler: HttpHandler;
}

function matchRoute(
  routes: HttpRoute[],
  method: string,
  pathname: string,
): { route: HttpRoute; params: [string, string][] } | null {
  const segments = splitPath(pathname);
  for (const route of routes) {
    const routeMethod = String(route.method ?? "GET").toUpperCase();
    if (routeMethod !== "*" && routeMethod !== method.toUpperCase()) continue;
    const pattern = splitPath(String(route.path ?? "/"));
    if (pattern.length !== segments.length) continue;
    const params: [string, string][] = [];
    let matched = true;
    for (let i = 0; i < pattern.length; i++) {
      const p = pattern[i]!;
      const s = segments[i]!;
      if (p.startsWith(":")) params.push([p.slice(1), s]);
      else if (p !== s) { matched = false; break; }
    }
    if (matched) return { route, params };
  }
  return null;
}

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter((s) => s.length > 0).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}

function makeRequest(
  req: http.IncomingMessage,
  url: URL,
  body: string,
  params: [string, string][],
): HttpRequest {
  const headers: [string, string][] = [];
  for (const [name, value] of Object.entries(req.headers)) {
    headers.push([name, Array.isArray(value) ? value.join(", ") : String(value ?? "")]);
  }
  return {
    method: req.method ?? "GET",
    path: url.pathname,
    query: url.search.startsWith("?") ? url.search.slice(1) : "",
    body,
    headers,
    params,
  };
}

async function handleRoute(
  R: unknown,
  route: HttpRoute,
  request: HttpRequest,
  res: http.ServerResponse,
): Promise<void> {
  const runtime = R as {
    _setRequest?: (request: HttpRequest | null) => void;
    run?: (value: unknown) => unknown;
  };
  if (typeof route.handler !== "function") {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("route has no handler");
    return;
  }
  runtime._setRequest?.(request);
  try {
    let response = route.handler(request);
    // A handler that performs algebraic effects compiles to a generator.
    if (response && typeof (response as { next?: unknown }).next === "function") {
      response = runtime.run ? runtime.run(response) : response;
    }
    sendResponse(res, await response);
  } catch (e) {
    console.error("[flow] route error:", e);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("internal error");
    } else {
      res.end();
    }
  } finally {
    runtime._setRequest?.(null);
  }
}

function sendResponse(res: http.ServerResponse, response: unknown): void {
  if (typeof response === "string") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(response);
    return;
  }
  if (!response || typeof response !== "object") {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("route did not return a Response");
    return;
  }
  const value = response as {
    status?: unknown;
    contentType?: unknown;
    headers?: unknown;
    body?: unknown;
  };
  const status = Number.isInteger(value.status) ? value.status as number : 200;
  const contentType = typeof value.contentType === "string" && value.contentType
    ? value.contentType
    : "text/plain; charset=utf-8";
  const headers: Record<string, string> = { "content-type": contentType };
  if (Array.isArray(value.headers)) {
    for (const pair of value.headers) {
      if (Array.isArray(pair) && pair.length >= 2) headers[String(pair[0])] = String(pair[1]);
    }
  }
  res.writeHead(status, headers);
  res.end(typeof value.body === "string" ? value.body : String(value.body ?? ""));
}

function pathToFileUrl(p: string): string {
  const abs = path.resolve(p).replace(/\\/g, "/");
  return new URL(`file:///${abs}`).href;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function shell(request?: HttpRequest): string {
  const payload = request ? JSON.stringify(request).replace(/</g, "\\u003c") : "null";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flow</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; padding: 2rem; }
  #app { max-width: 60rem; margin: 0 auto; }
  #flow-error { display: none; position: fixed; inset: auto 0 0 0; max-height: 50vh; overflow: auto;
    background: #300; color: #fdd; font: 12px/1.5 ui-monospace, monospace; padding: 1rem; white-space: pre-wrap; }
</style>
</head>
<body>
<div id="app"></div>
<pre id="flow-error"></pre>
<script>
  window.addEventListener("error", (e) => {
    const el = document.getElementById("flow-error");
    el.style.display = "block";
    el.textContent += (e.error && e.error.stack ? e.error.stack : e.message) + "\\n";
  });
  window.addEventListener("unhandledrejection", (e) => {
    const el = document.getElementById("flow-error");
    el.style.display = "block";
    el.textContent += "unhandled rejection: " + (e.reason && e.reason.stack ? e.reason.stack : e.reason) + "\\n";
  });
</script>
<script>window.__flow_request = ${payload};</script>
<script type="module">
  import { __flow_start } from "/app.js";
  __flow_start(document.getElementById("app"), window.__flow_request);
</script>
</body>
</html>`;
}

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const RUNTIME_DIR = path.join(import.meta.dirname, "runtime");

export interface HostOptions {
  /** directory containing app.js and server.js */
  outDir: string;
  port: number;
  secrets?: Record<string, string>;
}

export interface Host {
  url: string;
  close: () => Promise<void>;
  server: http.Server;
}

export async function createHost(opts: HostOptions): Promise<Host> {
  process.env.FLOW_OPTS = JSON.stringify({ secrets: opts.secrets ?? {} });

  const serverBundle = path.join(opts.outDir, "server.js");
  const { R } = await import(pathToFileUrl(serverBundle));
  const { createHub, attachServerTransport } = await import(
    pathToFileUrl(path.join(opts.outDir, "runtime", "server.js"))
  );

  const hub = createHub();
  attachServerTransport(R, hub);

  const clientBundle = fs.readFileSync(path.join(opts.outDir, "app.js"), "utf8");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

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

  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
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

function shell(): string {
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
<script type="module">
  import { __flow_start } from "/app.js";
  __flow_start(document.getElementById("app"));
</script>
</body>
</html>`;
}

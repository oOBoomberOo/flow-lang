/**
 * Flow server runtime.
 *
 * The server is just the other half of the same dataflow graph: it registers the
 * cuts it owns with `R.serve`, and consumes client-owned cuts with `R.remote`.
 * Transport is one Server-Sent-Events stream down and one POST channel up.
 */

import { createRuntime, installServerCapabilities } from "./core.js";

export function createServerRuntime(opts = {}) {
  const R = createRuntime();
  installServerCapabilities(R, opts);
  return R;
}

export function createHub() {
  /** sid -> Set<ServerResponse> */
  const clients = new Map();

  return {
    add(sid, res) {
      if (!clients.has(sid)) clients.set(sid, new Set());
      clients.get(sid).add(res);
    },
    remove(sid, res) {
      const set = clients.get(sid);
      if (!set) return;
      set.delete(res);
      if (set.size === 0) clients.delete(sid);
    },
    pushTo(sid, msg) {
      const set = clients.get(sid);
      if (!set) return;
      const data = `data: ${JSON.stringify(msg)}\n\n`;
      for (const res of set) {
        try { res.write(data); } catch { /* client went away */ }
      }
    },
    size() { return clients.size; },
  };
}

export function attachServerTransport(R, hub) {
  R._attach((msg) => {
    hub.pushTo(R._sessionId(), msg);
  });
  return R;
}

export { createRuntime, installServerCapabilities };

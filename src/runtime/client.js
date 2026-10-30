/**
 * Flow client runtime (served to the browser at /runtime/client.js).
 *
 * The transport is deliberately symmetric with the server's: the browser can
 * *serve* cuts too (that is how server code reads a client value), so this file
 * registers cuts and pushes subscriptions exactly like `runtime/server.js`.
 */

import { createRuntime, installClientCapabilities } from "./core.js";
import { installDom } from "./dom.js";

const R = createRuntime();
installClientCapabilities(R);
installDom(R);

const sid =
  (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    : `s${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

/** Messages produced before the SSE stream is open must not be dropped. */
const queue = [];
let ready = false;

function post(msg) {
  if (!ready) { queue.push(msg); return; }
  void fetch("/__flow/msg", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sid, msg }),
  }).catch((e) => console.error("[flow] transport error", e));
}

R._attach(post, sid);

const es = new EventSource(`/__flow/sse?sid=${encodeURIComponent(sid)}`);
globalThis.__flow = R;
globalThis.__flow_sid = sid;
es.onopen = () => {
  ready = true;
  for (const m of queue.splice(0)) post(m);
};
es.onmessage = async (ev) => {
  try {
    await R._receive(JSON.parse(ev.data));
  } catch (e) {
    console.error("[flow] bad message", e);
  }
};
es.onerror = () => { ready = false; };

export { R };

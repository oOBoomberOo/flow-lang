/**
 * Flow runtime core — a small dependency-tracking dataflow graph plus the
 * symmetric client/server transport. The *same* code runs on both sides:
 * whichever side hosts a cut registers it with `serve`, the other side
 * references it with `remote` (streaming) or `call` (request/response).
 *
 * This is what makes "control flow across the boundary" work without moving a
 * continuation: the boundary is an edge in the dataflow graph.
 */

let CURRENT = null;

class Node {
  constructor(fn) {
    this.fn = fn;
    this.deps = new Set();
    this.subs = new Set();
    this.value = undefined;
    this.valid = false;
    this.__node = true;
    this.__watchers = null;
  }
  get() {
    if (!this.valid) this.recompute();
    return this.value;
  }
  recompute() {
    const prev = CURRENT;
    CURRENT = this;
    this.deps.clear();
    try {
      this.value = this.fn();
    } finally {
      CURRENT = prev;
    }
    this.valid = true;
    for (const d of this.deps) {
      if (!d.subs) d.subs = new Set();
      d.subs.add(this);
    }
    return this.value;
  }
  invalidate() {
    this.valid = false;
    if (this.__watchers) {
      this.recompute();
      for (const w of this.__watchers) w(this.value);
    }
    for (const s of this.subs) s.invalidate();
  }
  watch(cb) {
    (this.__watchers ??= new Set()).add(cb);
    return () => this.__watchers.delete(cb);
  }
}

class Cell {
  constructor(v) {
    this.value = v;
    this.subs = new Set();
    this.__cell = true;
  }
  set(v) {
    if (Object.is(v, this.value)) return;
    this.value = v;
    for (const s of this.subs) s.invalidate();
  }
}

export function createRuntime() {
  const remotes = new Map();     // id -> { node, state }
  const serves = new Map();      // id -> fn(args) -> value
  const served = new Map();      // key -> { argCell, node }
  const pending = new Map();     // reqId -> { resolve }
  const provides = new Map();    // effect -> { op: fn }
  let seq = 0;
  let sendFn = () => {};
  let sid = "local";

  const R = {
    Node,
    Cell,

    /* ---------- values ---------- */

    v(x) {
      if (x == null) return x;
      if (x.__node) {
        const val = x.get();
        if (CURRENT) CURRENT.deps.add(x);
        return val;
      }
      if (x.__cell) {
        if (CURRENT) CURRENT.deps.add(x);
        return x.value;
      }
      if (x.__lazy) return x.fn();
      return x;
    },

    lazy(fn) { return { __lazy: true, fn }; },

    sig(fn) { return new Node(fn); },

    cell(init) { return new Cell(init); },

    get(x) {
      let v = x;
      let guard = 0;
      while (v && (v.__node || v.__lazy) && guard++ < 32) v = R.v(v);
      if (v && v.__cell) return R.v(v);
      return v;
    },

    set(cell, v) {
      let c = cell;
      let guard = 0;
      while (c && (c.__node || c.__lazy) && guard++ < 32) c = R.v(c);
      if (c && c.__cell) { c.set(v); return null; }
      throw new Error("flow: .set() called on a non-cell value");
    },

    /* ---------- data ---------- */

    ctor(tag, args) { return { $: tag, args: args ?? [] }; },

    eq(a, b) {
      if (Object.is(a, b)) return true;
      if (typeof a !== typeof b) return false;
      if (a == null || b == null) return false;
      if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => R.eq(x, b[i]));
      if (typeof a === "object") {
        if (a.$ !== undefined || b.$ !== undefined) {
          return a.$ === b.$ && R.eq(a.args ?? [], b.args ?? []);
        }
        const ka = Object.keys(a), kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        return ka.every((k) => R.eq(a[k], b[k]));
      }
      return false;
    },

    show(v) {
      if (v == null) return "";
      if (typeof v === "string") return v;
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      if (Array.isArray(v)) return "[" + v.map((x) => R.show(x)).join(", ") + "]";
      if (typeof v === "object") {
        if (v.$ !== undefined) {
          const a = v.args ?? [];
          return a.length ? `${v.$}(${a.map((x) => R.show(x)).join(", ")})` : v.$;
        }
        return "{ " + Object.entries(v).map(([k, x]) => `${k}: ${R.show(x)}`).join(", ") + " }";
      }
      if (typeof v === "function") return "<fn>";
      return String(v);
    },

    /**
     * `unsafe extern js fn …= "target"` — raw access to the host.
     *
     *   "Math.floor"  global path, called with its parent as receiver
     *   "@trim"       method on the first argument:      a.trim(b, …)
     *   "#length"     property of the first argument:    a.length
     *   "#index"      element of the first argument:     a[b]
     */
    ffiCall(target, args) {
      if (target[0] === "@") {
        const [recv, ...rest] = args;
        const m = recv == null ? undefined : recv[target.slice(1)];
        if (typeof m !== "function") throw new Error(`flow: FFI method '${target}' is not callable`);
        return m.apply(recv, rest);
      }
      if (target[0] === "#") {
        const [recv, ...rest] = args;
        if (recv == null) throw new Error(`flow: FFI target '${target}' on null`);
        return target === "#index" ? recv[rest[0]] : recv[target.slice(1)];
      }
      const parts = target.split(".");
      const name = parts.pop();
      let recv = globalThis;
      for (const p of parts) {
        recv = recv == null ? undefined : recv[p];
      }
      const fn = recv == null ? undefined : recv[name];
      // A dotted target may be a constant (`Math.PI`); a nullary binding reads it.
      if (typeof fn !== "function") {
        if (args.length === 0 && fn !== undefined) return fn;
        throw new Error(`flow: FFI target '${target}' is not a function`);
      }
      return fn.apply(recv, args);
    },

    ffiFn(target) {
      return (...args) => R.ffiCall(target, args);
    },

    /* ---------- effects ---------- */

    provide(effect, impl) {
      provides.set(effect, { ...(provides.get(effect) ?? {}), ...impl });
    },

    op(effect, name) {
      return (...args) => {
        const impl = provides.get(effect);
        const f = impl && impl[name];
        if (typeof f !== "function") {
          throw new Error(`flow: no handler for ${effect}.${name} on this side`);
        }
        return f(...args);
      };
    },

    /* ---------- transport ---------- */

    _attach(send, sessionId) {
      sendFn = send;
      if (sessionId) sid = sessionId;
    },

    _enter(sessionId) { sid = sessionId; },
    _sessionId() { return sid; },

    serve(id, fn) { serves.set(id, fn); },

    remote(id, depsThunk) {
      const existing = remotes.get(id);
      if (existing) return existing.node;
      const state = { value: undefined };
      const node = new Node(() => {
        const args = resolveArgs(depsThunk());
        sendFn({ t: "sub", id, args });
        return state.value;
      });
      remotes.set(id, { node, state });
      node.get();
      return node;
    },

    call(id, args) {
      return new Promise((resolve, reject) => {
        const reqId = ++seq;
        const timer = setTimeout(() => {
          if (pending.delete(reqId)) reject(new Error(`flow: remote call '${id}' timed out`));
        }, 20000);
        if (timer && typeof timer.unref === "function") timer.unref();
        pending.set(reqId, { resolve, reject, timer });
        sendFn({ t: "call", id, args: resolveArgs(args ?? {}), reqId });
      });
    },

    /** Inbound message dispatch. Both sides use the same implementation. */
    async _receive(msg, reply) {
      if (!msg || typeof msg !== "object") return;
      switch (msg.t) {
        case "sub": {
          const key = `${sid}:${msg.id}`;
          let s = served.get(key);
          if (!s) {
            const argCell = new Cell(msg.args ?? {});
            const fn = serves.get(msg.id);
            if (!fn) return;
            const node = new Node(() => fn(R.v(argCell)));
            node.watch((value) => sendFn({ t: "val", id: msg.id, value }));
            s = { argCell, node };
            served.set(key, s);
          }
          s.argCell.set(msg.args ?? {});
          sendFn({ t: "val", id: msg.id, value: await s.node.get() });
          return;
        }
        case "val": {
          const r = remotes.get(msg.id);
          if (!r) return;
          if (R.eq(r.state.value, msg.value)) return;
          r.state.value = msg.value;
          r.node.invalidate();
          return;
        }
        case "call": {
          const fn = serves.get(msg.id);
          if (!fn) { sendFn({ t: "ret", reqId: msg.reqId, error: `no such cut '${msg.id}'` }); return; }
          try {
            const value = await fn(msg.args ?? {});
            sendFn({ t: "ret", reqId: msg.reqId, value });
          } catch (e) {
            sendFn({ t: "ret", reqId: msg.reqId, error: String(e && e.message ? e.message : e) });
          }
          return;
        }
        case "ret": {
          const p = pending.get(msg.reqId);
          if (!p) return;
          pending.delete(msg.reqId);
          if (p.timer) clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.value);
          return;
        }
        default:
          if (reply) reply(msg);
      }
    },

    /* ---------- introspection ---------- */

    _stats() {      return { remotes: [...remotes.keys()], serves: [...serves.keys()], served: served.size };
    },
  };

  function resolveArgs(obj) {
    const out = {};
    // R.get dereferences nodes and cells to their current value *and* registers
    // them as dependencies of the enclosing node, so a change re-sends the sub.
    for (const [k, v] of Object.entries(obj ?? {})) out[k] = R.get(v);
    return out;
  }

  // The host surface reachable from `unsafe extern js` bindings.
  globalThis.__flow = {
    show: (x) => R.show(x),
    eq: (a, b) => R.eq(a, b),
    get: (x) => R.get(x),
    set: (x, v) => R.set(x, v),
    divInt: (a, b) => Math.trunc(a / b),
    host: {
      now: () => Date.now(),
      cell: (v) => R.cell(v),
      ctor: (tag, args) => R.ctor(tag, args),
    },
  };

  return R;
}

/* ------------------------------------------------------------------ */
/* host primitives                                                    */
/* ------------------------------------------------------------------ */
//
// The runtime no longer implements the capabilities. It exposes raw
// primitives, and std/prelude.flow provides Server, Client and Store on top of
// them through `unsafe extern js`.

/** Authority that only exists on a server process. */
export function installServerCapabilities(R, opts = {}) {
  const store = new Map(Object.entries(opts.store ?? {}));
  const routes = [];
  let notFound = null;
  let currentRequest = null;
  R._routes = () => routes;
  R._notFound = () => notFound;
  R._setRequest = (req) => { currentRequest = req; };

  const host = globalThis.__flow.host;
  host.secret = (name) =>
    opts.secrets && opts.secrets[name] != null ? String(opts.secrets[name]) : "";
  host.storeGet = (k) =>
    store.has(k) ? R.ctor("Some", [store.get(k)]) : R.ctor("None", []);
  host.storeSet = (k, v) => { store.set(k, v); return null; };
  host.log = (msg) => { (opts.log ?? console.log)(msg); return null; };

  // HTTP routing primitives used by std::http.
  host.route = (route) => { routes.push(route); return null; };
  host.routes = (list) => { for (const r of list ?? []) routes.push(r); return null; };
  host.notFound = (handler) => { notFound = handler; return null; };
  host.request = () => currentRequest ?? {
    method: "", path: "", query: "", body: "", headers: [], params: [],
  };
}

/** The client has no extra authority beyond the shared primitives. */
export function installClientCapabilities(_R) {
  // `Client` is provided by std/prelude.flow (state/now/log over __flow.host).
}

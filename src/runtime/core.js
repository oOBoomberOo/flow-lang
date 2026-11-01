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
  const pending = new Map();     // reqId -> { resolve, handlers }
  const pendingEffects = new Map(); // reqId -> resolve(effect answer)
  const handlerStack = [];       // { effect, ops } installed by algebraic handles
  const provides = new Map();    // effect -> { op: fn }
  let seq = 0;
  let sendFn = () => {};
  let sid = "local";

  /* ---------- remote cell handles ---------------------------------- */
  // A Cell never crosses as a value. It crosses as a handle: the owning side
  // keeps the real Cell, the other side gets a Cell-shaped proxy backed by
  // cell-sub/cell-val/cell-set messages. This is why a Cell can be created in
  // any local scope, on either tier, and still be read and written elsewhere.
  const cellRefs = new Map();     // handle id -> local Cell (owner side)
  const remoteCells = new Map();  // handle id -> proxy Cell (peer side)
  const cellWatches = new Map();  // `${sid}:${id}` -> Node watching the owner
  let cellSeq = 0;
  const cellPrefix = `c${Math.random().toString(36).slice(2, 8)}`;

  const plainObject = (v) => {
    if (!v || typeof v !== "object") return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  };

  const encodeCells = (v) => {
    if (v == null) return v;
    if (v.__cell) {
      let id = v.__remoteId;
      if (!id) {
        id = v.__refId;
        if (!id) {
          id = `${cellPrefix}${++cellSeq}`;
          Object.defineProperty(v, "__refId", { value: id, enumerable: false, configurable: true });
          cellRefs.set(id, v);
        }
      }
      return { __flowCell: id, value: encodeCells(v.value) };
    }
    if (Array.isArray(v)) return v.map(encodeCells);
    if (plainObject(v)) {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = encodeCells(x);
      return out;
    }
    return v;
  };

  const setRemoteValue = (cell, value) => {
    if (Object.is(cell.value, value)) return;
    cell.value = value;
    for (const s of cell.subs) s.invalidate();
  };

  const remoteCell = (id) => {
    let cell = remoteCells.get(id);
    if (cell) return cell;
    cell = new Cell(undefined);
    Object.defineProperty(cell, "__remoteId", { value: id, enumerable: false, configurable: true });
    cell.set = (value) => {
      if (Object.is(value, cell.value)) return;
      setRemoteValue(cell, value);
      sendMessage({ t: "cell-set", id, value });
    };
    remoteCells.set(id, cell);
    sendMessage({ t: "cell-sub", id });
    return cell;
  };

  const decodeCells = (v) => {
    if (v == null) return v;
    if (Array.isArray(v)) return v.map(decodeCells);
    if (typeof v === "object") {
      if (typeof v.__flowCell === "string") {
        const local = cellRefs.get(v.__flowCell);
        if (local) return local;
        const cell = remoteCell(v.__flowCell);
        if (v.value !== undefined) setRemoteValue(cell, decodeCells(v.value));
        return cell;
      }
      if (plainObject(v)) {
        const out = {};
        for (const [k, x] of Object.entries(v)) out[k] = decodeCells(x);
        return out;
      }
    }
    return v;
  };

  const sendMessage = (msg) => sendFn(msg);

  /** Send a cell notification to the session that subscribed, not whichever
   *  session happens to be current when a watcher fires later. */
  const sendAs = (owner, msg) => {
    const prev = sid;
    sid = owner ?? sid;
    try {
      sendMessage(msg);
    } finally {
      sid = prev;
    }
  };

  /**
   * Drive a cut body that may perform algebraic effects. A performed operation
   * is sent to the caller; the caller's handler replies resume/abort and the
   * generator continues. This is the same `yield` protocol as a local handle,
   * with the wire as the driver.
   */
  async function driveRemote(value, callReqId) {
    const it = value;
    if (!it || typeof it.next !== "function") return value;
    let step = it.next();
    while (!step.done) {
      const req = step.value;
      if (req && typeof req.then === "function") {
        step = it.next(await req);
        continue;
      }
      const provider = provides.get(req && req.effect);
      const impl = provider && provider[req.name];
      if (typeof impl === "function") {
        let v = impl(...((req && req.args) || []));
        if (v && typeof v.next === "function") v = await R.runAsync(v);
        else if (v && typeof v.then === "function") v = await v;
        step = it.next(v);
        continue;
      }
      const reqId = ++seq;
      const answer = new Promise((resolve) => pendingEffects.set(reqId, resolve));
      sendFn({
        t: "effect",
        reqId,
        call: callReqId,
        effect: req && req.effect,
        name: req && req.name,
        args: (req && req.args) || [],
      });
      const res = await answer;
      pendingEffects.delete(reqId);
      if (res.error) throw new Error(res.error);
      if (res.abort) {
        if (typeof it.return === "function") it.return(undefined);
        return res.value;
      }
      step = it.next(res.value);
    }
    return step.value;
  }

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
      if (typeof v === "boolean") return v ? "True" : "False";
      if (typeof v === "number") return String(v);
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

    /** Scoped capability handler: install `impl` for `effect` while `fn` runs. */
    withEffect(effect, impl, fn) {
      const prev = provides.get(effect);
      provides.set(effect, { ...(prev ?? {}), ...(impl ?? {}) });
      const restore = () => {
        if (prev) provides.set(effect, prev);
        else provides.delete(effect);
      };
      let result;
      try {
        result = fn();
      } catch (e) {
        restore();
        throw e;
      }
      if (result && typeof result.then === "function") return result.finally(restore);
      restore();
      return result;
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

    /* ---------- algebraic effects ---------- */

    /** A performed operation: a request that suspends the nearest handler. */
    perform(effect, name, args) {
      return { effect, name, args: args ?? [] };
    },

    /** Drive a generator (or plain value) to completion; unhandled operations throw. */
    /** Call a function that may be a generator; yield its effects if so. */
    *genCall(thunk) {
      const v = thunk();
      if (v && typeof v.next === "function") return yield* v;
      return v;
    },

    run(value) {
      const it = typeof value === "function" ? value() : value;
      if (!it || typeof it.next !== "function") return it;
      let input;
      for (;;) {
        const step = it.next(input);
        if (step.done) return step.value;
        const req = step.value ?? {};
        if (req && typeof req.then === "function") {
          throw new Error("flow: this computation waits on a boundary cut; drive it with runAsync");
        }
        const provider = provides.get(req.effect);
        const impl = provider && provider[req.name];
        if (typeof impl !== "function") {
          throw new Error(`flow: unhandled effect ${req.effect}.${req.name}`);
        }
        let v = impl(...(req.args ?? []));
        if (v && typeof v.next === "function") v = R.run(v);
        if (v && typeof v.then === "function") {
          throw new Error(`flow: provider ${req.effect}.${req.name} is asynchronous; drive it with runAsync`);
        }
        input = v;
      }
    },

    /**
     * Drive a handler body that may wait on a boundary cut. A cut inside a
     * generator is yielded as a Promise; await it and resume the generator, so
     * the handle (and its effect handlers) stays installed across the wire.
     */
    async runAsync(value) {
      const it = typeof value === "function" ? value() : value;
      if (!it || typeof it.next !== "function") {
        return it && typeof it.then === "function" ? await it : it;
      }
      let input;
      for (;;) {
        const step = it.next(input);
        if (step.done) {
          return step.value && typeof step.value.then === "function"
            ? await step.value
            : step.value;
        }
        const req = step.value;
        if (req && typeof req.then === "function") {
          input = await req;
          continue;
        }
        const provider = provides.get(req && req.effect);
        const impl = provider && provider[req.name];
        if (typeof impl !== "function") {
          throw new Error(`flow: unhandled effect ${req && req.effect}.${req && req.name}`);
        }
        let v = impl(...((req && req.args) || []));
        if (v && typeof v.next === "function") v = await R.runAsync(v);
        else if (v && typeof v.then === "function") v = await v;
        input = v;
      }
    },

    /**
     * Deep handler for an algebraic effect.
     *
     * The handled body is a generator. An operation it performs suspends there;
     * the handler operation receives the arguments plus `resume`, which drives
     * the rest of the body and returns its result. The handler's return value is
     * the result of the whole `handle` expression, so a handler that never
     * resumes aborts. Operations for other effects are forwarded outward.
     */
    *handle(effect, ops, body) {
      const entry = { effect, ops };
      handlerStack.push(entry);
      try {
        const gen = body();
        if (!gen || typeof gen.next !== "function") {
          if (gen && typeof gen.then === "function") return yield gen;
          return gen;
        }
        const invoke = function* (req) {
          const impl = ops && ops[req.name];
          if (typeof impl !== "function") throw new Error(`flow: no handler for ${effect}.${req.name}`);
          let used = false;
          const resume = function* (value) {
            if (used) throw new Error(`flow: resume for ${effect}.${req.name} called more than once (handlers are one-shot)`);
            used = true;
            return yield* drive(value, true);
          };
          return yield* impl(...req.args, resume);
        };
        const drive = function* (input, hasInput) {
          let step = hasInput ? gen.next(input) : gen.next();
          while (!step.done) {
            const req = step.value;
            if (!req || req.effect !== effect) {
              // A cut inside this handler is yielded as a Promise; the async
              // driver awaits it and resumes us. Effects from outer handlers
              // are forwarded the same way.
              const v = yield req;
              step = gen.next(v);
              continue;
            }
            return yield* invoke(req);
          }
          if (step.value && typeof step.value.then === "function") {
            return yield step.value;
          }
          return step.value;
        };
        return yield* drive(undefined, false);
      } finally {
        const i = handlerStack.lastIndexOf(entry);
        if (i >= 0) handlerStack.splice(i, 1);
      }
    },

    /** Scoped capability handler whose body performs algebraic effects. */
    *withEffectGen(effect, impl, fn) {
      const prev = provides.get(effect);
      provides.set(effect, { ...(prev ?? {}), ...(impl ?? {}) });
      try {
        return yield* fn();
      } finally {
        if (prev) provides.set(effect, prev);
        else provides.delete(effect);
      }
    },

    /* ---------- transport ---------- */

    _attach(send, sessionId) {
      sendFn = (msg) => send(encodeCells(msg));
      if (sessionId) sid = sessionId;
    },

    _enter(sessionId) { sid = sessionId; },
    _sessionId() { return sid; },

    serve(id, fn) { serves.set(id, fn); },

    remote(id, depsThunk, initial) {
      const existing = remotes.get(id);
      if (existing) return existing.node;
      const state = { value: initial };
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
        pending.set(reqId, { resolve, reject, timer, handlers: handlerStack.slice() });
        sendFn({ t: "call", id, args: resolveArgs(args ?? {}), reqId });
      });
    },

    /** Inbound message dispatch. Both sides use the same implementation. */
    async _receive(msg, reply) {
      if (!msg || typeof msg !== "object") return;
      msg = decodeCells(msg);
      switch (msg.t) {
        case "sub": {
          const key = `${sid}:${msg.id}`;
          // The watcher outlives this request, so remember which session
          // created the subscription. Otherwise an update triggered by client
          // A would be pushed to A for client B's subscription node too.
          const owner = sid;
          let s = served.get(key);
          if (!s) {
            const argCell = new Cell(msg.args ?? {});
            const fn = serves.get(msg.id);
            if (!fn) return;
            const node = new Node(() => fn(R.v(argCell)));
            node.watch((value) => sendAs(owner, { t: "val", id: msg.id, value }));
            s = { argCell, node };
            served.set(key, s);
          }
          s.argCell.set(msg.args ?? {});
          sendAs(owner, { t: "val", id: msg.id, value: await s.node.get() });
          return;
        }
        case "val": {
          const r = remotes.get(msg.id);
          if (!r) return;
          if (R.eq(r.state.value, msg.value)) return;
          r.state.value = msg.value;
          // The value itself changed. Publish it on the subscription node and
          // update dependents without invalidating the subscription, otherwise a
          // value-producing server cut would re-subscribe forever (and re-run
          // the server work on every reply).
          r.node.value = msg.value;
          for (const w of r.node.__watchers ?? []) w(msg.value);
          for (const s of r.node.subs ?? []) s.invalidate();
          return;
        }
        case "call": {
          const fn = serves.get(msg.id);
          if (!fn) { sendFn({ t: "ret", reqId: msg.reqId, error: `no such cut '${msg.id}'` }); return; }
          try {
            const value = await fn(msg.args ?? {});
            const result = await driveRemote(value, msg.reqId);
            sendFn({ t: "ret", reqId: msg.reqId, value: result });
          } catch (e) {
            sendFn({ t: "ret", reqId: msg.reqId, error: String(e && e.message ? e.message : e) });
          }
          return;
        }
        case "effect": {
          await R._remoteEffect(msg);
          return;
        }
        case "effect-ret": {
          const p = pendingEffects.get(msg.reqId);
          if (p) { pendingEffects.delete(msg.reqId); p({ value: msg.value }); }
          return;
        }
        case "effect-abort": {
          const p = pendingEffects.get(msg.reqId);
          if (p) { pendingEffects.delete(msg.reqId); p({ abort: true, value: msg.value }); }
          return;
        }
        case "effect-error": {
          const p = pendingEffects.get(msg.reqId);
          if (p) { pendingEffects.delete(msg.reqId); p({ error: msg.error }); }
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
        case "cell-sub": {
          const cell = cellRefs.get(msg.id);
          if (!cell) return;
          const owner = sid;
          const key = `${owner}:${msg.id}`;
          if (!cellWatches.has(key)) {
            const node = new Node(() => R.v(cell));
            node.watch((value) => sendAs(owner, { t: "cell-val", id: msg.id, value }));
            cellWatches.set(key, node);
          }
          const node = cellWatches.get(key);
          sendAs(owner, { t: "cell-val", id: msg.id, value: node.get() });
          return;
        }
        case "cell-set": {
          const cell = cellRefs.get(msg.id);
          if (cell) cell.set(msg.value);
          return;
        }
        case "cell-val": {
          const cell = remoteCells.get(msg.id);
          if (cell) setRemoteValue(cell, msg.value);
          return;
        }
        default:
          if (reply) reply(msg);
      }
    },

    /**
     * A cut on the other side performed an algebraic effect. Dispatch it to the
     * handler installed around the pending call. A handler that does not resume
     * aborts the remote computation and supplies the call's result.
     */
    async _remoteEffect(msg) {
      const call = pending.get(msg.call);
      const handlers = call?.handlers ?? [];
      let handler;
      for (let i = handlers.length - 1; i >= 0; i--) {
        if (handlers[i].effect === msg.effect) { handler = handlers[i]; break; }
      }
      if (!handler) {
        const provider = provides.get(msg.effect);
        const impl = provider && provider[msg.name];
        if (typeof impl === "function") {
          let value = impl(...(msg.args ?? []));
          if (value && typeof value.next === "function") value = await R.runAsync(value);
          else if (value && typeof value.then === "function") value = await value;
          sendFn({ t: "effect-ret", reqId: msg.reqId, value });
          return;
        }
        sendFn({ t: "effect-error", reqId: msg.reqId, error: `flow: unhandled effect ${msg.effect}.${msg.name}` });
        return;
      }
      let resumed = false;
      const resume = function* (value) {
        resumed = true;
        sendFn({ t: "effect-ret", reqId: msg.reqId, value });
        return undefined;
      };
      try {
        let result = handler.ops[msg.name](...(msg.args ?? []), resume);
        result = R.run(result);
        if (result && typeof result.then === "function") result = await result;
        if (!resumed) {
          if (call) {
            pending.delete(msg.call);
            if (call.timer) clearTimeout(call.timer);
            call.resolve(result);
          }
          sendFn({ t: "effect-abort", reqId: msg.reqId, value: result });
        }
      } catch (e) {
        sendFn({ t: "effect-error", reqId: msg.reqId, error: String(e && e.message ? e.message : e) });
      }
    },

    /* ---------- introspection ---------- */

    _stats() {      return { remotes: [...remotes.keys()], serves: [...serves.keys()], served: served.size };
    },
  };

  function resolveArgs(obj) {
    const out = {};
    // Dereference nodes, but keep a Cell as a Cell: it crosses as a handle.
    // Register both with the enclosing node so a change re-sends the sub.
    for (const [k, v] of Object.entries(obj ?? {})) {
      let x = v;
      let guard = 0;
      while (x && (x.__node || x.__lazy) && guard++ < 32) x = R.v(x);
      if (x && x.__cell && CURRENT) CURRENT.deps.add(x);
      out[k] = x;
    }
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
      // Dynamic access used by std::serialize. The compile-time TypeInfo is the
      // authority; these helpers only read/write the runtime representation.
      reflectField: (value, name) => (value == null ? undefined : value[String(name)]),
      reflectCtor: (value) => (value && typeof value === "object" && value.$ !== undefined ? String(value.$) : ""),
      reflectArgs: (value) => (value && typeof value === "object" && Array.isArray(value.args) ? value.args : []),
      reflectMake: (tag, args) => R.ctor(String(tag), args ?? []),
      reflectRecord: (pairs) => {
        const out = {};
        for (const pair of pairs ?? []) out[String(pair[0])] = pair[1];
        return out;
      },
      reflectList: (value) => (Array.isArray(value) ? value : []),
      reflectInt: (value) => value,
      reflectFloat: (value) => value,
      reflectStr: (value) => value,
      reflectBool: (value) => value,
      reflectCast: (value) => value,
      reflectFinite: (value) => Number.isFinite(value),
      jsonString: (value) => JSON.stringify(String(value)),
      /** Mutable box used by `std::ref` (neutral: works on client and server). */
      refNew: (init) => {
        let value = init;
        return {
          get: () => value,
          set: (next) => { value = next; return null; },
        };
      },
      /** Used by std::net on both sides; `fetch` exists in browsers and Node 18+. */
      netRequest: (method, url, headers, body, callback) => {
        const init = { method: String(method ?? "GET"), headers: {} };
        for (const pair of headers ?? []) {
          if (Array.isArray(pair) && pair.length >= 2) init.headers[String(pair[0])] = String(pair[1]);
        }
        if (body != null && String(body).length > 0) init.body = String(body);
        const done = (result) => {
          try { callback(result); }
          catch (e) { console.error("[flow] net callback error:", e); }
        };
        Promise.resolve()
          .then(() => fetch(String(url), init))
          .then(async (res) => done({ ok: res.ok, status: res.status, body: await res.text(), error: "" }))
          .catch((e) => done({ ok: false, status: 0, body: "", error: String(e && e.message ? e.message : e) }));
        return null;
      },
    },
  };

  installSharedHost();
  return R;
}

/** Host shims shared by both sides: text predicates, JSON, paths and dates. */
function installSharedHost() {
  const host = globalThis.__flow.host;
  // Small text predicates used by std/string. They live here because JavaScript
  // regular expressions cannot be expressed in the FFI target syntax.
  host.isDigit = (s) => /^[0-9]$/.test(String(s));
  host.isAlpha = (s) => /^[A-Za-z]$/.test(String(s));
  host.isAlphaNum = (s) => /^[A-Za-z0-9]$/.test(String(s));
  host.isSpace = (s) => /^\s$/.test(String(s));
  host.isUpper = (s) => /^[A-Z]$/.test(String(s));
  host.isLower = (s) => /^[a-z]$/.test(String(s));
  host.charUpper = (s) => String(s).toUpperCase();
  host.charLower = (s) => String(s).toLowerCase();
  host.strIndexOf = (haystack, needle) => String(haystack).indexOf(String(needle));
  host.strEndsWith = (s, suffix) => String(s).endsWith(String(suffix));
  host.strPadEnd = (s, n, fill) => String(s).padEnd(Number(n), String(fill ?? " "));
  host.strRepeat = (s, n) => String(s).repeat(Math.max(0, Number(n)));

  // JSON <-> the `Json` ADT of std/json. Decoding is a deep conversion so Flow
  // code can pattern match on the result.
  const toFlowJson = (v) => {
    if (v === null) return { $: "JNull", args: [] };
    if (typeof v === "boolean") return { $: "JBool", args: [v] };
    if (typeof v === "number") return { $: "JNum", args: [v] };
    if (typeof v === "string") return { $: "JStr", args: [v] };
    if (Array.isArray(v)) return { $: "JList", args: [v.map(toFlowJson)] };
    return { $: "JObject", args: [Object.entries(v).map(([k, x]) => [k, toFlowJson(x)])] };
  };

  // Walk a dotted path on a DOM event (`target.value`, `target.checked`, ...).
  // Only primitive leaves are returned; objects/nodes are not serialized.
  host.eventField = (event, path) => {
    let value = event;
    for (const part of String(path).split(".")) {
      if (value === null || value === undefined) return { $: "None", args: [] };
      value = value[part];
    }
    if (value === undefined) return { $: "None", args: [] };
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      return { $: "Some", args: [toFlowJson(value)] };
    }
    return { $: "None", args: [] };
  };
  // Environment and paths (std/env, std/path). Node-only values are undefined in
  // a browser, which is why std/env is annotated @server.
  const nodeProcess = typeof process !== "undefined" ? process : undefined;
  host.envGet = (key) => {
    const v = nodeProcess?.env?.[String(key)];
    return v === undefined || v === "" ? { $: "None", args: [] } : { $: "Some", args: [String(v)] };
  };
  host.envVars = () => Object.entries(nodeProcess?.env ?? {});
  host.envArgs = () => (nodeProcess?.argv ?? []).slice(2);
  host.envName = () => String(nodeProcess?.release?.name ?? "browser");
  host.envPlatform = () => String(nodeProcess?.platform ?? "browser");

  const slash = (p) => String(p).replace(/\\/g, "/");
  host.pathJoin = (parts) => parts.map(slash).filter((p) => p.length > 0)
    .join("/").replace(/\/+/g, "/").replace(/\/\.\//g, "/");
  host.pathBasename = (p) => slash(p).split("/").filter(Boolean).pop() ?? "";
  host.pathDirname = (p) => {
    const parts = slash(p).split("/");
    parts.pop();
    return parts.join("/") || ".";
  };
  host.pathExtension = (p) => {
    const base = host.pathBasename(p);
    const i = base.lastIndexOf(".");
    return i > 0 ? base.slice(i) : "";
  };
  host.pathNormalize = (p) => {
    const abs = slash(p).startsWith("/");
    const out = [];
    for (const part of slash(p).split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!abs) out.push(part); continue; }
      out.push(part);
    }
    return (abs ? "/" : "") + out.join("/") || ".";
  };
  host.pathIsAbsolute = (p) => /^([A-Za-z]:)?[\\/]/.test(String(p));
  host.pathSeparator = () => (nodeProcess?.platform === "win32" ? "\\" : "/");

  // std/time formatting (UTC, so client and server agree).
  const dateOf = (ms) => new Date(Number(ms));
  host.dateIso = (ms) => dateOf(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  host.datePart = (ms, what) => {
    const d = dateOf(ms);
    switch (String(what)) {
      case "year": return d.getUTCFullYear();
      case "monthNumber": return d.getUTCMonth() + 1;
      case "day": return d.getUTCDate();
      case "hour": return d.getUTCHours();
      case "minute": return d.getUTCMinutes();
      case "second": return d.getUTCSeconds();
      case "milli": return d.getUTCMilliseconds();
      default: return 0;
    }
  };
  host.dateWord = (ms, what) => {
    const d = dateOf(ms);
    if (String(what) === "weekday") return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()];
    return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][d.getUTCMonth()];
  };

  host.jsonParse = (text) => toFlowJson(JSON.parse(String(text)));
  host.jsonParseSafe = (text) => {
    try {
      return { $: "Some", args: [toFlowJson(JSON.parse(String(text)))] };
    } catch {
      return { $: "None", args: [] };
    }
  };

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

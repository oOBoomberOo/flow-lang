/**
 * Flow server runtime.
 *
 * The server is just the other half of the same dataflow graph: it registers the
 * cuts it owns with `R.serve`, and consumes client-owned cuts with `R.remote`.
 * Transport is one Server-Sent-Events stream down and one POST channel up.
 */

import fs from "node:fs";
import os from "node:os";
import { createRuntime, installServerCapabilities } from "./core.js";

export function createServerRuntime(opts = {}) {
  const R = createRuntime();
  installServerCapabilities(R, opts);
  installFsCapabilities(R);
  return R;
}

/** Node fs primitives used by std::fs; server-only. */
export function installFsCapabilities(R) {
  const host = globalThis.__flow.host;
  const p = (value) => String(value);
  host.fsReadText = (path) => fs.readFileSync(p(path), "utf8");
  host.fsTryReadText = (path) => {
    try {
      return R.ctor("Some", [fs.readFileSync(p(path), "utf8")]);
    } catch {
      return R.ctor("None", []);
    }
  };
  host.fsWriteText = (path, contents) => {
    fs.writeFileSync(p(path), String(contents), "utf8");
    return null;
  };
  host.fsAppendText = (path, contents) => {
    fs.appendFileSync(p(path), String(contents), "utf8");
    return null;
  };
  host.fsExists = (path) => fs.existsSync(p(path));
  host.fsListDir = (path) => fs.readdirSync(p(path)).map(String).sort();
  host.fsMakeDir = (path) => {
    fs.mkdirSync(p(path), { recursive: true });
    return null;
  };
  host.fsRemoveFile = (path) => {
    fs.rmSync(p(path), { force: true });
    return null;
  };
  host.fsRemoveDir = (path) => {
    fs.rmSync(p(path), { recursive: true, force: true });
    return null;
  };
  host.fsStat = (path) => {
    const s = fs.statSync(p(path));
    return { size: s.size, isDir: s.isDirectory(), modified: Math.trunc(s.mtimeMs) };
  };
  host.fsTmpDir = () => os.tmpdir();
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

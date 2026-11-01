/**
 * Flow DOM layer — turns the compiler's `R.el / R.text / R.hole` calls into a
 * live DOM whose dynamic parts are dependency-tracked nodes.
 */

export function installDom(R) {
  const Node = R.Node;

  function toNodes(v) {
    if (v == null || v === false) return [];
    if (typeof DocumentFragment !== "undefined" && v instanceof DocumentFragment) return [...v.childNodes];
    if (typeof window !== "undefined" && v instanceof window.Node) return [v];
    if (Array.isArray(v)) {
      // an empty list has no elements to render, whatever its element type
      if (v.length === 0) return [];
      // a list of markup renders as markup; a list of values renders structurally
      return v.some((x) => x && typeof x === "object" && "nodeType" in x)
        ? v.flatMap(toNodes)
        : [document.createTextNode(R.show(v))];
    }
    if (typeof v === "object") return [document.createTextNode(R.show(v))];
    return [document.createTextNode(String(v))];
  }

  function newElem(tag) {
    const e = document.createElement(tag);
    e.setAttribute("data-flow", "");
    return e;
  }

  /**
   * Run `compute` reactively; call `apply` with its value initially and on
   * change. A hole that has to ask the other tier returns a Promise; DOM
   * updates wait for it, so a server value can appear in markup.
   */
  function reactive(compute, apply) {
    const run = (v) => {
      if (v && typeof v.then === "function") {
        v.then(apply, (e) => console.error("[flow] async render failed", e));
      } else {
        apply(v);
      }
    };
    const n = new Node(compute);
    n.watch(run);
    run(n.get());
    return n;
  }

  /** A value, generator or promise from a boundary/effectful computation. */
  const force = (v) => {
    if (v && typeof v.next === "function") return R.runAsync(v);
    return R.v(v);
  };

  const D = {
    el(tag, attrs, children) {
      const e = newElem(tag);
      for (const [k, v] of Object.entries(attrs ?? {})) {
        if (k.startsWith("on:")) {
          const name = k.slice(3);
          e.addEventListener(name, (ev) => {
            try {
              const r = v(ev);
              if (r && typeof r.next === "function") R.runAsync(r).catch((x) => console.error("[flow] event failed", x));
              else if (r && typeof r.then === "function") r.catch((x) => console.error("[flow] event failed", x));
            } catch (x) {
              console.error("[flow] event failed", x);
            }
          });
          continue;
        }
        if (v && v.__attr) {
          reactive(() => force(v.fn()), (val) => setAttr(e, k, val));
          continue;
        }
        setAttr(e, k, v);
      }
      for (const c of children ?? []) {
        for (const n of toNodes(c)) e.appendChild(n);
      }
      return e;
    },

    text(s) { return document.createTextNode(String(s ?? "")); },

    /** A hole is a `span` with display:contents that hosts any value. */
    hole(thunk) {
      const host = newElem("flow-hole");
      host.style.display = "contents";
      reactive(() => force(thunk()), (v) => { host.replaceChildren(...toNodes(v)); });
      return host;
    },

    frag(children) {
      const f = document.createDocumentFragment();
      for (const c of children ?? []) for (const n of toNodes(c)) f.appendChild(n);
      return f;
    },

    attr(fn) { return { __attr: true, fn }; },

    mount(root, build) {
      const v = build();
      root.replaceChildren(...toNodes(v));
      return root;
    },

    /** Render a standalone Html value into a container. */
    render(root, value) { root.replaceChildren(...toNodes(value)); },

    _toNodes: toNodes,
  };

  Object.assign(R, D);
  return R;
}

function setAttr(e, name, val) {
  const tag = typeof e.tagName === "string" ? e.tagName.toUpperCase() : "";
  // `value` and `checked` are live DOM properties, not just attributes. Setting
  // the attribute leaves a user-edited control showing its old value (the
  // browser's dirty-value flag), so a reactive `draft := ""` would not clear
  // the input.
  const liveValue = name === "value"
    && (tag === "INPUT" || tag === "TEXTAREA" || tag === "PROGRESS" || tag === "METER");
  const liveChecked = name === "checked" && tag === "INPUT";
  const liveSelected = name === "selected" && tag === "OPTION";

  if (liveValue) {
    e.value = val == null || val === false ? "" : String(val);
    return;
  }
  if (liveChecked || liveSelected) {
    const on = val === true || (val != null && val !== false);
    if (liveChecked) e.checked = on;
    else e.selected = on;
    if (on) e.setAttribute(name, "");
    else e.removeAttribute(name);
    return;
  }
  if (val === true) e.setAttribute(name, "");
  else if (val === false || val == null) e.removeAttribute(name);
  else e.setAttribute(name, String(val));
}

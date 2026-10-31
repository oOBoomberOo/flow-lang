/** Shared helpers for the compiler tests. */

export const capSegment = (s) => s.split(/[-_]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");

/** `shapes/circle.flow` -> `Shapes.Circle` (the module name the path requires). */
export const moduleNameFor = (rel) =>
  rel.replace(/\.flow$/, "").split(/[\\/]/).map(capSegment).join(".");

/**
 * Test programs are written as files, and every file must declare its module.
 * Sources that already have a header are left alone.
 */
export function withModule(src, name = "Main") {
  return /^\s*module\s/m.test(src) ? src : `module ${name} where\n\n${src}`;
}

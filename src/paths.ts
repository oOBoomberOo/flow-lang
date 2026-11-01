/** Filesystem locations shared by the compiler, analysis and tooling. */

import path from "node:path";

export const REGISTRY_DIR = path.join(import.meta.dirname, "..", "registry");

/** The standard library is an ordinary registry package named `flow`. */
export const STD_PACKAGE_ROOT = path.join(REGISTRY_DIR, "packages", "flow", "1.0.0");
export const STDLIB_DIR = path.join(STD_PACKAGE_ROOT, "src");

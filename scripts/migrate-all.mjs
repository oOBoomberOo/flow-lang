// One-shot: rewrite every Flow source in the repository from the Rust-style syntax to the Haskell-style one.
import fs from "node:fs";
import path from "node:path";
import { migrateSource } from "../src/migrate.ts";

const root = path.resolve(import.meta.dirname, "..");
const jobs = [];
const add = (file, pkg) => jobs.push({ file: path.join(root, file), pkg });

for (const f of fs.readdirSync(path.join(root, "stdlib"))) if (f.endsWith(".flow") && f !== "builtins.flow") add(`stdlib/${f}`, "std");
for (const f of fs.readdirSync(path.join(root, "examples"))) if (f.endsWith(".flow")) add(`examples/${f}`, undefined);
for (const f of ["main", "util"]) add(`packages/demo/src/${f}.flow`, "demo");
add("packages/app/src/main.flow", "app");
add("registry/packages/flow-charts/1.0.0/src/bar.flow", "flow-charts");
add("registry/packages/flow-time/1.0.0/src/format.flow", "flow-time");
add("registry/packages/flow-time/1.2.0/src/format.flow", "flow-time");

for (const { file, pkg } of jobs) {
  if (!fs.existsSync(file)) { console.log("skip (missing)", path.relative(root, file)); continue; }
  const src = fs.readFileSync(file, "utf8");
  try {
    const out = migrateSource(src, file, { pkg });
    fs.writeFileSync(file, out);
    console.log("migrated", path.relative(root, file));
  } catch (e) {
    console.log("FAILED  ", path.relative(root, file), e.message, e.line ?? "");
  }
}

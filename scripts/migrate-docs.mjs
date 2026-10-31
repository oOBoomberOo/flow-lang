// Rewrite the ```flow examples in the docs into the Haskell-style syntax.
import fs from "node:fs";
import path from "node:path";
import { migrateSource } from "../src/migrate.ts";

const root = path.resolve(import.meta.dirname, "..");
const files = ["README.md", ...fs.readdirSync(path.join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];

let changed = 0;
for (const rel of files) {
  const file = path.join(root, rel);
  let src = fs.readFileSync(file, "utf8");
  let count = 0;
  src = src.replace(/```flow\n([\s\S]*?)```/g, (whole, body) => {
    // only migrate blocks that are complete declarations
    if (!/^\s*(fn|effect|type|trait|impl|provide|use|unsafe|extern)\b/m.test(body)) return whole;
    try {
      const out = migrateSource(body, "doc.flow", {}).trimEnd();
      count++;
      return "```flow\n" + out + "\n```";
    } catch {
      return whole;
    }
  });
  if (count) { fs.writeFileSync(file, src); changed += count; console.log(`${rel}: ${count} example(s)`); }
}
console.log("migrated", changed, "examples");

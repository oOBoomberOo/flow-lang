import fs from "node:fs";
import path from "node:path";
import { parse } from "./parser.ts";
import { Infer } from "./infer.ts";
import { Codegen } from "./codegen.ts";
import { Linker } from "./modules.ts";
import type { Program } from "./ast.ts";
import type { Module, Infer as InferType } from "./infer.ts";
import { FlowError } from "./lexer.ts";

export interface CompileResult {
  program: Program;
  mod: Module;
  infer: InferType;
  codegen: Codegen;
  client: string;
  server: string;
  diagnostics: string[];
  units: { id: string; file: string }[];
  display?: Map<string, string>;
}

function checkEntry(mod: Module, file: string) {
  const entry = mod.fns.get("main");
  if (!entry) throw new FlowError("a program must define `fn main() -> Html`", { file, code: "E_ENTRY" });
  if (entry.scheme.k === "fun") {
    const ret = entry.scheme.ret;
    const isHtml = ret.k === "con" && ret.name === "Html";
    if (!isHtml) {
      throw new FlowError(
        `\`main\` must return Html, but returns ${ret.k === "con" ? ret.name : ret.k}`,
        { file, code: "E_ENTRY" },
      );
    }
    if (entry.scheme.params.length !== 0) {
      throw new FlowError("`main` must take no parameters", { file, code: "E_ENTRY" });
    }
  }
}

export function compileProgram(program: Program, file: string, units: { id: string; file: string }[] = []): CompileResult {
  const infer = new Infer(file);
  const mod = infer.run(program);
  const codegen = new Codegen(mod, infer, program);
  const compiled = codegen.compile();
  checkEntry(mod, file);
  return {
    program, mod, infer, codegen,
    client: compiled.client, server: compiled.server,
    diagnostics: compiled.diagnostics, units,
  };
}

/** Single-file mode: no imports, used by tests and small examples. */
export function compileSource(src: string, file = "<input>"): CompileResult {
  return compileProgram(parse(src, file), file, [{ id: "main::main", file }]);
}

/** Package mode: load, link, then compile the flattened program. */
export function compileFile(file: string, opts: { overlay?: Map<string, string> } = {}): CompileResult {
  const linked = new Linker(opts).link(file);
  const result = compileProgram(linked.program, linked.entry.file, linked.units.map((u) => ({ id: u.id, file: u.file })));
  result.display = linked.display;
  return result;
}

void fs; void path;

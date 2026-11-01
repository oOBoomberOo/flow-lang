import fs from "node:fs";
import path from "node:path";
import { parse } from "./parser.ts";
import { Infer } from "./infer.ts";
import { Codegen } from "./codegen.ts";
import { Linker } from "./modules.ts";
import type { SymInfo } from "./modules.ts";
import type { Decl, Program } from "./ast.ts";
import type { Module, Infer as InferType } from "./infer.ts";
import type { Compiled } from "./codegen.ts";
import { FlowError } from "./lexer.ts";

export interface CompileOptions {
  /** keep going after type errors and report all of them (editor mode) */
  collectErrors?: boolean;
  /** require `main :: ()` (server startup) or `main :: Html` (CLI mode; libraries do not have one) */
  requireMain?: boolean;
  /** editor mode: recover from parse/link errors instead of throwing */
  recover?: boolean;
  /** editor mode: preload all std modules for path completion */
  allStd?: boolean;
}

export interface CompileResult {
  program: Program;
  mod: Module;
  infer: InferType;
  codegen?: Codegen;
  client: string;
  server: string;
  diagnostics: string[];
  errors: FlowError[];
  units: { id: string; file: string }[];
  display?: Map<string, string>;
  symbols?: Map<string, SymInfo>;
  importedByFile?: Map<string, Set<string>>;
}

function checkEntry(mod: Module, file: string) {
  const entry = mod.fns.get("main");
  if (!entry) {
    throw new FlowError(
      "a program must define `main :: ()` (server startup) or `main :: Html` (a single page)",
      { file, code: "E_ENTRY" },
    );
  }
  if (entry.scheme.k !== "fun") return;
  if (entry.scheme.params.length !== 0) {
    throw new FlowError("`main` must take no parameters", { file, code: "E_ENTRY" });
  }
  const ret = entry.scheme.ret;
  const name = ret.k === "con" ? ret.name : ret.k;
  if (ret.k === "con" && (ret.name === "Html" || ret.name === "Unit")) return;
  throw new FlowError(
    `\`main\` must return Html (a single client page) or () (server startup), but returns ${name}`,
    { file, code: "E_ENTRY" },
  );
}

export function compileProgram(
  program: Program,
  file: string,
  units: { id: string; file: string }[] = [],
  opts: CompileOptions = {},
): CompileResult {
  const infer = new Infer(file);
  const mod = infer.run(program);

  if (mod.errors.length && !opts.collectErrors) throw mod.errors[0];

  let codegen: Codegen | undefined;
  let compiled: Compiled = { client: "", server: "", cuts: [], diagnostics: [] };

  // Editor mode: a localized type error must not disable placement/cut analysis
  // for the rest of the file. Keep a Codegen instance even when checking failed
  // so hover, semantic tokens and inlay hints still get regions.
  if (!mod.errors.length || opts.collectErrors) {
    try {
      codegen = new Codegen(mod, infer, program);
      compiled = codegen.compile();
    } catch (e) {
      if (!opts.collectErrors || !(e instanceof FlowError)) throw e;
      if (!mod.errors.some((err) => err.message === (e as FlowError).message)) mod.errors.push(e as FlowError);
    }
    if (!mod.errors.length && opts.requireMain !== false) checkEntry(mod, file);
  }

  return {
    program, mod, infer, codegen,
    client: compiled.client,
    server: compiled.server,
    diagnostics: compiled.diagnostics,
    errors: mod.errors,
    units,
  };
}

/** A program that exists only in memory. It links exactly like a file, so
 *  `import List (map)` and `List.map` behave the same way they do on disk. */
export function compileSource(src: string, file = "input.flow", opts: CompileOptions = {}): CompileResult {
  const linked = new Linker({ recover: opts.recover, requireModule: false }).linkSource(src, file);
  const result = compileProgram(
    linked.program,
    linked.entry.file,
    linked.units.map((u) => ({ id: u.id, file: u.file })),
    opts,
  );
  if (linked.errors.length) {
    result.errors = [...linked.errors, ...result.errors];
    if (!opts.collectErrors) throw linked.errors[0];
  }
  result.display = linked.display;
  result.symbols = linked.symbols;
  result.importedByFile = linked.importedByFile;
  return result;
}

/** Package mode: load, link, then compile the flattened program. */
export function compileFile(
  file: string,
  opts: CompileOptions & { overlay?: Map<string, string> } = {},
): CompileResult {
  const linked = new Linker({
    overlay: opts.overlay,
    recover: opts.recover,
    allStd: opts.allStd,
  }).link(file);
  const result = compileProgram(
    linked.program,
    linked.entry.file,
    linked.units.map((u) => ({ id: u.id, file: u.file })),
    opts,
  );
  if (linked.errors.length) {
    result.errors = [...linked.errors, ...result.errors];
    if (!opts.collectErrors) throw linked.errors[0];
  }
  result.display = linked.display;
  result.symbols = linked.symbols;
  result.importedByFile = linked.importedByFile;
  return result;
}

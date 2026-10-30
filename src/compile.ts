import { parse } from "./parser.ts";
import { Infer } from "./infer.ts";
import { Codegen } from "./codegen.ts";
import { Linker } from "./modules.ts";
import type { SymInfo } from "./modules.ts";
import type { Program } from "./ast.ts";
import type { Module, Infer as InferType } from "./infer.ts";
import type { Compiled } from "./codegen.ts";
import { FlowError } from "./lexer.ts";

export interface CompileOptions {
  /** keep going after type errors and report all of them (editor mode) */
  collectErrors?: boolean;
  /** require `fn main() -> Html` (CLI mode; libraries do not have one) */
  requireMain?: boolean;
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
}

function checkEntry(mod: Module, file: string) {
  const entry = mod.fns.get("main");
  if (!entry) throw new FlowError("a program must define `fn main() -> Html`", { file, code: "E_ENTRY" });
  if (entry.scheme.k === "fun") {
    const ret = entry.scheme.ret;
    if (!(ret.k === "con" && ret.name === "Html")) {
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

  if (!mod.errors.length) {
    codegen = new Codegen(mod, infer, program);
    compiled = codegen.compile();
    if (opts.requireMain !== false) checkEntry(mod, file);
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

/** Single-file mode: no imports, used by tests and small examples. */
export function compileSource(src: string, file = "<input>", opts: CompileOptions = {}): CompileResult {
  return compileProgram(parse(src, file), file, [{ id: "main::main", file }], opts);
}

/** Package mode: load, link, then compile the flattened program. */
export function compileFile(
  file: string,
  opts: CompileOptions & { overlay?: Map<string, string> } = {},
): CompileResult {
  const linked = new Linker({ overlay: opts.overlay }).link(file);
  const result = compileProgram(
    linked.program,
    linked.entry.file,
    linked.units.map((u) => ({ id: u.id, file: u.file })),
    opts,
  );
  result.display = linked.display;
  result.symbols = linked.symbols;
  return result;
}

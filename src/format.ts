/**
 * Canonical Flow formatting.
 *
 * Shared by `flow fmt` and the language server so the editor and the CLI can
 * never disagree about what a formatted file looks like. Formatting is derived
 * from the AST, which is why lists, records, markup nesting and layout blocks
 * all indent consistently.
 */

import { parse } from "./parser.ts";
import { printProgram } from "./printer.ts";

export interface FormatOptions {
  /** Used when the source has no `module` header (the CLI's historical behaviour). */
  moduleName?: string;
  /** Return null instead of inventing a header or printing a broken program. */
  requireModule?: boolean;
}

/** `src/app/home-page.flow` -> `App.HomePage` for a default module name. */
export function moduleNameFromPath(file: string): string {
  const parts = file.split(/[\\/]/);
  const srcAt = parts.lastIndexOf("src");
  const rel = srcAt >= 0 ? parts.slice(srcAt + 1) : [parts[parts.length - 1]!];
  return rel
    .map((seg) => seg.replace(/\.flow$/, "").split(/[-_]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(""))
    .join(".");
}

/**
 * Format `src` as a Flow source file. Comments that sit directly above a
 * declaration are kept attached to it; the pretty printer owns the rest.
 */
export function formatSource(src: string, file: string, opts: FormatOptions = {}): string | null {
  const program = parse(src, file, { recover: true });
  if (opts.requireModule && (!program.module || (program.errors?.length ?? 0) > 0)) return null;

  const comments = new Map<number, string[]>();
  let pending: string[] = [];
  const declLines = new Set(program.decls.map((d) => d.span.line));
  src.split(/\r?\n/).forEach((text, i) => {
    const line = i + 1;
    if (/^\s*--/.test(text)) {
      pending.push(text.replace(/^\s*-- ?/, ""));
      return;
    }
    if (!text.trim()) return;
    if (declLines.has(line)) {
      if (pending.length) comments.set(line, pending);
      pending = [];
    } else if (/^\S/.test(text)) {
      pending = [];
    }
  });

  const moduleName = program.module?.join(".") ?? opts.moduleName ?? moduleNameFromPath(file);
  return printProgram(program, { moduleName, comments });
}

/**
 * A conservative fallback for a buffer that is mid-edit: never invent syntax,
 * never reorder declarations, only normalise trailing whitespace and the final
 * newline. Automatic indentation while typing is handled by the editor's
 * indentation rules and on-type formatting.
 */
export function tidyWhitespace(src: string): string {
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = src.split(/\r?\n/).map((line) => line.replace(/[ \t]+$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join(eol) + eol;
}

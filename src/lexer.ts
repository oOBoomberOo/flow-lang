/**
 * Flow — lexer.
 *
 * Produces a flat token stream with byte offsets into the original source so the
 * HTML parser can recover raw text nodes between markup.
 *
 * Grammar reference: docs/grammar.ebnf § 2 (Lexical grammar)
 */

export type TokenKind = "id" | "Con" | "num" | "float" | "str" | "kw" | "sym" | "eof";

export interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
  line: number;
  col: number;
}

export const KEYWORDS = new Set([
  "fn", "let", "mut", "if", "else", "match", "type", "trait", "impl",
  "effect", "provide", "with", "use", "extern", "unsafe", "html", "pub", "return", "handle",
  "algebraic",
  "for", "in", "true", "false", "and", "or", "not", "as",
]);

const MULTI = ["=>", "->", "==", "!=", "<=", ">=", "&&", "||", "..", "::"];
const SINGLE = "(){}[],;:.=!|@+-*/%<>?&^_";

export class FlowError extends Error {
  file?: string;
  line?: number;
  col?: number;
  code?: string;
  constructor(message: string, opts: { file?: string; line?: number; col?: number; code?: string } = {}) {
    super(message);
    this.name = "FlowError";
    this.file = opts.file;
    this.line = opts.line;
    this.col = opts.col;
    this.code = opts.code;
  }
  format(): string {
    const loc = this.file ? `${this.file}${this.line != null ? `:${this.line}:${this.col}` : ""}` : "";
    return `${loc ? loc + " — " : ""}${this.code ? `[${this.code}] ` : ""}${this.message}`;
  }
}

export function lex(src: string, file = "<input>"): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const fail = (msg: string): never => {
    throw new FlowError(msg, { file, line, col, code: "E_LEX" });
  };

  const push = (kind: TokenKind, value: string, start: number, startLine: number, startCol: number) => {
    toks.push({ kind, value, start, end: i, line: startLine, col: startCol });
  };

  while (i < src.length) {
    const c = src[i]!;

    // whitespace
    if (c === "\n") { i++; line++; col = 1; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; col++; continue; }

    // comments
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") { i++; col++; }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const startLine = line, startCol = col;
      i += 2; col += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") { line++; col = 1; } else { col++; }
        i++;
      }
      if (i >= src.length) { line = startLine; col = startCol; fail("unterminated block comment"); }
      i += 2; col += 2;
      continue;
    }

    const start = i, startLine = line, startCol = col;

    // strings
    if (c === '"') {
      i++; col++;
      let out = "";
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\n") fail("newline in string literal");
        if (src[i] === "\\") {
          const n = src[i + 1];
          out += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n === "0" ? "\0" : n === "\\" ? "\\" : n === '"' ? '"' : n;
          i += 2; col += 2;
        } else { out += src[i]; i++; col++; }
      }
      if (i >= src.length) fail("unterminated string literal");
      i++; col++;
      push("str", out, start, startLine, startCol);
      continue;
    }

    // numbers
    if (c >= "0" && c <= "9") {
      while (src[i] >= "0" && src[i] <= "9") { i++; col++; }
      if (src[i] === "." && src[i + 1] >= "0" && src[i + 1] <= "9") {
        i++; col++;
        while (src[i] >= "0" && src[i] <= "9") { i++; col++; }
        push("float", src.slice(start, i), start, startLine, startCol);
      } else {
        push("num", src.slice(start, i), start, startLine, startCol);
      }
      continue;
    }

    // identifiers / constructors / keywords
    if (/[A-Za-z_]/.test(c)) {
      while (i < src.length && /[A-Za-z0-9_']/.test(src[i]!)) { i++; col++; }
      const word = src.slice(start, i);
      if (KEYWORDS.has(word)) push("kw", word, start, startLine, startCol);
      else if (word[0] === word[0]!.toUpperCase() && word[0] !== "_") push("Con", word, start, startLine, startCol);
      else push("id", word, start, startLine, startCol);
      continue;
    }

    // multi-char symbols
    const three = src.slice(i, i + 2);
    if (MULTI.includes(three)) {
      i += 2; col += 2;
      push("sym", three, start, startLine, startCol);
      continue;
    }
    if (SINGLE.includes(c)) {
      i++; col++;
      push("sym", c, start, startLine, startCol);
      continue;
    }

    fail(`unexpected character ${JSON.stringify(c)}`);
  }

  toks.push({ kind: "eof", value: "<eof>", start: i, end: i, line, col });
  return toks;
}

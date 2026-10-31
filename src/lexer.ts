/**
 * Flow — lexer.
 *
 * Produces a flat token stream with byte offsets into the original source so the
 * markup parser can recover raw text nodes between tags. Every token also carries
 * the layout facts the parser needs for the offside rule: `bol` (first token on
 * its line) and whether it is surrounded by whitespace.
 *
 * Grammar reference: docs/grammar.ebnf § 2 (Lexical grammar)
 */

export type TokenKind = "id" | "Con" | "num" | "float" | "str" | "kw" | "op" | "sym" | "eof";

export interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
  line: number;
  col: number;
  /** first token on its line (candidate for a layout `;` or `}`) */
  bol: boolean;
  /** preceded / followed by whitespace (or the file edge) */
  spBefore: boolean;
  spAfter: boolean;
}

export const KEYWORDS = new Set([
  "module", "import", "as", "data", "type", "class", "instance", "where",
  "let", "in", "if", "then", "else", "case", "of", "do",
  "effect", "algebraic", "provide", "handle", "with", "for", "foreign",
]);

/** Characters that make up operators (Haskell's symbol characters). */
const OP_CHARS = "!#$%&*+./<=>?@^|-~:";
const SYM_CHARS = "()[]{},;`\\";

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

/**
 * Operator runs are lexed greedily, like Haskell, except around markup: `</`,
 * `/>`, `<>` and a `<` directly after `>` always start a new token so that
 * `</li><li>` and `<br/>` tokenize as tags.
 */
function splitRun(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("</", i) || s.startsWith("/>", i) || s.startsWith("<>", i)) {
      out.push(s.slice(i, i + 2));
      i += 2;
      continue;
    }
    let j = i + 1;
    while (
      j < s.length &&
      !(s[j] === "<" && s[j - 1] === ">") &&
      !s.startsWith("</", j) && !s.startsWith("/>", j) && !s.startsWith("<>", j)
    ) j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

export function lex(src: string, file = "<input>"): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let lastTokLine = 0;

  const fail = (msg: string): never => {
    throw new FlowError(msg, { file, line, col, code: "E_LEX" });
  };

  const isSpace = (c: string | undefined) => c === undefined || c === " " || c === "\t" || c === "\r" || c === "\n";

  const push = (kind: TokenKind, value: string, start: number, startLine: number, startCol: number) => {
    toks.push({
      kind, value, start, end: i, line: startLine, col: startCol,
      bol: startLine !== lastTokLine,
      spBefore: start === 0 || isSpace(src[start - 1]),
      spAfter: isSpace(src[i]),
    });
    lastTokLine = startLine;
  };

  while (i < src.length) {
    const c = src[i]!;

    if (c === "\n") { i++; line++; col = 1; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; col++; continue; }

    // block comment {- ... -} (nests)
    if (c === "{" && src[i + 1] === "-") {
      const startLine = line, startCol = col;
      let depth = 1;
      i += 2; col += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === "{" && src[i + 1] === "-") { depth++; i += 2; col += 2; continue; }
        if (src[i] === "-" && src[i + 1] === "}") { depth--; i += 2; col += 2; continue; }
        if (src[i] === "\n") { line++; col = 1; } else { col++; }
        i++;
      }
      if (depth > 0) { line = startLine; col = startCol; fail("unterminated block comment"); }
      continue;
    }

    // line comment: two or more dashes not followed by another symbol character
    if (c === "-" && src[i + 1] === "-") {
      let j = i;
      while (src[j] === "-") j++;
      if (j >= src.length || !OP_CHARS.includes(src[j]!)) {
        while (i < src.length && src[i] !== "\n") { i++; col++; }
        continue;
      }
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
      while (src[i] !== undefined && src[i]! >= "0" && src[i]! <= "9") { i++; col++; }
      if (src[i] === "." && src[i + 1] !== undefined && src[i + 1]! >= "0" && src[i + 1]! <= "9") {
        i++; col++;
        while (src[i] !== undefined && src[i]! >= "0" && src[i]! <= "9") { i++; col++; }
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
      else if (word[0]! >= "A" && word[0]! <= "Z") push("Con", word, start, startLine, startCol);
      else push("id", word, start, startLine, startCol);
      continue;
    }

    // punctuation that never combines
    if (SYM_CHARS.includes(c)) {
      i++; col++;
      push("sym", c, start, startLine, startCol);
      continue;
    }

    // operators
    if (OP_CHARS.includes(c)) {
      let j = i;
      while (j < src.length && OP_CHARS.includes(src[j]!)) j++;
      const run = src.slice(i, j);
      let off = i;
      for (const piece of splitRun(run)) {
        const tokStart = off;
        off += piece.length;
        const savedI = i;
        i = off;
        const sc = col + (tokStart - start);
        push("op", piece, tokStart, startLine, sc);
        i = savedI;
      }
      col += run.length;
      i = j;
      continue;
    }

    fail(`unexpected character ${JSON.stringify(c)}`);
  }

  toks.push({ kind: "eof", value: "<eof>", start: i, end: i, line, col, bol: true, spBefore: true, spAfter: true });
  return toks;
}

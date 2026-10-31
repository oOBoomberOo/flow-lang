import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSource } from "../src/compile.ts";

/**
 * Diagnostics must (a) exist when the program is wrong and (b) point at the
 * expression that is wrong, not at the enclosing function or block.
 */

function errorOf(src) {
  try {
    compileSource(src, "diag.flow");
  } catch (e) {
    return e;
  }
  assert.fail("expected a compile error");
}

// 1-based line/col of the first occurrence of `needle`.
function at(src, needle, offset = 0) {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i].indexOf(needle);
    if (c >= 0) return { line: i + 1, col: c + 1 + offset };
  }
  throw new Error(`missing ${needle}`);
}

test("diagnostics: a misspelled type name suggests the declaration", () => {
  const src = `data Colour = Red | Green

f :: () -> Colour
f () = Red

g :: () -> Colur
g () = f ()

main :: Html
main = <p>{str (g ())}</p>`;
  const e = errorOf(src);
  assert.match(e.message, /unknown type 'Colur'/);
  assert.match(e.message, /did you mean 'Colour'\?/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "Colur"));
});

test("diagnostics: a local signature without a binding is an error", () => {
  const src = `data Todo = Todo { id :: Int, title :: Str }

homePage :: List Todo -> Html
homePage todos = <p>{str (getLastId todos)}</p>
  where
    getLastid :: List Todo -> Int
    getLastId = List.fold Math.maxInt 0 . map (\\t -> t.id)

main :: Html
main = <p>{"x"}</p>`;
  const e = errorOf(src);
  assert.match(e.message, /the type signature for 'getLastid' lacks an accompanying binding/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "getLastid ::"));

  // Editor mode keeps the rest of the file: the binding still analyses.
  const r = compileSource(src, "diag.flow", { recover: true, collectErrors: true });
  assert.ok(r.errors.some((x) => /lacks an accompanying binding/.test(x.message)));
  assert.ok(r.program.decls.some((d) => d.k === "Fn" && d.name === "main"), "main survives the error");

  // A `let` statement is checked the same way.
  const doSrc = `main :: Html
main = do
  let f :: Int -> Int
  let g = 1
  <p>{str g}</p>`;
  const e2 = errorOf(doSrc);
  assert.match(e2.message, /the type signature for 'f' lacks an accompanying binding/);
  assert.deepEqual({ line: e2.line, col: e2.col }, at(doSrc, "f ::"));
});

test("diagnostics: a returned literal is checked against the declared return type", () => {
  const src = `f :: () -> Str
f () = 42

main :: Html
main = <p>{f ()}</p>`;
  const e = errorOf(src);
  assert.match(e.message, /return type mismatch in fn f: expected Str, got Int/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "42"));
});

test("diagnostics: a wrong return points at a multi-line tail expression", () => {
  const src = `f :: Bool -> Str
f flag = do
  let x = 1
  if flag then 1 else 2

main :: Html
main = <p>{f True}</p>`;
  const e = errorOf(src);
  assert.match(e.message, /return type mismatch in fn f: expected Str/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "if flag"));
});

test("diagnostics: a let annotation reports the value and both types", () => {
  const src = `main :: Html
main = do
  let
    n :: Str
    n = 42
  <p>{n}</p>`;
  const e = errorOf(src);
  assert.match(e.message, /'n' is annotated Str, but its value is Int/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "42"));
});

test("diagnostics: mismatched if branches point at the else branch", () => {
  const src = `f :: Bool -> Str
f flag = if flag then "yes" else 42

main :: Html
main = <p>{f True}</p>`;
  const e = errorOf(src);
  assert.match(e.message, /if branches have different types: then is Str, else is Int/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "42", 0));
});

test("diagnostics: a mismatched match arm points at that arm", () => {
  const src = `data C = A | B

f :: C -> Str
f c = case c of
  A -> "a"
  B -> 1

main :: Html
main = <p>{f A}</p>`;
  const e = errorOf(src);
  assert.match(e.message, /match arm returns Int, but the other arms return Str/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "B -> 1", 5));
});

test("diagnostics: a call argument mismatch points at the argument", () => {
  const src = `f :: Int -> Int
f n = n

main :: Html
main = <p>{str (f "no")}</p>`;
  const e = errorOf(src);
  assert.match(e.message, /type mismatch/);
  assert.match(e.message, /in argument 1/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, '"no"'));
});

test("diagnostics: an unknown effect label is rejected at the label", () => {
  const src = `f :: () -> Int ! Nope
f () = 1

main :: Html
main = <p>{str (f ())}</p>`;
  const e = errorOf(src);
  assert.match(e.message, /unknown effect 'Nope'/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "Nope"));
});

test("diagnostics: an unknown trait bound is rejected", () => {
  const src = `f :: Shwo a => a -> a
f x = x

main :: Html
main = <p>{"x"}</p>`;
  const e = errorOf(src);
  assert.match(e.message, /unknown trait 'Shwo' in the bounds of 'a'/);
  assert.equal(e.line, 1);
});

test("diagnostics: effect row variables are rejected", () => {
  const src = `f :: () -> Int ! {e}
f () = 1

main :: Html
main = <p>{str (f ())}</p>`;
  const e = errorOf(src);
  assert.match(e.message, /effect row variables are not supported/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "e}"));
});

test("diagnostics: a duplicate declaration is rejected", () => {
  const src = `f :: () -> Int
f () = 1

f :: () -> Int
f () = 2

main :: Html
main = <p>{str (f ())}</p>`;
  const e = errorOf(src);
  assert.match(e.message, /duplicate definition of 'f'/);
  assert.equal(e.line, 5);
});

test("diagnostics: duplicate record fields are rejected", () => {
  const typeDup = errorOf(`type R = { a :: Int, a :: Str }

main :: Html
main = <p>{"x"}</p>`);
  assert.match(typeDup.message, /duplicate field 'a' in record type R/);
  assert.deepEqual({ line: typeDup.line, col: typeDup.col }, at(`type R = { a :: Int, a :: Str }`, "Str"));

  const litSrc = `main :: Html
main = do
  let r = { a = 1, a = 2 }
  <p>{str r.a}</p>`;
  const litDup = errorOf(litSrc);
  assert.match(litDup.message, /duplicate field 'a' in record literal/);
  assert.deepEqual({ line: litDup.line, col: litDup.col }, at(litSrc, "2 }"));
});

test("diagnostics: builtin types check their type arguments", () => {
  const list = errorOf(`f :: List Int Str -> Int
f xs = len xs

main :: Html
main = <p>{str (f [1])}</p>`);
  assert.match(list.message, /type 'List' expects 1 type argument, got 2/);
  assert.deepEqual({ line: list.line, col: list.col }, at(`f :: List Int Str -> Int
f xs = len xs`, "List"));

  const event = errorOf(`f :: Event Int -> Int
f x = 1

main :: Html
main = <p>{str (f ())}</p>`);
  assert.match(event.message, /type 'Event' takes no type arguments/);
});

test("diagnostics: unknown types in unused declarations are reported", () => {
  const alias = errorOf(`type A = Nope

main :: Html
main = <p>{"x"}</p>`);
  assert.match(alias.message, /unknown type 'Nope'/);
  assert.deepEqual({ line: alias.line, col: alias.col }, at(`type A = Nope`, "Nope"));

  const record = errorOf(`type R = { a :: Nope }

main :: Html
main = <p>{"x"}</p>`);
  assert.match(record.message, /unknown type 'Nope'/);
});

test("diagnostics: a provide target is a real type", () => {
  const src = `effect E @ server where
  go :: () -> Int

provide E for Nope where
  go () = 1

main :: Html
main = <p>{str (E.go ())}</p>`;
  const e = errorOf(src);
  assert.match(e.message, /unknown type 'Nope'/);
  assert.deepEqual({ line: e.line, col: e.col }, at(src, "Nope"));
});

test("diagnostics: impls must implement exactly the trait's methods", () => {
  const extra = `class Show a where
  show :: a -> Str

instance Show Int where
  show x = str x
  bogus x = x

main :: Html
main = <p>{Show.show 1}</p>`;
  const e1 = errorOf(extra);
  assert.match(e1.message, /trait Show has no method 'bogus'/);
  assert.deepEqual({ line: e1.line, col: e1.col }, at(extra, "bogus x"));

  const missing = `class Show a where
  show :: a -> Str

instance Show Int where

main :: Html
main = <p>{Show.show 1}</p>`;
  const e2 = errorOf(missing);
  assert.match(e2.message, /impl Show for Int is missing method\(s\) show/);
  assert.equal(e2.line, 4);

  const unknown = `instance Nope Int where
  show x = "x"

main :: Html
main = <p>{"x"}</p>`;
  assert.match(errorOf(unknown).message, /impl for unknown trait 'Nope'/);
});

test("diagnostics: impl method signatures must match the trait", () => {
  const wrongReturn = `class Show a where
  show :: a -> Str

instance Show Int where
  show x = x

main :: Html
main = <p>{Show.show 1}</p>`;
  const e1 = errorOf(wrongReturn);
  // an untyped instance method takes its type from the class
  assert.match(e1.message, /return type mismatch in fn \$impl_Show_\d+_show: expected Str, got Int/);
  assert.equal(e1.line, 5);

  const wrongParam = `class Show a where
  show :: a -> Str

instance Show Int where
  show (x :: Str) = x

main :: Html
main = <p>{Show.show 1}</p>`;
  assert.match(errorOf(wrongParam).message, /impl Show\.show does not match the trait signature/);
});

test("diagnostics: duplicate impls and duplicate type parameters are rejected", () => {
  const dupImpl = `class Show a where
  show :: a -> Str

instance Show Int where
  show x = str x

instance Show Int where
  show x = str x

main :: Html
main = <p>{Show.show 1}</p>`;
  const e1 = errorOf(dupImpl);
  assert.match(e1.message, /duplicate impl of Show for Int/);
  assert.equal(e1.line, 7);

  const dupParam = `type R a a = { v :: a }

main :: Html
main = <p>{"x"}</p>`;
  assert.match(errorOf(dupParam).message, /duplicate type parameter 'a'/);
});

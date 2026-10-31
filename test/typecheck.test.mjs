import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSource } from "../src/compile.ts";

const ok = (src) => compileSource(src, "t.flow");
const bad = (src, re) => assert.throws(() => compileSource(src, "t.flow"), re);

const page = (body) => `fn main() -> Html { html { ${body} } }`;

/* ------------------------- types ------------------------- */

test("literals and arithmetic type-check", () => {
  ok(`main :: Html
main = <p>{1 + 2 * 3}</p>`);
});

test("string concatenation", () => {
  ok(`main :: Html
main = <p>{"a" + "b"}</p>`);
});

test("arithmetic on a string is a type error", () => {
  bad(`main :: Html
main = <p>{1 + "a"}</p>`, /right operand of '\+' \(left is Int\): expected Int, got Str/);
});

test("condition must be Bool", () => {
  bad(`main :: Html
main = <p>{if 1 then "a" else "b"}</p>`, /if condition/);
});

test("applying a non-function is rejected", () => {
  bad(`f :: () -> Int
f () = 1

main :: Html
main = <p>{f 1}</p>`, /expected 0 argument|argument/);
});

test("unbound names are rejected", () => {
  bad(`main :: Html
main = <p>{nope}</p>`, /unbound name 'nope'/);
});

test("an unbound serve points at the Http import", () => {
  bad(`main :: ()
main = serve (\\_ -> <p>{"x"}</p>)`, /import Http \(serve\)/);
});

/* ------------------------- ADTs ------------------------- */

test("exhaustive match on an ADT", () => {
  ok(`data Colour = Red | Green | Blue

name :: Colour -> Str
name c = case c of
  Red -> "red"
  Green -> "green"
  Blue -> "blue"

main :: Html
main = <p>{name Red}</p>`);
});

test("a single-constructor record ADT projects its fields", () => {
  const r = ok(`data Todo = Todo { id :: Int, title :: Str, completed :: Bool }

idOf :: Todo -> Int
idOf todo = todo.id

main :: Html
main = <p>{str (idOf (Todo { id = 1, title = "x", completed = False }))}</p>`);
  assert.match(r.client, /\.args\[0\]\.id/, "projection reads the constructor payload");
});

test("an inferred record projection upgrades to the annotated record ADT", () => {
  // The lambda parameter starts as an unresolved value; `.id` must not commit
  // it to an anonymous record before the declared `List Todo` arrives.
  const r = ok(`data Todo = Todo { id :: Int, title :: Str, completed :: Bool }

getLastId :: List Todo -> Int
getLastId = List.fold Math.maxInt 0 . map (\\t -> t.id)

ids :: List Todo -> List Int
ids = map (\\t -> t.id)

main :: Html
main = <p>{str (getLastId [])}{str (length (ids []))}</p>`);
  assert.match(r.client, /\.args\[0\]\.id/, "the projection reads the constructor payload");

  bad(`data Todo = Todo { id :: Int }

titles :: List Todo -> List Str
titles = map (\\t -> t.title)

main :: Html
main = <p>{str (length (titles []))}</p>`, /Todo has no field 'title'/);
});

test("a local projection infers from its annotated use site", () => {
  const r = ok(`data Todo = Todo { id :: Int, title :: Str }

homePage :: List Todo -> Html
homePage todos = <p>{str (lastId todos)}</p>
  where
    lastId = List.fold Math.maxInt 0 . map (\\t -> t.id)

main :: Html
main = <p>{"x"}</p>`);
  assert.match(r.client, /\.args\[0\]\.id/, "the local projection reads the payload");

  const r2 = ok(`data Todo = Todo { id :: Int, title :: Str }

homePage :: List Todo -> Html
homePage todos = <p>{str (lastId todos)}</p>
  where
    lastId :: List Todo -> Int
    lastId = List.fold Math.maxInt 0 . map (\\t -> t.id)

main :: Html
main = <p>{"x"}</p>`);
  assert.match(r2.client, /\.args\[0\]\.id/, "the annotated local projection reads the payload");
});

test("++ appends strings and lists in the emitted JavaScript", () => {
  const r = ok(`main :: Html
main = <p>{str ([1] ++ [2])}{"a" ++ "b"}</p>`);
  assert.match(r.client, /R\.ffiCall\("@concat", \[R\.v\(\[R\.v\(1\)\]\)/, "lists concatenate");
  assert.match(r.client, /\(R\.v\("a"\) \+ R\.v\("b"\)\)/, "strings use +");
  assert.doesNotMatch(r.client, /\+\+ R\.v/, "no JavaScript increment operator is emitted");
});

test("a record ADT keeps its identity through an if inside a lambda", () => {
  const r = ok(`data Todo = Todo { id :: Int, title :: Str, completed :: Bool }

toggleTodo :: Int -> List Todo -> List Todo
toggleTodo todoId = map \\t ->
  if t.id == todoId then
    Todo { completed = not t.completed, id = t.id, title = t.title }
  else
    t

main :: Html
main = <p>{str (length (toggleTodo 1 []))}</p>`);
  assert.match(r.client, /\.args\[0\]\.completed/, "both the projection and the branch use the payload");
});

test("a record pattern destructures a record ADT payload", () => {
  const r = ok(`data Todo = Todo { id :: Int, title :: Str }

idOf :: Todo -> Int
idOf t = case t of
  { id = n } -> n

main :: Html
main = <p>{str (idOf (Todo { id = 1, title = "x" }))}</p>`);
  assert.match(r.client, /\.args\[0\]\["id"\]/, "the pattern reads the constructor payload");

  bad(`data Todo = Todo { id :: Int }

titles :: Todo -> Str
titles t = case t of
  { title = s } -> s

main :: Html
main = <p>{"x"}</p>`, /Todo has no field 'title'/);

  // A field literal is refutable, so it does not cover the only constructor.
  bad(`data Todo = Todo { id :: Int }

first :: Todo -> Int
first t = case t of
  { id = 1 } -> 1

main :: Html
main = <p>{"x"}</p>`, /non-exhaustive match on Todo/);
});

test("projection rejects a missing field and a multi-constructor ADT", () => {
  bad(`data Todo = Todo { id :: Int }

titleOf :: Todo -> Str
titleOf todo = todo.title

main :: Html
main = <p>{"x"}</p>`, /Todo has no field 'title'/);

  bad(`data Shape = Circle Int | Rect Int Int

area :: Shape -> Int
area shape = shape.value

main :: Html
main = <p>{"x"}</p>`, /cannot project '.value' from Shape/);
});

test("non-exhaustive match is a type error", () => {
  bad(`data Colour = Red | Green | Blue

name :: Colour -> Str
name c = case c of
  Red -> "red"
  Green -> "green"

main :: Html
main = <p>{name Red}</p>`, /non-exhaustive match on Colour: missing Blue/);
});

test("match arms must agree on a type", () => {
  bad(`data C = A | B

f :: C -> Str
f c = case c of
  A -> "a"
  B -> 1

main :: Html
main = <p>{f A}</p>`, /match arm returns Int, but the other arms return Str/);
});

test("list patterns bind head and tail", () => {
  ok(`sum :: List Int -> Int
sum xs = case xs of
  [] -> 0
  x : rest -> x + sum rest

main :: Html
main = <p>{sum [1, 2, 3]}</p>`);
});

test("constructor arity is checked", () => {
  bad(`data Num = Nothing | Just Int

f :: Num -> Int
f o = case o of
  Nothing -> 0
  Just a b -> a

main :: Html
main = <p>{str (f Nothing)}</p>`, /expects 1 pattern argument/);
});

test("unknown type names are rejected", () => {
  bad(`type Colour = Red

f :: Colour -> Colour
f c = c

main :: Html
main = <p>{str (f 1)}</p>`, /unknown type 'Red'/);
});

test("aliases resolve", () => {
  ok(`type Id = Int

f :: Id -> Id
f x = x

main :: Html
main = <p>{f 1}</p>`);
});

/* ------------------------- traits ------------------------- */

test("trait dispatch resolves by type", () => {
  const r = ok(`class Show a where
  show :: a -> Str

instance Show Int where
  show x = "i"

instance Show Str where
  show x = "s"

main :: Html
main = <p>{Show.show 1 + Show.show "x"}</p>`);
  assert.equal(r.diagnostics.length, 0);
});

test("missing instance is a type error", () => {
  bad(`class Show a where
  show :: a -> Str

main :: Html
main = <p>{Show.show 1}</p>`, /no instance of Show for Int/);
});

test("generic instances match any element", () => {
  ok(`data Box a = Box a

class Show a where
  show :: a -> Str

instance Show (List a) a where
  show xs = "list"

main :: Html
main = <p>{Show.show [1, 2, 3]}</p>`);
});

/* ------------------------- effects ------------------------- */

test("declared effect row must cover inferred effects", () => {
  bad(`effect Clock where
  tick :: () -> Int

provide Clock where
  tick () = 7

f :: () -> Int ! {}
f () = Clock.tick ()

main :: Html
main = <p>{str (f ())}</p>`, /unhandled effect\(s\) \{Clock\}/);
});

test("effect operations require a declared effect", () => {
  ok(`effect Clock where
  tick :: () -> Int

provide Clock where
  tick () = 7

main :: Html
main = <p>{Clock.tick ()}</p>`);
});

test("provider signature is checked", () => {
  bad(`effect Clock where
  tick :: () -> Int

provide Clock where
  tick () = "no"

main :: Html
main = <p>{Clock.tick ()}</p>`, /does not match its signature/);
});

/* ------------------------- placement ------------------------- */

test("a pure program is single-tier", () => {
  const r = ok(`main :: Html
main = <p>{"hi"}</p>`);
  assert.equal(r.diagnostics.length, 0);
});

test("client state never crosses", () => {
  const r = ok(`
main :: Html
main = do
  let n = Client.state 0
  <div>{if n.get () > 0 then <b>{"hot"}</b> else <i>{"cold"}</i>}</div>`);
  assert.equal(r.diagnostics.length, 0);
});

test("server authority creates a server-side cut", () => {
  const r = ok(`
main :: Html
main = <p>{str (Server.now ())}</p>`);
  assert.equal(r.diagnostics.length, 1);
  assert.match(r.diagnostics[0], /server-side block/);
  assert.match(r.server, /R\.serve\("cut1"/);
  assert.match(r.client, /R\.remote\("cut1"/);
});

test("client code calling a server op inside an if keeps the if on the client", () => {
  const r = ok(`
main :: Html
main = do
  let on = Client.state False
  <div>{if on.get () then <p>{str (Server.now ())}</p> else <p>{"no"}</p>}</div>`);
  assert.equal(r.diagnostics.length, 1, "exactly the secret is cut out");
  assert.match(r.client, /\$impl_CellOps_\d+_get/); // condition stays on the client
  assert.match(r.client, /__flow\.get/);            // Cell.get is std code over the FFI
  assert.match(r.server, /R\.serve\("cut1"/);    // branch body is served
});

test("server code can consume a client value (uplink)", () => {
  const r = ok(`
main :: Html
main = <p>{Server.now () - Client.now ()}</p>`);
  assert.equal(r.diagnostics.length, 2);
  assert.ok(r.diagnostics.some((d) => /client-side block/.test(d)));
  assert.match(r.client, /R\.serve/);
  assert.match(r.server, /R\.remote/);
});

test("server value used in client arithmetic is cut only once", () => {
  const r = ok(`
main :: Html
main = do
  let t = Server.now ()
  <p>{"a"} {t}</p>`);
  assert.equal(r.diagnostics.length, 1);
});

test("an inferred parameter only requires the fields its body reads", () => {
  ok(`total = \\user -> user.age + user.score

main :: Html
main = <p>{str (total { name = "Ada", age = 36, score = 1 })}</p>`);
});

test("a right section fills the trailing parameter", () => {
  ok(`import Option

render :: Option (Int, Int) -> Option Int
render = map \\(a, b) -> a + b

main :: Html
main = <p>{str (render (Some (1, 2)))}</p>`);
});

test("diagnostics name unresolved variables a, b instead of compiler ids", () => {
  bad(`import Option

main :: Html
main = <p>{str (map (\\x -> x) (\\y -> y))}</p>`, /Functor\.map argument 2: expected a b, got a -> a/);
});

test("a record argument must still supply every field the callee reads", () => {
  bad(`total = \\user -> user.age + user.score

main :: Html
main = <p>{str (total { age = 36 })}</p>`, /record mismatch|missing/);
});

test("a non-serializable value cannot cross", () => {
  bad(`
main :: Html
main = do
  let f = \\(x :: Int) -> x
  <p>{Server.log (str f)}</p>`, /cannot cross the boundary|functions are not serializable/);
});

/* ------------------------- html ------------------------- */

test("components take a record and render", () => {
  ok(`Card :: { title :: Str, children :: Html } -> Html
Card props =
  <section>
    <h2>{props.title}</h2>
    {props.children}
  </section>

main :: Html
main =
  <Card title={"t"}>
    <p>{"body"}</p>
  </Card>`);
});

test("boolean HTML attributes take Bool", () => {
  ok(`main :: Html
main = <div><input type="checkbox" checked={True} disabled={False} /></div>`);
  bad(`main :: Html
main = <input checked={"yes"} />`, /attribute 'checked'/);
});

test("event handlers project DOM fields", () => {
  const r = ok(`main :: Html
main = <input onSubmit={\\(e :: Event) ->
  let title = e.target.value in
  let done = e.target.checked in
  let key = e.key in
  let _ = title + key in
  ()} />`);
  assert.match(r.client, /target\)\.value/, "target.value is read from the event");
  assert.match(r.client, /target\)\.checked/, "target.checked is read from the event");
  bad(`main :: Html
main = <input onSubmit={\\(e :: Event) -> let x = e.nope in ()} />`, /Event has no field 'nope'/);
});

test("event handlers must take an Event", () => {
  bad(`main :: Html
main = <button onClick={\\(x :: Int) -> 1}>{"x"}</button>`, /event handler 'onClick': expected Event -> Unit, got Int -> Int/);
});

test("adt values in html holes render structurally", () => {
  const r = ok(`data Weird = W Int

main :: Html
main = <p>{W 1}</p>`);
  assert.match(r.client, /R\.ctor\("W"/);
});

/* ------------------------- placement annotations ------------------------- */

test("placement annotations: matching signatures are accepted", () => {
  ok(`view :: () -> Html @client
view () = <p>{"x"}</p>

needClient :: (Str @client) -> Str
needClient x = x

needServer :: (Str @server) -> Str
needServer x = x

main :: Html
main = do
  let c = Client.state "x"
  let a = needClient (c.get ())
  let b = needServer (str (Server.now ()))
  let
    lit :: Str @client
    lit = "hi"
  <div>
    {view ()}
    <p>{a} {b} {lit}</p>
  </div>`);
});

test("placement annotations: a client return cannot be server-placed", () => {
  bad(`bad :: () -> Int @client
bad () = Server.now ()

main :: Html
main = <p>{str (bad ())}</p>
`, /placement mismatch: fn bad is annotated @client, but is placed server/);
});

test("placement annotations: a server return cannot be client-placed", () => {
  bad(`bad :: () -> Html @server
bad () = <p>{"x"}</p>

main :: Html
main = <p>{str 1}</p>
`, /placement mismatch: fn bad is annotated @server, but is placed client/);
});

test("placement annotations: call arguments must match annotated parameters", () => {
  bad(`need :: (Str @server) -> Str
need x = x

main :: Html
main = do
  <p>{need (str (Client.now ()))}</p>
`, /placement mismatch: argument 1 to need is annotated @server, but is placed client/);
});

test("placement annotations: let bindings are checked", () => {
  bad(`main :: Html
main = do
  let
    x :: Str @server
    x = str (Client.now ())
  <p>{x}</p>
`, /placement mismatch: 'x' is annotated @server, but is placed client/);
});

test("effect rows are per-instantiation, so one server callback does not poison others", () => {
  const r = ok(`call :: (Int -> Int) -> Int -> Int
call g x = g x

serverUse :: () -> Int
serverUse () = call (\\(n :: Int) -> Server.now ()) 1

clientUse :: () -> Int
clientUse () = do
  let pure = \\(n :: Int) -> n + 1
  let ignored = call pure 2
  pure 3 + ignored

main :: Html
main = <p>{str (clientUse ())}</p>
`);
  const call = r.mod.fns.get("call");
  const clientUse = r.mod.fns.get("clientUse");
  assert.deepEqual([...call.scheme.eff.labels], [], "call is not forced Server");
  assert.deepEqual([...clientUse.scheme.eff.labels], [], "clientUse is not forced Server");
  assert.equal(r.codegen.home(call.body), "neutral");
  assert.equal(r.codegen.home(clientUse.body), "neutral");
  const pureCall = [...r.mod.info.entries()].find(
    ([n]) => n.k === "App" && n.fn.k === "Var" && n.fn.name === "pure",
  );
  assert.ok(pureCall, "pure(3) node exists");
  assert.equal(pureCall[1].place, "neutral", "pure(3) stays neutral");
});

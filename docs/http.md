# HTTP capabilities and routing

`std::http` adds **effect capabilities** for the current request and for route
registration. They are ordinary Flow effects with providers; the host only
supplies the raw request and route primitives. This is why `Request` and
`Router` are declared with `effect`, not as a special HTTP runtime type.

## The request capability

```flow
pub effect Request @ server {
  fn current() -> RequestObject
}
```

`RequestObject` is a record:

```flow
pub type RequestObject = {
  method: Str,
  path: Str,
  query: Str,
  body: Str,
  headers: List<(Str, Str)>,
  params: List<(Str, Str)>,
}
```

A handler receives the object as its argument, and `Request.current()` reaches
the same object anywhere deeper in the server-side call stack:

```flow
get("/whoami", fn(_req: RequestObject) -> Response {
  let req = Request.current();
  textResponse(req.method + " " + req.path)
})
```

Helpers: `queryParam(req, name)`, `pathParam(req, name)` and
`header(req, name)`; `pathParam` reads the captures from a `:name` route.

## The routing capability

```flow
pub effect Router @ server {
  fn mount(routes: List<Route>) -> Unit
  fn notFound(handler: Handler) -> Unit
}
```

```flow
pub type Handler = (RequestObject) -> Response
pub type Route = { method: Str, path: Str, handler: Handler }
```

`Router.mount` and `Router.notFound` are effect operations. Their provider in
`std::http` forwards the values to the host, which stores them for startup.

## Easy routing

A program opts into HTTP routing by declaring and exporting `fn routes()`.
The host calls it once after loading the server bundle:

```flow
use std::http::{
  get, post, Router, Request, RequestObject, Response,
  textResponse, htmlResponse, jsonResponse, queryParam, pathParam,
  notFoundResponse,
}

fn routes() -> Unit {
  Router.mount([
    get("/", fn(req: RequestObject) -> Response {
      let who = match queryParam(req, "name") { Some(n) => n, None => "world" };
      htmlResponse("<h1>Hello " + who + "</h1>")
    }),
    post("/echo", fn(req: RequestObject) -> Response { textResponse(req.body) }),
    get("/users/:id", fn(req: RequestObject) -> Response {
      match pathParam(req, "id") {
        Some(id) => textResponse("user " + id),
        None => notFoundResponse("missing id"),
      }
    }),
  ]);
  Router.notFound(fn(req: RequestObject) -> Response {
    notFoundResponse("no route for " + req.path)
  });
}

fn main() -> Html { html { <p>{"client app"}</p> } }
```

The route constructors are `get`, `post`, `put`, `patch`, `del` and the
explicit `route(method, path, handler)`. Paths may contain `:name` captures;
matching is method + path, with query/body/headers left to the handler.

## Responses

```flow
pub type Response = {
  status: Int,
  contentType: Str,
  headers: List<(Str, Str)>,
  body: Str,
}
```

Helpers: `textResponse`, `htmlResponse`, `jsonResponse`, `withStatus`,
`withHeader`, `redirect` and `notFoundResponse`. The host sets the status,
`content-type`, additional headers and body from this record.

## The capability handler

`std::http::handle(routes, request)` is a reusable, in-language dispatcher over
a route list. It is the pure capability handler used for tests and for code that
wants to dispatch a request value without the host:

```flow
let response = handle(routes, request);
```

The host uses the same `Route` values for real requests; it adds path captures
and the request capability.

## Host behavior

* `routes()` is exported from the server bundle and called at startup.
* Routes are checked before the app shell; a route for `/` overrides the shell.
* `/app.js`, `/runtime/*` and `/__flow/*` remain reserved for the client bundle,
  the runtime and the dataflow transport.
* Unmatched requests go to the `notFound` handler when one is mounted; otherwise
  the normal shell/static handling and a final `404` apply.
* Route handlers are server-side: they return a `Response`, not `Html`.

See also [`examples/http.flow`](../examples/http.flow) and
[`test/http.test.mjs`](../test/http.test.mjs).

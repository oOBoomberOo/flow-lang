# Web apps: startup, pages and server responses

A Flow web program has two entry points, split by placement:

```flow
main :: ()          -- runs once on the server, at startup
serve handler       -- runs in the browser, once per request
```

`main` is where server-side setup belongs (files, environment, the store). `serve`
takes a **client-placed** callback `Request -> Html`; the host sends the shell for
every page request and the callback decides what to render. Server work inside a
page is an ordinary cut.

```flow
import Http (RequestObject, serve)
import Prelude (Store)

main :: ()
main = do
  Store.set "visits" "0"
  serve (\request -> <h1>{"Hello from " + request.path}</h1>)
```

`main :: Html` is still accepted as the single-page form: it mounts that page in
the browser and does not run on the server. New programs use `main :: ()` plus
`serve`.

## The request

The handler receives the real request:

```flow
type RequestObject = {
  method: Str,
  path: Str,
  query: Str,
  body: Str,
  headers: List<(Str, Str)>,
  params: List<(Str, Str)>,
}
```

The host reads the body before serving the shell, so a `POST` page sees
`request.method` and `request.body`. Helpers: `queryParam(req, name)`,
`pathParam(req, name)` and `header(req, name)`. `pathParam` reads the captures
that `matchPage` filled in.

## Routing pages

Pages are values, so a route table is an ordinary list:

```flow
import Http (RequestObject, PageRoute, serve, page, matchPage, pathParam)

pages :: List PageRoute
pages =
  [ page "/" home
  , page "/about" about
  , page "/users/:id" user
  ]

home :: RequestObject -> Html
home _ = <h1>{"Home"}</h1>

about :: RequestObject -> Html
about _ = <h1>{"About"}</h1>

user :: RequestObject -> Html
user request =
  case pathParam request "id" of
    Some id -> <h1>{"User " + id}</h1>
    None -> <h1>{"Missing id"}</h1>

main :: ()
main = serve (\request ->
  case matchPage pages request of
    Some (matched, view) -> view matched
    None -> <h1>{"Not found"}</h1>)
```

`page` is `GET`; `pagePost`, `pagePut`, `pagePatch` and `pageDelete` set the
method. `matchPage` checks the method and the `:name` path captures, then returns
the page with `request.params` filled in. `matchPath pattern path` is the pure
matcher if you want to route by hand.

The handler is a normal client callback, so it can use cells, events and
components:

```flow
main :: ()
main = serve (\_ ->
  let count = Client.state 0
  <div>
    <button onClick={\e -> count := count.value + 1}>{"+1"}</button>
    <p>{str count.value}</p>
  </div>)
```

A handler cannot close over `main`'s local bindings: it is compiled into the
browser bundle. Put server values behind a top-level server function or the
`Store` capability and call it from the handler; that call becomes a cut.

## Server responses

`routes()` and the `Router` capability remain the server-side response table. Use
them for JSON, redirects, custom status codes and APIs:

```flow
import Http (RequestObject, get, post, Router, jsonResponse, textResponse)

routes :: () -> ()
routes () =
  Router.mount
    [ get "/api/health" (\_ -> jsonResponse "{\"ok\":true}")
    , post "/api/echo" (\request -> textResponse request.body)
    ]

main :: ()
main = do
  -- server-side setup
  serve (\request -> <h1>{"site"}</h1>)
```

Routes are matched before the page shell. A path with no route falls through to
the page handler, so `/api/...` and page URLs can live in the same program.

`Response` is the raw server response:

```flow
type Response = {
  status: Int,
  contentType: Str,
  headers: List<(Str, Str)>,
  body: Str,
}
```

Helpers: `textResponse`, `htmlResponse`, `jsonResponse`, `withStatus`,
`withHeader`, `redirect` and `notFoundResponse`. `dispatch(routes, request)` is
the reusable in-language dispatcher.

## Host behavior

* `main :: ()` is exported as `__flow_entry` and called once, before the server
  starts listening. If it throws, startup fails loudly.
* `routes()` is called after `main`, so it can read state `main` initialised.
* When a program calls `serve`, every non-reserved request gets the shell with
  the real request payload; the browser renders the page. Page routes answer
  `200 text/html`; use `routes()` when the status or `content-type` matters.
* `/app.js`, `/runtime/*`, `/modules/*` and `/__flow/*` stay reserved.
* `main :: Html` (no `serve`) keeps the old single-page behavior: only `/` and
  `/index.html` get the shell, and unknown paths are `404`.
* `serve` can be called once. Routing belongs inside its handler.

See [`examples/web.flow`](../examples/web.flow) for a multi-page app and
[`examples/http.flow`](../examples/http.flow) for server response routes.

# Web apps: startup, pages and server responses

A Flow web program has one startup hook and one plain-data app object:

```flow
main :: ()      -- runs once on the server, at startup
serve app       -- supplies the browser pages and the server routes
```

`main` is where server-side setup belongs (files, environment, the store).
`app` is a normal record:

```flow
type AppConfig = { page :: Page, routes :: List Route }
```

`page` is a **client** callback `Request -> Html`; it is mounted in the browser.
`routes` is a plain `List Route` of **server** response handlers. Both are
ordinary typed Flow values split by the compiler — there is no separate HTML
server.

There are three typed entry points; each is an ordinary function with a real
signature, so wrong values are rejected by the type checker:

```flow
serve     :: AppConfig -> () @server   -- the full app object
servePage :: Page -> () @server        -- a browser-only page
serveApi  :: List Route -> () @server  -- a server-only API
```

```flow
import Flow.Http (RequestObject, serve, get, jsonResponse)

main :: ()
main = serve
  { page = \request -> <h1>{"Hello from " + request.path}</h1>
  , routes = [ get "/api/health" (\_ -> jsonResponse "{\"ok\":true}") ]
  }
```

The object may be written inline or as a top-level constant so the compiler can split its fields. Server
route handlers may use state `main` initialised; the page handler may not capture
`main`'s locals because it runs in the browser.

`main :: Html` is still accepted as the single-page form: it mounts that page in
the browser and does not run on the server.

## The request

Both page and route handlers receive the real request:

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

Pages are values, so a page table is an ordinary list:

```flow
import Flow.Http (RequestObject, PageRoute, page, matchPage, pathParam, servePage)

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
main = servePage (\request ->
  case matchPage pages request of
    Some (matched, view) -> view matched
    None -> <h1>{"Not found"}</h1>)
```

`page` is `GET`; `pagePost`, `pagePut`, `pagePatch` and `pageDelete` set the
method. `matchPage` checks the method and the `:name` path captures, then returns
the page with `request.params` filled in. `matchPath pattern path` is the pure
matcher if you want to route by hand.

The page handler is a normal client callback, so it can use cells, events and
components:

```flow
import Flow.Http (servePage)

main :: ()
main = servePage (\_ ->
  let count = Client.state 0
  <div>
    <button onClick={\e -> count := count.value + 1}>{"+1"}</button>
    <p>{str count.value}</p>
  </div>)
```

A page handler cannot close over `main`'s local bindings: it is compiled into
the browser bundle. Put server values behind a top-level server function or the
`Store` capability and call it from the handler; that call becomes a cut.

## Server routes

Put server responses in the same app object:

```flow
import Flow.Http (RequestObject, serve, get, post, jsonResponse, textResponse)

main :: ()
main = serve
  { page = \request -> <h1>{"site"}</h1>
  , routes =
      [ get "/api/health" (\_ -> jsonResponse "{\"ok\":true}")
      , post "/api/echo" (\request -> textResponse request.body)
      ]
  }
```

`routes` is just data. `get`, `post`, `put`, `patch`, `del` and `route` build
`Route` records; the host registers them once at startup because `main` runs on
the server. Routes are matched before the page shell, so `/api/...` and page URLs
can live in the same program. A route handler can use server startup state:

```flow
main :: ()
main = do
  let secret = "from-main"
  serve
    { page = \_ -> <h1>{"site"}</h1>
    , routes = [ get "/api/secret" (\_ -> textResponse secret) ]
    }
```

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

### API-only apps

`serveApi` takes the route list directly; it gets no browser page:

```flow
import Flow.Http (serveApi, get, textResponse)

main :: ()
main = serveApi [ get "/api" (\_ -> textResponse "ok") ]
```

## Legacy entries

Before the app object, `serve` took a page callback and a top-level `routes()`
function was called by the host:

```flow
serve (\request -> …)           -- old page-only form; use servePage now
routes () = Router.mount [ … ]  -- deprecated server route table
```

The bare `serve handler` form is no longer accepted because `serve` is typed as
`AppConfig -> ()`; use `servePage` for a page-only app. A `routes()` function is
still called after `main` for existing programs, but new code should pass
`routes` inside the app object; no `Router.mount` is needed.

## Host behavior

* `main :: ()` is exported as `__flow_entry` and called once, before the server
  starts listening. If it throws, startup fails loudly.
* `serve` registers the plain `routes` data during `main`; the host reads the
  route table after startup. A legacy `routes()` is called after `main` too.
* When the app has a `page`, every non-reserved request gets the shell with the
  real request payload; the browser renders the page. Page responses answer
  `200 text/html`; server `routes` control status and `content-type`.
* An API-only app (`serveApi`) does not take over page URLs.
* `/app.js`, `/runtime/*`, `/modules/*` and `/__flow/*` stay reserved.
* `main :: Html` (no `serve`) keeps the old single-page behavior: only `/` and
  `/index.html` get the shell, and unknown paths are `404`.
* `serve` can be called once.

See [`examples/web.flow`](../examples/web.flow) for a multi-page app with a
server API route, and [`examples/http.flow`](../examples/http.flow) for the
legacy server route / request capability API.

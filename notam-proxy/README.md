# notam-proxy

A single-file Cloudflare Worker behind the Loxodrome SPA's network
features. It started as a CORS bridge to the
[autorouter NOTAM API](https://www.autorouter.aero/wiki/api/) (which
sends no CORS headers, so a static GitHub-Pages site can't call it
directly) and now also serves live METAR / TAF weather from the NOAA Aviation
Weather Center, and route NOTAMs from the French SIA's
[SOFIA-Briefing](https://sofia-briefing.aviation-civile.gouv.fr/)
service, precipitation radar composites from the EUMETNET OPERA open-data
cache, and the SIA's Atlas VAC plates. The weather, radar and plate routes
are validated relays plus the right CORS headers; `/sofia` additionally performs a small server-side
session handshake (an anonymous cookie that never reaches the browser);
`/notam` is authenticated server-side (below).

**autorouter is authenticated at the application level.** A single
credential is held as a Worker secret (`AR_CLIENT_ID` / `AR_CLIENT_SECRET`)
and exchanged server-side for a bearer token, injected on each `/notam`
request. End-users supply no autorouter account, and the credential never
reaches the browser. Autorouter allows an account 20 simultaneously valid
tokens and each one lives a week, so that token is shared by every isolate
through a KV namespace; see [The shared token](#the-shared-token).

**Flood protection.** Because all users draw on one autorouter quota, and
the SOFIA upstream is a fragile government service, the worker applies a
per-IP rate limit (per route class), an aggregate per-route upstream
ceiling, and a short (~60 s) response cache to `/notam` and `/sofia` (the
weather, radar and plate routes keep their own edge caches). Every upstream fetch carries
a timeout so a hung upstream can't pin requests open.

## Prerequisites

1. **An autorouter application credential.** Autorouter grants API access
   per application via a support ticket
   ([autorouter.aero/support](https://www.autorouter.aero/support)); you
   receive a credential used with the OAuth2 `client_credentials` grant (a
   dedicated service-account email + password, or a registered-app
   `client_id` + secret). This is the ONE credential the worker holds; end
   users need no autorouter account.
2. A [Cloudflare](https://workers.cloudflare.com/) account. The canonical
   deploy runs on the Workers Paid plan, whose CPU and request allowances
   the relay's limits below are set against.

## Deploy

The worker is one file (`worker.js`) with no dependencies.

### Option A: copy/paste in the dashboard

1. Cloudflare → Workers & Pages → **Create** → **Hello World** worker.
2. Pick a name (e.g. `notam-proxy`).
3. Replace the default code with the contents of `worker.js`.
4. Set the autorouter credential as **secrets** (Settings → Variables →
   add `AR_CLIENT_ID` and `AR_CLIENT_SECRET`, both encrypted).
5. Create a KV namespace (Storage & Databases → KV → **Create**) and bind
   it to the worker as `AR_TOKEN_KV` (Settings → Bindings). Without it the
   worker runs, but mints one autorouter token per isolate; see
   [The shared token](#the-shared-token).
6. **Save and deploy**. Copy the resulting URL,
   `https://<name>.<account>.workers.dev`.
7. Point the SPA at it: build with `VITE_NOTAM_PROXY_URL=<url>`, or for
   a quick test set the DevTools override
   `localStorage.setItem('loxodrome:autorouter-proxy', '<url>')`.

The canonical deploy is not addressed that way: it answers on
**`https://proxy.loxodrome.fr`**, a custom domain on the site's own zone,
which is the address the app ships with. The `workers.dev` hostname stays on
beside it because installed Android builds carry it baked in and cannot be
repointed remotely.

### Option B: via wrangler

```sh
npm i -g wrangler
wrangler secret put AR_CLIENT_ID
wrangler secret put AR_CLIENT_SECRET
wrangler kv namespace create AR_TOKEN_KV   # once; paste the id in wrangler.toml
wrangler deploy
```

`wrangler.toml` in this directory carries the name, compatibility date, the
custom domain and the KV binding; bump `compatibility_date` when redeploying
after a long gap. The domain is declared as

```toml
[[routes]]
pattern = "proxy.loxodrome.fr"
custom_domain = true
```

and `custom_domain = true` is what creates the DNS record and provisions the
TLS certificate, so the first deploy after adding it is also what puts the
name on the air. `workers_dev = true` must stay ABOVE that block: a bare key
written after a table header belongs to the table, not to the file. The autorouter credential lives in **secrets**, never in
`wrangler.toml` (the KV namespace id is not a credential and does belong
there). For `wrangler dev`, put `AR_CLIENT_ID` / `AR_CLIENT_SECRET` in a
gitignored `.dev.vars` file in this directory; the token store is then a
local namespace persisted under `.wrangler/state`, so dev restarts reuse
their own token instead of spending the shared account's.

## Configure allowed origins

The worker only forwards requests from origins it recognises. The
deployed configuration (`ALLOW_ORIGINS` in `wrangler.toml`) is:

- `https://loxodrome.fr` and `https://www.loxodrome.fr` (the public site)
- `https://notam-viewer.net` (the NOTAM Viewer's own address, masked onto
  `https://loxodrome.fr/notam/` by `notam-viewer-net/`. The mask keeps the
  address in the bar, so this really is the Origin a briefing fetch presents
  and the entry is load-bearing: remove it and the viewer can fetch nothing
  from its primary address)
- `http://localhost:5173` and `http://localhost:5174` (Vite dev)
- `http://192.168.1.25:5173` and `http://192.168.1.25:5174` (the same dev
  servers reached from a phone on the LAN, for the device passes; plain
  http, so they carry no production traffic)
- `https://localhost` (the Capacitor Android app: its WebView serves the
  bundled app from that origin, `androidScheme https`, no port)

With `ALLOW_ORIGINS` unset, the worker falls back to the same list without
the two LAN dev origins (`DEFAULT_ALLOW_ORIGINS` in `worker.js`).

To override, set the worker environment variable `ALLOW_ORIGINS` to a
comma-separated list. Dashboard → your worker → **Settings** →
**Variables** → add `ALLOW_ORIGINS` = `https://my-fork.example.com`.

Requests with an `Origin` header outside the allow-list get `403`. The
preflight (`OPTIONS`) is answered locally and never reaches autorouter.

## What it forwards, what it doesn't

| Path                          | Method | Forwarded to                                    |
|-------------------------------|--------|-------------------------------------------------|
| `/notam`                      | GET    | `https://api.autorouter.aero/v1.0/notam<query>` (the worker injects the application bearer token; any client `Authorization` is ignored. Per-IP rate limited + ~60 s response cache keyed on the full normalized query, the now-anchored validity epochs bucketed to the TTL) |
| `/wx/metar`, `/wx/taf`        | GET    | `https://aviationweather.gov/api/data/` (whitelisted query surface: short `ids` list or a bounded `bbox`; `format=json` forced); edge-cached 60 s on the normalised URL, handed to the client `no-store` |
| `/wx/isigmet`, `/wx/airsigmet`| GET    | `https://aviationweather.gov/api/data/` (global decoded SIGMET feeds; no params); edge-cached 60 s, handed to the client `no-store` |
| `/sofia`                      | POST   | `https://sofia-briefing.aviation-civile.gouv.fr/sofia` (French SIA route NOTAMs; the worker first GETs `…/homepage.html` for an anonymous `JSESSIONID`, then POSTs the client's briefing body with the `Origin` / `Referer` / `Cookie` / `X-Requested-With` headers a browser can't set. Reuses a `JSESSIONID` passed as `?session=` instead of the homepage GET, validated against the JSESSIONID charset before it rides the upstream `Cookie` header. Per-IP rate limited + ~60 s response cache keyed on the raw body) |
| `/sofia/session`              | GET    | returns `{ "session": "<JSESSIONID>" }` from a homepage GET, so a multi-route briefing can fetch one anonymous session and reuse it across its per-route `/sofia` POSTs (one handshake, not one per route) |
| `/opera/frames`               | GET    | one or two `list-type=2` listings of `https://s3.waw3-1.cloudferro.com/openradar-24h` (the EUMETNET OPERA composites' anonymous 24-hour cache, which sends no CORS header): the frames of the last `hours` (1 to 6) of one product (DBZH / RATE) as `{ product, frames: [{ t, bytes, publishedAt }], now }`, single-flighted, edge-cached 60 s and handed to the client `no-store` (the zone's Browser Cache TTL rewrote a cached answer's `max-age` to 14 400 s on the way out until 2026-09-20, and a browser holding the list for four hours never saw another frame; the rule stands, see "The browser's cache"), each listing followed through S3's continuation tokens (a page is 1000 keys, a day of the bucket 960; five pages at most, logged past that), an 8 s timeout a page and 15 s for the whole listing, every page of every day it touches, answering 504 past it, the page the deadline cuts short included, and never a list the deadline cut short (the client's own index budget is 20 s; a day longer than five pages is the one partial list, answered as listed and logged), a key dated past the relay's own clock (beyond the minute of slack the frame route allows) not listed, a 200 that is not a ListBucketResult refused uncached and logged (it would have become an empty list every reader shared for a minute), the SERVE time stamped per request in `x-opera-now` (the body's `now` is the listing's instant, up to the edge's minute earlier on a hit). Its own `radar` limiter class |
| `/opera/<slot>/<product>.tiff` | GET   | one composite frame, `?tiles=3,4,11` (ascending unique indices under the product's tile count, 72 for DBZH on the 1 km grid and 20 for RATE on the 2 km one, no leading zero, nothing else): the object is fetched WHOLE once per data centre (single-flighted per object; refused above 16 MB, a declared length before the body is read and an undeclared one the moment the running count passes it) and cached at the edge for a day (a Content-Length-bearing 200 under `/opera/obj/<version>/<slot>/<product>`), its IFD0 walked (the one fixed-format parse here, since tile offsets differ per frame, and the CLIENT'S guard field for field, `src/lib/files/tiff.ts` `isOperaLayout`: the grid, two Float32 samples, zlib, no predictor, no strips, the tie point and pixel scale of the product's own cell; the fields it needs must lie inside the 8 192-byte head the client is handed, every tile inside the object), and the answer is the head followed by the named tiles, `private, immutable`. A HIT is cut from two RANGED reads of the stored object, the head and the tiles' span, each placed by the Content-Range the cache states (one stating no total, or a head not at byte 0, answers 503), never the object whole (25 slice requests in a second, a pan at the two-hour loop, must not hold 3.5 MB each in one isolate); `x-opera-read` says how the answer was read (`origin`, `range`, or `whole` when the cache answered a Range with a 200, read once and logged `cache-whole-read`, which must stay rare). A refused put is logged `cache-put-failed` and the slice served regardless; the bucket's own 403 / 5xx / redirect is logged `upstream-status`. The slot must lie on the product's cadence inside the last 24 h. A 404 (not yet published) passes through uncached; a TIFF that is not the product's own composite layout (a 1 km frame under RATE, a directory past the head, float tile tables), or an object past the size bound, answers 502, and the edge REMEMBERS the refusal for an hour under `/opera/refused/<version>/<slot>/<product>` rather than pulling the object whole again for every reader and every client's minute retry; anything else under a 200 (an error page, an empty body) answers 502 and is not remembered. Bytes are held in one per-isolate memory budget (48 MB: a leader's object twice through its download and the put, the put taking its own copy; a hit's span and its answer while it reads and cuts), waiting a turn at most 8 s past it and answering 503 with `Retry-After: 5` then, since the request limits count requests and not bytes: 36 misses of distinct frames at once held 128 MB, the isolate's whole memory. A share comes back once the answer is BUILT, never when a reader has taken it (the runtime neither reads to its end nor cancels the body of a client that has gone), and a miss's readers cut their answers from the object in hand without queueing |
| `/sofia/chart`                | GET    | `https://aviation.meteo.fr/FR/aviation/affiche_image.php` (the TEMSI / WINTEM PDFs the SOFIA chart catalog links, for the printed flight dossier; the upstream URL is rebuilt from exactly three validated query params (`login` token, `layer`, `echeance`), never from a client URL, redirects refused, response streamed `no-store`, nothing cached or rehosted; its own aggregate `chart` upstream ceiling) |
| `/sia/vac/<cycle>/<plate>`    | GET    | `https://www.sia.aviation-civile.gouv.fr/media/dvd/` (one Atlas VAC plate, `/sia/vac/06_AUG_2026/AD-2.LFPL.pdf`: the path carries the AIRAC cycle segment and the plate name and nothing else, both on charsets that cannot express a traversal, the product directory derived rather than passed, the upstream base fixed; the SIA answers a missing file with an HTML page under a 200, so a non-PDF answer is refused and logged; edge-cached a year and immutable, a new cycle being a new path; its own `vac` limiter class and upstream ceiling) |
| anything else                 | any    | `404`                                           |

On `/notam` the worker exchanges its `AR_CLIENT_ID` / `AR_CLIENT_SECRET`
secrets for a bearer token (shared across isolates, refreshed on expiry or
a 401), injects it, and copies the upstream body and status back (a success
memoized ~60 s). No autorouter credential ever reaches the browser. The
`/sofia` route is the other stateful one: it fetches an anonymous
`JSESSIONID` from the SIA homepage and replays it (with the browser-
forbidden `Origin` / `Referer` / `X-Requested-With` headers) on the
briefing POST, so no cookie is ever set on, or read from, the browser. The
client builds the SOFIA form body
(`:operation=postNarrowRoutePibRequest&route[]=…`); the worker forwards it
verbatim (capped at 8 KB, enforced before buffering: a declared or measured
oversize body is rejected `413` without ever being materialised) and
returns the JSON (memoized ~60 s, keyed on the raw body). To
brief several routes at once the client first GETs `/sofia/session` for one
anonymous `JSESSIONID` and passes it on each `/sofia` POST as `?session=`,
so the homepage handshake runs once instead of once per route; the
round-tripped value is validated against the JSESSIONID charset (`400`
otherwise), so no extra cookie pairs can be smuggled into the upstream
`Cookie` header.

**Redeploy after changing this file.** The worker is deployed by hand
(see above); a new route, or a change to the auth / rate-limit / cache
behaviour, is inert until you redeploy.

## The shared token

Autorouter allows an account **20 simultaneously valid** tokens from the
`client_credentials` grant, publishes no revoke endpoint, and asks a client not
to request a new token while it holds one
([wiki/api/authentication](https://www.autorouter.aero/wiki/api/authentication/)).

**Read the lifetime off `expires_in`, and do not trust the wiki's "one hour
presently".** Measured 2026-07-31, a real token came back with
`expires_in: 604800` - a **week**. That is the difference between a wasted
token costing an hour and costing seven days, and it is what turned a
per-isolate cache into a multi-day outage: twenty abandoned tokens held the
account at its cap for 39 hours, with no revoke endpoint, until autorouter
support cleared them by hand. Their guidance afterwards was exactly the design
below: keep the token, reuse it until it expires, and only request another
when a call comes back 401.

A module-global cache in a Worker is **per isolate**, so caching the token
there alone mints one per cold start (a new colo, an idle eviction, a
deploy, a `wrangler dev` restart), and an evicted isolate's token keeps its
slot for the rest of its hour. That reaches the cap, and the token endpoint
then answers `403 toomanytokens` to everyone until slots age out; because
each freed slot is taken by the next cold isolate, it does not clear on its
own under steady traffic.

So the token lives in the `AR_TOKEN_KV` namespace under the key
`autorouter-token`, and the module global is the memo in front of it:

1. **memo** — the isolate's own copy, while it is unexpired;
2. **store** — the entry another isolate published, adopted as-is;
3. **mint** — the exchange, published to the store for everyone else.

A 401 resolves *past* the token that failed rather than flushing the cache,
so a token already replaced elsewhere is adopted instead of spending a
second slot. KV is eventually consistent (a colo remembers a miss for
~60 s), so a few colos can still each mint one around a refresh; that is a
handful an hour against the cap of 20, instead of one per cold start. The
store fails **open**: no binding, a missing entry or a KV outage falls
through to a mint, which is what the worker did before it had one.

## Rate limits and caching

Two flood-protection tiers, both a module-global sliding window (so
best-effort **per isolate**, not a hard cross-edge guarantee):

1. **Per-IP** rate limit per route class (`RATE_LIMITS` in `worker.js`,
   `checkRateLimit`): caps a single source and counts every request (cache
   hits included), so it also bounds one IP's share of the worker's own
   request budget. A source is an IPv4 address whole, an IPv4 client on an
   IPv6 socket (`::ffff:a.b.c.d`) by its IPv4, and an IPv6 address by its
   /64 (`rateKeyIp`), the block one subscriber is handed.
2. **Aggregate per-route ceiling** (`GLOBAL_CEILINGS`, `reserveUpstream`):
   caps how many requests reach each upstream regardless of source IP,
   counted only on a cache **miss**. This is what stops a *distributed*
   flood (many IPs, each under the per-IP cap) from exhausting the shared
   autorouter quota or hammering the fragile SOFIA backend. The never-cached
   `/sofia/session` and `/sofia/chart` relays reserve a ceiling slot too
   (the chart relay under its own `chart` bucket, so a dossier-print storm
   can't starve the briefing ceiling).

Both refuse with `429` + a `Retry-After` hint (readable by the browser
because `corsHeaders` exposes it). Ahead of both tiers the `/notam` and
`/sofia` **response caches** (~60 s) serve repeated identical requests
without touching an upstream, and **single-flight** coalescing collapses
concurrent identical requests that arrive before the cache is warm into
one upstream call. A coalesced leader is registered with `ctx.waitUntil`,
so it outlives the client that started it: a client giving up (the SPA's
briefing budget expiring, a closed tab) would otherwise cancel the request
context with the leader's promise neither settled nor cleared from the
in-flight map, and the SPA's retry, which repeats a byte-identical body
and so lands on the same key, would follow a promise that can never
resolve. Left to finish, the leader frees the key and warms the cache, so
that retry is served from it. The limits are generous: one user action fans out to
several upstream calls (a `/notam` fetch chunks + pages; a SOFIA briefing
does one session + one POST per route, plus chart PDFs), so the caps
target sustained scripted / re-click
floods, not a legitimate burst; tune the two constants against the
dashboard metrics.

The per-isolate caveat means a flood spread across many isolates / colos
can exceed a ceiling (each isolate counts its own slice); it still bounds
a single hot isolate and every casual / single-source flood with zero
provisioning. For a per-colo counter, swap `slidingWindowAllow` for
Cloudflare's native Rate Limiting binding; a truly global counter needs a
Durable Object (paid plan).

The `radar` class is the newest: a two-hour loop fill of the
precipitation radar is 26 requests in about ten seconds, then one per new
frame, and per pan one per LOOP FRAME whose tiles it uncovers (25 at the
two-hour loop, the frames being content-addressed by slot), so its per-IP
window is 360/min, fourteen such pans a minute (hits count, which
caps a scripted scrape of the bucket through the relay) and its aggregate
ceiling 90/min on cache **miss** only, a miss being a whole-frame fetch
(3.5 MB, once per data centre and frame) or a listing. The frame objects
are cached at the edge WHOLE for the day they live; the sliced answers
are marked `private` so the browser keeps them and the edge never stores
the unbounded family of slices.

**The browser's cache.** The zone's Browser Cache TTL REWROTE the headers
`caches.default.match()` hands back, until 2026-09-20 (below): measured
on the deployed Worker, a
`/wx/metar` answer read `cache-control: public, max-age=60` on the edge
miss and `max-age=14400` on the hit two seconds later, so a browser that
fetched inside the edge's minute kept a METAR, or a radar frames list, for
four hours, its own refetches and the Refresh button returning that copy
(found by a radar drive reading a list 37 minutes stale). The rule here:
every freshness-sensitive edge-cached route (`/wx/*`, `/opera/frames`)
hands the CLIENT a `no-store` copy through `clientNoStore` while the edge
copy, stored first, keeps its own TTL; the SPA fetches those routes
`no-store` as well. The year-long and day-long routes (`/sia/vac`, the
frame slices) need nothing, the zone only lengthens. The zone-level cure
is Caching, Configuration, Browser Cache TTL set to "Respect Existing
Headers" (or a Cache Rule for the two Worker hostnames), which also lets
GitHub Pages' own `max-age=600` reach browsers for the site. That was done
on 2026-09-20 and verified at 21:04Z: the site's `sw.js` on an edge HIT
reads `max-age=600`, where the rewrite stamped 14 400. The code does not
depend on it either way, a zone setting being one click from its old
value.

Two further guards bound each in-flight request: every upstream fetch
carries a per-route timeout (`FETCH_TIMEOUT_MS`; a hung upstream becomes a
`502` instead of pinning the request, its ceiling slot, and every
coalesced follower), and upstream bodies over the ~4 MB cache body cap
(`RESP_CACHE_MAX_BODY`), or past what every read in flight may buffer
together (`INFLIGHT_BUFFER_BUDGET`, 32 MB), are streamed through to the client uncached
instead of being buffered in the isolate.

The `sofia` and `session` budgets are ordered against the SPA's own: the
worker's worst case for one briefing POST is `session + sofia` (it runs the
handshake inline whenever the client sends no `?session=`), and the SPA's
`BRIEFING_TIMEOUT_MS` must exceed that sum so this side always answers
first and the pilot reads the framed `502` rather than a bare "Failed to
fetch". `tests/sofiaTimeouts.spec.ts` in the SPA locks the two sides
together by parsing both sources.

## Tests

The worker has a self-contained test suite under `test/`: plain
`node:test`, no dependencies, no network (the `fetch` / `caches` globals
are stubbed, and each test imports a fresh worker instance). Run it with
Node 18+:

```sh
npm run test:proxy                         # from the repo root (part of npm run verify)
node --test "notam-proxy/test/*.test.js"   # the same, by hand
node --test                                # from this directory
```

`npm run test:proxy` gives every test two minutes (`--test-timeout`):
`node --test` has no timeout of its own, so a regression that leaves a
request waiting hangs the suite rather than failing it.

It covers the CORS gating, both rate-limit tiers (per-IP window and
upstream ceilings, `/sofia/session` + `/sofia/chart` included), the
response-cache keys (full normalized `/notam` query, raw `/sofia` body),
single-flight coalescing (including a leader outliving the client that
abandoned it), the token exchange (the shared store's adopt /
mint / republish paths and its outage fallback, the 401 retry and its
failure path, negative caching), the SOFIA body cap and `?session=`
validation, the chart param validation and redirect refusal, the oversize
pass-through, and the upstream timeout wiring. Run it before every
redeploy.

## Observability

`wrangler.toml` enables Workers Logs (`[observability]`) with the
per-request INVOCATION logs switched off: they record every request's URL
and headers, which the About page's privacy statement says these logs do
not keep. What is kept is the worker's own `console.error`, a structured
JSON line on its failure paths: token
failures, upstream errors / timeouts (per route), upstream 5xx statuses
(every route: `/notam`, `/sofia`, `/sofia/chart`, `/wx`, `/sia/vac` and
the radar, whose redirects and refused objects are logged too), and
ceiling refusals. It never logs secrets, tokens, cookies, request
bodies, or client IPs. The dashboard's Logs tab is where the README's
"tune the constants against the dashboard metrics" advice looks.

## Cost

The account is on the **Workers Paid** plan (docs/accounts-sync.md): 10
million requests a month are included and the rest is metered (about
$0.30 per million), CPU is 30 s per invocation, and Durable Objects, cron
triggers and the Email Service are available. So a request budget here is
a cost line, never a cap, and nothing in this worker is shaped by the free
plan's 100 000 requests a day or its 10 ms of CPU. A single user usually
triggers a handful of requests per session. The precipitation radar is the
heaviest client: a loop fill is one request per frame plus the index (14
for an hour, 26 for two), and keeping the layer on costs about one request per five
minutes for the frames index, asked for at the instant the next frame is
expected rather than every minute, plus one per new frame, about 450
requests for an eight-hour day with the layer on: a hundred such days a
month sit inside the included quota. The shared token store spends one KV
write per minted token (about 24 a day) and one read per cold isolate,
both far inside the paid plan's KV quotas.

Cloudflare does not bill for Workers bandwidth. The two rate-limit tiers
above, plus Cloudflare's automatic network-layer DDoS mitigation (on by
default), bound what a flood can cost and blunt abuse; the aggregate
ceilings additionally shield the shared autorouter quota and the SOFIA
backend, whose limits are not ours to spend.

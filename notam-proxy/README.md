# notam-proxy

A single-file Cloudflare Worker behind the Loxodrome SPA's network
features. It started as a CORS bridge to the
[autorouter NOTAM API](https://www.autorouter.aero/wiki/api/) (which
sends no CORS headers, so a static GitHub-Pages site can't call it
directly) and now also serves terrain elevation tiles for the route
vertical profile, live METAR / TAF weather from the NOAA Aviation
Weather Center, and route NOTAMs from the French SIA's
[SOFIA-Briefing](https://sofia-briefing.aviation-civile.gouv.fr/)
service. The tile / weather routes are validated passthroughs plus the
right CORS headers; `/sofia` additionally performs a small server-side
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
tile / weather routes keep their own caches). Every upstream fetch carries
a timeout so a hung upstream can't pin requests open.

## Prerequisites

1. **An autorouter application credential.** Autorouter grants API access
   per application via a support ticket
   ([autorouter.aero/support](https://www.autorouter.aero/support)); you
   receive a credential used with the OAuth2 `client_credentials` grant (a
   dedicated service-account email + password, or a registered-app
   `client_id` + secret). This is the ONE credential the worker holds; end
   users need no autorouter account.
2. A free [Cloudflare](https://workers.cloudflare.com/) account.

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

### Option B: via wrangler

```sh
npm i -g wrangler
wrangler secret put AR_CLIENT_ID
wrangler secret put AR_CLIENT_SECRET
wrangler kv namespace create AR_TOKEN_KV   # once; paste the id in wrangler.toml
wrangler deploy
```

`wrangler.toml` in this directory carries the name, compatibility date and
the KV binding; bump `compatibility_date` when redeploying after a long
gap. The autorouter credential lives in **secrets**, never in
`wrangler.toml` (the KV namespace id is not a credential and does belong
there). For `wrangler dev`, put `AR_CLIENT_ID` / `AR_CLIENT_SECRET` in a
gitignored `.dev.vars` file in this directory; the token store is then a
local namespace persisted under `.wrangler/state`, so dev restarts reuse
their own token instead of spending the shared account's.

## Configure allowed origins

The worker only forwards requests from origins it recognises. By default
that's:

- `https://loxodrome.fr` and `https://www.loxodrome.fr` (the public site)
- `https://notam-viewer.net` (the site the app moved off, still listed so a
  browser that installed it from there keeps working until it is replaced)
- `http://localhost:5173` and `http://localhost:5174` (Vite dev)

To override, set the worker environment variable `ALLOW_ORIGINS` to a
comma-separated list. Dashboard → your worker → **Settings** →
**Variables** → add `ALLOW_ORIGINS` = `https://my-fork.example.com`.

Requests with an `Origin` header outside the allow-list get `403`. The
preflight (`OPTIONS`) is answered locally and never reaches autorouter.

## What it forwards, what it doesn't

| Path                          | Method | Forwarded to                                    |
|-------------------------------|--------|-------------------------------------------------|
| `/notam`                      | GET    | `https://api.autorouter.aero/v1.0/notam<query>` (the worker injects the application bearer token; any client `Authorization` is ignored. Per-IP rate limited + ~60 s response cache keyed on the full normalized query, the now-anchored validity epochs bucketed to the TTL) |
| `/tiles/terrarium/{z}/{x}/{y}.png` | GET | the AWS `elevation-tiles-prod` Terrarium bucket (z/x/y bounds-checked, cached via the Cloudflare cache) |
| `/wx/metar`, `/wx/taf`        | GET    | `https://aviationweather.gov/api/data/` (whitelisted query surface: short `ids` list or a bounded `bbox`; `format=json` forced) |
| `/wx/isigmet`, `/wx/airsigmet`| GET    | `https://aviationweather.gov/api/data/` (global decoded SIGMET feeds; no params) |
| `/sofia`                      | POST   | `https://sofia-briefing.aviation-civile.gouv.fr/sofia` (French SIA route NOTAMs; the worker first GETs `…/homepage.html` for an anonymous `JSESSIONID`, then POSTs the client's briefing body with the `Origin` / `Referer` / `Cookie` / `X-Requested-With` headers a browser can't set. Reuses a `JSESSIONID` passed as `?session=` instead of the homepage GET, validated against the JSESSIONID charset before it rides the upstream `Cookie` header. Per-IP rate limited + ~60 s response cache keyed on the raw body) |
| `/sofia/session`              | GET    | returns `{ "session": "<JSESSIONID>" }` from a homepage GET, so a multi-route briefing can fetch one anonymous session and reuse it across its per-route `/sofia` POSTs (one handshake, not one per route) |
| `/sofia/chart`                | GET    | `https://aviation.meteo.fr/FR/aviation/affiche_image.php` (the TEMSI / WINTEM PDFs the SOFIA chart catalog links, for the printed flight dossier; the upstream URL is rebuilt from exactly three validated query params (`login` token, `layer`, `echeance`), never from a client URL, redirects refused, response streamed `no-store`, nothing cached or rehosted; its own aggregate `chart` upstream ceiling) |
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
   request budget.
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
does one session + one POST per route, plus chart PDFs; a profile render
pulls many tiles), so the caps target sustained scripted / re-click
floods, not a legitimate burst; tune the two constants against the
dashboard metrics.

The per-isolate caveat means a flood spread across many isolates / colos
can exceed a ceiling (each isolate counts its own slice); it still bounds
a single hot isolate and every casual / single-source flood with zero
provisioning. For a per-colo counter, swap `slidingWindowAllow` for
Cloudflare's native Rate Limiting binding; a truly global counter needs a
Durable Object (paid plan).

Two further guards bound each in-flight request: every upstream fetch
carries a per-route timeout (`FETCH_TIMEOUT_MS`; a hung upstream becomes a
`502` instead of pinning the request, its ceiling slot, and every
coalesced follower), and upstream bodies over the ~4 MB cache body cap
(`RESP_CACHE_MAX_BODY`) are streamed through to the client uncached
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
node --test "notam-proxy/test/*.test.js"   # from the repo root
node --test                                # from this directory
```

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

`wrangler.toml` enables Workers Logs (`[observability]`), and the worker
`console.error`s a structured JSON line on its failure paths: token
failures, upstream errors / timeouts (per route), upstream 5xx statuses,
and ceiling refusals. It never logs secrets, tokens, cookies, request
bodies, or client IPs. The dashboard's Logs tab is where the README's
"tune the constants against the dashboard metrics" advice looks.

## Cost

Cloudflare's free tier covers 100 000 requests/day per account. A
single user usually triggers a handful of requests per session, orders
of magnitude under the cap. The shared token store spends one KV write
per minted token (about 24 a day against the free tier's 1 000) and one
read per cold isolate (against 100 000).

Cloudflare does not bill for Workers bandwidth, and on the free plan an
over-the-cap day is *rejected*, never billed, so a flood degrades the
service (until the daily reset) rather than costing money. The two
rate-limit tiers above, plus Cloudflare's automatic network-layer DDoS
mitigation (on by default), keep legitimate traffic well within the cap
and blunt abuse; the aggregate ceilings additionally shield the shared
autorouter quota and the SOFIA backend, whose limits are not ours to
spend.

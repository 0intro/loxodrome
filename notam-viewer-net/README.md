# notam-viewer.net

The NOTAM Viewer's own address, served transparently from
`https://loxodrome.fr/notam/`.

The viewer used to be a site of its own here. It is now published inside
Loxodrome's site (`docs/notam-viewer.md`), which removed a second GitHub Pages
site, a cross-repo token and 32.6 MB of duplicated datasets. This worker is what
keeps the old address working *as an address*: the bar keeps reading
`notam-viewer.net`, because that domain carries the name, the links and whatever
search presence the tool built, and it is the canonical URL the page names.

A mask, not a redirect. One mapping, no HTML rewriting, no state, no secrets.

## The mapping

Every path lands inside the viewer's own subdirectory, except the four things
the viewer reads from the site root:

| request | upstream |
|---|---|
| `/` | `loxodrome.fr/notam/` |
| `/index.html` | `loxodrome.fr/notam/index.html` |
| `/sw.js` | `loxodrome.fr/notam/sw.js` (404) |
| `/v2/sw.js`, `/v2/` | `loxodrome.fr/notam/v2/…`: the old `/v2/` beta's service-worker KILL SWITCH and its moved-page notice |
| `/notam/assets/…` | unchanged |
| `/data/…` | the site root (the only shared prefix; the icons are the viewer's own) |
| `www.…` | 301 to the apex |

**Why a prefix and not a pass-through.** Passing paths through unchanged and
special-casing only `/` looks simpler and is unsafe. `notam-viewer.net/index.html`
is an old bookmark away (it is a live URL on the old site) and would map to
`loxodrome.fr/index.html`, which is the FLIGHT APP's shell. Serving that here
registers Loxodrome's service worker on this origin at scope `/`, and that
worker answers any unmatched navigation with its own `index.html`. Its denylist
carries `/^\/notam(\/|$)/`, which cannot help: masking is precisely the
operation that moves the viewer off that path. One stray visit would convert
this domain into the wrong app, offline-first, until the worker updated.

Prefixing makes both cases safe *by construction*: `/index.html` is the viewer,
and `/sw.js` 404s because `dist/notam/` ships no service worker (a decision
pinned by `tests/notamViewerSite.spec.ts`).

**The one worker script that must NOT 404 is `/v2/sw.js`.** The old site served
a kill switch there for the service worker its `/v2/` beta installed, which
otherwise answers navigations from its own precache and serves an expired AIRAC
cycle. An install picks the kill switch up on its next update check, and a
404 on that fetch does NOT unregister a worker: it leaves the stale shell in
place for good. So the viewer's own public directory carries it
(`src/notam/public/v2/sw.js`, with the notice beside it), the prefix rule maps
`notam-viewer.net/v2/sw.js` onto it unaided, and nothing ever registers it
afresh (pinned by the same spec). It went missing for three days when the mask
replaced the old site, 2026-09-19 to 2026-09-22. What it breaks instead is the shared
paths, which is the better failure: a missing entry in `SHARED` is a loud 404 on
the first page load rather than a wrong app cached on a stranger's phone.

**Why the subrequest follows redirects.** An incoming `Request` in a Worker
carries `redirect: 'manual'`, and `fetch` inherits it from the Request it is
handed, so an upstream 3xx came straight back to the reader with an **absolute
`loxodrome.fr` Location** and the mask was gone. Pages issues exactly that for
any directory path without a trailing slash: `notam-viewer.net/notam` answered
`301` to `loxodrome.fr/notam/` until `redirect: 'follow'` was passed beside the
Request. Followed here, the browser sees the final response and keeps the
address it asked for. `maskLocation` sits behind that for a 3xx following
cannot resolve, rewriting the host and only the host: mapping the path back is
ambiguous, since upstream `/notam/x` is the image of both `/x` and `/notam/x`,
and a working address with a redundant prefix beats a guess.

## Tests

`node:test`, no wrangler, no network, no dependencies.

```sh
node --test "notam-viewer-net/test/*.test.js"   # from the repo root
npm run test:viewer-net                          # the same, and part of `npm run verify`
```

They assert the table above, plus that a path merely *starting* like a shared
one is still prefixed, that the query string survives (the `?file=` boot
parameter needs it) and that a `www` redirect does not also fetch upstream.

## Deploy

```sh
cd notam-viewer-net
npx wrangler@4 deploy
```

**Delete the zone's Single Redirect rule first.** Cloudflare runs Redirect Rules
*before* Workers, so while the rule exists it answers 301 and this worker never
runs. That rule was the previous arrangement; the worker replaces it.

The routes are plain `[[routes]]` with `zone_name`, not `custom_domain = true`
as in the other two workers. The zone already has its own proxied placeholder
record, and a plain route attaches to it and leaves DNS alone. There is no
origin server behind the placeholder and there does not need to be: the worker
answers every request itself.

## Cost

Every byte the viewer serves passes through here, datasets included: about 300
requests on a cold load. The upstream responses carry `cache-control:
max-age=600` from GitHub Pages, so the edge absorbs the repeats.

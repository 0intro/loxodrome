/**
 * notam-proxy; Cloudflare Worker behind the Loxodrome SPA.
 *
 * The autorouter API (https://api.autorouter.aero) does not send CORS
 * headers, so a static SPA on GitHub Pages can't call it directly from the
 * browser. This worker forwards GET /notam to autorouter and adds the right
 * CORS headers on the response. It also relays live METAR / TAF / SIGMET weather from
 * the NOAA Aviation Weather Center (/wx/metar, /wx/taf, /wx/isigmet,
 * /wx/airsigmet, see handleWx), SOFIA-Briefing route NOTAMs from the French
 * SIA (POST /sofia, see handleSofia), and the TEMSI / WINTEM chart PDFs those
 * catalogs link on aviation.meteo.fr (GET /sofia/chart, see handleSofiaChart)
 * and the SIA's own Atlas VAC plates, which the map overlay draws in place
 * (GET /sia/vac/<cycle>/<plate>, see handleVacPlate) - all upstreams without
 * CORS headers of their own.
 *
 * Authentication (autorouter): this worker authenticates to autorouter at the
 * APPLICATION level. A single credential is held as a Worker secret
 * (AR_CLIENT_ID / AR_CLIENT_SECRET) and exchanged server-side for a bearer
 * token (getAutorouterToken), which is injected on each /notam request.
 * End-users no longer supply an autorouter account, and the credential is
 * never exposed to the browser. Autorouter allows an account only 20
 * simultaneously valid tokens and each lives a WEEK, so ONE token is shared by every
 * isolate through a KV namespace, with the module-global cache in front of it
 * as the per-isolate memo (see the token section below). The "Deployment"
 * note below covers the secret and the namespace.
 *
 * Flood protection (two tiers, both module-global => best-effort per isolate):
 * because all users now draw on ONE autorouter quota, and the SOFIA upstream is
 * a fragile government service, this worker applies (1) a per-IP rate limit per
 * route class (checkRateLimit; caps one source, counts every request) and (2)
 * an aggregate per-route ceiling that caps how many requests reach each UPSTREAM
 * regardless of source IP (reserveUpstream; counted only on cache MISS), so a
 * DISTRIBUTED flood can't exhaust the shared quota or hammer SOFIA even when no
 * single IP trips tier 1 (the never-cached /sofia/session and /sofia/chart
 * relays reserve a ceiling slot too). A short response cache and single-flight
 * coalescing on /notam and /sofia collapse identical requests ahead of both
 * tiers; /wx, /sia/vac and the radar keep their own edge caches. Every upstream fetch
 * carries an AbortSignal timeout (FETCH_TIMEOUT_MS) so a hung upstream can't
 * pin a request, its ceiling slot, and every coalesced follower until the
 * runtime's own limits fire.
 *
 * Deployment:
 *   1. A Cloudflare account (the canonical deploy runs on the Workers Paid
 *      plan, whose CPU and request allowances this relay's limits are set
 *      against) -> Workers & Pages -> Create a Worker.
 *   2. Paste this file as the worker source. Save and deploy.
 *   3. Set the autorouter application credential as secrets (encrypted, never
 *      in wrangler.toml / source):
 *        wrangler secret put AR_CLIENT_ID
 *        wrangler secret put AR_CLIENT_SECRET
 *      For `wrangler dev`, put the same two keys in notam-proxy/.dev.vars
 *      (gitignored).
 *   4. The canonical deploy answers on https://proxy.loxodrome.fr (the
 *      custom domain in wrangler.toml, which is also what provisions its
 *      certificate); the workers.dev hostname stays on beside it for the
 *      Android builds that carry it. A different deploy points the app at
 *      itself through the Loxodrome build's VITE_NOTAM_PROXY_URL.
 *
 * Allowed origins are configured via the worker environment variable
 * `ALLOW_ORIGINS` (comma-separated). If unset, defaults to the public site,
 * the Vite dev server, and the Capacitor Android app (whose WebView serves
 * the bundled app from the https://localhost origin).
 */

const DEFAULT_ALLOW_ORIGINS =
	'https://loxodrome.fr,https://www.loxodrome.fr,https://notam-viewer.net,http://localhost:5173,http://localhost:5174,https://localhost';
const UPSTREAM = 'https://api.autorouter.aero/v1.0';
const NOTAM_PATH = '/notam';
// autorouter's OAuth2 token endpoint; called server-to-server (no CORS
// concern) with grant_type=client_credentials and the app secrets.
const AR_TOKEN_URL = UPSTREAM + '/oauth2/token';


// Live weather (METAR / TAF / SIGMET) from the NOAA Aviation Weather Center
// data API, which sends no CORS headers either; see handleWx. The two SIGMET
// endpoints (isigmet international, airsigmet US) are GLOBAL feeds: they
// take no ids / bbox and the whole active set is ~100 KB.
const WX_PREFIX = '/wx/';
const AWC_BASE = 'https://aviationweather.gov/api/data/';
const WX_ENDPOINTS = new Set(['metar', 'taf']);
const WX_GLOBAL_ENDPOINTS = new Set(['isigmet', 'airsigmet']);
const WX_IDS_RE = /^[A-Za-z0-9]{3,8}(,[A-Za-z0-9]{3,8}){0,11}$/;
const WX_BBOX_MAX_SPAN_DEG = 4;
const WX_TTL_S = 60;

// SOFIA-Briefing (French DSNA / SIA) route NOTAMs. A same-origin government
// app with no CORS headers that authenticates the briefing POST with an
// anonymous JSESSIONID session cookie and requires request headers a browser
// refuses to let a script set (Origin / Referer / Cookie / X-Requested-With).
// So unlike the stateless passthroughs above, handleSofia does the two-step
// handshake (homepage GET for the cookie, then the briefing POST) itself. See
// handleSofia.
const SOFIA_PATH = '/sofia';
// Hands the client one anonymous JSESSIONID to reuse across a multi-route
// briefing (its per-route POSTs pass it back as ?session=), so the handshake
// runs once instead of once per route. See handleSofiaSession.
const SOFIA_SESSION_PATH = '/sofia/session';
const SOFIA_BASE = 'https://sofia-briefing.aviation-civile.gouv.fr';
// TEMSI / WINTEM chart PDF relay (the catalog links point at
// aviation.meteo.fr, which sends no CORS headers); see handleSofiaChart.
const SOFIA_CHART_PATH = '/sofia/chart';
const METEO_CHART_BASE = 'https://aviation.meteo.fr/FR/aviation/affiche_image.php';
// The three query params of a catalog link, and nothing else: login is the
// expiring base64 token, layer a lowercase product path (wintemp/fr/france/
// fl020), echeance a UTC timestamp. Tight charsets keep the route from being
// a general-purpose GET relay.
const CHART_LOGIN_RE = /^[A-Za-z0-9+/=]{1,256}$/;
const CHART_LAYER_RE = /^[A-Za-z0-9/_-]{1,64}$/;
const CHART_ECHEANCE_RE = /^\d{14}$/;
// A browser-like UA; the SIA host answers empty / bot UAs inconsistently.
const SOFIA_UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
// The client's briefing body is small (a route ICAO list + a few numbers);
// cap it so the route can't be turned into a general-purpose POST relay. The
// cap is enforced BEFORE buffering (Content-Length pre-check + a streamed
// running cap, see readRequestBodyCapped), so an oversized POST never
// materialises in the isolate.
const SOFIA_MAX_BODY = 8192;
// The ?session= value a client passes back is interpolated into the upstream
// Cookie header; accept only a plain JSESSIONID token (Tomcat hex plus the
// . - _ ! route-suffix characters some balancers append), so the relay can't
// be made to smuggle extra cookie pairs it never issued.
const SOFIA_SESSION_RE = /^[A-Za-z0-9._!-]{1,128}$/;

// French Atlas VAC plates. The SIA answers 200 with no CORS header at all,
// so a browser cannot read a plate from the source however it asks, and the
// plates are the pictures the VAC map overlay draws (docs/vac-overlay.md).
// The offline document packs exist so the SIA is fetched once per build for
// everyone rather than once per install, and a phone with a pack downloaded
// never comes here; this relay is for the reader who has no pack, and it
// carries the handful of plates actually looked at, not all 656.
//
// The path names the AIRAC cycle and one plate, both on tight charsets, and
// the upstream base is fixed, so the route cannot be walked into a general
// GET relay. A plate is immutable for its cycle, so it is cached hard.
const VAC_PREFIX = '/sia/vac/';
const SIA_MEDIA_BASE = 'https://www.sia.aviation-civile.gouv.fr/media/dvd/';
const VAC_RE = /^\/sia\/vac\/(\d{2}_[A-Z]{3}_\d{4})\/AD-([23])\.([A-Z0-9]{3,5})\.pdf$/;

// EUMETNET OPERA precipitation radar composites (docs/precipitation-radar.md).
// The Open Radar Data service publishes them in an anonymous 24-hour S3
// cache that sends no CORS header, so a browser cannot read a frame however
// it asks. Two routes. `/opera/frames` lists the frames of the last hours
// (one S3 listing per UTC day touched), so the client never polls blind.
// `/opera/<slot>/<product>.tiff?tiles=…` answers the TILES a viewport names,
// in one request per frame: the composite is a cloud-optimized GeoTIFF whose
// tile offsets differ per frame, so the client cannot name byte ranges it has
// not seen, and this relay walks the frame's own directory instead (the one
// fixed-format parse in this file). Each immutable frame is fetched WHOLE
// once per data centre and cached at the edge for the day it lives; the
// answer is the object's first OPERA_HEAD_BYTES (its directory) followed by
// the requested tiles in ascending index order, the directory's own
// bytecount table being the framing. The slot is validated against the
// cadence and the 24-hour cache, the product against a list, and the upstream
// base is fixed, so the route cannot be walked into a general GET relay.
const OPERA_PREFIX = '/opera/';
const OPERA_FRAMES_PATH = '/opera/frames';
const OPERA_BASE = 'https://s3.waw3-1.cloudferro.com/openradar-24h';
// product -> the cadence in minutes and the composite's geometry, which is
// the guard every relayed object must match: DBZH is the CIRRUS
// reflectivity on the 1 km grid (3800 x 4400 in 72 tiles of 512) every 5
// min, RATE the NIMBUS rain rate on the 2 km grid (1900 x 2200 in 20
// tiles) every 15. `cellM` is the grid's cell, which the tie point and the
// pixel scale are checked against (src/lib/weather/laea.ts OPERA_GRID /
// OPERA_GRID_2KM, the client's own statement of the same two grids).
const OPERA_PRODUCTS = {
	DBZH: { cadence: 5, width: 3800, height: 4400, tiles: 72, cellM: 1000 },
	RATE: { cadence: 15, width: 1900, height: 2200, tiles: 20, cellM: 2000 },
};
const OPERA_FRAME_RE = /^\/opera\/(\d{8}T\d{4})\/(DBZH|RATE)\.tiff$/;
// No leading zero: `00,07` would be another browser-cache entry for `0,7`.
const OPERA_TILES_RE = /^(0|[1-9]\d?)(,(0|[1-9]\d?))*$/;
const OPERA_HEAD_BYTES = 8192;
const OPERA_CACHE_MS = 24 * 3600_000;
const OPERA_INDEX_TTL_S = 60;
const OPERA_INDEX_MAX_HOURS = 6;
/** Listing pages a day may take: S3 answers 1000 keys a page, and a day of
 *  the bucket holds 960 (DBZH every 5 min, ACRR and RATE every 15, each as
 *  .h5 and .tiff; counted 2026-09-20), the newest keys LAST, so a day that
 *  outgrew one page would silently lose its latest frames. */
const OPERA_LIST_MAX_PAGES = 5;
/** The whole listing, every page of every day it touches, answers inside
 *  this, or answers 504, the page the deadline cuts short included (its
 *  abort is the deadline's, not an upstream failure's). The client gives
 *  the index 20 s end to end
 *  (FETCH_TIMEOUT_MS in src/lib/state/radar.svelte.ts), and pages are
 *  8 s each, so a window across 00Z on two paged days could take 80 s: the
 *  client aborted at 20 while this went on listing under waitUntil, and a
 *  healthy relay read as "radar index failed" every minute. Five seconds of
 *  margin leave the edge and the network their share of the client's 20. */
const OPERA_LIST_DEADLINE_MS = 15_000;
/** The most an upstream object may be before it is read whole: a frame is
 *  3.5 MB, and an isolate has 128 MB for every request it is serving. */
const OPERA_OBJECT_MAX_BYTES = 16 * 1024 * 1024;
/** What the radar relay may hold at once in one isolate, every request
 *  together: a leader's whole object (twice, the edge put taking its own
 *  copy), a hit's span read, every answer until its reader has taken it.
 *  The request limits count requests, not bytes held: 36 misses of distinct
 *  frames at once (slots no client loops over, so the edge held none) held
 *  a 3.5 MB buffer each for the whole download, 128 MB, and the isolate
 *  died with every request it was serving, /notam and /sofia included, its
 *  rate windows with it. Past the budget a request waits its turn (FIFO) for
 *  at most OPERA_MEMORY_WAIT_MS, then answers 503 with a Retry-After. */
const OPERA_MEMORY_BUDGET = 48 * 1024 * 1024;
const OPERA_MEMORY_WAIT_MS = 8_000;
const OPERA_MEMORY_QUEUE_MAX = 48;
/** How long the edge remembers an object the relay refused (not the
 *  composite's layout, or past the size bound), answering 502 from that
 *  memory rather than pulling the whole object again for every reader and
 *  every client's minute retry. */
const OPERA_REFUSED_TTL_S = 3600;
/** The edge key of a stored object carries the slicing format's version, so
 *  a change to what is stored or how it is cut retires a day's objects with
 *  the deploy rather than serving them under the new rules. */
const OPERA_OBJECT_KEY_VERSION = '1';
const operaInflight = new Map(); // index cache key -> Promise<record>
const operaObjInflight = new Map(); // object cache key -> Promise<record>
let operaBytesHeld = 0;
const operaWaiters = []; // FIFO of { bytes, grant }

// Upstream fetch timeouts (AbortSignal.timeout on every upstream call): a hung
// upstream must not stall the request, its ceiling slot, and every coalesced
// follower until the runtime's own limits fire. Generous per route: the SOFIA
// briefing POST is slow on long routes, the chart PDFs run to a few hundred
// KB, plates / wx are small and fast. A timeout surfaces as the existing 502
// 'upstream error' path.
//
// session + sofia is the worst case for ONE briefing POST, because
// fetchSofiaRecord runs the handshake inline whenever the client sends no
// ?session=. The SPA's own budget (BRIEFING_TIMEOUT_MS, 50 s) must exceed
// that sum, so this side always answers first and the pilot reads the framed
// 502 instead of a bare "Failed to fetch": 10 + 35 = 45 < 50. 35 s is about
// twice a cold SOFIA PIB, measured at 18.6 s.
const FETCH_TIMEOUT_MS = {
	token: 15_000,
	notam: 20_000,
	sofia: 35_000,
	session: 10_000,
	chart: 20_000,
	wx: 10_000,
	// A plate is half a megabyte off a government host that is not quick.
	vac: 25_000,
	// A radar frame is 3.5 MB whole, fetched once per data centre and day.
	radar: 30_000,
	// A listing page is a few hundred keys of XML. The whole listing, however
	// many pages and days, is bounded by OPERA_LIST_DEADLINE_MS, under the
	// client's own 20 s budget.
	radarList: 8_000,
};

// --- autorouter application token (server-side, shared across isolates) ----
// Autorouter allows an account 20 simultaneously valid client-credentials
// tokens, publishes no revoke endpoint, and asks a client not to request a new
// token while it holds one (wiki/api/authentication). The lifetime comes back
// as expires_in and is what the wiki's "one hour presently" is NOT: measured
// 2026-07-31, a real token carried expires_in 604800, a WEEK. That is why
// honouring expires_in (fetchAutorouterToken) matters, and why an abandoned
// token is expensive: a module-global cache is per ISOLATE, so caching there
// alone mints one per cold start, and an evicted isolate's token then holds
// its slot for the rest of the WEEK. Twenty of those and the endpoint answers
// 403 toomanytokens for everyone, for days, with no way to revoke: it took an
// autorouter support ticket to clear. The token therefore lives in KV (binding
// AR_TOKEN_KV, key TOKEN_KEY), shared by every isolate and colo, with the
// module global as the memo in front of it: memo -> KV -> mint. Without the
// binding (a dashboard copy/paste deploy) resolution still works, per isolate.
let arToken = null; // { value, expiresAt }; expiresAt = usable until
// Coalesces concurrent resolves within one isolate, keyed by the stale token
// they replace, so a caller whose own token went stale after an in-flight
// resolve started is never handed that resolve's result.
let arTokenInflight = null; // { stale, promise }
// Short negative cache so a credential / outage failure doesn't hammer the
// token endpoint on every request.
let arTokenFailUntil = 0;
let arTokenFailDetail = '';
const TOKEN_NEG_TTL_MS = 45_000;
const TOKEN_KEY = 'autorouter-token';
// The colo's read cache for the shared entry. A token lives days, so a read a
// minute stale still yields a valid token; it is also how long a colo
// remembers a MISS, i.e. the window in which two colos can each mint one.
const TOKEN_KV_CACHE_TTL_S = 60;
// KV's floor for expirationTtl.
const TOKEN_KV_MIN_TTL_S = 60;
// Cap on the upstream error text carried into the /notam 503 body; the SPA
// caps its own display at the same 240.
const TOKEN_DETAIL_MAX = 240;

// --- per-IP rate limiting (per route class) --------------------------------
// Immediate, zero-provisioning default: a module-global sliding window per
// (class, IP). Module-global => per-isolate, so this is best-effort flood
// protection, not a hard cross-edge guarantee (same caveat as the aggregate
// ceilings below). For stronger, per-colo enforcement, swap slidingWindowAllow
// for Cloudflare's native Rate Limiting binding (one binding per class,
// env.RL_<CLASS>.limit({ key })); verify the current binding syntax in the
// Cloudflare docs before wiring it.
//
// Limits are generous on purpose: ONE user action can fan out to several
// upstream calls (a /notam fetch chunks + pages; a SOFIA briefing does one
// session + one POST per route, plus chart PDFs; a radar loop pulls a frame
// per slot). The point is to stop sustained scripted / re-click floods
// (hundreds+/min), never a legitimate burst. Tune against real usage.
const RATE_LIMITS = {
	notam: { limit: 120, windowMs: 60_000 },
	sofia: { limit: 90, windowMs: 60_000 },
	wx: { limit: 120, windowMs: 60_000 },
	// Panning across France asks for a plate per aerodrome passed, and the
	// client caches what it has drawn, so this is generous for a reader and
	// nowhere near enough to mirror the atlas.
	vac: { limit: 60, windowMs: 60_000 },
	// A two-hour radar loop is 26 requests in about ten seconds, then one
	// per new frame, and per pan one per LOOP FRAME whose tiles it uncovers
	// (25 at the two-hour loop, the frames being content-addressed by slot);
	// 360 leaves a pilot fourteen such pans a minute. Hits count, so this
	// still caps a scripted scrape of the bucket through the relay.
	radar: { limit: 360, windowMs: 60_000 },
};
const rlHits = new Map(); // "class|ip" -> number[] of recent request times (ms)
const RL_MAX_KEYS = 5000; // crude memory guard on the map

// --- aggregate per-route ceilings (upstream-protection tier) ---------------
// The per-IP limiter above caps ONE source; it can't stop a DISTRIBUTED flood
// (many IPs each under their own cap) from exhausting the shared autorouter
// quota or hammering the fragile SOFIA backend. This second tier caps the
// AGGREGATE rate at which requests reach each upstream, counted only on cache
// MISS (a cache hit touches no upstream, so it costs nothing here) and, for
// /notam and /sofia, deduped by single-flight so a burst of identical requests
// is one upstream call. Same module-global => PER-ISOLATE caveat as the per-IP
// tier: a flood spread across many isolates/colos can exceed the cap (each
// isolate counts its own slice); it still bounds a single hot isolate and every
// casual / single-source flood with zero provisioning. For a per-colo counter,
// use Cloudflare's native Rate Limiting binding; a truly global counter is a
// Durable Object, which the account's Workers Paid plan allows (the
// per-isolate window stays by decision, being enough for a single hot isolate
// and every casual flood). Values are generous starting points (well above
// expected concurrent-legitimate load), tunable against the dashboard metrics.
const GLOBAL_CEILINGS = {
	notam: { limit: 300, windowMs: 60_000 },
	sofia: { limit: 150, windowMs: 60_000 },
	// The aviation.meteo.fr chart-PDF relay; a tier-2 bucket of its own so a
	// dossier-print storm can't starve the SOFIA briefing ceiling (tier 1
	// still classes /sofia/chart under 'sofia').
	chart: { limit: 300, windowMs: 60_000 },
	wx: { limit: 600, windowMs: 60_000 },
	// Counted on cache MISS only, so a popular aerodrome costs one fetch
	// for everyone until the edge copy ages out.
	vac: { limit: 120, windowMs: 60_000 },
	// Counted on cache MISS only: a whole-frame fetch or a listing. A cold
	// data centre filling a two-hour loop is 26 misses.
	radar: { limit: 90, windowMs: 60_000 },
};
// One sliding window per ceiling bucket (6 keys; no memory guard needed).
const ceilingHits = new Map(); // bucket -> number[] of recent upstream-call times (ms)

// --- short response cache (/notam, /sofia) ---------------------------------
// Module-global memos rather than caches.default: these two routes are POST /
// query-shaped and want a TTL in seconds, which the edge cache does not give
// per entry. Short TTL keeps safety-critical NOTAM data fresh; the entry +
// body caps bound memory (whole-FIR / full-bulletin payloads are large).
const NOTAM_CACHE_TTL_MS = 60_000;
const SOFIA_CACHE_TTL_MS = 60_000;
const RESP_CACHE_MAX = 32; // entries per cache
// Caps BOTH what is memoized and what ONE read buffers in flight (every read
// together is INFLIGHT_BUFFER_BUDGET's): an upstream body over this streams
// through to the client uncached (readUpstreamBody) instead of being fully
// materialised in the isolate.
const RESP_CACHE_MAX_BODY = 4_000_000;
// What the two memos may hold TOGETHER, counted at two bytes a character (a
// JS string's worst case): 32 entries of up to 4 MB each, per memo, could
// hold more than the isolate's 128 MB, every one of them set by a client's
// own limit / offset / POST body. The oldest entry of either memo goes first.
const RESP_CACHE_MAX_BYTES = 24_000_000;
// What the reads IN FLIGHT may buffer together, every route: past it a read
// passes the rest through (never memoized) instead of buffering, so forty
// concurrent near-cap bodies cannot hold 150 MB of an isolate's 128.
const INFLIGHT_BUFFER_BUDGET = 32_000_000;
let inflightBufferedBytes = 0;
// An answer longer than this (characters) is served and never memoized: a
// few such answers would be the whole budget.
const RESP_MEMO_MAX_CHARS = 2_000_000;
let respCacheBytes = 0;
const notamCache = new Map(); // key -> { body, contentType, status, expiresAt }
const sofiaCache = new Map();

// Single-flight: concurrent identical cache-miss requests (same cache key) share
// ONE upstream call instead of each hitting the backend before the response
// cache above is warm (a re-click storm, a fan-out). Keyed by the response-cache
// key; each entry is the in-flight Promise<record> and is deleted when it
// settles, so the maps only ever hold currently-in-flight keys.
const notamInflight = new Map(); // notamCacheKey -> Promise<record>
const sofiaInflight = new Map(); // raw POST body -> Promise<record>

export default {
	async fetch(request, env, ctx) {
		const origin = request.headers.get('Origin') ?? '';
		const allowed = (env.ALLOW_ORIGINS ?? DEFAULT_ALLOW_ORIGINS)
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		const allowOrigin = allowed.includes(origin) ? origin : '';

		// Preflight; answer here, don't forward.
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: corsHeaders(allowOrigin),
			});
		}

		if (!allowOrigin) {
			return new Response('origin not allowed', { status: 403 });
		}

		const url = new URL(request.url);

		// Tier 1, per-IP rate limit (per route class), before any upstream work.
		// Cache hits count too, so this caps total request volume; tier 2 (the
		// aggregate ceiling, enforced per handler on cache MISS) protects the
		// upstreams within that cap.
		const bucket = classifyRoute(url.pathname);
		if (bucket) {
			const rl = checkRateLimit(bucket, clientIp(request));
			if (!rl.allowed) {
				return cors(refusal('rate limited: slow down and retry', rl.retryAfterS), allowOrigin);
			}
		}

		// Live weather: served from the NOAA AWC data API, not autorouter.
		if (url.pathname.startsWith(WX_PREFIX)) {
			return handleWx(url, allowOrigin, ctx);
		}

		// Atlas VAC plates: the SIA sends no CORS header, so the browser
		// cannot read one directly.
		if (url.pathname.startsWith(VAC_PREFIX)) {
			return handleVacPlate(request, url, allowOrigin, ctx);
		}

		// SOFIA-Briefing route NOTAMs: served from the French SIA, not
		// autorouter, with a server-side session handshake (see handleSofia).
		if (url.pathname === SOFIA_SESSION_PATH) {
			return handleSofiaSession(allowOrigin);
		}
		if (url.pathname === SOFIA_CHART_PATH) {
			return handleSofiaChart(request, url, allowOrigin);
		}
		if (url.pathname === SOFIA_PATH) {
			return handleSofia(request, url, allowOrigin, ctx);
		}

		// autorouter NOTAMs: the one server-authenticated route.
		if (url.pathname === NOTAM_PATH) {
			return handleNotam(request, url, allowOrigin, env, ctx);
		}

		// EUMETNET OPERA precipitation radar: the frames index and the
		// per-frame tile relay (see the OPERA constants).
		if (url.pathname === OPERA_FRAMES_PATH) {
			return handleOperaFrames(request, url, allowOrigin, ctx);
		}
		if (url.pathname.startsWith(OPERA_PREFIX)) {
			return handleOperaFrame(request, url, allowOrigin, ctx);
		}

		return cors(new Response('not found', { status: 404 }), allowOrigin);
	},
};

/**
 * autorouter NOTAM fetch. Injects the shared application bearer token (obtained
 * server-side; any client-supplied Authorization is ignored) and retries once on
 * a 401 by force-refreshing the token. Successful (200) responses are memoized
 * for NOTAM_CACHE_TTL_MS, keyed on the FULL normalized query: every forwarded
 * param lands in the key (a key that dropped any dimension would let a
 * spoofed-Origin client poison the shared cache with a different window's
 * bulletin for every user). The `now`-anchored startvalidity / endvalidity
 * epochs are bucketed to the cache TTL inside the key, so consecutive
 * now-anchored requests still share an entry (a <=60 s stale window on a
 * 30-day forward briefing is immaterial) while a stale or crafted window can
 * never alias a live one: the two epochs are accepted only as the SPA writes
 * them, plain decimal seconds, once each (anything Number() would also read,
 * a hex or an exponent spelling, put a crafted query in the live entry while
 * the upstream received the raw spelling), and the query forwarded is rebuilt
 * from the parsed parameters, which for the SPA's own URLSearchParams query
 * is byte-identical. On a cache miss the call goes through coalesce():
 * concurrent identical requests share one upstream call (single-flight) and
 * the leader reserves the aggregate 'notam' ceiling (tier 2).
 */
async function handleNotam(request, url, allowOrigin, env, ctx) {
	if (request.method !== 'GET') {
		return cors(new Response('method not allowed', { status: 405 }), allowOrigin);
	}
	for (const name of ['startvalidity', 'endvalidity']) {
		const values = url.searchParams.getAll(name);
		if (values.length > 1 || (values.length === 1 && !VALIDITY_RE.test(values[0]))) {
			return cors(new Response('bad ' + name, { status: 400 }), allowOrigin);
		}
	}
	const key = notamCacheKey(url.searchParams);
	const hit = cacheGet(notamCache, key);
	if (hit) {
		return cors(cachedResponse(hit), allowOrigin);
	}
	const search = '?' + url.searchParams.toString();
	const rec = await coalesce(
		notamInflight,
		key,
		'notam',
		() => fetchNotamRecord(key, search, env),
		ctx,
	);
	if (rec.refused) {
		return cors(refusal(busyMessage('notam'), rec.retryAfterS), allowOrigin);
	}
	return cors(cachedResponse(rec), allowOrigin);
}

/**
 * The upstream half of handleNotam, run once per (coalesced) cache miss. Returns
 * a { body, contentType, status } record for EVERY outcome (never throws, so
 * single-flight followers get the same response): a token failure becomes the
 * 503 RFC-6749 record tokenErrorRecord builds (on the cold path AND on the 401
 * retry, so the SPA sees the same structured error for the same condition), an
 * upstream network error / timeout a 502, and a 200 is cached on the way out.
 * A body over RESP_CACHE_MAX_BODY comes back as a { stream } record instead:
 * passed through uncached, never fully buffered.
 */
async function fetchNotamRecord(key, search, env) {
	let token;
	try {
		token = await getAutorouterToken(env);
	} catch (err) {
		return tokenErrorRecord(err);
	}
	const upstreamUrl = UPSTREAM + NOTAM_PATH + search;
	let res;
	try {
		res = await fetch(upstreamUrl, bearerInit(token));
		if (res.status === 401) {
			// The token we used was rejected mid-life; resolve PAST it once (the
			// shared entry may already carry a replacement, in which case no new
			// token is minted). The resolve failing is a TOKEN failure, not an
			// upstream network error: report it as the structured 503 the cold
			// path builds.
			try {
				token = await getAutorouterToken(env, token);
			} catch (err) {
				return tokenErrorRecord(err);
			}
			res = await fetch(upstreamUrl, bearerInit(token));
		}
	} catch (err) {
		logError('upstream-error', { route: 'notam', error: err.message ?? String(err) });
		return {
			body: 'upstream error: ' + (err.message ?? String(err)),
			contentType: 'text/plain; charset=utf-8',
			status: 502,
		};
	}
	if (res.status >= 500) {
		logError('upstream-status', { route: 'notam', status: res.status });
	}
	const contentType = res.headers.get('content-type') ?? 'application/json; charset=utf-8';
	const read = await readUpstreamBody(res);
	if (read.stream) {
		return { stream: read.stream, contentType, status: res.status };
	}
	if (res.status === 200) {
		cacheSet(notamCache, key, { body: read.text, contentType, status: 200 }, NOTAM_CACHE_TTL_MS);
	}
	return { body: read.text, contentType, status: res.status };
}

function bearerInit(token) {
	return {
		headers: { Authorization: 'Bearer ' + token },
		redirect: 'follow',
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS.notam),
	};
}

// The full normalized query: every forwarded param lands in the key, sorted
// and JSON-encoded (no delimiter ambiguity between keys and values), with the
// now-anchored validity epochs bucketed to the cache TTL. See handleNotam's
// doc comment for why.
function notamCacheKey(params) {
	const entries = [];
	for (const [k, v] of params.entries()) {
		entries.push([k, k === 'startvalidity' || k === 'endvalidity' ? bucketValidity(v) : v]);
	}
	entries.sort((a, b) =>
		a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
	);
	return JSON.stringify(entries);
}

// The one spelling of a validity epoch the route accepts: decimal seconds,
// no sign, no leading zero, no exponent (handleNotam refuses any other).
const VALIDITY_RE = /^(?:0|[1-9]\d{0,11})$/;

// An epoch-seconds validity param (VALIDITY_RE-checked), quantised to the
// cache TTL.
function bucketValidity(v) {
	return 'b' + Math.floor((Number(v) * 1000) / NOTAM_CACHE_TTL_MS);
}

/**
 * Obtain the shared application bearer token: the per-isolate memo, else the
 * token another isolate published in KV, else a fresh exchange of the
 * AR_CLIENT_ID / AR_CLIENT_SECRET secrets via grant_type=client_credentials.
 * `staleToken` is the value that just failed (the /notam 401 retry passes it),
 * null on the cold path: it makes a refresh a COMPARISON rather than a flush,
 * so a token already replaced elsewhere is adopted instead of minting a second
 * one, and a failed refresh leaves the memo standing for the requests it still
 * serves. Concurrent callers replacing the same token share one resolve.
 * Throws an Error with a `.detail` string on any failure (missing secrets,
 * unreachable endpoint, non-2xx, no token).
 */
async function getAutorouterToken(env, staleToken = null) {
	const memo = usableToken(arToken, staleToken);
	if (memo) {
		return memo;
	}
	if (arTokenInflight && arTokenInflight.stale === staleToken) {
		return arTokenInflight.promise;
	}
	const entry = { stale: staleToken, promise: null };
	entry.promise = resolveAutorouterToken(env, staleToken).finally(() => {
		if (arTokenInflight === entry) {
			arTokenInflight = null;
		}
	});
	arTokenInflight = entry;
	return entry.promise;
}

/** The value of a token record usable right now: present, unexpired, and not
 *  the one that just failed. Null otherwise. */
function usableToken(rec, staleToken) {
	if (!rec || Date.now() >= rec.expiresAt || rec.value === staleToken) {
		return null;
	}
	return rec.value;
}

/**
 * Resolve a token past the memo: adopt the shared KV entry when it holds a
 * usable one (another isolate minted it; that also clears this isolate's
 * negative cache, which is serviceable again), else mint one and publish it.
 * The negative cache gates the MINT only, deliberately after the KV read: an
 * isolate whose own exchange failed 20 s ago can still adopt a token a luckier
 * isolate obtained meanwhile, which is how the fleet converges on one token
 * through a token-endpoint outage.
 */
async function resolveAutorouterToken(env, staleToken) {
	const shared = await readSharedToken(env);
	if (usableToken(shared, staleToken)) {
		arToken = shared;
		arTokenFailUntil = 0;
		arTokenFailDetail = '';
		return shared.value;
	}
	if (Date.now() < arTokenFailUntil) {
		throw tokenErr(arTokenFailDetail || 'autorouter authentication failed');
	}
	let tok;
	try {
		tok = await fetchAutorouterToken(env);
	} catch (err) {
		arTokenFailUntil = Date.now() + TOKEN_NEG_TTL_MS;
		arTokenFailDetail = (err && err.detail) || (err && err.message) || 'token error';
		logError('token-error', { detail: arTokenFailDetail });
		throw err;
	}
	arToken = tok;
	arTokenFailUntil = 0;
	arTokenFailDetail = '';
	await writeSharedToken(env, tok);
	return tok.value;
}

/** The shared token record from KV: null when the binding is absent (the
 *  per-isolate fallback), the entry is missing, or it is unreadable. A KV
 *  failure is logged and falls through to a mint, never to a failed request. */
async function readSharedToken(env) {
	const kv = env.AR_TOKEN_KV;
	if (!kv) {
		return null;
	}
	let rec;
	try {
		rec = await kv.get(TOKEN_KEY, { type: 'json', cacheTtl: TOKEN_KV_CACHE_TTL_S });
	} catch (err) {
		logError('token-store-error', { op: 'read', error: err.message ?? String(err) });
		return null;
	}
	const usable = rec && typeof rec.value === 'string' && typeof rec.expiresAt === 'number';
	return usable ? rec : null;
}

/** Publish a freshly minted token for the other isolates. The entry expires
 *  with the token itself, so a dead one is never there to adopt. */
async function writeSharedToken(env, tok) {
	const kv = env.AR_TOKEN_KV;
	if (!kv) {
		return;
	}
	const ttlS = Math.max(TOKEN_KV_MIN_TTL_S, Math.ceil((tok.expiresAt - Date.now()) / 1000));
	try {
		await kv.put(TOKEN_KEY, JSON.stringify(tok), { expirationTtl: ttlS });
	} catch (err) {
		logError('token-store-error', { op: 'write', error: err.message ?? String(err) });
	}
}

async function fetchAutorouterToken(env) {
	const clientId = env.AR_CLIENT_ID;
	const clientSecret = env.AR_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		throw tokenErr('autorouter application credentials are not configured');
	}
	const body = new URLSearchParams({
		grant_type: 'client_credentials',
		client_id: clientId,
		client_secret: clientSecret,
	});
	let res;
	try {
		res = await fetch(AR_TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
			redirect: 'follow',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS.token),
		});
	} catch (err) {
		throw tokenErr('cannot reach autorouter: ' + (err.message ?? String(err)));
	}
	if (!res.ok) {
		let detail = '';
		try {
			detail = tokenErrorDetail(await res.text());
		} catch {
			/* leave detail empty */
		}
		throw tokenErr('autorouter token HTTP ' + res.status + (detail ? ': ' + detail : ''));
	}
	let data;
	try {
		data = await res.json();
	} catch {
		throw tokenErr('autorouter token response was not JSON');
	}
	if (!data || !data.access_token) {
		throw tokenErr('autorouter token response had no access_token');
	}
	const ttl = typeof data.expires_in === 'number' ? data.expires_in : 3600;
	// Refresh 60 s early so a request issued near expiry still arrives valid.
	return { value: data.access_token, expiresAt: Date.now() + Math.max(0, ttl - 60) * 1000 };
}

// The human half of an upstream token-error body: the RFC 6749 section 5.2
// error_description autorouter answers with, else its error code, else the raw
// text; trimmed and capped either way. Mirrors the SPA's humanErrorDetail
// (src/lib/autorouter/errorDetail.ts), which unwraps one layer only: embedding
// the body verbatim here put raw nested JSON in the user's error line.
function tokenErrorDetail(body) {
	const raw = body.trim();
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return capDetail(raw);
	}
	if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
		for (const field of ['error_description', 'error']) {
			const v = parsed[field];
			if (typeof v === 'string' && v.trim() !== '') {
				return capDetail(v);
			}
		}
	}
	return capDetail(raw);
}

function capDetail(s) {
	return s.trim().slice(0, TOKEN_DETAIL_MAX);
}

function tokenErr(detail) {
	const e = new Error(detail || 'autorouter token error');
	e.detail = detail || 'autorouter token error';
	return e;
}

// A 503 record with an RFC-6749-shaped JSON body so the SPA's humanErrorDetail
// unwraps the reason into the error line. A record (not a Response) so it flows
// through coalesce / cachedResponse like any other /notam outcome.
function tokenErrorRecord(err) {
	const detail = (err && err.detail) || 'could not obtain autorouter token';
	return {
		body: JSON.stringify({ error: 'token_unavailable', error_description: detail }),
		contentType: 'application/json; charset=utf-8',
		status: 503,
	};
}

// --- rate-limit helpers ----------------------------------------------------

function classifyRoute(pathname) {
	if (pathname === NOTAM_PATH) {
		return 'notam';
	}
	if (pathname === SOFIA_PATH || pathname.startsWith(SOFIA_PATH + '/')) {
		return 'sofia';
	}
	if (pathname.startsWith(WX_PREFIX)) {
		return 'wx';
	}
	if (pathname.startsWith(VAC_PREFIX)) {
		return 'vac';
	}
	if (pathname.startsWith(OPERA_PREFIX)) {
		return 'radar';
	}
	return null;
}

function clientIp(request) {
	return rateKeyIp(
		request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown',
	);
}

// The per-IP limiter's key for an address: an IPv4 address whole, an IPv6
// one by its /64, the block one subscriber is handed. Keyed on the whole
// address, one /64 was 2^64 fresh identities, each with a full window, and a
// client rotating through them met no per-IP limit on any route.
function rateKeyIp(ip) {
	if (!ip.includes(':')) {
		return ip;
	}
	// An IPv4 client reaching an IPv6 socket (::ffff:a.b.c.d) is that IPv4
	// client: its /64 is ::, which every such client would share.
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip.split('%')[0]);
	if (mapped) {
		return mapped[1];
	}
	const [head, tail = ''] = ip.split('%')[0].split('::');
	const left = head === '' ? [] : head.split(':');
	const right = tail === '' ? [] : tail.split(':');
	const groups = ip.includes('::')
		? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
		: left;
	return (
		groups
			.slice(0, 4)
			.map((g) => (g === '' ? '0' : g.toLowerCase().replace(/^0+(?=.)/, '')))
			.join(':') + '::/64'
	);
}

// The shared sliding-window core: prune map[key] to the last windowMs, then
// admit-and-record or refuse. Returns { allowed, retryAfterS }, retryAfterS the
// whole seconds until the oldest in-window hit ages out (>= 1). Both rate-limit
// tiers use it; the caller owns the map and any memory guard.
function slidingWindowAllow(map, key, limit, windowMs, now) {
	let hits = map.get(key);
	if (!hits) {
		hits = [];
		map.set(key, hits);
	}
	// Drop timestamps outside the window, in place.
	const cutoff = now - windowMs;
	let w = 0;
	for (let i = 0; i < hits.length; i++) {
		if (hits[i] > cutoff) {
			hits[w++] = hits[i];
		}
	}
	hits.length = w;
	if (hits.length >= limit) {
		const retryAfterS = Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000));
		return { allowed: false, retryAfterS };
	}
	hits.push(now);
	return { allowed: true, retryAfterS: 0 };
}

// Tier 1: per-(class, IP) sliding window. Bounds the per-IP map before the
// helper creates a new key (one key per IP; the ceiling map needs no guard):
// past RL_MAX_KEYS the LEAST RECENTLY USED key goes, never the whole map,
// which forgot every window at once, the flooding client's included, so
// enough fresh keys reset the limit for everyone.
function checkRateLimit(bucket, ip) {
	const cfg = RATE_LIMITS[bucket];
	if (!cfg) {
		return { allowed: true, retryAfterS: 0 };
	}
	const key = bucket + '|' + ip;
	const held = rlHits.get(key);
	if (held) {
		// Re-inserted at the end: the Map's order is its use order.
		rlHits.delete(key);
		rlHits.set(key, held);
	} else {
		while (rlHits.size >= RL_MAX_KEYS) {
			rlHits.delete(rlHits.keys().next().value);
		}
	}
	return slidingWindowAllow(rlHits, key, cfg.limit, cfg.windowMs, Date.now());
}

// Tier 2: reserve one aggregate upstream slot for the route class. Called only
// on a cache miss, immediately before the upstream call (in coalesce for /notam
// and /sofia, inline for /wx, /sia/vac and the radar), so cached hits never count.
function reserveUpstream(bucket) {
	const cfg = GLOBAL_CEILINGS[bucket];
	if (!cfg) {
		return { allowed: true, retryAfterS: 0 };
	}
	const res = slidingWindowAllow(ceilingHits, bucket, cfg.limit, cfg.windowMs, Date.now());
	if (!res.allowed) {
		logError('ceiling-refused', { route: bucket, retryAfterS: res.retryAfterS });
	}
	return res;
}

// A 429 refusal with a Retry-After hint (seconds), used by both tiers. The
// browser can read Retry-After because corsHeaders exposes it.
function refusal(message, retryAfterS) {
	const res = new Response(message, { status: 429 });
	res.headers.set('content-type', 'text/plain; charset=utf-8');
	if (retryAfterS > 0) {
		res.headers.set('Retry-After', String(retryAfterS));
	}
	return res;
}

function busyMessage(bucket) {
	return `server busy: too many ${bucket} requests, retry shortly`;
}

/**
 * Single-flight + tier-2 ceiling for a cache-miss upstream call. If another
 * request for `key` is already in flight, await ITS result (follower: no ceiling
 * reservation, no upstream call). Otherwise reserve the ceiling (leader); on
 * refusal return a { refused, retryAfterS } marker, else run produce(), publish
 * its promise under `key` for followers to share, and clear it once settled.
 * produce() resolves to a { body, contentType, status } record; a defensive
 * catch turns any unexpected throw into a 502 record so a shared promise never
 * rejects a follower. (One isolate is single-threaded, so get -> reserve -> set
 * runs with no await between: two concurrent requests can't both become leader.)
 *
 * `ctx.waitUntil` keeps the LEADER alive past its own client. A client that
 * gives up (the SPA's briefing budget expiring, a closed tab) has its request
 * context cancelled, and without this the leader's promise would neither
 * settle nor clear its inflight key: the SPA's retry, which repeats a
 * byte-identical body and so hits the same key, would then follow a promise
 * that can never resolve and hang until it too gave up. That is the one
 * failure a retry exists to recover, so the leader finishes on its own,
 * frees the key and warms the response cache, which turns that retry into a
 * cache hit. Costs nothing when the client stays: the promise is already
 * awaited below.
 */
async function coalesce(inflight, key, bucket, produce, ctx) {
	const pending = inflight.get(key);
	if (pending) {
		return pending;
	}
	const reservation = reserveUpstream(bucket);
	if (!reservation.allowed) {
		return { refused: true, retryAfterS: reservation.retryAfterS };
	}
	const promise = (async () => {
		try {
			return await produce();
		} catch (err) {
			logError('upstream-error', {
				route: bucket,
				error: err && err.message ? err.message : String(err),
			});
			return {
				body: 'upstream error: ' + (err && err.message ? err.message : String(err)),
				contentType: 'text/plain; charset=utf-8',
				status: 502,
			};
		}
	})();
	inflight.set(key, promise);
	// Clear the key from the promise itself, not from the await below: the
	// await belongs to this client and dies with it, while the promise settles
	// on its own under waitUntil.
	const settled = promise.finally(() => inflight.delete(key));
	if (ctx && typeof ctx.waitUntil === 'function') {
		ctx.waitUntil(settled);
	}
	return settled;
}

// --- response-cache helpers ------------------------------------------------

function cacheGet(cache, key) {
	const e = cache.get(key);
	if (!e) {
		return null;
	}
	if (Date.now() >= e.expiresAt) {
		cacheDrop(cache, key);
		return null;
	}
	return e;
}

function memoBytes(entry) {
	return 2 * (typeof entry.body === 'string' ? entry.body.length : 0);
}

function cacheDrop(cache, key) {
	const e = cache.get(key);
	if (e) {
		cache.delete(key);
		respCacheBytes -= memoBytes(e);
	}
}

function cacheSet(cache, key, entry, ttlMs) {
	cacheDrop(cache, key); // re-inserted at the end, for oldest-first eviction
	if (typeof entry.body === 'string' && entry.body.length > RESP_MEMO_MAX_CHARS) {
		return;
	}
	entry.expiresAt = Date.now() + ttlMs;
	cache.set(key, entry);
	respCacheBytes += memoBytes(entry);
	while (cache.size > RESP_CACHE_MAX) {
		cacheDrop(cache, cache.keys().next().value);
	}
	// Both memos carry one TTL, so their insertion order is their age: the
	// older of the two heads goes first.
	while (respCacheBytes > RESP_CACHE_MAX_BYTES) {
		const a = notamCache.values().next().value;
		const b = sofiaCache.values().next().value;
		if (!a && !b) {
			respCacheBytes = 0;
			break;
		}
		const from = !b || (a && a.expiresAt <= b.expiresAt) ? notamCache : sofiaCache;
		cacheDrop(from, from.keys().next().value);
	}
}

// Build a Response from a cache / coalesce record. Text records (the normal
// case) replay freely. Stream records (an over-cap body passed through, see
// readUpstreamBody) are single-consumer: the first caller (the coalesce
// leader, in practice) streams it; a follower arriving second gets a
// retryable refusal, since the response cache never warms for these.
function cachedResponse(entry) {
	if (entry.stream) {
		if (entry.streamTaken) {
			return refusal('response too large to share; retry', 1);
		}
		entry.streamTaken = true;
		const out = new Response(entry.stream, { status: entry.status });
		out.headers.set('content-type', entry.contentType);
		return out;
	}
	const out = new Response(entry.body, { status: entry.status });
	out.headers.set('content-type', entry.contentType);
	return out;
}

// --- capped body reads -----------------------------------------------------

// Concatenate + UTF-8-decode the chunks of a capped read (decoding the whole
// buffer at once keeps multi-byte characters split across chunks intact).
function decodeChunks(chunks, total) {
	const buf = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		buf.set(c, off);
		off += c.byteLength;
	}
	return new TextDecoder().decode(buf);
}

/**
 * Read a request body under a hard byte cap. Rejects on a declared
 * Content-Length over the cap before reading anything, and aborts a chunked /
 * undeclared body the moment the running total passes the cap, so an
 * oversized POST is never fully buffered in the isolate. Returns the decoded
 * string, or null when the cap was exceeded.
 */
async function readRequestBodyCapped(request, maxBytes) {
	const declared = Number(request.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) {
		return null;
	}
	if (!request.body) {
		return '';
	}
	const reader = request.body.getReader();
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel('body too large');
			return null;
		}
		chunks.push(value);
	}
	return decodeChunks(chunks, total);
}

/**
 * Read an upstream response body under the cache body cap. Within the cap the
 * full text comes back ({ text }): memoizable, safely shared by coalesced
 * followers. Beyond it (a declared Content-Length over the cap, or the cap
 * crossed mid-read) nothing more is buffered: the bytes already read are
 * re-joined with the rest of the upstream stream and handed back as a
 * pass-through ({ stream }), never cached (see cachedResponse).
 */
async function readUpstreamBody(res) {
	const declared = Number(res.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > RESP_CACHE_MAX_BODY) {
		return { stream: res.body };
	}
	if (!res.body) {
		return { text: '' };
	}
	const reader = res.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			chunks.push(value);
			total += value.byteLength;
			inflightBufferedBytes += value.byteLength;
			// Past the per-body cap, or past what every read in flight may
			// buffer together: pass the rest through instead of holding it.
			if (total > RESP_CACHE_MAX_BODY || inflightBufferedBytes > INFLIGHT_BUFFER_BUDGET) {
				reader.releaseLock();
				return { stream: prefixedStream(chunks, res.body) };
			}
		}
		return { text: decodeChunks(chunks, total) };
	} finally {
		inflightBufferedBytes -= total;
	}
}

// The buffered prefix of an over-cap read, then the rest of the upstream
// stream, as one ReadableStream.
function prefixedStream(prefix, rest) {
	const reader = rest.getReader();
	let i = 0;
	return new ReadableStream({
		async pull(controller) {
			if (i < prefix.length) {
				controller.enqueue(prefix[i++]);
				return;
			}
			const { done, value } = await reader.read();
			if (done) {
				controller.close();
			} else {
				controller.enqueue(value);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}


/**
 * Live METAR / TAF proxy. The NOAA Aviation Weather Center data API
 * (https://aviationweather.gov/api/data/) sends no CORS headers, so the
 * browser can't call it directly. Only two endpoints are exposed
 * (/wx/metar, /wx/taf) with a whitelisted query surface: `ids` (a short
 * comma-separated ident list) or `bbox` (minLat,minLon,maxLat,maxLon with a
 * bounded span), plus `taf=true` on the metar endpoint; `format=json` is
 * forced. Responses are edge-cached for WX_TTL_S on the normalised URL, which
 * is a real cache here (a custom domain), so one observation serves every
 * client on a colo for its TTL; the client's own copy is never kept
 * (clientNoStore).
 */
async function handleWx(url, allowOrigin, ctx) {
	const endpoint = url.pathname.slice(WX_PREFIX.length);
	if (!WX_ENDPOINTS.has(endpoint) && !WX_GLOBAL_ENDPOINTS.has(endpoint)) {
		return cors(new Response('not found', { status: 404 }), allowOrigin);
	}

	const ids = url.searchParams.get('ids');
	const bbox = url.searchParams.get('bbox');
	const params = new URLSearchParams();
	if (WX_GLOBAL_ENDPOINTS.has(endpoint)) {
		// Whole-world feeds by design; refusing scoping params keeps one
		// shared cache entry per endpoint.
		if (ids != null || bbox != null) {
			return cors(new Response('no params for this endpoint', { status: 400 }), allowOrigin);
		}
	} else if (ids != null && bbox == null) {
		if (!WX_IDS_RE.test(ids)) {
			return cors(new Response('bad ids', { status: 400 }), allowOrigin);
		}
		params.set('ids', ids.toUpperCase());
	} else if (bbox != null && ids == null) {
		const parts = bbox.split(',').map(Number);
		const [minLat, minLon, maxLat, maxLon] = parts;
		const ok =
			parts.length === 4 &&
			parts.every(Number.isFinite) &&
			minLat >= -90 && maxLat <= 90 && minLat < maxLat &&
			minLon >= -180 && maxLon <= 180 && minLon < maxLon &&
			maxLat - minLat <= WX_BBOX_MAX_SPAN_DEG &&
			maxLon - minLon <= WX_BBOX_MAX_SPAN_DEG;
		if (!ok) {
			return cors(new Response('bad bbox', { status: 400 }), allowOrigin);
		}
		// Round to a coarse grid so nearby clients share cache entries.
		params.set('bbox', parts.map((n) => n.toFixed(2)).join(','));
	} else {
		return cors(new Response('ids or bbox required', { status: 400 }), allowOrigin);
	}
	if (endpoint === 'metar' && url.searchParams.get('taf') === 'true') {
		params.set('taf', 'true');
	}
	params.set('format', 'json');

	// Edge cache on the worker's own normalised URL (params in a fixed
	// order); CORS is layered on per-request below.
	const cache = caches.default;
	const cacheKey = new Request(`${url.origin}${WX_PREFIX}${endpoint}?${params}`, {
		method: 'GET',
	});
	let cached = await cache.match(cacheKey);
	if (!cached) {
		// Tier-2 ceiling before the upstream call. Counted on cache MISS only,
		// so with the edge cache live only the first reader of an observation
		// spends from the (already generous) wx ceiling.
		const reservation = reserveUpstream('wx');
		if (!reservation.allowed) {
			return cors(refusal(busyMessage('wx'), reservation.retryAfterS), allowOrigin);
		}
		let upstream;
		try {
			upstream = await fetch(`${AWC_BASE}${endpoint}?${params}`, {
				redirect: 'follow',
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS.wx),
			});
		} catch (err) {
			logError('upstream-error', { route: 'wx', error: err.message ?? String(err) });
			return cors(
				new Response('upstream error: ' + (err.message ?? String(err)), {
					status: 502,
				}),
				allowOrigin,
			);
		}
		if (!upstream.ok) {
			// Pass an upstream failure through (rate limit, outage); don't cache it.
			if (upstream.status >= 500) {
				logError('upstream-status', { route: 'wx', status: upstream.status });
			}
			return cors(new Response(upstream.body, { status: upstream.status }), allowOrigin);
		}
		// An ident with no station at all answers 204 No Content; normalise to
		// the empty JSON array every other miss returns.
		const body = upstream.status === 204 ? '[]' : upstream.body;
		cached = new Response(body, {
			status: 200,
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'cache-control': `public, max-age=${WX_TTL_S}`,
			},
		});
		ctx.waitUntil(cache.put(cacheKey, cached.clone()));
	}

	return cors(clientNoStore(new Response(cached.body, { status: 200, headers: cached.headers })), allowOrigin);
}

/** Fetch an anonymous JSESSIONID from the SIA homepage. Both handleSofia and the
 *  /sofia/session route (which lets a multi-route briefing reuse one session
 *  instead of one handshake per route) share this. Returns the token, or '' if
 *  the homepage response carried no JSESSIONID; throws on a network error. */
async function sofiaSession() {
	const home = await fetch(`${SOFIA_BASE}/sofia/pages/homepage.html`, {
		headers: { 'User-Agent': SOFIA_UA },
		redirect: 'follow',
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS.session),
	});
	const setCookie =
		typeof home.headers.getSetCookie === 'function'
			? home.headers.getSetCookie().join('; ')
			: (home.headers.get('set-cookie') ?? '');
	const m = /JSESSIONID=([^;,\s]+)/.exec(setCookie);
	return m ? m[1] : '';
}

/** GET /sofia/session: hand the client one anonymous JSESSIONID so it can reuse
 *  it across a multi-route briefing (each /sofia POST passes it back as
 *  ?session=), instead of the worker running a fresh homepage handshake per
 *  route. The token is anonymous (no login), so exposing it to the browser is
 *  harmless; it is never a credential, and a client that skips this route just
 *  handshakes per route. */
async function handleSofiaSession(allowOrigin) {
	// Tier-2 ceiling: every /sofia/session is an upstream call (never cached),
	// so it reserves the aggregate 'sofia' slot like any other cache miss.
	const reservation = reserveUpstream('sofia');
	if (!reservation.allowed) {
		return cors(refusal(busyMessage('sofia'), reservation.retryAfterS), allowOrigin);
	}
	let jsession;
	try {
		jsession = await sofiaSession();
	} catch (err) {
		logError('upstream-error', { route: 'sofia-session', error: err.message ?? String(err) });
		return cors(
			new Response('sofia session error: ' + (err.message ?? String(err)), { status: 502 }),
			allowOrigin,
		);
	}
	if (!jsession) {
		return cors(new Response('sofia session error: no JSESSIONID', { status: 502 }), allowOrigin);
	}
	const out = new Response(JSON.stringify({ session: jsession }), { status: 200 });
	out.headers.set('content-type', 'application/json; charset=utf-8');
	return cors(out, allowOrigin);
}

/**
 * SOFIA-Briefing route-NOTAM proxy. The French SIA briefing backend
 * (sofia-briefing.aviation-civile.gouv.fr) is a Java servlet app: NOTAM
 * consultation is anonymous, but the briefing POST needs a JSESSIONID session
 * cookie plus request headers a browser won't let a script set (Origin,
 * Referer, Cookie, X-Requested-With). This handler does that handshake
 * server-side, so the SPA just POSTs the briefing body and gets the JSON back:
 *   1. GET /sofia/pages/homepage.html to obtain an anonymous JSESSIONID
 *      (skipped when the client passes a reusable one as ?session=, see
 *      handleSofiaSession).
 *   2. POST /sofia with that cookie + the forbidden headers, forwarding the
 *      client's x-www-form-urlencoded body verbatim.
 * The body is the client-built SOFIA form (:operation=postNarrowRoutePibRequest
 * &route[]=...&width=...); the client owns that (uncertain, evolving) schema so
 * the worker stays a stable relay. No secrets, no cookies reach the browser.
 *
 * Successful (200) responses are memoized for SOFIA_CACHE_TTL_MS keyed on the
 * RAW POST body (bodies are capped at SOFIA_MAX_BODY and the cache at
 * RESP_CACHE_MAX entries, so key memory is bounded, and unlike a short hash no
 * two different briefings can ever collide onto one entry), so repeated
 * "Get NOTAMs" re-clicks for the same route are served without re-hitting the
 * flood-prone SIA backend (the ?session= param is not part of the key; it does
 * not change the bulletin, but it IS validated against the JSESSIONID charset
 * before it is replayed in the upstream Cookie header). On a cache miss the
 * handshake + POST run through coalesce(): concurrent identical briefings share
 * one upstream call (single-flight) and the leader reserves the 'sofia' ceiling.
 */
async function handleSofia(request, url, allowOrigin, ctx) {
	if (request.method !== 'POST') {
		return cors(new Response('method not allowed', { status: 405 }), allowOrigin);
	}
	const session = url.searchParams.get('session') ?? '';
	if (session && !SOFIA_SESSION_RE.test(session)) {
		return cors(new Response('bad session', { status: 400 }), allowOrigin);
	}
	const body = await readRequestBodyCapped(request, SOFIA_MAX_BODY);
	if (body === null) {
		return cors(new Response('body too large', { status: 413 }), allowOrigin);
	}
	const hit = cacheGet(sofiaCache, body);
	if (hit) {
		return cors(cachedResponse(hit), allowOrigin);
	}
	const rec = await coalesce(
		sofiaInflight,
		body,
		'sofia',
		() => fetchSofiaRecord(session, body),
		ctx,
	);
	if (rec.refused) {
		return cors(refusal(busyMessage('sofia'), rec.retryAfterS), allowOrigin);
	}
	return cors(cachedResponse(rec), allowOrigin);
}

/**
 * The session handshake + briefing POST, run once per (coalesced) cache miss.
 * Returns a { body, contentType, status } record for EVERY outcome (never
 * throws): a missing / failed JSESSIONID or an upstream network error becomes a
 * plain-text 502 (kept plain text, like the 429 ceiling refusal, so the SPA's
 * SOFIA client surfaces the HTTP-framed line instead of losing a JSON body),
 * and a 200 is cached on the way out (keyed on the raw body). A response over
 * RESP_CACHE_MAX_BODY comes back as a { stream } record: passed through
 * uncached, never fully buffered. `session` is the optional reusable cookie
 * the client passed as ?session= (already validated by handleSofia); empty
 * means fetch a fresh one here.
 */
async function fetchSofiaRecord(session, body) {
	// Step 0: anonymous session cookie. Reuse the client's ?session= across a
	// multi-route briefing, else fetch a fresh JSESSIONID from the homepage.
	let jsession = session;
	if (!jsession) {
		try {
			jsession = await sofiaSession();
		} catch (err) {
			logError('upstream-error', { route: 'sofia-session', error: err.message ?? String(err) });
			return sofiaSessionErrorRecord(err.message ?? String(err));
		}
	}
	if (!jsession) {
		return sofiaSessionErrorRecord('no JSESSIONID');
	}
	// Step 1: the briefing POST. Origin / Referer / Cookie / X-Requested-With are
	// the headers a browser forbids a script from setting; the Worker runtime
	// allows them on a subrequest.
	let upstream;
	try {
		upstream = await fetch(`${SOFIA_BASE}${SOFIA_PATH}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
				'X-Requested-With': 'XMLHttpRequest',
				Accept: 'application/json, text/javascript, */*',
				Cookie: `JSESSIONID=${jsession}`,
				Origin: SOFIA_BASE,
				Referer: `${SOFIA_BASE}/sofia/pages/notamsearchroute.html`,
				'User-Agent': SOFIA_UA,
			},
			body,
			redirect: 'follow',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS.sofia),
		});
	} catch (err) {
		logError('upstream-error', { route: 'sofia', error: err.message ?? String(err) });
		return {
			body: 'upstream error: ' + (err.message ?? String(err)),
			contentType: 'text/plain; charset=utf-8',
			status: 502,
		};
	}
	if (upstream.status >= 500) {
		logError('upstream-status', { route: 'sofia', status: upstream.status });
	}
	// Pass the JSON body + status through (cookies / connection headers dropped);
	// memoize a success. Mirrors the autorouter passthrough.
	const contentType = upstream.headers.get('content-type') ?? 'application/json; charset=utf-8';
	const read = await readUpstreamBody(upstream);
	if (read.stream) {
		return { stream: read.stream, contentType, status: upstream.status };
	}
	if (upstream.status === 200) {
		cacheSet(sofiaCache, body, { body: read.text, contentType, status: 200 }, SOFIA_CACHE_TTL_MS);
	}
	return { body: read.text, contentType, status: upstream.status };
}

function sofiaSessionErrorRecord(detail) {
	return {
		body: 'sofia session error: ' + detail,
		contentType: 'text/plain; charset=utf-8',
		status: 502,
	};
}

/**
 * TEMSI / WINTEM chart PDF relay. The SOFIA chart catalog (POST /sofia,
 * :operation=postTemsi / postWintem) returns tokenized, EXPIRING links on
 * aviation.meteo.fr, which sends no CORS headers, so the SPA cannot read the
 * PDF bytes to rasterize charts into the printed flight dossier. The client
 * copies the link's three query params here; the worker rebuilds the upstream
 * URL from the fixed base plus exactly those validated params (never a
 * client-supplied URL), refuses redirects (nothing can step outside the
 * base), and streams the PDF back uncached: the upstream says no-store and
 * the token expires, so nothing is persisted or rehosted.
 */
async function handleSofiaChart(request, url, allowOrigin) {
	if (request.method !== 'GET') {
		return cors(new Response('method not allowed', { status: 405 }), allowOrigin);
	}
	const login = url.searchParams.get('login') ?? '';
	const layer = url.searchParams.get('layer') ?? '';
	const echeance = url.searchParams.get('echeance') ?? '';
	if (
		!CHART_LOGIN_RE.test(login) ||
		!CHART_LAYER_RE.test(layer) ||
		!CHART_ECHEANCE_RE.test(echeance)
	) {
		return cors(new Response('bad chart params', { status: 400 }), allowOrigin);
	}
	// Tier-2 ceiling: every chart fetch is an upstream call (never cached), so
	// it reserves the dedicated 'chart' slot before touching aviation.meteo.fr.
	const reservation = reserveUpstream('chart');
	if (!reservation.allowed) {
		return cors(refusal(busyMessage('chart'), reservation.retryAfterS), allowOrigin);
	}
	// layer and echeance are raw-safe by their charsets; login (base64) needs
	// its + / = re-encoded exactly as the catalog link carries them.
	const upstreamUrl =
		`${METEO_CHART_BASE}?login=${encodeURIComponent(login)}` +
		`&layer=${layer}&echeance=${echeance}`;
	let upstream;
	try {
		upstream = await fetch(upstreamUrl, {
			headers: { 'User-Agent': SOFIA_UA },
			// The Workers runtime rejects redirect:'error'; 'manual' plus the
			// 3xx refusal below keeps a redirect from stepping outside the
			// fixed upstream base.
			redirect: 'manual',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS.chart),
		});
	} catch (err) {
		logError('upstream-error', { route: 'chart', error: err.message ?? String(err) });
		return cors(
			new Response('upstream error: ' + (err.message ?? String(err)), { status: 502 }),
			allowOrigin,
		);
	}
	if (upstream.status >= 300 && upstream.status < 400) {
		logError('upstream-status', { route: 'chart', status: upstream.status });
		return cors(new Response('upstream redirect refused', { status: 502 }), allowOrigin);
	}
	if (upstream.status >= 500) {
		logError('upstream-status', { route: 'chart', status: upstream.status });
	}
	// Pass body + status through (an expired token's error page included, so
	// the client's res.ok check counts it as a failed chart).
	const out = new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
	});
	const ct = upstream.headers.get('content-type');
	if (ct) {
		out.headers.set('content-type', ct);
	}
	out.headers.set('cache-control', 'no-store');
	return cors(out, allowOrigin);
}

/**
 * One Atlas VAC plate, relayed because the SIA publishes no CORS header.
 *
 * The path carries the AIRAC cycle segment and the plate name, and nothing
 * else: `/sia/vac/06_AUG_2026/AD-2.LFPL.pdf`. Section 2 is the aerodrome
 * product and section 3 the helistation one, and each spells its own
 * directory, which is why the product is derived rather than passed. Both
 * fields are on charsets that cannot express a traversal, and the upstream
 * base is fixed, so this is a relay for one file shape and not a GET proxy.
 *
 * Edge-cached for a year and immutable: a plate does not change within its
 * cycle, and a new cycle is a new path.
 */
async function handleVacPlate(request, url, allowOrigin, ctx) {
	if (request.method !== 'GET') {
		return cors(new Response('method not allowed', { status: 405 }), allowOrigin);
	}
	if (url.search !== '') {
		// Nothing in a query is meaningful here; refusing keeps the cache
		// key clean, the /wx rule.
		return cors(new Response('bad request', { status: 400 }), allowOrigin);
	}
	const m = VAC_RE.exec(url.pathname);
	if (!m) {
		return cors(new Response('bad plate path', { status: 400 }), allowOrigin);
	}
	const [, cycle, section, code] = m;
	const product = section === '3' ? 'VACH' : 'VAC';
	const name = `AD-${section}.${code}.pdf`;

	const cache = caches.default;
	const cacheKey = new Request(url.toString(), { method: 'GET' });
	let cached = await cache.match(cacheKey);
	if (!cached) {
		const reservation = reserveUpstream('vac');
		if (!reservation.allowed) {
			return cors(refusal(busyMessage('vac'), reservation.retryAfterS), allowOrigin);
		}
		const upstreamUrl =
			`${SIA_MEDIA_BASE}eAIP_${cycle}/Atlas-VAC/PDF_AIPparSSection/` +
			`${product}/AD/${name}`;
		let upstream;
		try {
			upstream = await fetch(upstreamUrl, {
				// The SIA host answers empty / bot user agents inconsistently.
				headers: { 'User-Agent': SOFIA_UA },
				redirect: 'follow',
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS.vac),
			});
		} catch (err) {
			logError('upstream-error', { route: 'vac', error: err.message ?? String(err) });
			return cors(
				new Response('upstream error: ' + (err.message ?? String(err)), { status: 502 }),
				allowOrigin,
			);
		}
		if (!upstream.ok) {
			// A plate the atlas does not carry; pass the miss through and
			// do not cache it. A server error is logged: the plates a
			// cycle's pack could not read fall back to this relay.
			if (upstream.status >= 500) {
				logError('upstream-status', { route: 'vac', status: upstream.status });
			}
			return cors(new Response(null, { status: upstream.status }), allowOrigin);
		}
		// The SIA answers a missing file with an HTML error page under a 200,
		// so the content type is checked before anything is cached or handed
		// back as a chart.
		const ct = upstream.headers.get('content-type') ?? '';
		if (!ct.toLowerCase().includes('pdf')) {
			logError('upstream-error', { route: 'vac', error: 'non-pdf response: ' + ct });
			return cors(new Response(null, { status: 404 }), allowOrigin);
		}
		cached = new Response(upstream.body, {
			status: 200,
			headers: {
				'content-type': 'application/pdf',
				'cache-control': 'public, max-age=31536000, immutable',
			},
		});
		ctx.waitUntil(cache.put(cacheKey, cached.clone()));
	}
	return cors(new Response(cached.body, { status: 200, headers: cached.headers }), allowOrigin);
}

/**
 * The frames the bucket holds for the last `hours` (1 to 6) of one product,
 * as JSON: { product, frames: [{ t, bytes, publishedAt }], now }, ascending
 * by slot. One S3 listing per UTC day the window touches (two across 00Z),
 * each on the day's key prefix, single-flighted per key and edge-cached
 * for a minute: a new frame lands every five, so the client asks at the
 * expected publication instant and this answers every reader in a data
 * centre from one listing. `now` is this clock, which the client measures
 * ages from (a device clock may be off).
 */
async function handleOperaFrames(request, url, allowOrigin, ctx) {
	if (request.method !== 'GET') {
		return cors(new Response('method not allowed', { status: 405 }), allowOrigin);
	}
	const product = url.searchParams.get('product') ?? 'DBZH';
	const hoursRaw = url.searchParams.get('hours') ?? '3';
	const hours = /^\d$/.test(hoursRaw) ? Number(hoursRaw) : NaN;
	const extra = [...url.searchParams.keys()].some((k) => k !== 'product' && k !== 'hours');
	// Own keys only: `in` would admit `toString` or `constructor` through
	// the prototype and answer an empty list for a product that is not one.
	if (!Object.hasOwn(OPERA_PRODUCTS, product) || !(hours >= 1 && hours <= OPERA_INDEX_MAX_HOURS) || extra) {
		return cors(new Response('bad frames query', { status: 400 }), allowOrigin);
	}
	const cache = caches.default;
	// Normalised key: the two validated params only, so every reader shares
	// the minute's entry whatever the order they wrote them in.
	const cacheKey = new Request(`${url.origin}${OPERA_FRAMES_PATH}?product=${product}&hours=${hours}`, {
		method: 'GET',
	});
	let cached = await cache.match(cacheKey);
	if (!cached) {
		// The put is awaited INSIDE the leader (the frame path's rule): the
		// key clears only once the edge holds the listing, so no reader falls
		// between the two and starts a second listing on a second ceiling slot.
		const record = await coalesce(
			operaInflight,
			cacheKey.url,
			'radar',
			async () => {
				const rec = await listOperaFrames(product, hours);
				if (rec.status === 200) {
					try {
						await cache.put(cacheKey, operaListingResponse(rec.body));
					} catch (err) {
						logError('cache-put-failed', { route: 'radar', error: err && err.message ? err.message : String(err) });
					}
				}
				return rec;
			},
			ctx,
		);
		if (record.refused) {
			return cors(refusal(busyMessage('radar'), record.retryAfterS), allowOrigin);
		}
		if (record.status !== 200) {
			return cors(
				new Response(record.body, {
					status: record.status,
					headers: { 'content-type': record.contentType },
				}),
				allowOrigin,
			);
		}
		cached = operaListingResponse(record.body);
	}
	// The EDGE copy carries the 60 s; the CLIENT copy is never kept
	// (clientNoStore: a browser that held the list for four hours never saw
	// another frame). The body's `now` is the LISTING's instant, up to the
	// edge TTL behind a hit; the serve time rides a per-request header so
	// the client measures every age from the instant it was answered.
	const out = new Response(cached.body, { status: 200, headers: cached.headers });
	out.headers.set('x-opera-now', new Date(Date.now()).toISOString());
	return cors(clientNoStore(out), allowOrigin);
}

/** The listing's edge copy (and each reader's answer): the edge keeps it
 *  OPERA_INDEX_TTL_S. */
function operaListingResponse(body) {
	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': `public, max-age=${OPERA_INDEX_TTL_S}`,
		},
	});
}

/** The listing itself: a { body, contentType, status } record (coalesce's
 *  shape). Keys look like
 *  2026/09/20/OPERA/COMP/OPERA@20260920T0810@0@DBZH.tiff; the `@` must be
 *  percent-encoded in the prefix, which URLSearchParams does. */
async function listOperaFrames(product, hours) {
	const now = Date.now();
	const deadline = now + OPERA_LIST_DEADLINE_MS;
	const startMs = now - hours * 3600_000;
	const p2 = (n) => String(n).padStart(2, '0');
	const dayOf = (ms) => {
		const d = new Date(ms);
		return { y: d.getUTCFullYear(), m: p2(d.getUTCMonth() + 1), d: p2(d.getUTCDate()) };
	};
	const days = [];
	for (let ms = Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), new Date(startMs).getUTCDate()); ms <= now; ms += 86_400_000) {
		days.push(ms);
	}
	const suffix = `@0@${product}.tiff`;
	const frames = [];
	for (let i = 0; i < days.length; i++) {
		const { y, m, d } = dayOf(days[i]);
		const dayPrefix = `${y}/${m}/${d}/OPERA/COMP/`;
		const params = new URLSearchParams({
			'list-type': '2',
			prefix: `${dayPrefix}OPERA@${y}${m}${d}T`,
			'max-keys': '1000',
		});
		if (i === 0) {
			// Skip the part of the first day before the window.
			const s = new Date(startMs);
			params.set('start-after', `${dayPrefix}OPERA@${y}${m}${d}T${p2(s.getUTCHours())}${p2(s.getUTCMinutes())}`);
		}
		// One page holds a whole day today; the continuation token keeps the
		// day's LAST keys, the newest frames, from vanishing the day it does
		// not (OPERA_LIST_MAX_PAGES).
		for (let page = 0; page < OPERA_LIST_MAX_PAGES; page++) {
			const left = deadline - Date.now();
			if (left <= 0) {
				return listingPastDeadline();
			}
			// The page is timed by what is left of the deadline once that is
			// the shorter: its timeout firing is then the deadline's, which a
			// thrown abort turned into coalesce()'s 502 "upstream error", the
			// 504 unreachable in practice (only a clock that jumped past the
			// deadline between two pages ever reached it).
			const deadlineBound = left < FETCH_TIMEOUT_MS.radarList;
			let xml;
			try {
				const res = await fetch(`${OPERA_BASE}?${params}`, {
					redirect: 'manual',
					signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS.radarList, left)),
				});
				if (res.status >= 300 && res.status < 400) {
					logError('upstream-status', { route: 'radar', status: res.status });
					return { body: 'upstream redirect refused', contentType: 'text/plain; charset=utf-8', status: 502 };
				}
				if (!res.ok) {
					logError('upstream-status', { route: 'radar', status: res.status });
					return { body: 'upstream error: ' + res.status, contentType: 'text/plain; charset=utf-8', status: 502 };
				}
				xml = await res.text();
			} catch (err) {
				if (deadlineBound && err && err.name === 'TimeoutError') {
					return listingPastDeadline();
				}
				throw err;
			}
			if (!xml.includes('<ListBucketResult')) {
				// A 200 that is not a listing (an error page, a captive portal)
				// would otherwise become an EMPTY frames list, cached a minute
				// at the edge and withdrawing the echoes of every reader.
				logError('upstream-error', { route: 'radar', error: 'listing is not a ListBucketResult' });
				return { body: 'upstream error: not a listing', contentType: 'text/plain; charset=utf-8', status: 502 };
			}
			for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
				const key = /<Key>([^<]*)<\/Key>/.exec(block[1]);
				if (!key || !key[1].endsWith(suffix)) {
					continue;
				}
				const slot = /OPERA@(\d{8}T\d{4})@0@/.exec(key[1]);
				if (!slot) {
					continue;
				}
				const slotMs = operaSlotMs(slot[1], OPERA_PRODUCTS[product].cadence);
				// A key dated past this clock (the frame route's minute of
				// slack) is no frame of the composite: a producer keying a
				// frame ahead of its scan read 0 min old in every client, a
				// stopped feed drawn as fresh (the client drops it too).
				if (slotMs == null || slotMs < startMs || slotMs > now + 60_000) {
					continue;
				}
				const size = /<Size>(\d+)<\/Size>/.exec(block[1]);
				const lm = /<LastModified>([^<]*)<\/LastModified>/.exec(block[1]);
				frames.push({
					t: slot[1],
					bytes: size ? Number(size[1]) : 0,
					publishedAt: lm ? lm[1] : null,
				});
			}
			const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
			if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !next) {
				break;
			}
			if (page === OPERA_LIST_MAX_PAGES - 1) {
				// Five thousand keys in a day: answer what was listed and say so
				// (a day of the bucket holds 960, so this is a partial list only
				// past a fivefold growth, where the deadline's is never answered).
				logError('upstream-error', { route: 'radar', error: 'listing longer than ' + OPERA_LIST_MAX_PAGES + ' pages' });
				break;
			}
			params.set('continuation-token', xmlUnescape(next[1]));
		}
	}
	frames.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
	return {
		body: JSON.stringify({ product, frames, now: new Date(now).toISOString() }),
		contentType: 'application/json; charset=utf-8',
		status: 200,
	};
}

/** The listing's answer once its deadline has passed: never a list cut
 *  short by it, since the day it would lose is the NEWEST one, and a list
 *  short of its latest frames reads to the client as a feed gone stale,
 *  echoes withdrawn. The index the client already holds stays on screen
 *  behind the error. */
function listingPastDeadline() {
	logError('upstream-error', { route: 'radar', error: 'listing past its ' + OPERA_LIST_DEADLINE_MS + ' ms deadline' });
	return { body: 'upstream error: listing timed out', contentType: 'text/plain; charset=utf-8', status: 504 };
}

/** The five XML entities an S3 listing may escape a token with. */
function xmlUnescape(s) {
	return s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (m, e) =>
		e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : "'",
	);
}

/** The UTC instant of a slot key on a product's cadence, or null. */
function operaSlotMs(slot, stepMin) {
	const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})$/.exec(slot);
	if (!m) {
		return null;
	}
	const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
	const d = new Date(ms);
	const back =
		`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}` +
		`T${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
	if (back !== slot || +m[5] % stepMin !== 0) {
		return null;
	}
	return ms;
}

/** The ascending, unique tile indices of a `tiles` query under the
 *  product's tile count, or null. */
function parseOperaTiles(raw, tileCount) {
	if (!raw || !OPERA_TILES_RE.test(raw)) {
		return null;
	}
	const list = raw.split(',').map(Number);
	if (list.length > tileCount) {
		return null;
	}
	for (let i = 0; i < list.length; i++) {
		if (list[i] >= tileCount || (i > 0 && list[i] <= list[i - 1])) {
			return null;
		}
	}
	return list;
}

// The TIFF field types the guard reads, bytes per element (the client's
// TYPE_SIZE, src/lib/files/tiff.ts): BYTE, ASCII, SHORT, LONG, RATIONAL,
// FLOAT, DOUBLE. An entry of any other type is skipped, never guessed at.
const TIFF_TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8 };
// The fields the layout NEEDS (the client's NEEDED_TAGS): one whose value
// lies past the head refuses the frame, since the client refuses it too.
const TIFF_NEEDED_TAGS = new Set([256, 257, 258, 259, 273, 277, 317, 322, 323, 324, 325, 339]);
// The optional ones the guard reads, ModelPixelScale and ModelTiepoint: one
// past the head reads as ABSENT, as it does in the client.
const TIFF_READ_TAGS = new Set([...TIFF_NEEDED_TAGS, 33550, 33922]);

/**
 * The tile table of a composite frame, read off its first OPERA_HEAD_BYTES:
 * a little-endian classic TIFF whose IFD0 states the product's grid in
 * 512-px tiles. The directory and every field read HERE must lie INSIDE
 * the head, since that is all the client is handed (and, on a hit, all the
 * relay reads back); a field the client does not need (GDAL_METADATA, a
 * GeoASCIIParams) may lie past it, the client skipping such a field rather
 * than refusing the frame; every tile must lie inside the object, whose length is
 * `objectLength` (the buffer's own when the whole object is in hand, the
 * stored length on a hit). Null for anything else: another grid,
 * another product, a directory a converter change pushed past the head, a
 * tile past the end. Walked afresh per call, microseconds on 8 KB: a memo
 * keyed by slot would outlive the object it described.
 *
 * The guard is the CLIENT'S, field for field: parseTiledTiffHead and
 * isOperaLayout in src/lib/files/tiff.ts, their defaults for an absent field
 * included (one sample, one bit, unsigned, uncompressed, no predictor).
 * Two Float32 samples a pixel, zlib tiles, no predictor, no strips, the tie
 * point at the ODIM corner or the converter's half-cell shift of it, the
 * pixel scale the product's own cell. A frame the relay accepts and the
 * client refuses is the costly direction: the relay answers 200 and caches
 * the object for a day, and every client throws, marks the frame for a
 * cache-bypassing reload and asks again every minute it stays in the loop,
 * up to 25 frames a client, where a 502 here is answered from the edge's
 * memory of the refusal for an hour (OPERA_REFUSED_TTL_S). So a producer
 * switching CIRRUS to LZW, or to one band, at the same geometry, is refused
 * here first.
 */
function operaTileLayout(buf, product, objectLength) {
	const geo = OPERA_PRODUCTS[product];
	if (!Number.isFinite(objectLength)) {
		// Every tile-inside-the-object check below would pass against an
		// unknown length (`x > NaN` and `x > Infinity` are both false).
		return null;
	}
	const u8 = new Uint8Array(buf);
	const headEnd = Math.min(u8.length, OPERA_HEAD_BYTES);
	if (headEnd < 8 || u8[0] !== 0x49 || u8[1] !== 0x49) {
		return null;
	}
	const dv = new DataView(buf, u8.byteOffset, u8.byteLength);
	if (dv.getUint16(2, true) !== 42) {
		return null;
	}
	const ifd = dv.getUint32(4, true);
	if (ifd < 8 || ifd + 2 > headEnd) {
		return null;
	}
	const n = dv.getUint16(ifd, true);
	if (n === 0 || n > 512 || ifd + 2 + n * 12 > headEnd) {
		return null;
	}
	const fields = new Map();
	for (let i = 0; i < n; i++) {
		const e = ifd + 2 + i * 12;
		const tag = dv.getUint16(e, true);
		const type = dv.getUint16(e + 2, true);
		const count = dv.getUint32(e + 4, true);
		const size = TIFF_TYPE_SIZE[type];
		if (!TIFF_READ_TAGS.has(tag) || !size) {
			continue;
		}
		if ((tag === 324 || tag === 325) && type !== 3 && type !== 4) {
			// The tile tables are byte offsets and counts: SHORT or LONG. A
			// float passed every range test below as NaN and asked the budget
			// for NaN bytes, which nothing ever grants (tiff.ts refuses too).
			return null;
		}
		const total = size * count;
		const at = total <= 4 ? e + 8 : dv.getUint32(e + 8, true);
		if (at + total > headEnd) {
			if (TIFF_NEEDED_TAGS.has(tag)) {
				return null;
			}
			continue;
		}
		const vals = new Array(count);
		for (let k = 0; k < count; k++) {
			const q = at + k * size;
			switch (type) {
				case 1:
				case 2:
					vals[k] = dv.getUint8(q);
					break;
				case 3:
					vals[k] = dv.getUint16(q, true);
					break;
				case 4:
					vals[k] = dv.getUint32(q, true);
					break;
				case 5:
					vals[k] = dv.getUint32(q, true) / (dv.getUint32(q + 4, true) || 1);
					break;
				case 11:
					vals[k] = dv.getFloat32(q, true);
					break;
				default:
					vals[k] = dv.getFloat64(q, true);
			}
		}
		fields.set(tag, vals);
	}
	// The client's defaults for an absent field (tiff.ts parseTiledTiffHead).
	const one = (tag, fallback) => {
		const v = fields.get(tag);
		return v && v.length > 0 ? v[0] : fallback;
	};
	const offsets = fields.get(324);
	const counts = fields.get(325);
	const tie = fields.get(33922);
	const scale = fields.get(33550);
	const half = geo.cellM / 2;
	const tieOk =
		!tie ||
		tie.length < 5 ||
		(Math.abs(tie[3]) < 1 && Math.abs(tie[4]) < 1) ||
		(Math.abs(tie[3] + half) < 1 && Math.abs(tie[4] - half) < 1);
	const scaleOk =
		!scale || scale.length < 2 || (Math.abs(scale[0] - geo.cellM) < 1e-6 && Math.abs(scale[1] - geo.cellM) < 1e-6);
	if (
		one(256, null) !== geo.width ||
		one(257, null) !== geo.height ||
		one(322, null) !== 512 ||
		one(323, null) !== 512 ||
		one(277, 1) !== 2 ||
		one(258, 1) !== 32 ||
		one(339, 1) !== 3 ||
		one(259, 1) !== 8 ||
		one(317, 1) !== 1 ||
		fields.has(273) ||
		!offsets ||
		!counts ||
		offsets.length !== geo.tiles ||
		counts.length !== geo.tiles ||
		!tieOk ||
		!scaleOk
	) {
		return null;
	}
	for (let i = 0; i < geo.tiles; i++) {
		if (offsets[i] < OPERA_HEAD_BYTES || offsets[i] + counts[i] > objectLength) {
			return null;
		}
	}
	return { offsets, counts };
}

/**
 * One byte range of a stored object: { buf, at, total, ranged }, `at` the
 * offset the buffer starts at and `total` the object's length, both as the
 * cache STATED them: the 206's Content-Range, or for a 200 (the cache
 * answering whole, `ranged` false) byte 0 and the bytes actually in hand.
 * A 206 whose Content-Range does not state both, `bytes 0-8191/*` (an
 * unknown total) among them, answers NaN for the two, never the start that
 * was asked for and an infinite length: with those, the head passed every
 * tile-inside-the-object check it was read for. Null when nothing is stored.
 */
async function cacheRange(cache, cacheKey, start, endInclusive) {
	const res = await cache.match(
		new Request(cacheKey.url, { method: 'GET', headers: { range: `bytes=${start}-${endInclusive}` } }),
	);
	if (!res) {
		return null;
	}
	if (res.status === 206) {
		const m = /^bytes (\d+)-\d+\/(\d+)$/.exec((res.headers.get('content-range') || '').trim());
		return { buf: await res.arrayBuffer(), at: m ? Number(m[1]) : NaN, total: m ? Number(m[2]) : NaN, ranged: true };
	}
	if (res.status !== 200) {
		return null;
	}
	const buf = await res.arrayBuffer();
	return { buf, at: 0, total: buf.byteLength, ranged: false };
}

/**
 * Hold `bytes` of the radar relay's memory budget (OPERA_MEMORY_BUDGET):
 * resolves to the release function, or null when the budget did not free up
 * within OPERA_MEMORY_WAIT_MS or the queue is full. FIFO, so a large request
 * is never overtaken for good by small ones. A request larger than the
 * budget waits for an idle isolate and then holds all of it.
 */
function holdOperaBytes(bytes) {
	if (!Number.isFinite(bytes)) {
		// Never granted, and never let to block the queue behind it.
		return Promise.resolve(null);
	}
	const need = Math.max(0, Math.min(Math.ceil(bytes), OPERA_MEMORY_BUDGET));
	let released = false;
	const release = () => {
		if (!released) {
			released = true;
			operaBytesHeld -= need;
			drainOperaWaiters();
		}
	};
	if (operaWaiters.length === 0 && operaBytesHeld + need <= OPERA_MEMORY_BUDGET) {
		operaBytesHeld += need;
		return Promise.resolve(release);
	}
	if (operaWaiters.length >= OPERA_MEMORY_QUEUE_MAX) {
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		const waiter = {
			bytes: need,
			grant: () => {
				clearTimeout(timer);
				operaBytesHeld += need;
				resolve(release);
			},
		};
		const timer = setTimeout(() => {
			const at = operaWaiters.indexOf(waiter);
			if (at >= 0) {
				operaWaiters.splice(at, 1);
			}
			resolve(null);
			// The head may have been the one blocking the rest.
			drainOperaWaiters();
		}, OPERA_MEMORY_WAIT_MS);
		operaWaiters.push(waiter);
	});
}

function drainOperaWaiters() {
	while (operaWaiters.length > 0 && operaBytesHeld + operaWaiters[0].bytes <= OPERA_MEMORY_BUDGET) {
		operaWaiters.shift().grant();
	}
}

/** The relay's own "busy": 503 with a Retry-After, the client retrying on
 *  its frame pace. */
function operaBusy() {
	const res = new Response('server busy: radar relay at its memory budget, retry shortly', { status: 503 });
	res.headers.set('content-type', 'text/plain; charset=utf-8');
	res.headers.set('Retry-After', '5');
	return res;
}

/**
 * An upstream body read whole, or null the moment it passes `maxBytes`, the
 * stream cancelled there. A declared Content-Length over the bound is
 * refused before this is called; this is what holds the bound for a body
 * that declares none (a chunked answer, an error page streamed without a
 * length), which `arrayBuffer()` would have read to its end, however long,
 * before anything could be checked. With a declared length within the
 * bound the bytes land in one buffer of that size; without one they are
 * gathered and joined once.
 */
async function readBodyBounded(res, maxBytes, declared) {
	if (!res.body) {
		return new ArrayBuffer(0);
	}
	const reader = res.body.getReader();
	const sized = Number.isFinite(declared) && declared > 0 ? new Uint8Array(declared) : null;
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		if (total + value.byteLength > maxBytes || (sized && total + value.byteLength > sized.length)) {
			// Past the bound, or past what the answer itself declared.
			await reader.cancel('object too large').catch(() => {});
			return null;
		}
		if (sized) {
			sized.set(value, total);
		} else {
			chunks.push(value);
		}
		total += value.byteLength;
	}
	if (sized) {
		return total === sized.length ? sized.buffer : sized.slice(0, total).buffer;
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out.buffer;
}

/**
 * The whole object of one frame, fetched once and stored at the edge under
 * its own key with the Content-Length the edge needs to answer any later
 * Range request itself; the record coalesce() hands its followers:
 * { status: 200, buf } on success, { status, body } for a miss, a refused
 * object or a relay at its memory budget. A miss is not cached; a refused
 * object is REMEMBERED at the edge under `refusedKey` for
 * OPERA_REFUSED_TTL_S. A thrown fetch becomes coalesce()'s own 502 record.
 * The object's bytes are held in the memory budget from the read to the
 * edge put (twice: the put takes its own copy); the readers then cut their
 * answers from it synchronously, outside the budget, since the object is
 * in hand and a reader queued behind other leaders would only hold it
 * longer.
 */
async function fetchOperaObject(key, product, cache, cacheKey, refusedKey) {
	const refuse = async (reason) => {
		logError('upstream-error', { route: 'radar', error: reason });
		try {
			await cache.put(
				refusedKey,
				new Response(reason, {
					status: 200,
					headers: {
						'content-type': 'text/plain; charset=utf-8',
						'cache-control': `public, max-age=${OPERA_REFUSED_TTL_S}`,
					},
				}),
			);
		} catch (err) {
			logError('cache-put-failed', { route: 'radar', error: err && err.message ? err.message : String(err) });
		}
		return { status: 502, body: 'upstream error: ' + reason };
	};
	const upstream = await fetch(`${OPERA_BASE}/${key}`, {
		redirect: 'manual',
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS.radar),
	});
	if (upstream.status >= 300 && upstream.status < 400) {
		logError('upstream-status', { route: 'radar', status: upstream.status });
		return { status: 502, body: 'upstream redirect refused' };
	}
	if (upstream.status === 404) {
		// Not published yet (or gone): the miss passes through, nothing cached.
		return { status: 404, body: null };
	}
	if (!upstream.ok) {
		logError('upstream-status', { route: 'radar', status: upstream.status });
		return { status: 502, body: 'upstream error: ' + upstream.status };
	}
	const declared = Number(upstream.headers.get('content-length'));
	if (declared > OPERA_OBJECT_MAX_BYTES) {
		await upstream.body?.cancel().catch(() => {});
		return refuse('object too large');
	}
	const size = Number.isFinite(declared) && declared > 0 ? declared : OPERA_OBJECT_MAX_BYTES;
	const release = await holdOperaBytes(2 * size);
	if (!release) {
		await upstream.body?.cancel().catch(() => {});
		return { status: 503, body: null, busy: true };
	}
	try {
		const buf = await readBodyBounded(upstream, OPERA_OBJECT_MAX_BYTES, declared);
		if (!buf) {
			return await refuse('object too large');
		}
		if (!operaTileLayout(buf, product, buf.byteLength)) {
			// A TIFF that is not the product's composite is the OBJECT's
			// answer, remembered for the hour. Anything else under a 200 (an
			// error page, an empty body) is the bucket's moment and is said
			// once, not remembered: the next reader asks again.
			if (!looksLikeTiff(buf)) {
				logError('upstream-error', { route: 'radar', error: 'not a TIFF' });
				return { status: 502, body: 'upstream error: not a composite frame' };
			}
			return await refuse('not a composite frame');
		}
		try {
			await cache.put(
				cacheKey,
				new Response(buf.slice(0), {
					status: 200,
					headers: {
						'content-type': 'application/octet-stream',
						'content-length': String(buf.byteLength),
						'cache-control': 'public, max-age=86400, immutable',
					},
				}),
			);
		} catch (err) {
			// The object is in hand: the slice is served whatever the edge did
			// with it, and the next reader's leader tries the put again.
			logError('cache-put-failed', { route: 'radar', error: err && err.message ? err.message : String(err) });
		}
		return { status: 200, buf };
	} finally {
		release();
	}
}

/** A classic TIFF of either byte order: what an object must at least be for
 *  its refusal to say something about the object rather than the bucket. */
function looksLikeTiff(buf) {
	const u8 = new Uint8Array(buf);
	return (
		u8.length >= 4 &&
		((u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 42 && u8[3] === 0) ||
			(u8[0] === 0x4d && u8[1] === 0x4d && u8[2] === 0 && u8[3] === 42))
	);
}

/**
 * One frame's directory plus the requested tiles. The slot must lie on the
 * product's cadence inside the bucket's 24-hour life (a minute of clock
 * slack ahead), `tiles` must be ascending unique indices under the
 * product's tile count (72 for DBZH, 20 for RATE), and the query carries
 * nothing else. The whole object is cached at the edge under
 * its own key (`/opera/obj/<version>/<slot>/<product>`, a Content-Length-bearing 200,
 * immutable for a day); the sliced answer is marked private so the browser
 * keeps it and the edge never stores the unbounded family of slices. A
 * 404 (a frame not yet published) passes through uncached; an object that
 * is not a composite frame answers 502, and the edge remembers the refusal
 * for an hour (OPERA_REFUSED_TTL_S) rather than pulling the object again
 * for every reader. A hit holds the bytes it reads and the answer it cuts in
 * the relay's memory budget (holdOperaBytes) while it reads and cuts, a 503
 * answering past it; the share comes back the moment the answer is built.
 */
async function handleOperaFrame(request, url, allowOrigin, ctx) {
	if (request.method !== 'GET') {
		return cors(new Response('method not allowed', { status: 405 }), allowOrigin);
	}
	const m = OPERA_FRAME_RE.exec(url.pathname);
	if (!m) {
		return cors(new Response('bad frame path', { status: 400 }), allowOrigin);
	}
	const [, slot, product] = m;
	const slotMs = operaSlotMs(slot, OPERA_PRODUCTS[product].cadence);
	const now = Date.now();
	if (slotMs == null || slotMs > now + 60_000 || slotMs < now - OPERA_CACHE_MS) {
		return cors(new Response('bad frame slot', { status: 400 }), allowOrigin);
	}
	const tiles = parseOperaTiles(url.searchParams.get('tiles'), OPERA_PRODUCTS[product].tiles);
	if (!tiles || [...url.searchParams.keys()].some((k) => k !== 'tiles')) {
		return cors(new Response('bad tiles', { status: 400 }), allowOrigin);
	}
	const cache = caches.default;
	const cacheKey = new Request(`${url.origin}/opera/obj/${OPERA_OBJECT_KEY_VERSION}/${slot}/${product}`, { method: 'GET' });
	// A hit is answered from two RANGED reads of the stored object, the head
	// and the span the named tiles cover, never the object whole: a slice
	// request holding 3.5 MB of buffer would let a burst of hits (a pan at
	// the two-hour loop is 25 in a second) exhaust the isolate's memory.
	// The Content-Length stored with the object is what lets the edge answer
	// a Range; a cache that answers whole instead is read whole (the tests'
	// shim did, before it learnt ranges).
	let head = await cacheRange(cache, cacheKey, 0, OPERA_HEAD_BYTES - 1);
	if (head && (head.at !== 0 || !Number.isFinite(head.total))) {
		// The same refusal as the span read's below: a head the cache did not
		// place at byte 0 of an object of a stated length is not one this
		// relay can vouch for, and the layout it would read is checked
		// against the object's length. The client retries on its own pace.
		return cors(new Response('frame left the cache', { status: 503 }), allowOrigin);
	}
	let layout = head ? operaTileLayout(head.buf, product, head.total) : null;
	let whole = null;
	if (!head || !layout) {
		const refusedKey = new Request(`${url.origin}/opera/refused/${OPERA_OBJECT_KEY_VERSION}/${slot}/${product}`, {
			method: 'GET',
		});
		const refused = await cache.match(refusedKey);
		if (refused) {
			// Said once an hour, not pulled whole for every reader.
			return cors(new Response('upstream error: ' + (await refused.text()), { status: 502 }), allowOrigin);
		}
		const key = `${slot.slice(0, 4)}/${slot.slice(4, 6)}/${slot.slice(6, 8)}/OPERA/COMP/OPERA@${slot}@0@${product}.tiff`;
		// Single-flighted per object: readers whose polls land in the
		// seconds before the first put would each pull the whole frame and
		// each spend a ceiling slot; coalesce() hands them the leader's
		// bytes, and the reservation is the leader's alone. The put is
		// awaited INSIDE the leader, so the key clears only once the edge
		// holds the object and no reader can fall between the two.
		const rec = await coalesce(
			operaObjInflight,
			cacheKey.url,
			'radar',
			() => fetchOperaObject(key, product, cache, cacheKey, refusedKey),
			ctx,
		);
		if (rec.refused) {
			return cors(refusal(busyMessage('radar'), rec.retryAfterS), allowOrigin);
		}
		if (rec.busy) {
			return cors(operaBusy(), allowOrigin);
		}
		if (rec.status !== 200) {
			return cors(new Response(rec.body ?? null, { status: rec.status }), allowOrigin);
		}
		whole = rec.buf;
		layout = operaTileLayout(whole, product, whole.byteLength);
		if (!layout) {
			return cors(new Response('upstream error: not a composite frame', { status: 502 }), allowOrigin);
		}
		head = { buf: whole, at: 0, total: whole.byteLength, ranged: false };
	}
	let spanStart = Infinity;
	let spanEnd = 0;
	let total = OPERA_HEAD_BYTES;
	for (const i of tiles) {
		spanStart = Math.min(spanStart, layout.offsets[i]);
		spanEnd = Math.max(spanEnd, layout.offsets[i] + layout.counts[i]);
		total += layout.counts[i];
	}
	// A hit's own bytes, the span it reads (a ranged hit) and the answer it
	// cuts, are held in the budget while it reads and cuts. The share comes
	// back once the answer is BUILT, never when a reader has taken it: the
	// runtime neither reads to its end nor cancels the body of a client that
	// has gone, so a share tied to the reader never came back, and enough of
	// them wedged the relay into a 503 for everyone. A miss holds nothing
	// here: its object is in hand (the leader held it through the download
	// and the put), and a reader queued behind other leaders would only hold
	// it longer.
	let release = null;
	let span;
	if (whole) {
		span = { buf: whole, at: 0 };
	} else {
		release = await holdOperaBytes(total + (head.ranged ? spanEnd - spanStart : 0));
		if (!release) {
			return cors(operaBusy(), allowOrigin);
		}
		// A cache that answered the head whole has already handed the object
		// over: the span is cut from that, never read a second time.
		try {
			span = head.ranged
				? await cacheRange(cache, cacheKey, spanStart, spanEnd - 1)
				: { buf: head.buf, at: 0, ranged: false };
		} catch (err) {
			release();
			throw err;
		}
	}
	if (!span || !(span.at <= spanStart) || span.buf.byteLength < spanEnd - span.at) {
		release?.();
		// The object left the edge between the two reads, or the cache
		// answered a range other than the one asked (a start past the first
		// tile would cut garbage silently): the client retries on its own
		// retry pace and the leader path fills it again.
		return cors(new Response('frame left the cache', { status: 503 }), allowOrigin);
	}
	// How the answer was read, for an audit from outside: `origin` (the
	// leader's whole fetch), `range` (a hit cut from two 206 reads) or
	// `whole` (a hit the cache answered with a 200, read whole: the memory
	// argument above does not hold on that path, so it must stay rare).
	const read = whole ? 'origin' : head.ranged && span.ranged ? 'range' : 'whole';
	if (read === 'whole') {
		// The memory argument does not hold on this path; an operator must
		// be able to see it happening.
		logError('cache-whole-read', { route: 'radar' });
	}
	const out = new Uint8Array(total);
	const headU8 = new Uint8Array(head.buf);
	// The head is exactly OPERA_HEAD_BYTES, zero-padded should an object be
	// shorter (a real frame never is), so the client always finds the tiles
	// at the same offset.
	out.set(headU8.subarray(0, Math.min(OPERA_HEAD_BYTES, headU8.length)), 0);
	const spanU8 = new Uint8Array(span.buf);
	let at = OPERA_HEAD_BYTES;
	for (const i of tiles) {
		const from = layout.offsets[i] - span.at;
		out.set(spanU8.subarray(from, from + layout.counts[i]), at);
		at += layout.counts[i];
	}
	release?.();
	return cors(
		new Response(out, {
			status: 200,
			headers: {
				'content-type': 'application/octet-stream',
				'cache-control': 'private, max-age=86400, immutable',
				'x-opera-tiles': tiles.join(','),
				'x-opera-read': read,
			},
		}),
		allowOrigin,
	);
}

// Structured error logging for Workers Logs ([observability] in wrangler.toml
// persists console output). Route + status + upstream error text only; never
// secrets, tokens, cookies, request bodies, or client IPs.
function logError(event, fields) {
	console.error(JSON.stringify({ event, ...fields }));
}

function corsHeaders(origin) {
	const h = new Headers();
	if (origin) {
		h.set('Access-Control-Allow-Origin', origin);
		h.set('Vary', 'Origin');
	}
	h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
	// So the browser can read Retry-After off a 429 refusal (both rate-limit
	// tiers set it); without this, cross-origin JS sees the header as absent.
	h.set('Access-Control-Expose-Headers', 'Retry-After, X-Opera-Tiles, X-Opera-Now, X-Opera-Read');
	h.set('Access-Control-Max-Age', '86400');
	return h;
}

function cors(res, origin) {
	for (const [k, v] of corsHeaders(origin).entries()) {
		res.headers.set(k, v);
	}
	return res;
}

/** A route whose freshness matters hands the CLIENT a copy it will never
 *  keep. The zone's Browser Cache TTL rewrites the headers
 *  `caches.default.match()` hands back: measured on /wx, the miss answered
 *  `max-age=60` and the hit two seconds later `max-age=14400`, so a browser
 *  that fetched inside the edge's minute held a METAR, or a radar frames
 *  list, for four hours (found by a radar drive reading a list 37 minutes
 *  stale). The edge copy is stored BEFORE this runs and keeps its own TTL;
 *  the zone only lengthens, so the year-long and day-long routes need
 *  nothing. The clients fetch these routes `no-store` as well. */
function clientNoStore(res) {
	res.headers.set('cache-control', 'no-store');
	return res;
}

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
 * tiers; /wx and /tiles keep their own edge caches. Every upstream fetch
 * carries an AbortSignal timeout (FETCH_TIMEOUT_MS) so a hung upstream can't
 * pin a request, its ceiling slot, and every coalesced follower until the
 * runtime's own limits fire.
 *
 * Deployment:
 *   1. Free Cloudflare account -> Workers & Pages -> Create a Worker.
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

// Upstream fetch timeouts (AbortSignal.timeout on every upstream call): a hung
// upstream must not stall the request, its ceiling slot, and every coalesced
// follower until the runtime's own limits fire. Generous per route: the SOFIA
// briefing POST is slow on long routes, the chart PDFs run to a few hundred
// KB, tiles / wx are small and fast. A timeout surfaces as the existing 502
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
// session + one POST per route, plus chart PDFs; a profile render pulls many
// tiles). The point is to stop sustained scripted / re-click floods
// (hundreds+/min), never a legitimate burst. Tune against real usage.
const RATE_LIMITS = {
	notam: { limit: 120, windowMs: 60_000 },
	sofia: { limit: 90, windowMs: 60_000 },
	wx: { limit: 120, windowMs: 60_000 },
	// Panning across France asks for a plate per aerodrome passed, and the
	// client caches what it has drawn, so this is generous for a reader and
	// nowhere near enough to mirror the atlas.
	vac: { limit: 60, windowMs: 60_000 },
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
// use Cloudflare's native Rate Limiting binding; a truly global counter needs a
// Durable Object (Paid plan). Values are generous starting points (well above
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
};
// One sliding window per ceiling bucket (5 keys; no memory guard needed).
const ceilingHits = new Map(); // bucket -> number[] of recent upstream-call times (ms)

// --- short response cache (/notam, /sofia) ---------------------------------
// Module-global memos rather than caches.default: these two routes are POST /
// query-shaped and want a TTL in seconds, which the edge cache does not give
// per entry. Short TTL keeps safety-critical NOTAM data fresh; the entry +
// body caps bound memory (whole-FIR / full-bulletin payloads are large).
const NOTAM_CACHE_TTL_MS = 60_000;
const SOFIA_CACHE_TTL_MS = 60_000;
const RESP_CACHE_MAX = 32; // entries per cache
// Caps BOTH what is memoized and the in-flight buffer: an upstream body over
// this streams through to the client uncached (readUpstreamBody) instead of
// being fully materialised in the isolate.
const RESP_CACHE_MAX_BODY = 4_000_000;
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
 * never alias a live one. On a cache miss the call goes through coalesce():
 * concurrent identical requests share one upstream call (single-flight) and
 * the leader reserves the aggregate 'notam' ceiling (tier 2).
 */
async function handleNotam(request, url, allowOrigin, env, ctx) {
	if (request.method !== 'GET') {
		return cors(new Response('method not allowed', { status: 405 }), allowOrigin);
	}
	const key = notamCacheKey(url.searchParams);
	const hit = cacheGet(notamCache, key);
	if (hit) {
		return cors(cachedResponse(hit), allowOrigin);
	}
	const rec = await coalesce(
		notamInflight,
		key,
		'notam',
		() => fetchNotamRecord(key, url, env),
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
async function fetchNotamRecord(key, url, env) {
	let token;
	try {
		token = await getAutorouterToken(env);
	} catch (err) {
		return tokenErrorRecord(err);
	}
	const upstreamUrl = UPSTREAM + NOTAM_PATH + url.search;
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

// An epoch-seconds validity param, quantised to the cache TTL; a non-numeric
// value stays verbatim (still part of the key, just unbucketed).
function bucketValidity(v) {
	const n = Number(v);
	return Number.isFinite(n) ? 'b' + Math.floor((n * 1000) / NOTAM_CACHE_TTL_MS) : v;
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
	return null;
}

function clientIp(request) {
	return (
		request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'
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
// helper creates a new key (one key per IP; the ceiling map needs no guard).
function checkRateLimit(bucket, ip) {
	const cfg = RATE_LIMITS[bucket];
	if (!cfg) {
		return { allowed: true, retryAfterS: 0 };
	}
	const key = bucket + '|' + ip;
	if (!rlHits.has(key) && rlHits.size > RL_MAX_KEYS) {
		rlHits.clear();
	}
	return slidingWindowAllow(rlHits, key, cfg.limit, cfg.windowMs, Date.now());
}

// Tier 2: reserve one aggregate upstream slot for the route class. Called only
// on a cache miss, immediately before the upstream call (in coalesce for /notam
// and /sofia, inline for /wx and /tiles), so cached hits never count.
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
		cache.delete(key);
		return null;
	}
	return e;
}

function cacheSet(cache, key, entry, ttlMs) {
	entry.expiresAt = Date.now() + ttlMs;
	cache.delete(key); // re-insert at the end for oldest-first eviction
	cache.set(key, entry);
	while (cache.size > RESP_CACHE_MAX) {
		const oldest = cache.keys().next().value;
		cache.delete(oldest);
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
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		chunks.push(value);
		total += value.byteLength;
		if (total > RESP_CACHE_MAX_BODY) {
			reader.releaseLock();
			return { stream: prefixedStream(chunks, res.body) };
		}
	}
	return { text: decodeChunks(chunks, total) };
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
 * is a real cache here as for the tiles, so one observation serves every
 * client on a colo for its TTL.
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
	// order); CORS is layered on per-request below, as for the tiles.
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

	return cors(new Response(cached.body, { status: 200, headers: cached.headers }), allowOrigin);
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
		return cors(new Response('upstream redirect refused', { status: 502 }), allowOrigin);
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
		// key clean, the /tiles rule.
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
			// do not cache it.
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
	h.set('Access-Control-Expose-Headers', 'Retry-After');
	h.set('Access-Control-Max-Age', '86400');
	return h;
}

function cors(res, origin) {
	for (const [k, v] of corsHeaders(origin).entries()) {
		res.headers.set(k, v);
	}
	return res;
}

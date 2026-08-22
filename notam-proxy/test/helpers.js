// Shared harness for the notam-proxy worker tests (node:test, no deps, no
// network). The worker is a self-contained ES module whose handlers touch
// three runtime globals: fetch (stubbed per test), caches (Workers-only,
// shimmed as an always-miss cache), and AbortSignal.timeout (native in Node).
// Module state (token cache, rate-limit windows, response caches) is
// per-module-instance, so each test imports a FRESH copy of worker.js via a
// cache-busting query string.

let seq = 0;

export const ORIGIN = 'https://loxodrome.fr';
export const ENV = { AR_CLIENT_ID: 'test-id', AR_CLIENT_SECRET: 'test-secret' };
export const TOKEN_URL = 'https://api.autorouter.aero/v1.0/oauth2/token';
export const NOTAM_URL = 'https://api.autorouter.aero/v1.0/notam';
export const SOFIA_HOME_URL =
	'https://sofia-briefing.aviation-civile.gouv.fr/sofia/pages/homepage.html';
export const SOFIA_POST_URL = 'https://sofia-briefing.aviation-civile.gouv.fr/sofia';
export const CHART_URL = 'https://aviation.meteo.fr/FR/aviation/affiche_image.php';

// A no-op edge cache (caches.default): every lookup misses, puts are dropped,
// so the worker's miss paths (upstream ceiling + fetch) always run.
export function installCachesShim() {
	globalThis.caches = {
		default: {
			async match() {
				return undefined;
			},
			async put() {},
		},
	};
}

// Import a fresh worker module (fresh module-global state) and return its
// default export ({ fetch }).
export async function freshWorker() {
	installCachesShim();
	const href = new URL('../worker.js', import.meta.url).href + '?fresh=' + seq++;
	const mod = await import(href);
	return mod.default;
}

export function makeCtx() {
	const waits = [];
	return {
		waitUntil(p) {
			waits.push(Promise.resolve(p).catch(() => {}));
		},
		waits,
	};
}

// Stub globalThis.fetch with handler(url, init, n) -> Response | Promise.
// Returns the recorded calls array [{ url, init }], appended before the
// handler runs so in-flight upstream calls are observable.
export function stubFetch(handler) {
	const calls = [];
	globalThis.fetch = async (input, init = {}) => {
		const url = typeof input === 'string' ? input : input.url;
		calls.push({ url, init });
		return handler(url, init, calls.length);
	};
	return calls;
}

export function req(
	path,
	{ method = 'GET', origin = ORIGIN, ip = '203.0.113.1', headers = {}, body } = {},
) {
	const h = new Headers(headers);
	if (origin !== null) {
		h.set('Origin', origin);
	}
	h.set('CF-Connecting-IP', ip);
	const init = { method, headers: h };
	if (body !== undefined) {
		init.body = body;
		if (typeof body !== 'string') {
			init.duplex = 'half'; // undici requires it for stream bodies
		}
	}
	return new Request('https://proxy.example' + path, init);
}

export function tokenResponse(value = 'tok-1') {
	return Response.json({ access_token: value, expires_in: 3600 });
}

// The worker's key inside the shared-token namespace.
export const TOKEN_KEY = 'autorouter-token';

// The subset of a Workers KV namespace the worker uses (get with
// {type:'json'}, put with {expirationTtl}), plus the raw store and a put log
// for assertions. `seed` is a { value, expiresAt } token record, or null for an
// empty namespace; `fail` makes every get throw, standing in for a KV outage.
export function makeKv({ seed = null, fail = false } = {}) {
	const store = new Map();
	if (seed) {
		store.set(TOKEN_KEY, JSON.stringify(seed));
	}
	const puts = [];
	return {
		store,
		puts,
		async get(key, opts) {
			if (fail) {
				throw new Error('kv unavailable');
			}
			const raw = store.get(key);
			if (raw == null) {
				return null;
			}
			return opts && opts.type === 'json' ? JSON.parse(raw) : raw;
		},
		async put(key, value, opts) {
			puts.push({ key, value, opts });
			store.set(key, value);
		},
	};
}

// A token record as the worker stores it; msFromNow < 0 for an expired one.
export function tokenRecord(value, msFromNow = 3_540_000) {
	return { value, expiresAt: Date.now() + msFromNow };
}

// The standard ENV plus a KV binding (the production shape).
export function envWithKv(kv) {
	return { ...ENV, AR_TOKEN_KV: kv };
}

export function jsonResponse(body, status = 200) {
	return new Response(body, {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

// Not a real Response: undici (per the fetch spec) strips Set-Cookie from
// constructed responses, so hand back the minimal shape sofiaSession reads.
export function homepageResponse(jsession = 'A1B2C3D4E5') {
	return {
		headers: {
			getSetCookie: () => [`JSESSIONID=${jsession}; Path=/sofia; HttpOnly`],
		},
	};
}

// A ReadableStream emitting the given chunks (strings are UTF-8-encoded).
export function streamOf(chunks) {
	let i = 0;
	return new ReadableStream({
		pull(controller) {
			if (i < chunks.length) {
				const c = chunks[i++];
				controller.enqueue(typeof c === 'string' ? new TextEncoder().encode(c) : c);
			} else {
				controller.close();
			}
		},
	});
}

// Recorded calls whose URL starts with prefix / equals url exactly.
export function callsWith(list, prefix) {
	return list.filter((c) => c.url.startsWith(prefix));
}

export function callsTo(list, url) {
	return list.filter((c) => c.url === url);
}

// Poll until cond() holds (bounded); for observing an in-flight upstream call.
export async function waitFor(cond, ms = 2000) {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) {
			throw new Error('waitFor timed out');
		}
		await new Promise((r) => setTimeout(r, 5));
	}
}

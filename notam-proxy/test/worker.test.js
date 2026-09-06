// notam-proxy worker tests: node --test "notam-proxy/test/*.test.js" (no deps, offline).
// Each test imports a fresh worker instance (fresh module-global state) and
// stubs globalThis.fetch, so no request ever leaves the process.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ENV,
	ORIGIN,
	TOKEN_KEY,
	TOKEN_URL,
	NOTAM_URL,
	SOFIA_HOME_URL,
	SOFIA_POST_URL,
	CHART_URL,
	freshWorker,
	makeCtx,
	makeKv,
	envWithKv,
	stubFetch,
	installRecordingCache,
	req,
	tokenRecord,
	tokenResponse,
	jsonResponse,
	homepageResponse,
	streamOf,
	callsWith,
	callsTo,
	waitFor,
} from './helpers.js';

test('OPTIONS preflight from an allowed origin returns the CORS headers', async () => {
	const worker = await freshWorker();
	const fc = stubFetch(() => {
		throw new Error('no upstream call expected');
	});
	const res = await worker.fetch(req('/notam', { method: 'OPTIONS' }), ENV, makeCtx());
	assert.equal(res.status, 204);
	assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
	assert.equal(res.headers.get('Vary'), 'Origin');
	assert.ok(res.headers.get('Access-Control-Expose-Headers').includes('Retry-After'));
	assert.equal(fc.length, 0);
});

test('the Capacitor Android app origin is allowed by default', async () => {
	const worker = await freshWorker();
	const fc = stubFetch(() => {
		throw new Error('no upstream call expected');
	});
	// The Android WebView serves the bundled app from https://localhost
	// (androidScheme https, no port); the default allow-list must carry it.
	const res = await worker.fetch(
		req('/notam', { method: 'OPTIONS', origin: 'https://localhost' }),
		ENV,
		makeCtx(),
	);
	assert.equal(res.status, 204);
	assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://localhost');
	assert.equal(fc.length, 0);
});

test('requests from an unlisted or missing origin are refused', async () => {
	const worker = await freshWorker();
	const fc = stubFetch(() => {
		throw new Error('no upstream call expected');
	});
	const bad = await worker.fetch(req('/notam', { origin: 'https://evil.example' }), ENV, makeCtx());
	assert.equal(bad.status, 403);
	assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
	const none = await worker.fetch(req('/notam', { origin: null }), ENV, makeCtx());
	assert.equal(none.status, 403);
	assert.equal(fc.length, 0);
});

test('/notam injects the app bearer token, ignores client Authorization, sets timeouts', async () => {
	const worker = await freshWorker();
	const fc = stubFetch((url) => {
		if (url === TOKEN_URL) {
			return tokenResponse('tok-1');
		}
		if (url.startsWith(NOTAM_URL)) {
			return jsonResponse('["ok"]');
		}
		throw new Error('unexpected url ' + url);
	});
	const res = await worker.fetch(
		req('/notam?itemas=%5B%22LFFF%22%5D&limit=100&offset=0', {
			headers: { Authorization: 'Bearer client-junk' },
		}),
		ENV,
		makeCtx(),
	);
	assert.equal(res.status, 200);
	assert.equal(await res.text(), '["ok"]');
	const tokenCall = callsTo(fc, TOKEN_URL)[0];
	assert.ok(tokenCall.init.body.includes('grant_type=client_credentials'));
	assert.ok(tokenCall.init.body.includes('client_id=test-id'));
	assert.ok(tokenCall.init.signal instanceof AbortSignal);
	const upstreamCall = callsWith(fc, NOTAM_URL)[0];
	assert.equal(upstreamCall.init.headers.Authorization, 'Bearer tok-1');
	assert.ok(upstreamCall.url.includes('itemas='));
	assert.ok(upstreamCall.init.signal instanceof AbortSignal);
});

test('the /notam response cache keys on the full normalized query', async () => {
	const worker = await freshWorker();
	const fc = stubFetch((url) => {
		if (url === TOKEN_URL) {
			return tokenResponse();
		}
		if (url.startsWith(NOTAM_URL)) {
			return jsonResponse('["bulletin"]');
		}
		throw new Error('unexpected url ' + url);
	});
	const ctx = makeCtx();
	const base = '/notam?itemas=%5B%22LFFF%22%5D&limit=100&offset=0';
	const upstream = () => callsWith(fc, NOTAM_URL).length;

	// 1000000000 is 40 s into its 60 s bucket: +10 s stays inside, so two
	// consecutive now-anchored requests share one entry.
	await worker.fetch(req(base + '&startvalidity=1000000000&endvalidity=1000086400'), ENV, ctx);
	assert.equal(upstream(), 1);
	await worker.fetch(req(base + '&startvalidity=1000000010&endvalidity=1000086410'), ENV, ctx);
	assert.equal(upstream(), 1);

	// A crafted stale window (the cache-poisoning shape) gets its OWN key and
	// can never alias the live window's entry.
	await worker.fetch(req(base + '&startvalidity=0&endvalidity=1'), ENV, ctx);
	assert.equal(upstream(), 2);

	// The original window still replays from cache.
	await worker.fetch(req(base + '&startvalidity=1000000000&endvalidity=1000086400'), ENV, ctx);
	assert.equal(upstream(), 2);

	// Any other param differing is a different key too.
	await worker.fetch(
		req(
			base.replace('offset=0', 'offset=100') + '&startvalidity=1000000000&endvalidity=1000086400',
		),
		ENV,
		ctx,
	);
	assert.equal(upstream(), 3);
});

test('the per-IP rate limit refuses the 121st /notam inside the window', async () => {
	const worker = await freshWorker();
	stubFetch((url) => {
		if (url === TOKEN_URL) {
			return tokenResponse();
		}
		if (url.startsWith(NOTAM_URL)) {
			return jsonResponse('[]');
		}
		throw new Error('unexpected url ' + url);
	});
	const ctx = makeCtx();
	const path = '/notam?itemas=%5B%22LFFF%22%5D&limit=10&offset=0';
	for (let i = 0; i < 120; i++) {
		const res = await worker.fetch(req(path), ENV, ctx);
		assert.equal(res.status, 200);
	}
	const refused = await worker.fetch(req(path), ENV, ctx);
	assert.equal(refused.status, 429);
	assert.ok(Number(refused.headers.get('Retry-After')) >= 1);
	// Another IP is unaffected (served from the warm cache).
	const other = await worker.fetch(req(path, { ip: '198.51.100.9' }), ENV, ctx);
	assert.equal(other.status, 200);
});

test('/sofia enforces the body cap before buffering (string and streamed)', async () => {
	const worker = await freshWorker();
	const fc = stubFetch(() => {
		throw new Error('no upstream call expected');
	});
	const big = 'x'.repeat(9000);
	const declared = await worker.fetch(req('/sofia', { method: 'POST', body: big }), ENV, makeCtx());
	assert.equal(declared.status, 413);
	// A chunked body with no Content-Length trips the streamed running cap.
	const chunks = [new Uint8Array(4096), new Uint8Array(4096), new Uint8Array(4096)];
	const streamed = await worker.fetch(
		req('/sofia', { method: 'POST', body: streamOf(chunks) }),
		ENV,
		makeCtx(),
	);
	assert.equal(streamed.status, 413);
	assert.equal(fc.length, 0);
});

test('/sofia validates ?session= against the JSESSIONID charset', async () => {
	const worker = await freshWorker();
	const fc = stubFetch((url) => {
		if (url === SOFIA_POST_URL) {
			return jsonResponse('{"pib":1}');
		}
		throw new Error('unexpected url ' + url);
	});
	const smuggle = await worker.fetch(
		req('/sofia?session=' + encodeURIComponent('abc; FOO=bar'), {
			method: 'POST',
			body: 'route=x',
		}),
		ENV,
		makeCtx(),
	);
	assert.equal(smuggle.status, 400);
	assert.equal(fc.length, 0);
	// A valid token skips the homepage handshake and rides the Cookie header.
	const ok = await worker.fetch(
		req('/sofia?session=0A1B2C3D4E', { method: 'POST', body: 'route=x' }),
		ENV,
		makeCtx(),
	);
	assert.equal(ok.status, 200);
	assert.equal(fc.length, 1);
	assert.equal(fc[0].url, SOFIA_POST_URL);
	assert.equal(fc[0].init.headers.Cookie, 'JSESSIONID=0A1B2C3D4E');
	assert.equal(fc[0].init.headers['X-Requested-With'], 'XMLHttpRequest');
	assert.ok(fc[0].init.signal instanceof AbortSignal);
});

test('concurrent identical /sofia briefings coalesce into one upstream POST', async () => {
	const worker = await freshWorker();
	let releasePost;
	const gate = new Promise((r) => {
		releasePost = r;
	});
	const fc = stubFetch(async (url) => {
		if (url === SOFIA_HOME_URL) {
			return homepageResponse('S1');
		}
		if (url === SOFIA_POST_URL) {
			await gate;
			return jsonResponse('{"pib":42}');
		}
		throw new Error('unexpected url ' + url);
	});
	const ctx = makeCtx();
	const mk = () => req('/sofia', { method: 'POST', body: 'route=LFPB' });
	const p1 = worker.fetch(mk(), ENV, ctx);
	// Wait until the leader is inside the upstream POST, then fire a follower.
	await waitFor(() => callsTo(fc, SOFIA_POST_URL).length === 1);
	const p2 = worker.fetch(mk(), ENV, ctx);
	await new Promise((r) => setTimeout(r, 25));
	releasePost();
	const [r1, r2] = await Promise.all([p1, p2]);
	assert.equal(r1.status, 200);
	assert.equal(r2.status, 200);
	assert.equal(await r1.text(), '{"pib":42}');
	assert.equal(await r2.text(), '{"pib":42}');
	assert.equal(callsTo(fc, SOFIA_POST_URL).length, 1);
	assert.equal(callsTo(fc, SOFIA_HOME_URL).length, 1);
});

test('an abandoned /sofia leader still settles, freeing its key and warming the cache', async () => {
	// The SPA aborts a briefing that outruns its budget and retries the SAME
	// body 4 s later, which is both the cache key and the single-flight key.
	// The leader must therefore outlive the client that started it: waitUntil
	// is what lets it finish, clear the key and fill the cache, so the retry
	// is served instead of following a promise that can never resolve.
	const worker = await freshWorker();
	let releasePost;
	const gate = new Promise((r) => {
		releasePost = r;
	});
	const fc = stubFetch(async (url) => {
		if (url === SOFIA_HOME_URL) {
			return homepageResponse('S1');
		}
		if (url === SOFIA_POST_URL) {
			await gate;
			return jsonResponse('{"pib":7}');
		}
		throw new Error('unexpected url ' + url);
	});
	const ctx = makeCtx();
	const mk = () => req('/sofia', { method: 'POST', body: 'route=LFPL' });
	// The first client asks and walks away; nothing awaits its response.
	void worker.fetch(mk(), ENV, ctx);
	await waitFor(() => callsTo(fc, SOFIA_POST_URL).length === 1);
	assert.equal(ctx.waits.length, 1, 'the leader is registered with waitUntil');
	releasePost();
	await Promise.all(ctx.waits);
	// The retry hits the cache: no second POST, and the body is the leader's.
	const retry = await worker.fetch(mk(), ENV, ctx);
	assert.equal(retry.status, 200);
	assert.equal(await retry.text(), '{"pib":7}');
	assert.equal(callsTo(fc, SOFIA_POST_URL).length, 1);
});

test('the /sofia response cache keys on the raw body', async () => {
	const worker = await freshWorker();
	let posts = 0;
	stubFetch((url) => {
		if (url === SOFIA_HOME_URL) {
			return homepageResponse('S9');
		}
		if (url === SOFIA_POST_URL) {
			posts++;
			return jsonResponse('{"n":' + posts + '}');
		}
		throw new Error('unexpected url ' + url);
	});
	const ctx = makeCtx();
	const r1 = await worker.fetch(
		req('/sofia', { method: 'POST', body: 'route=LFPB&width=10' }),
		ENV,
		ctx,
	);
	assert.equal(await r1.text(), '{"n":1}');
	const r2 = await worker.fetch(
		req('/sofia', { method: 'POST', body: 'route=LFPB&width=10' }),
		ENV,
		ctx,
	);
	assert.equal(await r2.text(), '{"n":1}'); // cache hit
	assert.equal(posts, 1);
	const r3 = await worker.fetch(
		req('/sofia', { method: 'POST', body: 'route=LFPG&width=10' }),
		ENV,
		ctx,
	);
	assert.equal(await r3.text(), '{"n":2}'); // different body, different entry
	assert.equal(posts, 2);
});

test('/notam retries once with a freshly minted token on 401', async () => {
	const worker = await freshWorker();
	let tokenCalls = 0;
	let notamCalls = 0;
	const fc = stubFetch((url) => {
		if (url === TOKEN_URL) {
			tokenCalls++;
			return tokenResponse('tok-' + tokenCalls);
		}
		if (url.startsWith(NOTAM_URL)) {
			notamCalls++;
			return notamCalls === 1
				? new Response('expired', { status: 401 })
				: jsonResponse('["after"]');
		}
		throw new Error('unexpected url ' + url);
	});
	const res = await worker.fetch(req('/notam?itemas=%5B%22LFEE%22%5D'), ENV, makeCtx());
	assert.equal(res.status, 200);
	assert.equal(await res.text(), '["after"]');
	assert.equal(tokenCalls, 2);
	assert.equal(notamCalls, 2);
	assert.equal(callsWith(fc, NOTAM_URL)[1].init.headers.Authorization, 'Bearer tok-2');
});

test('a token failure during the 401 retry reports the real token error', async () => {
	const worker = await freshWorker();
	let tokenCalls = 0;
	stubFetch((url) => {
		if (url === TOKEN_URL) {
			tokenCalls++;
			return tokenCalls === 1
				? tokenResponse('tok-1')
				: new Response('invalid_client', { status: 400 });
		}
		if (url.startsWith(NOTAM_URL)) {
			return new Response('expired', { status: 401 });
		}
		throw new Error('unexpected url ' + url);
	});
	const res = await worker.fetch(req('/notam?itemas=%5B%22LFEE%22%5D'), ENV, makeCtx());
	assert.equal(res.status, 503);
	const data = JSON.parse(await res.text());
	assert.equal(data.error, 'token_unavailable');
	assert.ok(data.error_description.includes('HTTP 400'));
});

test('an RFC 6749 token error carries its sentence, not the raw JSON', async () => {
	const worker = await freshWorker();
	stubFetch((url) => {
		if (url === TOKEN_URL) {
			return new Response(
				JSON.stringify({
					error: 'toomanytokens',
					error_description: 'You have too many active access tokens (limit 20).',
				}),
				{ status: 403 },
			);
		}
		throw new Error('unexpected url ' + url);
	});
	const res = await worker.fetch(req('/notam?itemas=%5B%22LFEE%22%5D'), ENV, makeCtx());
	assert.equal(res.status, 503);
	const data = JSON.parse(await res.text());
	assert.equal(
		data.error_description,
		'autorouter token HTTP 403: You have too many active access tokens (limit 20).',
	);
});

test('token failures are negative-cached (one token call for two requests)', async () => {
	const worker = await freshWorker();
	let tokenCalls = 0;
	stubFetch((url) => {
		if (url === TOKEN_URL) {
			tokenCalls++;
			return new Response('nope', { status: 500 });
		}
		throw new Error('unexpected url ' + url);
	});
	const ctx = makeCtx();
	const r1 = await worker.fetch(req('/notam?itemas=a'), ENV, ctx);
	assert.equal(r1.status, 503);
	const r2 = await worker.fetch(req('/notam?itemas=b'), ENV, ctx);
	assert.equal(r2.status, 503);
	assert.equal(tokenCalls, 1);
});

// --- the shared token store ------------------------------------------------
// Autorouter allows 20 simultaneously valid one-hour tokens per account, so a
// cold isolate must adopt the token the others already hold instead of minting
// its own (see worker.js, the token section).

test('a cold isolate adopts the stored token instead of minting one', async () => {
	const worker = await freshWorker();
	const kv = makeKv({ seed: tokenRecord('tok-shared') });
	const fc = stubFetch((url) => {
		if (url.startsWith(NOTAM_URL)) {
			return jsonResponse('["ok"]');
		}
		throw new Error('unexpected url ' + url);
	});
	const res = await worker.fetch(req('/notam?itemas=%5B%22LFEE%22%5D'), envWithKv(kv), makeCtx());
	assert.equal(res.status, 200);
	assert.equal(callsTo(fc, TOKEN_URL).length, 0);
	assert.equal(callsWith(fc, NOTAM_URL)[0].init.headers.Authorization, 'Bearer tok-shared');
	assert.equal(kv.puts.length, 0);
});

test('a minted token is published to the store for the other isolates', async () => {
	const worker = await freshWorker();
	const kv = makeKv();
	stubFetch((url) => {
		if (url === TOKEN_URL) {
			return tokenResponse('tok-1');
		}
		if (url.startsWith(NOTAM_URL)) {
			return jsonResponse('["ok"]');
		}
		throw new Error('unexpected url ' + url);
	});
	const res = await worker.fetch(req('/notam?itemas=%5B%22LFEE%22%5D'), envWithKv(kv), makeCtx());
	assert.equal(res.status, 200);
	assert.equal(kv.puts.length, 1);
	const put = kv.puts[0];
	assert.equal(put.key, TOKEN_KEY);
	assert.equal(JSON.parse(put.value).value, 'tok-1');
	// Expires with the token: the hour it is valid for, less the early-refresh
	// margin, and never under KV's 60 s floor.
	assert.ok(put.opts.expirationTtl > 60 && put.opts.expirationTtl <= 3600);
});

test('an expired stored token is replaced, not adopted', async () => {
	const worker = await freshWorker();
	const kv = makeKv({ seed: tokenRecord('tok-dead', -1000) });
	const fc = stubFetch((url) => {
		if (url === TOKEN_URL) {
			return tokenResponse('tok-1');
		}
		if (url.startsWith(NOTAM_URL)) {
			return jsonResponse('["ok"]');
		}
		throw new Error('unexpected url ' + url);
	});
	const res = await worker.fetch(req('/notam?itemas=%5B%22LFEE%22%5D'), envWithKv(kv), makeCtx());
	assert.equal(res.status, 200);
	assert.equal(callsTo(fc, TOKEN_URL).length, 1);
	assert.equal(callsWith(fc, NOTAM_URL)[0].init.headers.Authorization, 'Bearer tok-1');
	assert.equal(JSON.parse(kv.store.get(TOKEN_KEY)).value, 'tok-1');
});

test('a 401 adopts a token refreshed elsewhere instead of minting one', async () => {
	const worker = await freshWorker();
	const kv = makeKv({ seed: tokenRecord('tok-old') });
	const fc = stubFetch((url, init) => {
		if (url.startsWith(NOTAM_URL)) {
			if (init.headers.Authorization === 'Bearer tok-old') {
				// Another isolate has already replaced it; the retry must find
				// that one rather than spend a slot on a new token.
				kv.store.set(TOKEN_KEY, JSON.stringify(tokenRecord('tok-new')));
				return new Response('expired', { status: 401 });
			}
			return jsonResponse('["after"]');
		}
		throw new Error('unexpected url ' + url);
	});
	const res = await worker.fetch(req('/notam?itemas=%5B%22LFEE%22%5D'), envWithKv(kv), makeCtx());
	assert.equal(res.status, 200);
	assert.equal(await res.text(), '["after"]');
	assert.equal(callsTo(fc, TOKEN_URL).length, 0);
	assert.equal(callsWith(fc, NOTAM_URL)[1].init.headers.Authorization, 'Bearer tok-new');
});

test('a 401 on the stored token itself mints once and republishes', async () => {
	const worker = await freshWorker();
	const kv = makeKv({ seed: tokenRecord('tok-old') });
	const fc = stubFetch((url, init) => {
		if (url === TOKEN_URL) {
			return tokenResponse('tok-1');
		}
		if (url.startsWith(NOTAM_URL)) {
			return init.headers.Authorization === 'Bearer tok-old'
				? new Response('expired', { status: 401 })
				: jsonResponse('["after"]');
		}
		throw new Error('unexpected url ' + url);
	});
	const res = await worker.fetch(req('/notam?itemas=%5B%22LFEE%22%5D'), envWithKv(kv), makeCtx());
	assert.equal(res.status, 200);
	assert.equal(callsTo(fc, TOKEN_URL).length, 1);
	assert.equal(callsWith(fc, NOTAM_URL)[1].init.headers.Authorization, 'Bearer tok-1');
	assert.equal(JSON.parse(kv.store.get(TOKEN_KEY)).value, 'tok-1');
});

test('a store outage falls through to a mint, never to a failed request', async () => {
	const worker = await freshWorker();
	const kv = makeKv({ fail: true });
	const fc = stubFetch((url) => {
		if (url === TOKEN_URL) {
			return tokenResponse('tok-1');
		}
		if (url.startsWith(NOTAM_URL)) {
			return jsonResponse('["ok"]');
		}
		throw new Error('unexpected url ' + url);
	});
	const res = await worker.fetch(req('/notam?itemas=%5B%22LFEE%22%5D'), envWithKv(kv), makeCtx());
	assert.equal(res.status, 200);
	assert.equal(callsTo(fc, TOKEN_URL).length, 1);
	assert.equal(callsWith(fc, NOTAM_URL)[0].init.headers.Authorization, 'Bearer tok-1');
});

test('an isolate whose own mint failed still adopts a token stored since', async () => {
	const worker = await freshWorker();
	const kv = makeKv();
	let tokenCalls = 0;
	stubFetch((url) => {
		if (url === TOKEN_URL) {
			tokenCalls++;
			return new Response('{"error":"toomanytokens"}', { status: 403 });
		}
		if (url.startsWith(NOTAM_URL)) {
			return jsonResponse('["ok"]');
		}
		throw new Error('unexpected url ' + url);
	});
	const env = envWithKv(kv);
	const first = await worker.fetch(req('/notam?itemas=a'), env, makeCtx());
	assert.equal(first.status, 503);
	// A luckier isolate got one meanwhile; the negative cache must not hide it.
	kv.store.set(TOKEN_KEY, JSON.stringify(tokenRecord('tok-shared')));
	const second = await worker.fetch(req('/notam?itemas=b'), env, makeCtx());
	assert.equal(second.status, 200);
	assert.equal(tokenCalls, 1);
});

test('the sofia upstream ceiling also covers /sofia/session', async () => {
	const worker = await freshWorker();
	const fc = stubFetch((url) => {
		if (url === SOFIA_HOME_URL) {
			return homepageResponse('SESSTOK');
		}
		throw new Error('unexpected url ' + url);
	});
	const ctx = makeCtx();
	for (let i = 0; i < 150; i++) {
		const ip = '10.0.' + Math.floor(i / 250) + '.' + (i % 250);
		const res = await worker.fetch(req('/sofia/session', { ip }), ENV, ctx);
		assert.equal(res.status, 200);
	}
	const refused = await worker.fetch(req('/sofia/session', { ip: '10.9.9.9' }), ENV, ctx);
	assert.equal(refused.status, 429);
	assert.ok((await refused.text()).includes('sofia'));
	assert.equal(callsTo(fc, SOFIA_HOME_URL).length, 150);
});

test('/sofia/chart validates params and refuses redirects', async () => {
	const worker = await freshWorker();
	const fc = stubFetch((url, init) => {
		assert.equal(init.redirect, 'manual');
		return new Response('%PDF-1.4', {
			status: 200,
			headers: { 'content-type': 'application/pdf' },
		});
	});
	const ctx = makeCtx();
	const good =
		'/sofia/chart?login=QUJDRA%3D%3D&layer=wintemp/fr/france/fl020&echeance=20260718120000';
	for (const bad of [
		'/sofia/chart?login=a%20b&layer=wintemp/fr&echeance=20260718120000', // space in login
		'/sofia/chart?login=QUJD&layer=..%2Fetc&echeance=20260718120000', // dot in layer
		'/sofia/chart?login=QUJD&layer=wintemp/fr&echeance=2026', // short echeance
		'/sofia/chart?layer=wintemp/fr&echeance=20260718120000', // login missing
	]) {
		const res = await worker.fetch(req(bad), ENV, ctx);
		assert.equal(res.status, 400, bad);
	}
	assert.equal(fc.length, 0);

	const ok = await worker.fetch(req(good), ENV, ctx);
	assert.equal(ok.status, 200);
	assert.equal(ok.headers.get('cache-control'), 'no-store');
	assert.equal(fc.length, 1);
	assert.ok(fc[0].url.startsWith(CHART_URL + '?login='));
	assert.ok(fc[0].init.signal instanceof AbortSignal);

	// A redirect must never be followed off the fixed base.
	stubFetch(() =>
		new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
	);
	const redirected = await worker.fetch(req(good, { ip: '203.0.113.7' }), ENV, ctx);
	assert.equal(redirected.status, 502);
	assert.ok((await redirected.text()).includes('redirect refused'));
});

test('the chart ceiling caps aggregate upstream chart fetches', async () => {
	const worker = await freshWorker();
	stubFetch(() =>
		new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }),
	);
	const ctx = makeCtx();
	const good = '/sofia/chart?login=QUJD&layer=wintemp/fr/france/fl020&echeance=20260718120000';
	for (let i = 0; i < 300; i++) {
		const ip = '10.1.' + Math.floor(i / 250) + '.' + (i % 250);
		const res = await worker.fetch(req(good, { ip }), ENV, ctx);
		assert.equal(res.status, 200);
	}
	const refused = await worker.fetch(req(good, { ip: '10.9.9.9' }), ENV, ctx);
	assert.equal(refused.status, 429);
	assert.ok((await refused.text()).includes('chart'));
});

test('a declared oversize upstream body streams through uncached', async () => {
	const worker = await freshWorker();
	let notamCalls = 0;
	stubFetch((url) => {
		if (url === TOKEN_URL) {
			return tokenResponse();
		}
		if (url.startsWith(NOTAM_URL)) {
			notamCalls++;
			// Content-Length over the 4 MB cap: pass through, never memoize.
			return new Response('BIGDATA', {
				status: 200,
				headers: { 'content-type': 'application/json', 'content-length': '5000000' },
			});
		}
		throw new Error('unexpected url ' + url);
	});
	const ctx = makeCtx();
	const r1 = await worker.fetch(req('/notam?itemas=big'), ENV, ctx);
	assert.equal(r1.status, 200);
	assert.equal(await r1.text(), 'BIGDATA');
	const r2 = await worker.fetch(req('/notam?itemas=big'), ENV, ctx);
	assert.equal(r2.status, 200);
	assert.equal(await r2.text(), 'BIGDATA');
	assert.equal(notamCalls, 2); // not served from the response cache
});

test('a body crossing the cap mid-read switches to pass-through', async () => {
	const worker = await freshWorker();
	let notamCalls = 0;
	const chunk = new Uint8Array(1_000_000).fill(65); // 'A'
	stubFetch((url) => {
		if (url === TOKEN_URL) {
			return tokenResponse();
		}
		if (url.startsWith(NOTAM_URL)) {
			notamCalls++;
			// 5 MB streamed with no Content-Length: the running cap must kick in.
			return new Response(streamOf([chunk, chunk, chunk, chunk, chunk]), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}
		throw new Error('unexpected url ' + url);
	});
	const ctx = makeCtx();
	const r1 = await worker.fetch(req('/notam?itemas=huge'), ENV, ctx);
	assert.equal(r1.status, 200);
	const text = await r1.text();
	assert.equal(text.length, 5_000_000);
	assert.equal(text[0], 'A');
	assert.equal(text[text.length - 1], 'A');
	const r2 = await worker.fetch(req('/notam?itemas=huge'), ENV, ctx);
	assert.equal((await r2.text()).length, 5_000_000);
	assert.equal(notamCalls, 2); // cache never warmed
});

test('/wx validates its query surface', async () => {
	const worker = await freshWorker();
	const fc = stubFetch((url, init) => {
		assert.ok(init.signal instanceof AbortSignal);
		return jsonResponse('[{"icaoId":"LFPO"}]');
	});
	const ctx = makeCtx();
	const ok = await worker.fetch(req('/wx/metar?ids=LFPO'), ENV, ctx);
	assert.equal(ok.status, 200);
	assert.ok(fc[0].url.startsWith('https://aviationweather.gov/api/data/metar?'));
	assert.ok(fc[0].url.includes('format=json'));
	for (const bad of [
		'/wx/metar?ids=bad..list',
		'/wx/metar?bbox=0,0,10,10', // span over 4 degrees
		'/wx/metar', // ids or bbox required
		'/wx/isigmet?ids=LFPO', // global endpoint refuses params
		'/wx/nope?ids=LFPO', // unknown endpoint
	]) {
		const res = await worker.fetch(req(bad), ENV, ctx);
		assert.ok(res.status === 400 || res.status === 404, bad);
	}
	assert.equal(fc.length, 1);
});

test('/wx serves a second origin from the edge cache under its own CORS header', async () => {
	const worker = await freshWorker();
	installRecordingCache();
	const fc = stubFetch(() => jsonResponse('[{"icaoId":"LFPO"}]'));
	const ctx = makeCtx();
	const first = await worker.fetch(req('/wx/metar?ids=LFPO'), ENV, ctx);
	assert.equal(first.status, 200);
	assert.equal(first.headers.get('access-control-allow-origin'), ORIGIN);
	await Promise.all(ctx.waits);
	assert.equal(fc.length, 1);

	// The Android WebView's origin, allow-listed like the site's: it is served
	// the cached body under ITS OWN name. The edge cache keys on the URL alone,
	// so a stored copy carrying the first origin's header would hand this
	// reader a response its browser must reject.
	const second = await worker.fetch(
		req('/wx/metar?ids=LFPO', { origin: 'https://localhost', ip: '203.0.113.9' }),
		ENV,
		ctx,
	);
	assert.equal(second.status, 200);
	assert.equal(second.headers.get('access-control-allow-origin'), 'https://localhost');
	assert.equal(fc.length, 1, 'the second origin must not reach the AWC');
});



test('/sia/vac relays one Atlas plate and refuses every other shape', async () => {
	const worker = await freshWorker();
	const fc = stubFetch((url, init) => {
		assert.ok(init.signal instanceof AbortSignal);
		return new Response('%PDF-1.4', {
			status: 200,
			headers: { 'content-type': 'application/pdf' },
		});
	});
	const ctx = makeCtx();
	for (const bad of [
		'/sia/vac/06_AUG_2026/AD-2.LFPL.pdf?x=1', // a query is never meaningful
		'/sia/vac/2026-08-06/AD-2.LFPL.pdf', // not the cycle's own spelling
		'/sia/vac/06_AUG_2026/AD-4.LFPL.pdf', // no such Atlas product
		'/sia/vac/06_AUG_2026/AD-2.LFPL.exe', // not a plate
		'/sia/vac/06_AUG_2026/AD-2.LF-PL.pdf', // punctuation in the code
	]) {
		const res = await worker.fetch(req(bad), ENV, ctx);
		assert.equal(res.status, 400, bad);
	}
	// A traversal never reaches the handler at all: the URL parser resolves
	// it away, so the path leaves the prefix and the router answers 404.
	const up = await worker.fetch(req('/sia/vac/06_AUG_2026/../../secret'), ENV, ctx);
	assert.equal(up.status, 404);
	const posted = await worker.fetch(
		req('/sia/vac/06_AUG_2026/AD-2.LFPL.pdf', { method: 'POST' }),
		ENV,
		ctx,
	);
	assert.equal(posted.status, 405);
	assert.equal(fc.length, 0);

	const ok = await worker.fetch(req('/sia/vac/06_AUG_2026/AD-2.LFPL.pdf'), ENV, ctx);
	assert.equal(ok.status, 200);
	assert.equal(ok.headers.get('content-type'), 'application/pdf');
	// A plate does not change within its cycle, and a new cycle is a new path.
	assert.equal(ok.headers.get('cache-control'), 'public, max-age=31536000, immutable');
	assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
	assert.equal(fc.length, 1);
	assert.equal(
		fc[0].url,
		'https://www.sia.aviation-civile.gouv.fr/media/dvd/eAIP_06_AUG_2026/' +
			'Atlas-VAC/PDF_AIPparSSection/VAC/AD/AD-2.LFPL.pdf',
	);

	// Section 3 is the helistation product, which spells its own directory.
	const heli = await worker.fetch(req('/sia/vac/06_AUG_2026/AD-3.LF075.pdf'), ENV, ctx);
	assert.equal(heli.status, 200);
	assert.ok(fc[1].url.includes('/PDF_AIPparSSection/VACH/AD/AD-3.LF075.pdf'));
});

test('/sia/vac refuses a non-PDF 200 and passes an upstream miss through', async () => {
	const worker = await freshWorker();
	// The SIA answers a missing file with an HTML error page under a 200, so
	// the content type decides, never the status.
	let fc = stubFetch(() =>
		new Response('<html>Not found</html>', {
			status: 200,
			headers: { 'content-type': 'text/html; charset=utf-8' },
		}),
	);
	const ctx = makeCtx();
	const html = await worker.fetch(req('/sia/vac/06_AUG_2026/AD-2.LFXX.pdf'), ENV, ctx);
	assert.equal(html.status, 404);
	assert.equal(html.headers.get('access-control-allow-origin'), ORIGIN);
	assert.equal(fc.length, 1);

	stubFetch(() => new Response(null, { status: 404 }));
	const miss = await worker.fetch(req('/sia/vac/06_AUG_2026/AD-2.LFYY.pdf'), ENV, ctx);
	assert.equal(miss.status, 404);

	stubFetch(() => {
		throw new Error('boom');
	});
	const down = await worker.fetch(req('/sia/vac/06_AUG_2026/AD-2.LFZZ.pdf'), ENV, ctx);
	assert.equal(down.status, 502);
	assert.ok((await down.text()).includes('boom'));
});

test('/sia/vac serves a second reader from the edge cache', async () => {
	const worker = await freshWorker();
	// A recording cache, unlike the helper's always-miss shim: the point here
	// is that one plate costs the SIA one fetch however many pilots ask.
	installRecordingCache();
	const fc = stubFetch(() =>
		new Response('%PDF-1.4', {
			status: 200,
			headers: { 'content-type': 'application/pdf' },
		}),
	);
	const ctx = makeCtx();
	const path = '/sia/vac/06_AUG_2026/AD-2.LFPL.pdf';
	const first = await worker.fetch(req(path), ENV, ctx);
	assert.equal(first.status, 200);
	assert.equal(await first.text(), '%PDF-1.4');
	await Promise.all(ctx.waits);
	assert.equal(fc.length, 1);

	// The second reader is the Android shell: the stored copy must carry
	// NO origin of its own and be stamped per request (Cloudflare keys the
	// edge cache on the URL alone and ignores Vary: Origin), the same pin
	// the /wx and /tiles routes carry.
	const second = await worker.fetch(
		req(path, { ip: '203.0.113.9', origin: 'https://localhost' }),
		ENV,
		ctx,
	);
	assert.equal(second.status, 200);
	assert.equal(await second.text(), '%PDF-1.4');
	assert.equal(second.headers.get('access-control-allow-origin'), 'https://localhost');
	assert.equal(fc.length, 1, 'the second reader must not reach the SIA');
});

test('the vac ceiling caps aggregate upstream plate fetches', async () => {
	const worker = await freshWorker();
	stubFetch(() =>
		new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }),
	);
	const ctx = makeCtx();
	for (let i = 0; i < 120; i++) {
		const ip = '10.2.' + Math.floor(i / 100) + '.' + (i % 100);
		const path = '/sia/vac/06_AUG_2026/AD-2.LF' + String(i).padStart(2, '0') + '.pdf';
		const res = await worker.fetch(req(path, { ip }), ENV, ctx);
		assert.equal(res.status, 200);
	}
	const refused = await worker.fetch(
		req('/sia/vac/06_AUG_2026/AD-2.LFZZ.pdf', { ip: '10.9.9.9' }),
		ENV,
		ctx,
	);
	assert.equal(refused.status, 429);
	assert.ok((await refused.text()).includes('vac'));
});

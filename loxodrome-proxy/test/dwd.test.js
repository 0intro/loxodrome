// The Deutscher Wetterdienst analysis relay (GET /dwd/charts/analysis and
// /dwd/charts/analysis/<name>): node --test, offline. The listing fixture is
// a trimmed copy of the real autoindex (tests/fixtures/dwd-analysis-index.html,
// read 2026-10-02), which carries every shape the parser must leave out: the
// black-and-white rendering, the wider and the marine products, a model
// chart and the LATEST aliases.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	ENV,
	ORIGIN,
	freshWorker,
	installRecordingCache,
	makeCtx,
	req,
	streamOf,
	stubFetch,
} from './helpers.js';

const BASE = 'https://opendata.dwd.de/weather/charts/analysis/';
const INDEX_HTML = readFileSync(
	new URL('../../tests/fixtures/dwd-analysis-index.html', import.meta.url),
	'utf8',
);
const NAME_18 =
	'Z__C_EDZW_20261001191239_tka01%2Cana_bwkman_dwdna_O_000000_000000_202610011800_WV12.png';
const NAME_00 =
	'Z__C_EDZW_20261002014431_tka01%2Cana_bwkman_dwdna_O_000000_000000_202610020000_WV12.png';
const NAME_06 =
	'Z__C_EDZW_20261002074952_tka01%2Cana_bwkman_dwdna_O_000000_000000_202610020600_WV12.png';

/** A PNG's signature, its IHDR chunk head, then filler. */
const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x11,
	0x25, 0, 0, 0x0c, 0x2a, 8, 2, 0, 0, 0, 1, 2, 3, 4, 5,
]);

function htmlResponse(body, status = 200) {
	return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

/** The chart as DWD serves it: a declared length, the bytes in pieces (the
 *  signature split across two of them, which the relay must join). */
function pngResponse(bytes = PNG, length = String(bytes.length)) {
	const headers = { 'content-type': 'image/png' };
	if (length != null) {
		headers['content-length'] = length;
	}
	return new Response(streamOf([bytes.slice(0, 3), bytes.slice(3, 11), bytes.slice(11)]), {
		status: 200,
		headers,
	});
}

/** console.error, captured as the parsed log records it writes. */
async function capturingLogs(fn) {
	const logs = [];
	const orig = console.error;
	console.error = (line) => logs.push(JSON.parse(line));
	try {
		await fn();
	} finally {
		console.error = orig;
	}
	return logs;
}

test('/dwd/charts/analysis lists the colour North Atlantic-Europe analyses, and only them', async () => {
	const worker = await freshWorker();
	const store = installRecordingCache();
	const fc = stubFetch((url, init) => {
		assert.equal(url, BASE);
		// A redirect would leave the fixed base: refused rather than followed.
		assert.equal(init.redirect, 'manual');
		assert.ok(init.signal instanceof AbortSignal);
		return htmlResponse(INDEX_HTML);
	});
	const ctx = makeCtx();
	const res = await worker.fetch(req('/dwd/charts/analysis'), ENV, ctx);
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { names: [NAME_18, NAME_00, NAME_06] });
	// A fresh chart lands every six hours: the browser never keeps the list.
	assert.equal(res.headers.get('cache-control'), 'no-store');
	assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
	await Promise.all(ctx.waits);
	// The stored copy carries the edge's own lifetime and NO Allow-Origin, so a
	// hit for another allow-listed origin is stamped for that origin.
	const stored = [...store.values()];
	assert.equal(stored.length, 1);
	assert.equal(stored[0].headers.get('cache-control'), 'public, max-age=300');
	assert.equal(stored[0].headers.get('access-control-allow-origin'), null);

	const second = await worker.fetch(
		req('/dwd/charts/analysis', { origin: 'https://localhost', ip: '203.0.113.9' }),
		ENV,
		ctx,
	);
	assert.equal(second.status, 200);
	assert.equal(second.headers.get('access-control-allow-origin'), 'https://localhost');
	assert.deepEqual((await second.json()).names, [NAME_18, NAME_00, NAME_06]);
	assert.equal(fc.length, 1);
});

test('/dwd/charts/analysis refuses what is not the listing, and keeps none of it', async () => {
	const worker = await freshWorker();
	const store = installRecordingCache();
	const ctx = makeCtx();
	const cases = [
		// An error page under a 200 must not become an empty list for everyone.
		() => htmlResponse('<html><body>Service unavailable</body></html>'),
		() => new Response(null, { status: 301, headers: { location: 'https://example.com/' } }),
		() => htmlResponse('oops', 503),
		() => {
			throw new Error('connect ECONNREFUSED');
		},
	];
	const logs = await capturingLogs(async () => {
		for (const answer of cases) {
			stubFetch(answer);
			const res = await worker.fetch(req('/dwd/charts/analysis'), ENV, ctx);
			assert.equal(res.status, 502);
			assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
		}
	});
	await Promise.all(ctx.waits);
	assert.equal(store.size, 0);
	// Every refusal is logged, by route, never by address.
	assert.equal(logs.length, 4);
	for (const l of logs) {
		assert.equal(l.route, 'dwd-list');
		assert.equal(l.ip, undefined);
	}
});

test('/dwd/charts/analysis answers a listing of none as the empty list, and logs it', async () => {
	const worker = await freshWorker();
	stubFetch(() =>
		htmlResponse(
			'<html><head><title>Index of /weather/charts/analysis/</title></head><body>' +
				'<h1>Index of /weather/charts/analysis/</h1><pre><a href="../">../</a></pre></body></html>',
		),
	);
	const ctx = makeCtx();
	let res;
	const logs = await capturingLogs(async () => {
		res = await worker.fetch(req('/dwd/charts/analysis'), ENV, ctx);
	});
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { names: [] });
	assert.deepEqual(logs, [{ event: 'upstream-error', route: 'dwd-list', error: 'no analysis listed' }]);
});

test('/dwd/charts/analysis takes no query and no other method', async () => {
	const worker = await freshWorker();
	const fc = stubFetch(() => htmlResponse(INDEX_HTML));
	const ctx = makeCtx();
	assert.equal((await worker.fetch(req('/dwd/charts/analysis?x=1'), ENV, ctx)).status, 400);
	assert.equal(
		(await worker.fetch(req('/dwd/charts/analysis', { method: 'POST' }), ENV, ctx)).status,
		405,
	);
	assert.equal((await worker.fetch(req('/dwd/charts'), ENV, ctx)).status, 404);
	assert.equal(fc.length, 0);
});

test('/dwd/charts/analysis/<name> streams one analysis and keeps it for its days', async () => {
	const worker = await freshWorker();
	const store = installRecordingCache();
	const fc = stubFetch((url, init) => {
		// The name exactly as the listing spells it, the comma still encoded.
		assert.equal(url, BASE + NAME_06);
		assert.equal(init.redirect, 'manual');
		assert.ok(init.signal instanceof AbortSignal);
		return pngResponse();
	});
	const ctx = makeCtx();
	const res = await worker.fetch(req(`/dwd/charts/analysis/${NAME_06}`), ENV, ctx);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get('content-type'), 'image/png');
	assert.equal(res.headers.get('cache-control'), 'private, max-age=86400, immutable');
	assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
	// The bytes read to check the signature are handed back first, whole.
	assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
	await Promise.all(ctx.waits);
	const stored = [...store.values()];
	assert.equal(stored.length, 1);
	assert.equal(stored[0].headers.get('cache-control'), 'public, max-age=259200, immutable');
	assert.equal(stored[0].headers.get('access-control-allow-origin'), null);

	const second = await worker.fetch(
		req(`/dwd/charts/analysis/${NAME_06}`, { origin: 'https://localhost', ip: '203.0.113.9' }),
		ENV,
		ctx,
	);
	assert.equal(second.status, 200);
	assert.equal(second.headers.get('access-control-allow-origin'), 'https://localhost');
	assert.deepEqual(new Uint8Array(await second.arrayBuffer()), PNG);
	assert.equal(fc.length, 1);
});

test('/dwd/charts/analysis/<name> takes the one product and rendering, spelled as listed', async () => {
	const worker = await freshWorker();
	const fc = stubFetch(() => pngResponse());
	const ctx = makeCtx();
	for (const bad of [
		NAME_06.replace('%2C', ','), // the comma not as the listing spells it
		NAME_06.replace('%2C', '%252C'), // encoded twice
		NAME_06.replace('_WV12.png', '_WV12SW.png'), // the black-and-white rendering
		NAME_06.replace('dwdna', 'dwdc'), // the wider product
		NAME_06.replace('dwdna_O_000000_000000_202610020600_WV12', 'dwdsk_O_000000_000000_202610020600_WVHASW'),
		'Z__C_EDZW_LATEST_tka01%2Cana_bwkman_dwdna_O_000000_000000_LATEST_WV12.png',
		'Z__C_EDZW_20261002034200_nwv01%2Cico_p00_na_N_000000_999999_202610020000_WV11.png',
		NAME_06.toLowerCase(),
		`${NAME_06}/x`,
		`x/${NAME_06}`,
		'',
	]) {
		const res = await worker.fetch(req(`/dwd/charts/analysis/${bad}`), ENV, ctx);
		assert.equal(res.status, 400, bad);
	}
	// A traversal never reaches the handler: the URL parser resolves it away
	// and the path leaves the route (the /sia/vac precedent).
	assert.equal((await worker.fetch(req('/dwd/charts/analysis/../../x'), ENV, ctx)).status, 404);
	assert.equal(
		(await worker.fetch(req(`/dwd/charts/analysis/${NAME_06}?v=1`), ENV, ctx)).status,
		400,
	);
	assert.equal(
		(await worker.fetch(req(`/dwd/charts/analysis/${NAME_06}`, { method: 'POST' }), ENV, ctx))
			.status,
		405,
	);
	assert.equal(fc.length, 0);
});

test('/dwd/charts/analysis/<name> refuses what is not a chart, and keeps none of it', async () => {
	const worker = await freshWorker();
	const store = installRecordingCache();
	const ctx = makeCtx();
	const big = String(13 * 1024 * 1024);
	const cases = [
		// A chart the server no longer keeps: its own 404, passed through.
		[() => new Response(null, { status: 404 }), 404],
		// A page under a 200.
		[() => new Response('<html>error</html>', { status: 200, headers: { 'content-length': '18' } }), 502],
		[() => new Response(null, { status: 302, headers: { location: 'https://example.com/' } }), 502],
		[() => new Response('busy', { status: 503 }), 502],
		// No stated length: nothing bounds what would be read.
		[() => pngResponse(PNG, null), 502],
		[() => pngResponse(PNG, big), 502],
		// Shorter than a signature.
		[() => new Response(streamOf([PNG.slice(0, 5)]), { status: 200, headers: { 'content-length': '5' } }), 502],
		[
			() => {
				throw new Error('socket hang up');
			},
			502,
		],
	];
	await capturingLogs(async () => {
		for (const [answer, status] of cases) {
			stubFetch(answer);
			const res = await worker.fetch(req(`/dwd/charts/analysis/${NAME_00}`), ENV, ctx);
			assert.equal(res.status, status);
			assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
		}
	});
	await Promise.all(ctx.waits);
	assert.equal(store.size, 0);
});

test('one client past 60 DWD requests a minute is refused', async () => {
	const worker = await freshWorker();
	installRecordingCache();
	stubFetch(() => htmlResponse(INDEX_HTML));
	const ctx = makeCtx();
	for (let i = 0; i < 60; i++) {
		const res = await worker.fetch(req('/dwd/charts/analysis'), ENV, ctx);
		assert.equal(res.status, 200, `request ${i + 1}`);
		await res.arrayBuffer();
	}
	const over = await worker.fetch(req('/dwd/charts/analysis'), ENV, ctx);
	assert.equal(over.status, 429);
	assert.ok(over.headers.get('retry-after'));
});

test('past 120 upstream misses a minute, every client waits', async () => {
	const worker = await freshWorker();
	// The always-miss edge: every request reaches DWD.
	stubFetch(() => pngResponse());
	const ctx = makeCtx();
	await capturingLogs(async () => {
		for (let i = 0; i < 120; i++) {
			const res = await worker.fetch(
				req(`/dwd/charts/analysis/${NAME_00}`, { ip: `198.51.100.${i % 250}` }),
				ENV,
				ctx,
			);
			assert.equal(res.status, 200, `miss ${i + 1}`);
			await res.arrayBuffer();
		}
		const over = await worker.fetch(
			req(`/dwd/charts/analysis/${NAME_00}`, { ip: '192.0.2.77' }),
			ENV,
			ctx,
		);
		assert.equal(over.status, 429);
		assert.ok((await over.text()).includes('dwd'));
	});
});

// The zone NOTAMs of the French FIRs (GET /notam/fr-zones): one fixed
// autorouter query for LFBB, LFEE, LFFF, LFMM and LFRR, every page to the
// stated total, the rows of series R and Z kept, edge-cached for five
// minutes and handed to the client as a no-store copy.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ENV,
	NOTAM_URL,
	TOKEN_URL,
	callsWith,
	freshWorker,
	installRecordingCache,
	jsonResponse,
	makeCtx,
	req,
	stubFetch,
	tokenResponse,
} from './helpers.js';

const PAGES = [
	{ total: 3, rows: [{ series: 'R', number: 2724, year: 26 }, { series: 'A', number: 1, year: 26 }] },
	{ total: 3, rows: [{ series: 'Z', number: 5, year: 26 }] },
];

function upstream(url) {
	if (url === TOKEN_URL) {
		return tokenResponse('tok-1');
	}
	if (url.startsWith(NOTAM_URL)) {
		const offset = Number(new URL(url).searchParams.get('offset'));
		return jsonResponse(JSON.stringify(offset === 0 ? PAGES[0] : PAGES[1]));
	}
	throw new Error('unexpected url ' + url);
}

test('/notam/fr-zones asks the five French FIRs and keeps series R and Z from every page', async () => {
	const worker = await freshWorker();
	const fc = stubFetch(upstream);
	const res = await worker.fetch(req('/notam/fr-zones'), ENV, makeCtx());
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.deepEqual(
		body.rows.map((r) => r.series),
		['R', 'Z'],
	);
	assert.deepEqual(body.firs, ['LFBB', 'LFEE', 'LFFF', 'LFMM', 'LFRR']);
	const calls = callsWith(fc, NOTAM_URL);
	assert.equal(calls.length, 2);
	assert.equal(new URL(calls[0].url).searchParams.get('itemas'), JSON.stringify(['LFBB', 'LFEE', 'LFFF', 'LFMM', 'LFRR']));
	assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-1');
});

test('/notam/fr-zones is kept at the edge for five minutes and handed out no-store', async () => {
	const worker = await freshWorker();
	const store = installRecordingCache();
	const fc = stubFetch(upstream);
	const ctx = makeCtx();
	const first = await worker.fetch(req('/notam/fr-zones'), ENV, ctx);
	await Promise.all(ctx.waits);
	assert.equal(first.headers.get('cache-control'), 'no-store');
	assert.equal(first.headers.get('access-control-allow-origin'), 'https://loxodrome.fr');
	assert.equal(store.size, 1);
	const [kept] = [...store.values()];
	assert.equal(kept.headers.get('cache-control'), 'public, max-age=300');
	assert.equal(kept.headers.get('access-control-allow-origin'), null);
	const second = await worker.fetch(req('/notam/fr-zones'), ENV, makeCtx());
	assert.equal(second.status, 200);
	assert.equal((await second.json()).rows.length, 2);
	assert.equal(callsWith(fc, NOTAM_URL).length, 2, 'the second reader is served from the edge');
});

test('/notam/fr-zones keeps no failure at the edge', async () => {
	const worker = await freshWorker();
	const store = installRecordingCache();
	stubFetch((url) => (url === TOKEN_URL ? tokenResponse('tok-1') : jsonResponse('{}', 500)));
	const ctx = makeCtx();
	const res = await worker.fetch(req('/notam/fr-zones'), ENV, ctx);
	await Promise.all(ctx.waits);
	assert.equal(res.status, 502);
	assert.equal(store.size, 0);
});

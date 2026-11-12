import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS } from '../src/models.ts';
import { ifsSteps, listEcmwf, listMeteoFrance, listRuns, mfKeys, readyEcmwf, readyMeteoFrance } from '../src/discover.ts';
import { Coalescer } from '../src/coalesce.ts';
import { CanaryReadFailed, checkCanaries, storeHandler } from '../src/storeHandler.ts';
import { clientKey, rateLimited } from '../src/http.ts';
import type { Env } from '../src/env.ts';
import { chainReceipts, FakeBucket, FIXTURES } from './helpers.ts';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

void test('Météo-France readiness wants all four packages of a group', async () => {
	const spec = MODELS.arome0025;
	const run = Date.parse('2026-10-06T00:00:00Z');
	const r = '2026-10-06T00:00:00Z';
	const key = (pkg: string, label: string): string => `pnt/${r}/arome/0025/${pkg}/arome__0025__${pkg}__${label}__${r}.grib2`;
	const listed = [key('IP1', '00H06H'), key('IP2', '00H06H'), key('SP1', '00H06H'), key('SP2', '00H06H'), key('IP1', '07H12H'), key('SP1', '07H12H')];
	const xml = `<ListBucketResult>${listed.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`;
	let asked = '';
	const keys = await listMeteoFrance(spec, run, (u) => {
		asked = u;
		return Promise.resolve(new Response(xml));
	});
	assert.match(asked, /prefix=pnt%2F2026-10-06T00%3A00%3A00Z%2Farome%2F0025%2F/);
	assert.deepEqual([...readyMeteoFrance(spec, run, spec.blocks(0), keys)], ['b000-006']);
	// ARPEGE reads its clouds from IP3, and labels with three digits.
	const ar = MODELS.arpege01;
	const k2 = (pkg: string): string => `pnt/${r}/arpege/01/${pkg}/arpege__01__${pkg}__000H012H__${r}.grib2`;
	assert.deepEqual([...readyMeteoFrance(ar, run, ar.blocks(0), new Set(['IP1', 'IP3', 'SP1', 'SP2'].map(k2)))], ['b000-012']);
	assert.deepEqual([...readyMeteoFrance(ar, run, ar.blocks(0), new Set(['IP1', 'IP2', 'SP1', 'SP2'].map(k2)))], []);
});

void test('a model publishing a file per hour is ready once every hour of a block is listed', () => {
	const spec = { ...MODELS.arome0025, mf: { dir: 'arome-om/DOM/0025', stem: 'arome-om-DOM__0025', cloudPkg: 'IP2', labelWidth: 3, hourly: true } };
	const run = Date.parse('2026-10-06T00:00:00Z');
	const b = { first: 7, last: 12, name: 'b007-012' };
	const keys = mfKeys(spec, run, b);
	assert.equal(keys.length, 24);
	assert.equal(keys[0], 'pnt/2026-10-06T00:00:00Z/arome-om/DOM/0025/IP1/arome-om-DOM__0025__IP1__007H__2026-10-06T00:00:00Z.grib2');
	assert.equal(keys[23], 'pnt/2026-10-06T00:00:00Z/arome-om/DOM/0025/SP2/arome-om-DOM__0025__SP2__012H__2026-10-06T00:00:00Z.grib2');
	assert.deepEqual([...readyMeteoFrance(spec, run, [b], new Set(keys))], ['b007-012']);
	// One hour's surface file missing holds the block back.
	assert.deepEqual([...readyMeteoFrance(spec, run, [b], new Set(keys.filter((k) => !k.includes('SP1__010H'))))], []);
});

void test('an AROME-OM domain is listed under its own directory and ready hour by hour', async () => {
	const spec = MODELS.aromeomantil;
	const run = Date.parse('2026-10-08T00:00:00Z');
	const b0 = spec.blocks(0)[0];
	const keys = mfKeys(spec, run, b0);
	assert.equal(keys.length, 28);
	let asked = '';
	const xml = `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`;
	const listed = await listMeteoFrance(spec, run, (u) => {
		asked = u;
		return Promise.resolve(new Response(xml));
	});
	assert.match(asked, /prefix=pnt%2F2026-10-08T00%3A00%3A00Z%2Farome-om%2FANTIL%2F0025%2F/);
	assert.deepEqual([...readyMeteoFrance(spec, run, spec.blocks(0), listed)], ['b000-006']);
	listed.delete(keys[27]);
	assert.deepEqual([...readyMeteoFrance(spec, run, spec.blocks(0), listed)], []);
});

void test('ECMWF readiness reads the directory listing for this run only', async () => {
	const html = ['0', '3', '6', '9', '12', '15'].map((s) => `<a href="20261006000000-${s}h-oper-fc.index">x</a>`).join('') + '<a href="20261005180000-18h-oper-fc.index">';
	const steps = await listEcmwf(Date.parse('2026-10-06T00:00:00Z'), () => Promise.resolve(new Response(html)));
	assert.deepEqual([...steps].sort((a, b) => a - b), [0, 3, 6, 9, 12, 15]);
	assert.deepEqual([...readyEcmwf(MODELS.ifs025.blocks(0), steps)], ['b000-012']);
	assert.deepEqual(ifsSteps({ first: 150, last: 168, name: '' }), [150, 156, 162, 168]);
	assert.deepEqual(await listEcmwf(0, () => Promise.resolve(new Response('', { status: 404 }))), new Set());
});

void test('a tick lists its runs in order under one budget, skipping the rest once it is spent', async () => {
	const spec = MODELS.ifs025;
	const runs = ['2026-10-07T18:00:00Z', '2026-10-08T00:00:00Z', '2026-10-08T06:00:00Z'];
	const budget = new AbortController();
	const asked: string[] = [];
	const listed = await listRuns(
		spec,
		runs,
		(u, init) => {
			asked.push(u);
			assert.equal(init?.signal, budget.signal, 'every request carries the budget');
			if (u.includes('/20261007/18z/')) {
				// A run that fails leaves the next to be listed.
				return Promise.resolve(new Response('busy', { status: 503 }));
			}
			// The budget runs out during the second run's listing.
			budget.abort(new Error('listing past 40 s'));
			return Promise.reject(budget.signal.reason as Error);
		},
		budget.signal,
	);
	assert.deepEqual(asked, [
		'https://data.ecmwf.int/forecasts/20261007/18z/ifs/0p25/oper/',
		'https://data.ecmwf.int/forecasts/20261008/00z/ifs/0p25/oper/',
	]);
	assert.deepEqual(
		listed.map((l) => [l.run, String(l.error)]),
		[
			[runs[0], 'Error: ECMWF listing: HTTP 503'],
			[runs[1], 'Error: listing past 40 s'],
		],
		'the third never asked',
	);
	const ok = await listRuns(spec, runs.slice(1, 2), () => Promise.resolve(new Response('', { status: 404 })), new AbortController().signal);
	assert.deepEqual(ok, [{ run: runs[1], ready: new Set() }]);
});

void test('a tick made while one runs joins it, and says so once that one is old', async () => {
	const c = new Coalescer<number>();
	let release = (_: number): void => undefined;
	let calls = 0;
	const fn = (): Promise<number> => {
		calls++;
		return new Promise((r) => (release = r));
	};
	const ages: number[] = [];
	const first = c.run(1_000, fn, (a) => ages.push(a));
	const second = c.run(61_000, fn, (a) => ages.push(a));
	assert.equal(calls, 1, 'joined, not queued');
	assert.deepEqual(ages, [60_000]);
	release(7);
	assert.deepEqual([await first, await second], [7, 7]);
	// Once it settled, the next call runs afresh, a failure too.
	const failing = c.run(121_000, () => Promise.reject(new Error('listing failed')));
	await assert.rejects(failing, /listing failed/);
	assert.equal(await c.run(181_000, () => Promise.resolve(9)), 9);
	assert.equal(calls, 1);
});

function env(bucket: FakeBucket): Env {
	return { NWP: bucket.asR2() } as unknown as Env;
}

void test('the store handler writes, reads and assembles a multipart upload', async () => {
	const bucket = new FakeBucket();
	const e = env(bucket);
	const put = await storeHandler(new Request('http://r2.nwp/receipts/arome0025/2026100600/b000-006.json', { method: 'PUT', body: '{"a":1}', headers: { 'Content-Length': '7' } }), e);
	assert.equal(put.status, 200);
	const got = await storeHandler(new Request('http://r2.nwp/receipts/arome0025/2026100600/b000-006.json'), e);
	assert.equal(await got.text(), '{"a":1}');
	const start = await storeHandler(new Request('http://r2.nwp/blocks/a/b.pmtiles?uploads', { method: 'POST' }), e);
	const { uploadId } = await start.json<{ uploadId: string }>();
	const parts = [];
	for (const [n, text] of [[1, 'hello '], [2, 'world']] as const) {
		const r = await storeHandler(new Request(`http://r2.nwp/blocks/a/b.pmtiles?part=${n}&upload=${uploadId}`, { method: 'PUT', body: text }), e);
		parts.push(await r.json());
	}
	const done = await storeHandler(new Request(`http://r2.nwp/blocks/a/b.pmtiles?upload=${uploadId}`, { method: 'POST', body: JSON.stringify({ parts }) }), e);
	assert.equal(done.status, 200);
	assert.equal(new TextDecoder().decode(bucket.objects.get('blocks/a/b.pmtiles')?.data), 'hello world');
	// Only the ingest's own prefixes.
	for (const bad of ['latest/arome0025.json', 'manifests/x.json', 'first/../latest/x']) {
		const r = await storeHandler(new Request(`http://r2.nwp/${bad}`, { method: 'PUT', body: 'x' }), e);
		assert.equal(r.status, 400, bad);
	}
	assert.equal((await storeHandler(new Request('http://r2.nwp/first/none.pmtiles'), e)).status, 404);
	// The job's log, and the bodiless report when even that fails.
	const log = await storeHandler(new Request('http://r2.nwp/logs/arome0025/2026100600/b000-006.log', { method: 'PUT', body: 'ok\n', headers: { 'Content-Length': '3' } }), e);
	assert.equal(log.status, 200);
	assert.equal((await storeHandler(new Request('http://r2.nwp/__log?m=arome0025%20failed'), e)).status, 204);
});

void test('canary tiles decode to their receipts and catch a corrupted archive', async () => {
	const bucket = FakeBucket.fromDir(join(FIXTURES, 'chain'));
	for (const rec of chainReceipts()) {
		assert.equal(await checkCanaries(bucket.asR2(), rec), null, rec.key);
	}
	const rec = chainReceipts()[0];
	const obj = bucket.objects.get(rec.key)!;
	const c = rec.canaries[0];
	// Flip one byte inside the first canary's payload.
	const { Archive } = await import('../src/pmtiles.ts');
	const archive = await Archive.open(obj.data, (o, l) => Promise.resolve(obj.data.subarray(o, o + l)));
	const at = await archive.locate(c.z, c.x, c.y);
	const copy = obj.data.slice();
	copy[at!.offset + at!.length - 3] ^= 0xff;
	bucket.objects.set(rec.key, { data: copy });
	assert.notEqual(await checkCanaries(bucket.asR2(), rec), null);
});

void test('the rate limit keys an IPv6 /64 and holds an address to its window', () => {
	assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
	assert.equal(clientKey('2001:db8:aa:bb:1:2:3:4'), '2001:db8:aa:bb::/64');
	assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0::/64');
	assert.equal(clientKey('2001:0db8:00aa::'), '2001:db8:aa:0::/64');
	const t = 1_000_000;
	for (let k = 0; k < 300; k++) {
		assert.equal(rateLimited('x', t + k), 0);
	}
	assert.ok(rateLimited('x', t + 300) > 0);
	assert.equal(rateLimited('x', t + 60_001), 0, 'the window slides');
	assert.equal(rateLimited('y', t + 300), 0, 'per address');
});

void test('the store handler is registered through the setter the outbound proxy reads', () => {
	// The ingest module needs the Workers runtime, so its source is read: a
	// static FIELD shadows Container's setter and leaves the proxy's registry
	// empty (every store request then leaves for the internet).
	const src = readFileSync(join(FIXTURES, '..', '..', 'src', 'ingest.ts'), 'utf8');
	assert.doesNotMatch(src, /^\s*static\s+(override\s+)?outboundByHost\s*=/m);
	assert.match(src, /^NwpIngest\.outboundByHost = \{ \[STORE_HOST\]: storeHandler \};$/m);
});

void test('every job start passes the daily budget, the tick names its kill, and the inactivity timeout stays out of the serialized path', () => {
	// The ingest module needs the Workers runtime, so its source is read.
	const src = readFileSync(join(FIXTURES, '..', '..', 'src', 'ingest.ts'), 'utf8');
	const starts = [...src.matchAll(/this\.start\(/g)];
	assert.equal(starts.length, 1, 'one place starts a container');
	const asked = src.indexOf('budgetSpent(state, budgetMs, Date.now())');
	assert.ok(asked > 0 && asked < (starts[0].index ?? 0), 'the budget is asked before the start');
	assert.match(src, /await this\.collect\(state, 'killed past the job cap', undefined, true\);/);
	const expiry = src.slice(src.indexOf('override async onActivityExpired'), src.indexOf('private async publish'));
	assert.ok(expiry.length > 0);
	assert.doesNotMatch(expiry, /serial\(/, 'stop() reaches onStop, which waits on serial');
	const worker = readFileSync(join(FIXTURES, '..', '..', 'worker.ts'), 'utf8');
	assert.match(worker, /\.\.\.budgetStatus\(st, budgetMs, now\)/);
});

void test('every orchestrator is reached with the WEUR hint, the status page included', () => {
	// Whoever touches a Durable Object first places it for good: a model's
	// object first created by a status hit would sit near the caller.
	const src = readFileSync(join(FIXTURES, '..', '..', 'worker.ts'), 'utf8');
	const gets = [...src.matchAll(/INGEST\.get\(/g)];
	assert.equal(gets.length, 1, 'one stub helper reaches the orchestrators');
	assert.match(src, /env\.INGEST\.get\(env\.INGEST\.idFromName\(model\), \{ locationHint: 'weur' \}\)/);
	assert.ok(!/INGEST\.idFromName\([^)]*\)\)\.(tick|status)/.test(src), 'a stub without the hint');
});

void test('a canary read the bucket fails is no verdict; an archive gone is one', async () => {
	const rec = chainReceipts()[0];
	const failing = {
		get: () => Promise.reject(new Error('network connection lost')),
	} as unknown as R2Bucket;
	await assert.rejects(checkCanaries(failing, rec), (err: unknown) => err instanceof CanaryReadFailed);
	const empty = new FakeBucket();
	assert.match((await checkCanaries(empty.asR2(), rec)) ?? '', /not in the bucket/);
});

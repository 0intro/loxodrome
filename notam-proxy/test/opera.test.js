// The EUMETNET OPERA radar routes: node --test "notam-proxy/test/*.test.js".
// Same harness as worker.test.js: a fresh worker per test, a stubbed fetch,
// no network. The frame under test is a synthetic little-endian tiled TIFF
// declaring the CIRRUS layout (3800 x 4400, 512-px tiles, 72 of them) over
// tiny tile blobs, since the relay slices and never inflates.

import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ENV,
	ORIGIN,
	callsTo,
	freshWorker,
	makeCtx,
	objectsIn,
	refusalsIn,
	stubFetch,
	installRecordingCache,
	req,
	waitFor,
} from './helpers.js';

const OPERA_BASE = 'https://s3.waw3-1.cloudferro.com/openradar-24h';

/** A classic TIFF whose IFD0 claims a composite layout (the 1 km CIRRUS
 *  one by default; `{ width: 1900, height: 2200, tiles: 20 }` is the 2 km
 *  NIMBUS one); tile i holds `tileBytes` bytes all equal to (i + 1) & 255.
 *  Longer than the 8 KB head the relay prepends, like a real frame.
 *  `fields` replaces, adds or (null) removes directory entries by tag, as
 *  [type, values] with type 3 SHORT, 4 LONG or 12 DOUBLE. */
function syntheticFrame(tileBytes = 128, { width = 3800, height = 4400, tiles = 72, ifdAt = 8, overhang = 0, entries = 0, valuesAt: valuesAtOpt = 0, fields = {} } = {}) {
	let tags = [
		[256, 4, [width]],
		[257, 4, [height]],
		[258, 3, [32, 32]],
		[259, 3, [8]],
		[277, 3, [2]],
		[317, 3, [1]],
		[322, 4, [512]],
		[323, 4, [512]],
		[324, 4, []], // offsets, filled below
		[325, 4, []],
		[339, 3, [3, 3]],
	];
	for (const [tag, spec] of Object.entries(fields)) {
		tags = tags.filter((t) => t[0] !== Number(tag));
		if (spec) {
			tags.push([Number(tag), spec[0], spec[1]]);
		}
	}
	tags.sort((a, b) => a[0] - b[0]);
	const SIZE = { 3: 2, 4: 4, 12: 8 };
	const n = tags.length;
	const ifdBytes = 2 + n * 12 + 4;
	// `valuesAt` places the arrays elsewhere (a directory inside the head
	// whose tile tables lie past it).
	let valuesAt = valuesAtOpt || ifdAt + ifdBytes;
	const outOfLine = tags.reduce((sum, [tag, type, values]) => {
		const bytes = (tag === 324 || tag === 325 ? tiles : values.length) * SIZE[type];
		return sum + (bytes > 4 ? bytes : 0);
	}, 0);
	// The tiles start past the 8 KB head the relay hands out, as in a real
	// frame (the client reads the directory off that head alone).
	const dataAt = Math.max(8192, valuesAt + outOfLine + 64);
	const offsets = [];
	const counts = [];
	for (let i = 0; i < tiles; i++) {
		offsets.push(dataAt + i * tileBytes);
		counts.push(tileBytes);
	}
	// `overhang` declares the last tile longer than the bytes there are.
	counts[tiles - 1] += overhang;
	const find = (tag) => tags.find((t) => t[0] === tag);
	if (find(324)) find(324)[2] = offsets;
	if (find(325)) find(325)[2] = counts;
	const total = dataAt + tiles * tileBytes;
	const buf = new Uint8Array(total);
	const dv = new DataView(buf.buffer);
	buf[0] = 0x49;
	buf[1] = 0x49;
	dv.setUint16(2, 42, true);
	dv.setUint32(4, ifdAt, true);
	// `entries` overrides the entry count the directory claims (a hostile head).
	dv.setUint16(ifdAt, entries || n, true);
	let e = ifdAt + 2;
	for (const [tag, type, values] of tags) {
		const size = SIZE[type];
		dv.setUint16(e, tag, true);
		dv.setUint16(e + 2, type, true);
		dv.setUint32(e + 4, values.length, true);
		let p = e + 8;
		if (values.length * size > 4) {
			p = valuesAt;
			dv.setUint32(e + 8, valuesAt, true);
			valuesAt += values.length * size;
		}
		for (let k = 0; k < values.length; k++) {
			if (type === 3) dv.setUint16(p + k * 2, values[k], true);
			else if (type === 4) dv.setUint32(p + k * 4, values[k], true);
			else dv.setFloat64(p + k * 8, values[k], true);
		}
		e += 12;
	}
	dv.setUint32(e, 0, true);
	for (let i = 0; i < tiles; i++) {
		buf.fill((i + 1) & 255, offsets[i], offsets[i] + tileBytes);
	}
	return buf;
}

function frameResponse(buf) {
	return new Response(buf, { status: 200, headers: { 'content-type': 'binary/octet-stream' } });
}

/** A slot key for `minutesAgo` minutes before now, floored to 5 minutes. */
function slotAgo(minutesAgo, stepMin = 5) {
	const ms = Math.floor((Date.now() - minutesAgo * 60_000) / (stepMin * 60_000)) * stepMin * 60_000;
	const d = new Date(ms);
	const p2 = (x) => String(x).padStart(2, '0');
	return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}`;
}

/** The listing tests run on a pinned mid-day clock: `hours=3` must not
 *  straddle 00Z, where the relay lists two UTC days and a stub answering
 *  both with the same keys would list every frame twice. */
async function atNoon(fn) {
	const realNow = Date.now;
	Date.now = () => Date.UTC(2026, 8, 20, 12, 0);
	try {
		return await fn();
	} finally {
		Date.now = realNow;
	}
}

function listingXml(keys, { next = null } = {}) {
	return (
		'<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>openradar-24h</Name>' +
		`<IsTruncated>${next ? 'true' : 'false'}</IsTruncated>` +
		(next ? `<NextContinuationToken>${next}</NextContinuationToken>` : '') +
		keys
			.map(
				([key, size, lm]) =>
					`<Contents><Key>${key}</Key><LastModified>${lm}</LastModified><ETag>"x"</ETag><Size>${size}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
			)
			.join('') +
		'</ListBucketResult>'
	);
}

test('/opera/frames lists the product frames of the window as JSON', () => atNoon(async () => {
	const worker = await freshWorker();
	const t1 = slotAgo(20);
	const t2 = slotAgo(10);
	const day = `${t2.slice(0, 4)}/${t2.slice(4, 6)}/${t2.slice(6, 8)}/OPERA/COMP/`;
	const fc = stubFetch(() =>
		new Response(
			listingXml([
				[`${day}OPERA@${t2}@0@DBZH.h5`, 2365822, '2026-09-20T08:14:08.598Z'],
				[`${day}OPERA@${t2}@0@DBZH.tiff`, 3521572, '2026-09-20T08:14:11.545Z'],
				[`${day}OPERA@${t1}@0@DBZH.tiff`, 3521360, '2026-09-20T08:09:08.991Z'],
				[`${day}OPERA@${t1}@0@RATE.tiff`, 3028050, '2026-09-20T08:10:03.795Z'],
			]),
			{ status: 200, headers: { 'content-type': 'application/xml' } },
		),
	);
	const ctx = makeCtx();
	const res = await worker.fetch(req('/opera/frames?product=DBZH&hours=3'), ENV, ctx);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
	// The client copy is never kept (the zone would stretch a cached
	// answer's max-age to four hours); the edge copy carries the 60 s.
	assert.equal(res.headers.get('cache-control'), 'no-store');
	const body = await res.json();
	assert.equal(body.product, 'DBZH');
	assert.deepEqual(
		body.frames.map((f) => f.t),
		[t1, t2],
		'ascending, the tiff of the product only',
	);
	assert.equal(body.frames[1].bytes, 3521572);
	assert.equal(body.frames[1].publishedAt, '2026-09-20T08:14:11.545Z');
	assert.ok(Math.abs(Date.parse(body.now) - Date.now()) < 5000);
	assert.equal(fc.length, 1);
	const u = new URL(fc[0].url);
	assert.equal(u.origin + u.pathname, OPERA_BASE);
	assert.equal(u.searchParams.get('list-type'), '2');
	assert.ok(u.searchParams.get('prefix').endsWith(`OPERA@${t2.slice(0, 8)}T`));
	assert.ok(fc[0].url.includes('%40'), 'the @ of the prefix is percent-encoded');
	assert.equal(fc[0].init.redirect, 'manual');
}));

test('/opera/frames drops a key dated past its own clock', () => atNoon(async () => {
	// A producer keying a frame ahead of its scan (an hour-offset bug): taken
	// at face value it read 0 min old in every client, a feed that had
	// stopped drawn as fresh. The frame route refuses such a slot; the
	// listing must not offer it.
	const worker = await freshWorker();
	const real = slotAgo(10);
	const ahead = slotAgo(-120);
	const day = `${real.slice(0, 4)}/${real.slice(4, 6)}/${real.slice(6, 8)}/OPERA/COMP/`;
	stubFetch(() =>
		new Response(
			listingXml([
				[`${day}OPERA@${real}@0@DBZH.tiff`, 3521572, '2026-09-20T11:54:11.545Z'],
				[`${day}OPERA@${ahead}@0@DBZH.tiff`, 3521572, '2026-09-20T11:55:11.545Z'],
			]),
			{ status: 200, headers: { 'content-type': 'application/xml' } },
		),
	);
	const res = await worker.fetch(req('/opera/frames?product=DBZH&hours=3'), ENV, makeCtx());
	assert.equal(res.status, 200);
	assert.deepEqual(
		(await res.json()).frames.map((f) => f.t),
		[real],
	);
}));

test('/opera/frames follows a truncated listing to the day\'s last keys', () =>
	atNoon(async () => {
		// S3 answers 1000 keys a page, newest last: the day's latest frames
		// are exactly what a single page would drop.
		const worker = await freshWorker();
		installRecordingCache();
		const older = slotAgo(20);
		const newer = slotAgo(10);
		const fc = stubFetch((url) => {
			const u = new URL(url);
			if (u.searchParams.get('continuation-token') === 'tok&1<>"\'\'') {
				return new Response(listingXml([[`2026/09/20/OPERA/COMP/OPERA@${newer}@0@DBZH.tiff`, 3000000, '2026-09-20T11:54:10.000Z']]), { status: 200 });
			}
			return new Response(
				listingXml([[`2026/09/20/OPERA/COMP/OPERA@${older}@0@DBZH.tiff`, 3000000, '2026-09-20T11:44:10.000Z']], { next: 'tok&amp;1&lt;&gt;&quot;&apos;&#39;' }),
				{ status: 200 },
			);
		});
		const res = await worker.fetch(req('/opera/frames?product=DBZH&hours=1'), ENV, makeCtx());
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.deepEqual(
			body.frames.map((f) => f.t),
			[older, newer],
		);
		assert.equal(fc.length, 2);
		assert.equal(new URL(fc[1].url).searchParams.get('continuation-token'), 'tok&1<>"\'\'', 'the token is unescaped');
		assert.equal(new URL(fc[0].url).searchParams.get('continuation-token'), null);
	}));

test('/opera/frames stamps the serve time beside the listing\'s own', async () => {
	// The body's `now` is the listing's instant; a hit a minute later must
	// not read as a minute younger (the client measures every age from the
	// instant it was answered).
	const worker = await freshWorker();
	installRecordingCache();
	const realNow = Date.now;
	const t0 = Date.UTC(2026, 8, 20, 12, 0);
	Date.now = () => t0;
	try {
		stubFetch(() => new Response(listingXml([[`2026/09/20/OPERA/COMP/OPERA@${slotAgo(10)}@0@DBZH.tiff`, 3000000, '2026-09-20T11:54:10.000Z']]), { status: 200 }));
		const ctx = makeCtx();
		const first = await worker.fetch(req('/opera/frames?product=DBZH&hours=1'), ENV, ctx);
		assert.equal(first.headers.get('x-opera-now'), new Date(t0).toISOString());
		assert.ok(first.headers.get('access-control-expose-headers').split(/,\s*/).includes('X-Opera-Now'));
		await Promise.all(ctx.waits);
		Date.now = () => t0 + 45_000;
		const hit = await worker.fetch(req('/opera/frames?product=DBZH&hours=1', { ip: '203.0.113.9' }), ENV, ctx);
		assert.equal(hit.status, 200);
		assert.equal(hit.headers.get('x-opera-now'), new Date(t0 + 45_000).toISOString(), 'the serve time is the hit\'s own');
		assert.equal((await hit.json()).now, new Date(t0).toISOString(), 'the body keeps the listing\'s instant');
		assert.equal(hit.headers.get('cache-control'), 'no-store');
	} finally {
		Date.now = realNow;
	}
});

test('/opera/frames validates its query', async () => {
	const worker = await freshWorker();
	const fc = stubFetch(() => {
		throw new Error('no upstream call expected');
	});
	const ctx = makeCtx();
	for (const q of ['?product=ACRR', '?product=toString', '?product=constructor', '?hours=7', '?hours=0', '?hours=x', '?product=DBZH&x=1']) {
		const res = await worker.fetch(req('/opera/frames' + q), ENV, ctx);
		assert.equal(res.status, 400, q);
	}
	const post = await worker.fetch(req('/opera/frames', { method: 'POST', body: 'x' }), ENV, ctx);
	assert.equal(post.status, 405);
	assert.equal(fc.length, 0);
});

test('/opera/frames lists two days across 00Z and serves readers from the edge cache', async () => {
	const worker = await freshWorker();
	const store = installRecordingCache();
	const realNow = Date.now;
	Date.now = () => Date.UTC(2026, 8, 21, 0, 30);
	try {
		const fc = stubFetch(() =>
			new Response(listingXml([]), { status: 200, headers: { 'content-type': 'application/xml' } }),
		);
		const ctx = makeCtx();
		const first = await worker.fetch(req('/opera/frames?hours=3'), ENV, ctx);
		assert.equal(first.status, 200);
		assert.equal(first.headers.get('cache-control'), 'no-store');
		await Promise.all(ctx.waits);
		assert.equal(fc.length, 2, 'one listing per UTC day touched');
		assert.equal(store.size, 1);
		assert.equal([...store.values()][0].headers.get('cache-control'), 'public, max-age=60', 'the edge copy keeps its TTL');
		const u0 = new URL(fc[0].url);
		const u1 = new URL(fc[1].url);
		assert.ok(u0.searchParams.get('prefix').startsWith('2026/09/20/'));
		assert.equal(u0.searchParams.get('start-after'), '2026/09/20/OPERA/COMP/OPERA@20260920T2130');
		assert.ok(u1.searchParams.get('prefix').startsWith('2026/09/21/'));
		assert.equal(u1.searchParams.get('start-after'), null);
		// The second reader, another origin, another order of the same
		// params: the stored copy carries no origin and is stamped per
		// request (the /wx and /sia/vac pin).
		const second = await worker.fetch(
			req('/opera/frames?hours=3&product=DBZH', { ip: '203.0.113.9', origin: 'https://localhost' }),
			ENV,
			ctx,
		);
		assert.equal(second.status, 200);
		assert.equal(second.headers.get('access-control-allow-origin'), 'https://localhost');
		assert.equal(second.headers.get('cache-control'), 'no-store');
		assert.equal(fc.length, 2, 'the second reader must not reach the bucket');
	} finally {
		Date.now = realNow;
	}
});

test('/opera/<slot> refuses a tile index with a leading zero', async () => {
	const worker = await freshWorker();
	const fc = stubFetch(() => frameResponse(syntheticFrame(128)));
	const res = await worker.fetch(req(`/opera/${slotAgo(10)}/DBZH.tiff?tiles=00,7`), ENV, makeCtx());
	assert.equal(res.status, 400);
	assert.equal(fc.length, 0);
});

test('/opera/<slot> validates the slot and the tiles before any upstream call', async () => {
	const worker = await freshWorker();
	const fc = stubFetch(() => {
		throw new Error('no upstream call expected');
	});
	const ctx = makeCtx();
	const good = slotAgo(10);
	const future = slotAgo(-120);
	const old = slotAgo(25 * 60);
	const off = good.slice(0, 12) + '3';
	// A 5-minute slot that is not on RATE's 15-minute grid: the newest one,
	// or the one before it when the newest happens to sit on the grid.
	const rateOff = Number(good.slice(11, 13)) % 15 === 0 ? slotAgo(15, 5) : good;
	for (const path of [
		`/opera/${future}/DBZH.tiff?tiles=1`,
		`/opera/${old}/DBZH.tiff?tiles=1`,
		`/opera/${off}/DBZH.tiff?tiles=1`,
		`/opera/${rateOff}/RATE.tiff?tiles=1`,
		`/opera/${good}/ACRR.tiff?tiles=1`,
		`/opera/${good}/DBZH.tiff`,
		`/opera/${good}/DBZH.tiff?tiles=`,
		`/opera/${good}/DBZH.tiff?tiles=a`,
		`/opera/${good}/DBZH.tiff?tiles=5,3`,
		`/opera/${good}/DBZH.tiff?tiles=3,3`,
		`/opera/${good}/DBZH.tiff?tiles=72`,
		`/opera/${good}/DBZH.tiff?tiles=1&x=2`,
		`/opera/${good}/DBZH.tiff?tiles=${Array.from({ length: 73 }, (_, i) => i).join(',')}`,
		`/opera/obj/${good}/DBZH`,
		`/opera/${good}/DBZH.h5?tiles=1`,
	]) {
		const res = await worker.fetch(req(path), ENV, ctx);
		assert.equal(res.status, 400, path);
	}
	assert.equal(fc.length, 0);
});

test('/opera/<slot> fetches a frame whole once, caches it and answers head + tiles', async () => {
	const worker = await freshWorker();
	const store = installRecordingCache();
	const frame = syntheticFrame(128);
	assert.ok(frame.length > 8192);
	const fc = stubFetch(() => frameResponse(frame));
	const ctx = makeCtx();
	const slot = slotAgo(10);
	const res = await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=3,4,11`), ENV, ctx);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get('content-type'), 'application/octet-stream');
	assert.equal(res.headers.get('cache-control'), 'private, max-age=86400, immutable');
	assert.equal(res.headers.get('x-opera-tiles'), '3,4,11');
	assert.equal(res.headers.get('x-opera-read'), 'origin');
	// The tiles header is what a script reads back: exposed, or CORS hides it.
	assert.ok(res.headers.get('access-control-expose-headers').split(/,\s*/).includes('X-Opera-Tiles'));
	assert.ok(res.headers.get('access-control-expose-headers').split(/,\s*/).includes('X-Opera-Read'));
	assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
	const body = new Uint8Array(await res.arrayBuffer());
	assert.equal(body.length, 8192 + 3 * 128);
	assert.deepEqual([...body.subarray(0, 8192)], [...frame.subarray(0, 8192)]);
	assert.ok(body.subarray(8192, 8192 + 128).every((b) => b === 4), 'tile 3 first');
	assert.ok(body.subarray(8192 + 128, 8192 + 256).every((b) => b === 5), 'then tile 4');
	assert.ok(body.subarray(8192 + 256).every((b) => b === 12), 'then tile 11');
	await Promise.all(ctx.waits);
	assert.equal(fc.length, 1);
	assert.equal(
		fc[0].url,
		`${OPERA_BASE}/${slot.slice(0, 4)}/${slot.slice(4, 6)}/${slot.slice(6, 8)}/OPERA/COMP/OPERA@${slot}@0@DBZH.tiff`,
	);
	assert.equal(fc[0].init.redirect, 'manual');
	// The whole object sits in the edge cache under its own key, with the
	// Content-Length the edge needs, and no origin of its own.
	assert.equal(store.size, 1);
	const stored = [...store.values()][0];
	assert.equal(stored.headers.get('content-length'), String(frame.length));
	assert.equal(stored.headers.get('cache-control'), 'public, max-age=86400, immutable');
	assert.equal(stored.headers.get('access-control-allow-origin'), null);

	// Another viewport from another origin: no upstream call, its own stamp.
	const second = await worker.fetch(
		req(`/opera/${slot}/DBZH.tiff?tiles=0,71`, { ip: '203.0.113.9', origin: 'https://localhost' }),
		ENV,
		ctx,
	);
	assert.equal(second.status, 200);
	assert.equal(second.headers.get('x-opera-read'), 'range', 'a hit is cut from ranged reads');
	assert.equal(second.headers.get('access-control-allow-origin'), 'https://localhost');
	const body2 = new Uint8Array(await second.arrayBuffer());
	assert.equal(body2.length, 8192 + 2 * 128);
	assert.ok(body2.subarray(8192, 8192 + 128).every((b) => b === 1));
	assert.ok(body2.subarray(8192 + 128).every((b) => b === 72));
	assert.equal(fc.length, 1, 'the second reader must not reach the bucket');
	assert.equal(store.size, 1, 'slices are never stored at the edge');
	// The hit was cut from two ranged reads, the head and the tiles' span,
	// never the object whole (a burst of hits must not hold a frame each).
	const storedObj = [...store.values()][0];
	const len = Number(storedObj.headers.get('content-length'));
	assert.deepEqual(store.ranges, ['bytes=0-8191', `bytes=8192-${len - 1}`]);
	// Two interior tiles: the span is theirs alone (tiles 3 and 4 sit at
	// 8192 + 3 * 128), not everything after the head.
	store.ranges.length = 0;
	const third = await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=3,4`), ENV, ctx);
	assert.equal(third.status, 200);
	assert.equal(third.headers.get('x-opera-read'), 'range');
	assert.deepEqual(store.ranges, ['bytes=0-8191', 'bytes=8576-8831']);
});

test('/opera/<slot> reads a hit whole, once, when the cache ignores the Range, and says so', async () => {
	const worker = await freshWorker();
	installRecordingCache();
	const frame = syntheticFrame(128);
	stubFetch(() => frameResponse(frame));
	const ctx = makeCtx();
	const slot = slotAgo(10);
	const miss = await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=3,4`), ENV, ctx);
	const missBody = new Uint8Array(await miss.arrayBuffer());
	const realMatch = globalThis.caches.default.match;
	let matches = 0;
	globalThis.caches.default.match = async (key) => {
		matches++;
		return realMatch(typeof key === 'string' ? key : key.url);
	};
	const logs = [];
	const realError = console.error;
	console.error = (line) => logs.push(String(line));
	try {
		const hit = await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=3,4`), ENV, ctx);
		assert.equal(hit.status, 200);
		assert.equal(hit.headers.get('x-opera-read'), 'whole');
		assert.deepEqual(new Uint8Array(await hit.arrayBuffer()), missBody);
		assert.equal(matches, 1, 'the object handed over whole is not read a second time for the span');
		assert.ok(logs.some((l) => l.includes('cache-whole-read')));
	} finally {
		console.error = realError;
		globalThis.caches.default.match = realMatch;
	}
});

test('/opera/<slot> refuses a directory whose tile tables lie past the 8 KB head', async () => {
	// The IFD itself inside the head, the offsets and counts arrays at 9000.
	const worker = await freshWorker();
	const store = installRecordingCache();
	stubFetch(() => frameResponse(syntheticFrame(128, { valuesAt: 9000 })));
	const res = await worker.fetch(req(`/opera/${slotAgo(10)}/DBZH.tiff?tiles=3`), ENV, makeCtx());
	assert.equal(res.status, 502);
	assert.equal(objectsIn(store), 0);
	assert.equal(refusalsIn(store), 1, 'the refusal is remembered');
	// For an hour (OPERA_REFUSED_TTL_S), the figure the docs state.
	const [, kept] = [...store.entries()].find(([k]) => k.includes('/opera/refused/'));
	assert.match(kept.headers.get('cache-control'), /\bmax-age=3600\b/);
});

test('/opera/<slot> serves the slice when the edge refuses the put, and logs it', async () => {
	const worker = await freshWorker();
	installRecordingCache();
	const realPut = globalThis.caches.default.put;
	globalThis.caches.default.put = async () => {
		throw new Error('put refused');
	};
	const frame = syntheticFrame(128);
	const fc = stubFetch(() => frameResponse(frame));
	const logs = [];
	const realError = console.error;
	console.error = (line) => logs.push(String(line));
	try {
		const res = await worker.fetch(req(`/opera/${slotAgo(10)}/DBZH.tiff?tiles=3`), ENV, makeCtx());
		assert.equal(res.status, 200);
		assert.equal(res.headers.get('x-opera-read'), 'origin');
		assert.equal(fc.length, 1);
		assert.ok(logs.some((l) => l.includes('cache-put-failed')));
	} finally {
		console.error = realError;
		globalThis.caches.default.put = realPut;
	}
});

test('/opera/frames refuses a 200 that is not a listing, uncached and logged', async () => {
	const worker = await freshWorker();
	const store = installRecordingCache();
	stubFetch(() => new Response('<html><body>maintenance</body></html>', { status: 200 }));
	const logs = [];
	const realError = console.error;
	console.error = (line) => logs.push(String(line));
	try {
		const res = await worker.fetch(req('/opera/frames?product=DBZH&hours=1'), ENV, makeCtx());
		assert.equal(res.status, 502);
		assert.equal(store.size, 0);
		assert.ok(logs.some((l) => l.includes('not a ListBucketResult')));
	} finally {
		console.error = realError;
	}
});

test('/opera/frames logs an upstream status the bucket answers, and stops after five pages', () =>
	atNoon(async () => {
		const worker = await freshWorker();
		installRecordingCache();
		stubFetch(() => new Response('forbidden', { status: 403 }));
		const logs = [];
		const realError = console.error;
		console.error = (line) => logs.push(String(line));
		try {
			assert.equal((await worker.fetch(req('/opera/frames?product=DBZH&hours=1'), ENV, makeCtx())).status, 502);
			assert.ok(logs.some((l) => l.includes('upstream-status') && l.includes('403')));
			// Every page truncated, one frame a page: five are read, their
			// frames listed, the overrun logged.
			let page = 0;
			const fc = stubFetch(() => {
				const slot = slotAgo(30 - 5 * page++);
				return new Response(
					listingXml([[`2026/09/20/OPERA/COMP/OPERA@${slot}@0@DBZH.tiff`, 3000000, '2026-09-20T11:44:10.000Z']], { next: 'more' }),
					{ status: 200 },
				);
			});
			const res = await worker.fetch(req('/opera/frames?product=DBZH&hours=1', { ip: '203.0.113.9' }), ENV, makeCtx());
			assert.equal(res.status, 200);
			assert.equal(fc.length, 5);
			assert.equal((await res.json()).frames.length, 5, 'one frame a page, five pages');
			assert.ok(logs.some((l) => l.includes('listing longer than')));
		} finally {
			console.error = realError;
		}
	}));

test('/opera/<slot> answers 503 when the object leaves the cache between the two reads, or the span comes back short', async () => {
	// The head read finds the object, the span read does not (evicted in
	// between), or comes back from a later offset than asked: never garbage
	// cut from the wrong bytes, a 503 the client retries.
	const worker = await freshWorker();
	const store = installRecordingCache();
	const frame = syntheticFrame(128);
	stubFetch(() => frameResponse(frame));
	const ctx = makeCtx();
	const slot = slotAgo(10);
	assert.equal((await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=3`), ENV, ctx)).status, 200);
	const realMatch = globalThis.caches.default.match;
	let reads = 0;
	globalThis.caches.default.match = async (key) => {
		reads++;
		if (reads === 2) {
			return undefined;
		}
		return realMatch(key);
	};
	assert.equal((await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=3`), ENV, ctx)).status, 503);
	reads = 0;
	globalThis.caches.default.match = async (key) => {
		reads++;
		const res = await realMatch(key);
		if (reads === 2 && res && res.status === 206) {
			// The span, shifted 16 bytes past the first tile asked for.
			const headers = new Headers(res.headers);
			const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(headers.get('content-range'));
			headers.set('content-range', `bytes ${Number(m[1]) + 16}-${m[2]}/${m[3]}`);
			return new Response((await res.arrayBuffer()).slice(16), { status: 206, headers });
		}
		return res;
	};
	assert.equal((await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=3`), ENV, ctx)).status, 503);
	globalThis.caches.default.match = realMatch;
	assert.equal(store.size, 1);
});

test('/opera/<slot> refuses a frame whose directory reaches past the 8 KB head', async () => {
	// A converter change that moves IFD0's tile tables past the head would
	// otherwise be relayed 200 and refused by every client for the day the
	// browser keeps the slice.
	const worker = await freshWorker();
	const store = installRecordingCache();
	stubFetch(() => frameResponse(syntheticFrame(128, { ifdAt: 9000 })));
	const res = await worker.fetch(req(`/opera/${slotAgo(10)}/DBZH.tiff?tiles=3`), ENV, makeCtx());
	assert.equal(res.status, 502);
	assert.equal(objectsIn(store), 0);
});

test('/opera/<slot> refuses a tile past the object and a directory claiming too many entries', async () => {
	const worker = await freshWorker();
	const store = installRecordingCache();
	let frame = syntheticFrame(128, { overhang: 1 });
	stubFetch(() => frameResponse(frame));
	const ctx = makeCtx();
	const slot = slotAgo(10);
	assert.equal((await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=3`), ENV, ctx)).status, 502);
	frame = syntheticFrame(128, { entries: 513 });
	assert.equal((await worker.fetch(req(`/opera/${slotAgo(15)}/DBZH.tiff?tiles=3`), ENV, ctx)).status, 502);
	assert.equal(objectsIn(store), 0);
	assert.equal(refusalsIn(store), 2);
});

test('/opera/<slot> refuses an object larger than a frame can be, before reading it whole', async () => {
	const worker = await freshWorker();
	const store = installRecordingCache();
	const fc = stubFetch(
		() =>
			new Response(new Uint8Array(16), {
				status: 200,
				headers: { 'content-type': 'binary/octet-stream', 'content-length': String(64 * 1024 * 1024) },
			}),
	);
	const res = await worker.fetch(req(`/opera/${slotAgo(10)}/DBZH.tiff?tiles=3`), ENV, makeCtx());
	assert.equal(res.status, 502);
	assert.equal(fc.length, 1);
	assert.equal(objectsIn(store), 0);
});

test('/opera/frames answers 502 and stores nothing when the bucket is down', async () => {
	const worker = await freshWorker();
	const store = installRecordingCache();
	stubFetch(() => new Response('down', { status: 503 }));
	const res = await worker.fetch(req('/opera/frames?product=DBZH&hours=1'), ENV, makeCtx());
	assert.equal(res.status, 502);
	assert.equal(store.size, 0);
});

test('followers of a leader that meets a 404 all read the miss, nothing stored', async () => {
	const worker = await freshWorker();
	const store = installRecordingCache();
	let release;
	const gate = new Promise((r) => {
		release = r;
	});
	const fc = stubFetch(async () => {
		await gate;
		return new Response(null, { status: 404 });
	});
	const ctx = makeCtx();
	const slot = slotAgo(10);
	const p1 = worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=3`), ENV, ctx);
	await waitFor(() => fc.length === 1);
	const p2 = worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=4`, { ip: '203.0.113.9' }), ENV, ctx);
	await new Promise((r) => setTimeout(r, 25));
	release();
	const [r1, r2] = await Promise.all([p1, p2]);
	assert.equal(r1.status, 404);
	assert.equal(r2.status, 404);
	assert.equal(fc.length, 1);
	assert.equal(store.size, 0);
});

test('concurrent readers of one uncached frame coalesce into one upstream fetch', async () => {
	// Two viewports polling the same new frame in the seconds before the
	// leader's put lands: the follower rides the leader's bytes and spends
	// no ceiling slot, and its own tiles are cut from them.
	const worker = await freshWorker();
	const store = installRecordingCache();
	const frame = syntheticFrame(128);
	let releaseObject;
	const gate = new Promise((r) => {
		releaseObject = r;
	});
	const fc = stubFetch(async () => {
		await gate;
		return frameResponse(frame);
	});
	const ctx = makeCtx();
	const slot = slotAgo(10);
	const objectUrl = `${OPERA_BASE}/${slot.slice(0, 4)}/${slot.slice(4, 6)}/${slot.slice(6, 8)}/OPERA/COMP/OPERA@${slot}@0@DBZH.tiff`;
	const p1 = worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=3`), ENV, ctx);
	await waitFor(() => callsTo(fc, objectUrl).length === 1);
	const p2 = worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=11`, { ip: '203.0.113.9' }), ENV, ctx);
	await new Promise((r) => setTimeout(r, 25));
	assert.equal(fc.length, 1, 'the follower must not reach the bucket while the leader is in flight');
	releaseObject();
	const [r1, r2] = await Promise.all([p1, p2]);
	assert.equal(r1.status, 200);
	assert.equal(r2.status, 200);
	assert.equal(r1.headers.get('x-opera-tiles'), '3');
	assert.equal(r2.headers.get('x-opera-tiles'), '11');
	const b1 = new Uint8Array(await r1.arrayBuffer());
	const b2 = new Uint8Array(await r2.arrayBuffer());
	assert.ok(b1.subarray(8192).every((b) => b === 4), 'the leader cut its own tile');
	assert.ok(b2.subarray(8192).every((b) => b === 12), 'the follower cut its own tile from the same bytes');
	await Promise.all(ctx.waits);
	assert.equal(fc.length, 1);
	assert.equal(store.size, 1, 'the object was put once');
});

test('/opera/<slot> passes a 404 through uncached and refuses a non-frame object', async () => {
	const worker = await freshWorker();
	const store = installRecordingCache();
	const ctx = makeCtx();
	const slot = slotAgo(2);
	stubFetch(() => new Response(null, { status: 404 }));
	const miss = await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=1`), ENV, ctx);
	assert.equal(miss.status, 404);
	assert.equal(miss.headers.get('access-control-allow-origin'), ORIGIN);
	assert.equal(store.size, 0);

	// A TIFF that is not the product's composite (here a frame on another
	// grid) is the OBJECT's answer: remembered, never stored as an object, so
	// the next reader and every client's minute retry are answered from the
	// edge's memory of it.
	const fc = stubFetch(() => frameResponse(syntheticFrame(128, { width: 3801 })));
	const bad = await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=1`), ENV, ctx);
	assert.equal(bad.status, 502);
	assert.equal(objectsIn(store), 0);
	assert.equal(refusalsIn(store), 1);
	const again = await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=1`), ENV, ctx);
	assert.equal(again.status, 502);
	assert.equal(fc.length, 1, 'a refused object is not pulled whole again');

	// Anything else under a 200 (an error page, zeros) is the bucket's moment:
	// said, never remembered, so the frame is asked again once the bucket is
	// back rather than blinded for the hour.
	const other = slotAgo(15);
	const junk = stubFetch(() => frameResponse(new Uint8Array(20000)));
	assert.equal((await worker.fetch(req(`/opera/${other}/DBZH.tiff?tiles=1`), ENV, ctx)).status, 502);
	assert.equal(refusalsIn(store), 1);
	stubFetch(() => frameResponse(syntheticFrame(128)));
	const back = await worker.fetch(req(`/opera/${other}/DBZH.tiff?tiles=1`), ENV, ctx);
	assert.equal(back.status, 200);
	assert.equal(junk.length, 1);

	stubFetch(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere' } }));
	const redirect = await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=1`), ENV, ctx);
	assert.equal(redirect.status, 502);

	stubFetch(() => {
		throw new Error('boom');
	});
	const down = await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=1`), ENV, ctx);
	assert.equal(down.status, 502);
});

const RATE_SHAPE = { width: 1900, height: 2200, tiles: 20 };

test('/opera/frames lists the RATE frames on the 15-minute grid only', () => atNoon(async () => {
	const worker = await freshWorker();
	const t1 = slotAgo(35, 15);
	const t2 = slotAgo(20, 15);
	// A 5-minute slot that is NOT on the 15-minute grid, for the same product.
	const off = Number(t2.slice(11, 13)) % 15 === 0 ? slotAgo(15, 5) : t2;
	const offGrid = Number(off.slice(11, 13)) % 15 === 0 ? slotAgo(10, 5) : off;
	const day = `${t2.slice(0, 4)}/${t2.slice(4, 6)}/${t2.slice(6, 8)}/OPERA/COMP/`;
	stubFetch(() =>
		new Response(
			listingXml([
				[`${day}OPERA@${t1}@0@RATE.tiff`, 3028050, '2026-09-20T08:10:03.795Z'],
				[`${day}OPERA@${t1}@0@DBZH.tiff`, 3521360, '2026-09-20T08:09:08.991Z'],
				[`${day}OPERA@${t2}@0@RATE.tiff`, 3030000, '2026-09-20T08:25:05.000Z'],
				[`${day}OPERA@${t2}@0@RATE.h5`, 2000000, '2026-09-20T08:25:04.000Z'],
				[`${day}OPERA@${offGrid}@0@RATE.tiff`, 3030000, '2026-09-20T08:20:05.000Z'],
			]),
			{ status: 200, headers: { 'content-type': 'application/xml' } },
		),
	);
	const ctx = makeCtx();
	const res = await worker.fetch(req('/opera/frames?product=RATE&hours=3'), ENV, ctx);
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.product, 'RATE');
	assert.deepEqual(
		body.frames.map((f) => f.t),
		[...new Set([t1, t2])].sort(),
		'the RATE tiffs on the 15-minute grid, ascending',
	);
	assert.equal(body.frames.at(-1).bytes, 3030000);
}));

test('/opera/<slot> slices a RATE frame on the 2 km grid under its own tile count', async () => {
	const worker = await freshWorker();
	const store = installRecordingCache();
	// 512-byte tiles: 20 of them reach past the 8 KB head, like a real frame.
	const frame = syntheticFrame(512, RATE_SHAPE);
	assert.ok(frame.length > 8192);
	const fc = stubFetch(() => frameResponse(frame));
	const ctx = makeCtx();
	const slot = slotAgo(20, 15);
	const res = await worker.fetch(req(`/opera/${slot}/RATE.tiff?tiles=0,19`), ENV, ctx);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get('x-opera-tiles'), '0,19');
	const body = new Uint8Array(await res.arrayBuffer());
	assert.equal(body.length, 8192 + 2 * 512);
	assert.deepEqual([...body.subarray(0, 8192)], [...frame.subarray(0, 8192)]);
	assert.ok(body.subarray(8192, 8192 + 512).every((b) => b === 1), 'tile 0 first');
	assert.ok(body.subarray(8192 + 512).every((b) => b === 20), 'then tile 19');
	await Promise.all(ctx.waits);
	assert.equal(fc.length, 1);
	assert.ok(fc[0].url.endsWith(`OPERA@${slot}@0@RATE.tiff`));
	assert.equal(store.size, 1, 'the whole object cached under its own key');
	// Tile 20 does not exist on this grid (it would on the 1 km one).
	const over = await worker.fetch(req(`/opera/${slot}/RATE.tiff?tiles=20`), ENV, ctx);
	assert.equal(over.status, 400);
	store.ranges.length = 0;
	const last = await worker.fetch(req(`/opera/${slot}/RATE.tiff?tiles=19`), ENV, ctx);
	assert.equal(last.status, 200);
	assert.equal(fc.length, 1, 'served from the edge copy');
	// The hit's span on the 2 km grid: tile 19 alone, 512 bytes at 8192 + 19 * 512.
	assert.equal(last.headers.get('x-opera-read'), 'range');
	assert.deepEqual(store.ranges, ['bytes=0-8191', 'bytes=17920-18431']);
});

test('/opera/<slot> refuses a frame on the other grid, both ways, uncached', async () => {
	const worker = await freshWorker();
	const store = installRecordingCache();
	const ctx = makeCtx();
	// A 1 km object served under RATE.
	const fc = stubFetch(() => frameResponse(syntheticFrame(128)));
	const rateSlot = slotAgo(20, 15);
	const wrong = await worker.fetch(req(`/opera/${rateSlot}/RATE.tiff?tiles=1`), ENV, ctx);
	assert.equal(wrong.status, 502);
	assert.equal(objectsIn(store), 0);
	const again = await worker.fetch(req(`/opera/${rateSlot}/RATE.tiff?tiles=1`), ENV, ctx);
	assert.equal(again.status, 502);
	assert.equal(fc.length, 1, 'remembered, not pulled whole again');
	// A 2 km object served under DBZH.
	stubFetch(() => frameResponse(syntheticFrame(512, RATE_SHAPE)));
	const wrong2 = await worker.fetch(req(`/opera/${slotAgo(10)}/DBZH.tiff?tiles=1`), ENV, ctx);
	assert.equal(wrong2.status, 502);
	assert.equal(objectsIn(store), 0);
	assert.equal(refusalsIn(store), 2);
});

test('the radar per-IP window refuses the 361st request in a minute', async () => {
	const worker = await freshWorker();
	installRecordingCache();
	stubFetch(() => frameResponse(syntheticFrame(128)));
	const ctx = makeCtx();
	const slot = slotAgo(10);
	for (let i = 0; i < 360; i++) {
		const res = await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=${i % 72}`), ENV, ctx);
		assert.equal(res.status, 200, `request ${i}`);
	}
	const refused = await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=1`), ENV, ctx);
	assert.equal(refused.status, 429);
	assert.ok(refused.headers.get('retry-after'));
	const other = await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=1`, { ip: '203.0.113.7' }), ENV, ctx);
	assert.equal(other.status, 200, 'another reader is not affected');
});

test('the radar ceiling caps aggregate whole-frame fetches', async () => {
	const worker = await freshWorker();
	stubFetch(() => frameResponse(syntheticFrame(128)));
	const ctx = makeCtx();
	// The helper's always-miss cache makes every request an upstream fetch.
	for (let i = 0; i < 90; i++) {
		const ip = '10.3.' + Math.floor(i / 100) + '.' + (i % 100);
		const res = await worker.fetch(req(`/opera/${slotAgo(10 + 5 * (i % 100))}/DBZH.tiff?tiles=1`, { ip }), ENV, ctx);
		assert.equal(res.status, 200, `fetch ${i}`);
	}
	const refused = await worker.fetch(req(`/opera/${slotAgo(10)}/DBZH.tiff?tiles=1`, { ip: '10.9.9.9' }), ENV, ctx);
	assert.equal(refused.status, 429);
	assert.ok((await refused.text()).includes('radar'));
});

test('/opera/frames answers 504 when the listing outruns its deadline, never a partial list', async () => {
	// Every page truncated and six seconds long: three are read inside the
	// 15 s deadline, then the relay answers rather than listing on past the
	// client's own 20 s budget. A partial list would lose the NEWEST keys and
	// read to the client as a feed gone stale.
	const worker = await freshWorker();
	const store = installRecordingCache();
	const realNow = Date.now;
	let clock = Date.UTC(2026, 8, 20, 12, 0);
	Date.now = () => clock;
	const logs = [];
	const realError = console.error;
	console.error = (line) => logs.push(String(line));
	try {
		let page = 0;
		const fc = stubFetch(() => {
			clock += 6000;
			const slot = slotAgo(30 - 5 * page++);
			return new Response(
				listingXml([[`2026/09/20/OPERA/COMP/OPERA@${slot}@0@DBZH.tiff`, 3000000, '2026-09-20T11:44:10.000Z']], { next: 'more' }),
				{ status: 200 },
			);
		});
		const res = await worker.fetch(req('/opera/frames?product=DBZH&hours=1'), ENV, makeCtx());
		assert.equal(res.status, 504);
		assert.equal(fc.length, 3, 'three six-second pages, then the deadline');
		assert.equal(store.size, 0, 'nothing cached');
		assert.ok(logs.some((l) => l.includes('deadline')));
	} finally {
		Date.now = realNow;
		console.error = realError;
	}
});

test('/opera/frames answers 504 when its deadline cuts a page short, the abort being the deadline\'s', async () => {
	// A real fetch honours its signal: the page that straddles the 15 s
	// deadline is aborted by the timeout it was given, what was left of the
	// deadline, and that abort became coalesce()'s 502 "upstream error", the
	// 504 reached only by a clock that jumped past the deadline between two
	// pages (the test above). Timed here by a stand-in for
	// AbortSignal.timeout that fires the deadline's share at once, the clock
	// moved to it; a page's own 8 s never fires.
	const worker = await freshWorker();
	const store = installRecordingCache();
	const realNow = Date.now;
	const realTimeout = AbortSignal.timeout;
	let clock = Date.UTC(2026, 8, 20, 12, 0);
	Date.now = () => clock;
	AbortSignal.timeout = (ms) => {
		const c = new AbortController();
		if (ms < 8_000) {
			setTimeout(() => {
				clock += ms;
				c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
			}, 5);
		}
		return c.signal;
	};
	const logs = [];
	const realError = console.error;
	console.error = (line) => logs.push(String(line));
	try {
		let page = 0;
		const fc = stubFetch((url, init) => {
			if (page < 2) {
				clock += 6000;
				const slot = slotAgo(30 - 5 * page++);
				return new Response(
					listingXml([[`2026/09/20/OPERA/COMP/OPERA@${slot}@0@DBZH.tiff`, 3000000, '2026-09-20T11:44:10.000Z']], { next: 'more' }),
					{ status: 200 },
				);
			}
			page++;
			// The third page never answers: aborted by its signal, as a real
			// fetch is.
			return new Promise((_, reject) => {
				init.signal.addEventListener('abort', () => reject(init.signal.reason));
			});
		});
		const res = await worker.fetch(req('/opera/frames?product=DBZH&hours=1'), ENV, makeCtx());
		assert.equal(res.status, 504);
		assert.equal(fc.length, 3, 'two six-second pages, then the one the deadline cut');
		assert.equal(store.size, 0, 'nothing cached');
		assert.ok(logs.some((l) => l.includes('deadline')));
	} finally {
		Date.now = realNow;
		AbortSignal.timeout = realTimeout;
		console.error = realError;
	}
});

test('/opera/frames answers a page\'s own timeout, inside the deadline, as the upstream error it is', async () => {
	// The page timeout (8 s) is the shorter while more than that is left:
	// its abort is the bucket's slowness, not the deadline's, and stays 502.
	const worker = await freshWorker();
	installRecordingCache();
	const realTimeout = AbortSignal.timeout;
	AbortSignal.timeout = (ms) => {
		const c = new AbortController();
		setTimeout(() => c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 5);
		void ms;
		return c.signal;
	};
	const realError = console.error;
	console.error = () => {};
	try {
		stubFetch(
			(url, init) =>
				new Promise((_, reject) => {
					init.signal.addEventListener('abort', () => reject(init.signal.reason));
				}),
		);
		const res = await worker.fetch(req('/opera/frames?product=DBZH&hours=1'), ENV, makeCtx());
		assert.equal(res.status, 502);
	} finally {
		AbortSignal.timeout = realTimeout;
		console.error = realError;
	}
});

test('/opera/<slot> refuses a body with no length past the bound, without reading it to its end', async () => {
	// A chunked answer (or an error page streamed without a length) declares
	// nothing, so the Content-Length test cannot refuse it: read whole, 64 MiB
	// would sit in the isolate before anything was checked.
	const worker = await freshWorker();
	const store = installRecordingCache();
	const MiB = 1024 * 1024;
	let pulled = 0;
	stubFetch(
		() =>
			new Response(
				new ReadableStream({
					pull(controller) {
						pulled++;
						if (pulled > 64) {
							controller.close();
							return;
						}
						controller.enqueue(new Uint8Array(MiB));
					},
				}),
				{ status: 200, headers: { 'content-type': 'binary/octet-stream' } },
			),
	);
	const res = await worker.fetch(req(`/opera/${slotAgo(10)}/DBZH.tiff?tiles=3`), ENV, makeCtx());
	assert.equal(res.status, 502);
	assert.ok(pulled <= 18, `read ${pulled} MiB of a body that declared no length`);
	assert.equal(objectsIn(store), 0);
	// Within the bound the same undeclared body is read whole and relayed.
	const frame = syntheticFrame(128);
	stubFetch(
		() =>
			new Response(
				new ReadableStream({
					start(controller) {
						for (let at = 0; at < frame.length; at += 1000) {
							controller.enqueue(frame.slice(at, at + 1000));
						}
						controller.close();
					},
				}),
				{ status: 200 },
			),
	);
	const ok = await worker.fetch(req(`/opera/${slotAgo(15)}/DBZH.tiff?tiles=3`), ENV, makeCtx());
	assert.equal(ok.status, 200);
	const body = new Uint8Array(await ok.arrayBuffer());
	assert.ok(body.subarray(8192).every((b) => b === 4), 'tile 3, whole');
});

test('/opera/<slot> refuses a cached head the cache did not place at byte 0 of a stated length', async () => {
	// `bytes 0-8191/*` states no total, so the tile-inside-the-object check
	// ran against Infinity; a head placed past byte 0 is not the head.
	const worker = await freshWorker();
	installRecordingCache();
	const frame = syntheticFrame(128);
	const fc = stubFetch(() => frameResponse(frame));
	const ctx = makeCtx();
	const slot = slotAgo(10);
	assert.equal((await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=3`), ENV, ctx)).status, 200);
	const realMatch = globalThis.caches.default.match;
	try {
		for (const [what, rewrite, only] of [
			['an unknown total', (m) => `bytes ${m[1]}-${m[2]}/*`, 0],
			['a head past byte 0', (m) => `bytes ${Number(m[1]) + 16}-${m[2]}/${m[3]}`, 0],
			// The span read, the head intact: a range it cannot place is not
			// the span it asked for, whatever start it asked from.
			['a span of unknown placement', (m) => `bytes ${m[1]}-${m[2]}/*`, 2],
		]) {
			let reads = 0;
			globalThis.caches.default.match = async (key) => {
				const res = await realMatch(key);
				reads++;
				if (!res || res.status !== 206 || (only && reads !== only)) {
					return res;
				}
				const headers = new Headers(res.headers);
				headers.set('content-range', rewrite(/bytes (\d+)-(\d+)\/(\d+)/.exec(headers.get('content-range'))));
				return new Response(await res.arrayBuffer(), { status: 206, headers });
			};
			const res = await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=3`), ENV, ctx);
			assert.equal(res.status, 503, what);
		}
	} finally {
		globalThis.caches.default.match = realMatch;
	}
	assert.equal(fc.length, 1, 'the bucket is not asked again for an object the edge holds');
});

test('/opera/<slot> refuses what the client refuses, field by field, on both grids', async () => {
	// The relay's guard is the client's (src/lib/files/tiff.ts isOperaLayout):
	// a frame relayed 200 that every client then refuses is cached for a day
	// and asked for again, past the browser's cache, every minute it stays in
	// a loop. Each case below changes ONE field of a frame that is accepted.
	const worker = await freshWorker();
	const store = installRecordingCache();
	const ctx = makeCtx();
	const grids = [
		{ product: 'DBZH', shape: {}, tileBytes: 128, cellM: 1000, other: 2000, step: 5 },
		{ product: 'RATE', shape: RATE_SHAPE, tileBytes: 512, cellM: 2000, other: 1000, step: 15 },
	];
	let k = 0;
	for (const { product, shape, tileBytes, cellM, other, step } of grids) {
		const half = cellM / 2;
		const refused = {
			'one sample a pixel': { 277: [3, [1]] },
			'no sample count (one by default)': { 277: null },
			'16-bit samples': { 258: [3, [16, 16]] },
			'signed integer samples': { 339: [3, [2, 2]] },
			'no sample format (unsigned by default)': { 339: null },
			'LZW tiles': { 259: [3, [5]] },
			'uncompressed tiles': { 259: [3, [1]] },
			'a horizontal predictor': { 317: [3, [2]] },
			'strips beside the tiles': { 273: [4, [8192]] },
			'a tie point off the corner': { 33922: [12, [0, 0, 0, 12000, 34000, 0]] },
			"the other grid's half-cell shift": { 33922: [12, [0, 0, 0, -other / 2, other / 2, 0]] },
			"the other grid's pixel scale": { 33550: [12, [other, other, 0]] },
		};
		const accepted = {
			'the ODIM corner': { 33922: [12, [0, 0, 0, 0, 0, 0]] },
			"the converter's half-cell shift": { 33922: [12, [0, 0, 0, -half, half, 0]] },
			'its own pixel scale': { 33550: [12, [cellM, cellM, 0]] },
			'no predictor field (none by default)': { 317: null },
		};
		for (const [cases, want] of [
			[refused, 502],
			[accepted, 200],
		]) {
			for (const [what, fields] of Object.entries(cases)) {
				stubFetch(() => frameResponse(syntheticFrame(tileBytes, { ...shape, fields })));
				const before = objectsIn(store);
				const res = await worker.fetch(req(`/opera/${slotAgo(10 + step * k++, step)}/${product}.tiff?tiles=1`, { ip: `10.4.0.${k}` }), ENV, ctx);
				assert.equal(res.status, want, `${product}: ${what}`);
				assert.equal(objectsIn(store), before + (want === 200 ? 1 : 0), `${product}: ${what}, stored`);
			}
		}
	}
});

test('/opera/<slot> relays the real live heads the client reads, each under its own product only', async () => {
	// The heads of two live frames (tests/fixtures, the ones tests/tiff.spec.ts
	// pins the client's isOperaLayout against), each before a zero-filled body
	// reaching its last tile: the relay accepts exactly what the client does.
	const worker = await freshWorker();
	installRecordingCache();
	const ctx = makeCtx();
	const live = [
		['opera-head.bin', 'DBZH', 5, 'RATE', 15],
		['opera-rate-head.bin', 'RATE', 15, 'DBZH', 5],
	];
	let k = 0;
	for (const [file, product, step, otherProduct, otherStep] of live) {
		const head = new Uint8Array(readFileSync(new URL(`../../tests/fixtures/${file}`, import.meta.url)));
		const object = new Uint8Array(3_600_000);
		object.set(head, 0);
		stubFetch(() => frameResponse(object));
		const own = await worker.fetch(req(`/opera/${slotAgo(10 + 15 * k++, step)}/${product}.tiff?tiles=0`), ENV, ctx);
		assert.equal(own.status, 200, `${file} under ${product}`);
		const crossed = await worker.fetch(req(`/opera/${slotAgo(10 + 15 * k++, otherStep)}/${otherProduct}.tiff?tiles=0`), ENV, ctx);
		assert.equal(crossed.status, 502, `${file} under ${otherProduct}`);
	}
});

test('whole-frame downloads wait on the relay memory budget instead of exhausting the isolate', async () => {
	// Twelve misses of twelve frames at once, each object declaring 3.6 MB
	// and held open upstream. Each leader holds twice its object (the edge
	// put takes a copy) against a 48 MB budget: six are read, six wait, and
	// no download is started past the budget. A burst of misses once held a
	// buffer each for the whole download and killed the isolate.
	const worker = await freshWorker();
	installRecordingCache();
	const frame = syntheticFrame(128);
	const gates = [];
	let reading = 0;
	stubFetch(() => {
		let opened = false;
		let open;
		const gate = new Promise((r) => (open = r));
		gates.push(() => open());
		// Pulled only when read (highWaterMark 0), so `reading` counts the
		// downloads the relay actually started.
		return new Response(
			new ReadableStream(
				{
					async pull(controller) {
						if (!opened) {
							opened = true;
							reading++;
							await gate;
							controller.enqueue(frame);
							controller.close();
						}
					},
				},
				{ highWaterMark: 0 },
			),
			{ status: 200, headers: { 'content-length': String(3_600_000) } },
		);
	});
	const ctx = makeCtx();
	const answers = Array.from({ length: 12 }, (_, i) =>
		worker.fetch(req(`/opera/${slotAgo(10 + 5 * i)}/DBZH.tiff?tiles=3`, { ip: `10.9.0.${i}` }), ENV, ctx),
	);
	await waitFor(() => gates.length === 12 && reading === 6);
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(reading, 6, 'only the downloads the budget holds are read');
	// As each lands, its share frees and the next waiter reads.
	for (let k = 0; k < 12; k++) {
		await waitFor(() => reading > k);
		gates[k]();
	}
	const statuses = (await Promise.all(answers)).map((r) => r.status);
	assert.deepEqual(statuses, Array(12).fill(200));
});

test('a download that waits past its turn answers 503 with a Retry-After', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const worker = await freshWorker();
	installRecordingCache();
	const gates = [];
	stubFetch(() => {
		let open;
		const gate = new Promise((r) => (open = r));
		gates.push(() => open());
		return new Response(
			new ReadableStream(
				{
					async pull(controller) {
						await gate;
						controller.close();
					},
				},
				{ highWaterMark: 0 },
			),
			{ status: 200, headers: { 'content-length': String(3_600_000) } },
		);
	});
	const ctx = makeCtx();
	const answers = Array.from({ length: 7 }, (_, i) =>
		worker.fetch(req(`/opera/${slotAgo(10 + 5 * i)}/DBZH.tiff?tiles=3`, { ip: `10.9.1.${i}` }), ENV, ctx),
	);
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
	await new Promise((r) => setImmediate(r));
	// Still waiting its turn a hair short of the 8 s (OPERA_MEMORY_WAIT_MS,
	// the figure the docs state), answered 503 past it.
	let settled = false;
	answers[6].then(
		() => (settled = true),
		() => (settled = true),
	);
	t.mock.timers.tick(7_999);
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
	await new Promise((r) => setImmediate(r));
	assert.equal(settled, false, 'still waiting at 7.999 s');
	t.mock.timers.tick(2);
	const late = await answers[6];
	assert.equal(late.status, 503);
	assert.equal(late.headers.get('retry-after'), '5');
	for (const open of gates) {
		open();
	}
	await Promise.allSettled(answers.slice(0, 6));
});

test('readers that left never wedge the relay: a share comes back once the answer is built', async () => {
	// The runtime neither reads to its end nor cancels the body of a client
	// that has gone (measured on workerd), so an unread answer is modelled as
	// exactly that: never touched again. A share tied to its reader never
	// came back, and seven such continent views filled the budget, every
	// later reader waiting 8 s for a 503 until the isolate was recycled.
	const worker = await freshWorker();
	installRecordingCache();
	// 72 tiles of 200 kB, a 14 MB object; half the tiles are 7.2 MB of span
	// and 7.2 MB of answer, 14.4 MB a hit.
	const frame = syntheticFrame(200_000);
	stubFetch(() => frameResponse(frame));
	const ctx = makeCtx();
	const slot = slotAgo(10);
	const half = Array.from({ length: 36 }, (_, i) => i).join(',');
	await (await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=${half}`), ENV, ctx)).arrayBuffer();
	for (let i = 0; i < 7; i++) {
		const r = await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=${half}`, { ip: `10.9.2.${i}` }), ENV, ctx);
		assert.equal(r.status, 200);
		assert.equal(r.headers.get('x-opera-read'), 'range');
	}
	const t0 = Date.now();
	const res = await worker.fetch(req(`/opera/${slot}/DBZH.tiff?tiles=${half}`, { ip: '10.9.3.1' }), ENV, ctx);
	assert.equal(res.status, 200);
	assert.ok(Date.now() - t0 < 1000, 'answered at once');
	assert.equal((await res.arrayBuffer()).byteLength, 8192 + 36 * 200_000);
});

test('a reader whose object has landed is answered without queueing behind other leaders', async () => {
	// Leaders downloading other frames fill the budget and one more waits
	// behind them: a reader whose own object is already in hand must not
	// queue behind that waiter holding the object (it held 124 MB of
	// objects outside the budget on the commit's own 36-miss scenario).
	const worker = await freshWorker();
	installRecordingCache();
	const big = syntheticFrame(48 * 1024); // 3.55 MB, a real frame's size
	const small = syntheticFrame(128);
	const gates = [];
	let openSmall;
	const smallGate = new Promise((r) => (openSmall = r));
	stubFetch((url) => {
		const isSmall = url.includes(`@${slotAgo(10)}@`);
		const gate = isSmall ? smallGate : new Promise((r) => gates.push(r));
		const bytes = isSmall ? small : big;
		let sent = false;
		return new Response(
			new ReadableStream(
				{
					async pull(c) {
						if (sent) {
							c.close();
							return;
						}
						await gate;
						sent = true;
						c.enqueue(bytes.slice());
					},
				},
				{ highWaterMark: 0 },
			),
			{ status: 200, headers: { 'content-length': String(bytes.length) } },
		);
	});
	const ctx = makeCtx();
	const smallAnswer = worker.fetch(req(`/opera/${slotAgo(10)}/DBZH.tiff?tiles=3`), ENV, ctx);
	await new Promise((r) => setTimeout(r, 10));
	// Seven big leaders hold 49.7 MB of the 50.3 (7.1 MB each, the object
	// twice through its put); an eighth waits for its turn.
	const bigAnswers = Array.from({ length: 8 }, (_, i) =>
		worker.fetch(req(`/opera/${slotAgo(60 + 5 * i)}/DBZH.tiff?tiles=3`, { ip: `10.9.4.${i}` }), ENV, ctx),
	);
	await new Promise((r) => setTimeout(r, 10));
	openSmall();
	const t0 = Date.now();
	const res = await smallAnswer;
	assert.equal(res.status, 200);
	assert.ok(Date.now() - t0 < 1000, 'not queued behind the waiting leader');
	for (const g of gates) {
		g();
	}
	await Promise.allSettled(bigAnswers);
});

test('a frame whose tile tables are not integers is refused, never queued for NaN bytes', async () => {
	// A float TileByteCounts (a NaN among them) passed every "tile inside
	// the object" test and asked the budget for NaN bytes, which nothing
	// grants: every radar request behind it waited 8 s for a 503. Byte
	// offsets and counts are SHORT or LONG, and a float table is refused.
	const worker = await freshWorker();
	installRecordingCache();
	const good = syntheticFrame(128);
	const bad = syntheticFrame(128, { fields: { 325: [12, []] } });
	stubFetch((url) => frameResponse(url.includes(`@${slotAgo(10)}@`) ? bad : good));
	const ctx = makeCtx();
	const refused = await worker.fetch(req(`/opera/${slotAgo(10)}/DBZH.tiff?tiles=3`), ENV, ctx);
	assert.equal(refused.status, 502);
	const t0 = Date.now();
	const other = await worker.fetch(req(`/opera/${slotAgo(20)}/DBZH.tiff?tiles=3`, { ip: '10.1.1.1' }), ENV, ctx);
	assert.equal(other.status, 200);
	assert.ok(Date.now() - t0 < 1000);
});

test('/opera/frames keeps one listing for readers arriving before its edge put lands', async () => {
	const worker = await freshWorker();
	const store = installRecordingCache();
	const realPut = globalThis.caches.default.put;
	// A real edge write takes time.
	globalThis.caches.default.put = (k, r) => new Promise((res) => setTimeout(() => res(realPut(k, r)), 50));
	const fc = stubFetch(() => new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 }));
	const ctx = makeCtx();
	const a = worker.fetch(req('/opera/frames?product=DBZH&hours=1'), ENV, ctx);
	await new Promise((r) => setTimeout(r, 10));
	const b = worker.fetch(req('/opera/frames?product=DBZH&hours=1', { ip: '203.0.113.9' }), ENV, ctx);
	assert.equal((await a).status, 200);
	assert.equal((await b).status, 200);
	assert.equal(fc.length, 1, 'the second reader shared the leader, put and all');
	assert.equal(store.size, 1);
});

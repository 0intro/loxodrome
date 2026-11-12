import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { answer, parseRequest, RequestError, SplitError, LIMITS, bracket, gustSlot, type Source } from '../src/forecast.ts';
import { R2Source, resetStoreCaches } from '../src/store.ts';
import { nextPointer, type Receipt, type RunState } from '../src/plan.ts';
import type { Pointer } from '../src/pointer.ts';
import { chainReceipts, FakeBucket, FIXTURES, hourUnix, MINI_CHAINS, MINI_MODELS, miniValue } from './helpers.ts';

const R00 = '2026-10-06T00:00:00Z';
const R03 = '2026-10-06T03:00:00Z';
const NOW = Date.parse('2026-10-06T06:00:00Z');

function runState(run: string, recs: Receipt[]): RunState {
	const blocks: RunState['blocks'] = {};
	for (const r of recs) {
		blocks[`b${String(r.first).padStart(3, '0')}-${String(r.last).padStart(3, '0')}`] = { status: 'built', attempts: 0, receipt: r };
	}
	return { run, status: 'collecting', blocks, seenAt: 0 };
}

function publishAll(model: string, runs: string[], recs: Receipt[]): Pointer {
	let p: Pointer | null = null;
	for (const run of runs) {
		const mine = recs.filter((r) => r.model === model && r.run === run);
		const st = runState(run, mine);
		p = nextPointer(p, model as never, st, Object.keys(st.blocks), false, NOW);
	}
	return p as Pointer;
}

function source(): { src: R2Source; bucket: FakeBucket } {
	const bucket = FakeBucket.fromDir(join(FIXTURES, 'chain'));
	const recs = chainReceipts();
	bucket.objects.set('latest/mini.json', { data: new TextEncoder().encode(JSON.stringify(publishAll('mini', [R00, R03], recs))) });
	bucket.objects.set('latest/miniwide.json', { data: new TextEncoder().encode(JSON.stringify(publishAll('miniwide', [R00], recs))) });
	return { src: new R2Source(bucket.asR2(), null, '', null), bucket };
}

function url(params: Record<string, string>): URL {
	const q = new URLSearchParams({ models: 'mini_chain', wind_speed_unit: 'kn', timeformat: 'unixtime', ...params });
	return new URL(`https://nwp.test/v1/forecast?${q.toString()}`);
}

const VARS = [
	'pressure_msl',
	'surface_pressure',
	'temperature_2m',
	'wind_speed_10m',
	'wind_gusts_10m',
	'temperature_850hPa',
	'geopotential_height_850hPa',
	'wind_speed_850hPa',
	'wind_direction_850hPa',
	'cloud_cover_850hPa',
];

beforeEach(() => resetStoreCaches());

/** What the archive serves at (i, j), `h` hours into a run shifted by
 *  `shift`, `every` the levels' step (3 h in the fixture) and gusts over
 *  `gustPeriod` hours. */
function expected(i: number, j: number, h: number, shift: number, levelStep: number, sfcStep: number, gustPeriod: number) {
	const at = (name: string, level: number, step: number): number => miniValue(name, level, i, j, step, shift);
	const lerped = (name: string, level: number, every: number): number => {
		const s0 = Math.floor(h / every) * every;
		if (s0 === h) {
			return at(name, level, h);
		}
		const w = (h - s0) / every;
		return at(name, level, s0) + (at(name, level, s0 + every) - at(name, level, s0)) * w;
	};
	const r = (x: number, d: number): number => Math.round(x * 10 ** d) / 10 ** d;
	const u850 = lerped('wind_u', 850, levelStep);
	const u10 = lerped('wind_u_10m', 0, sfcStep);
	let gust: number | null = null;
	const gs = Math.ceil(h / gustPeriod) * gustPeriod;
	if (h > 0 && gs > 0) {
		gust = r(at('wind_gusts_10m', 0, gs), 1);
	}
	return {
		pressure_msl: r(lerped('pressure_msl', 0, sfcStep), 1),
		surface_pressure: r(lerped('surface_pressure', 0, levelStep), 1),
		temperature_2m: r(lerped('temperature_2m', 0, sfcStep), 1),
		wind_speed_10m: r(Math.hypot(u10, u10), 1),
		wind_gusts_10m: gust,
		temperature_850hPa: r(lerped('temperature', 850, levelStep), 1),
		geopotential_height_850hPa: r(lerped('geopotential_height', 850, levelStep), 0),
		wind_speed_850hPa: r(Math.hypot(u850, u850), 1),
		wind_direction_850hPa: u850 === 0 ? 0 : u850 > 0 ? 225 : 45,
		cloud_cover_850hPa: r(lerped('cloud_cover', 850, levelStep), 0),
	} as Record<string, number | null>;
}

void test('a covered point: past hours from the kept first blocks, live ones from the newest run, levels across blocks', async () => {
	const { src } = source();
	const i = 18;
	const j = 11;
	const req = parseRequest(
		url({ latitude: '49.775', longitude: '1.5', hourly: VARS.join(','), start_hour: '2026-10-06T00:00', end_hour: '2026-10-06T15:00' }),
		MINI_CHAINS,
	);
	const res = await answer(req, src, MINI_MODELS, NOW);
	const loc = res.locations[0] as { hourly: Record<string, (number | null)[]>; elevation: number; latitude: number; longitude: number; x_runs: Record<string, number>; x_unserved?: boolean };
	assert.equal(loc.elevation, 191);
	assert.equal(loc.latitude, 49.775);
	assert.equal(loc.longitude, 1.5);
	assert.equal(loc.x_unserved, undefined);
	// A run published whole is named a second after its start (runStamp).
	assert.deepEqual(loc.x_runs, { mini: hourUnix(R03) + 1 });
	assert.deepEqual((loc as unknown as { x_latest: Record<string, number> }).x_latest, { mini: hourUnix(R03) + 1 });
	assert.equal(loc.hourly.time[0], hourUnix(R00));
	assert.equal(loc.hourly.time.length, 16);
	for (let H = 0; H <= 15; H++) {
		// Before 03Z: the 00Z run's first block; from 03Z: the 03Z run.
		const past = H < 3;
		const want = past ? expected(i, j, H, 0, 3, 1, 1) : expected(i, j, H - 3, 40, 3, 1, 1);
		if (H === 3) {
			// 03Z is the 03Z run's first hour, which has no gust of its own:
			// the 00Z run's +3 h holds it.
			want.wind_gusts_10m = expected(i, j, 3, 0, 3, 1, 1).wind_gusts_10m;
		}
		for (const v of VARS) {
			assert.equal(loc.hourly[v][H], want[v], `${v} at +${H} h`);
		}
	}
});

void test('a point in the first member masked corner falls to the next member, its own run and ground', async () => {
	const { src } = source();
	const req = parseRequest(
		url({ latitude: '50.025', longitude: '1.075', hourly: VARS.join(','), start_hour: '2026-10-06T00:00', end_hour: '2026-10-06T15:00' }),
		MINI_CHAINS,
	);
	const res = await answer(req, src, MINI_MODELS, NOW);
	const loc = res.locations[0] as { hourly: Record<string, (number | null)[]>; elevation: number; x_runs: Record<string, number>; latitude: number; longitude: number };
	// The wide grid's point (11, 10): 50.0 N 1.1 E.
	assert.equal(loc.elevation, 120);
	assert.equal(loc.latitude, 50);
	assert.equal(loc.longitude, 1.1);
	assert.deepEqual(loc.x_runs, { miniwide: hourUnix(R00) + 1 });
	for (let H = 0; H <= 12; H++) {
		const want = expected(11, 10, H, 80, 3, 3, 3);
		for (const v of VARS) {
			assert.equal(loc.hourly[v][H], want[v], `${v} at +${H} h`);
		}
	}
	// Past the wide model's reach nobody serves the hour: the horizon
	// speaking, not a hole, so the point stays served.
	for (let H = 13; H <= 15; H++) {
		for (const v of VARS) {
			assert.equal(loc.hourly[v][H], null, `${v} at +${H} h`);
		}
	}
	assert.equal((loc as { x_unserved?: boolean }).x_unserved, undefined);
});

void test('a past hour no kept archive serves makes the point unserved, its other hours kept', async () => {
	const { src } = source();
	// From 21Z the day before: no run of either member started that early.
	const req = parseRequest(
		url({ latitude: '49.775', longitude: '1.5', hourly: 'pressure_msl', start_hour: '2026-10-05T21:00', end_hour: '2026-10-06T02:00' }),
		MINI_CHAINS,
	);
	const loc = (await answer(req, src, MINI_MODELS, NOW)).locations[0] as { x_unserved?: boolean; hourly: Record<string, (number | null)[]> };
	assert.equal(loc.x_unserved, true);
	assert.deepEqual(loc.hourly.pressure_msl.slice(0, 3), [null, null, null]);
	assert.ok(loc.hourly.pressure_msl.slice(3).every((v) => v != null));
	// The same hours asked when they were still ahead are no hole.
	const before = (await answer(req, src, MINI_MODELS, Date.parse('2026-10-05T20:00:00Z'))).locations[0] as { x_unserved?: boolean };
	assert.equal(before.x_unserved, undefined);
});

void test('a point no member covers is unserved, and only the first member answers its own chain', async () => {
	const { src } = source();
	const far = await answer(
		parseRequest(url({ latitude: '40', longitude: '10', hourly: 'pressure_msl', start_hour: '2026-10-06T03:00', end_hour: '2026-10-06T04:00' }), MINI_CHAINS),
		src,
		MINI_MODELS,
		NOW,
	);
	const loc = far.locations[0] as { x_unserved?: boolean; hourly: Record<string, unknown[]>; x_runs: object };
	assert.equal(loc.x_unserved, true);
	assert.deepEqual(loc.hourly.pressure_msl, [null, null]);
	assert.deepEqual(loc.x_runs, {});
	const masked = await answer(
		parseRequest(
			url({ models: 'mini_only', latitude: '50.025', longitude: '1.075', hourly: 'pressure_msl', start_hour: '2026-10-06T03:00', end_hour: '2026-10-06T04:00' }),
			MINI_CHAINS,
		),
		src,
		MINI_MODELS,
		NOW,
	);
	assert.equal((masked.locations[0] as { x_unserved?: boolean }).x_unserved, true);
});

void test('a lattice on a coarse level reads its coarse tile and the native values', async () => {
	const { src } = source();
	const hourly = 'pressure_msl,wind_speed_850hPa';
	const window = { start_hour: '2026-10-06T03:00', end_hour: '2026-10-06T03:00' };
	// Native (8, 7) and (13, 12): the x5 level's (1, 1) and (2, 2).
	const lattice = await answer(parseRequest(url({ latitude: '49.875,49.75', longitude: '1.25,1.375', hourly, ...window }), MINI_CHAINS), src, MINI_MODELS, NOW);
	assert.equal(lattice.tileReads, 1);
	const want = expected(8, 7, 0, 40, 3, 1, 1);
	const first = lattice.locations[0] as { hourly: Record<string, number[]> };
	assert.equal(first.hourly.pressure_msl[0], want.pressure_msl);
	assert.equal(first.hourly.wind_speed_850hPa[0], want.wind_speed_850hPa);
	// One of them alone, off any lattice once paired with a native-only point.
	const mixed = await answer(parseRequest(url({ latitude: '49.875,49.85', longitude: '1.25,1.25', hourly, ...window }), MINI_CHAINS), src, MINI_MODELS, NOW);
	assert.equal((mixed.locations[0] as { hourly: Record<string, number[]> }).hourly.pressure_msl[0], want.pressure_msl);
});

void test('several points answer an array in their order; repeated reads share tiles', async () => {
	const { src, bucket } = source();
	const req = parseRequest(
		url({ latitude: '49.775,49.775,40', longitude: '1.5,1.5,10', hourly: 'pressure_msl', start_hour: '2026-10-06T03:00', end_hour: '2026-10-06T08:00' }),
		MINI_CHAINS,
	);
	const res = await answer(req, src, MINI_MODELS, NOW);
	assert.equal(res.locations.length, 3);
	assert.equal((res.locations[2] as { x_unserved?: boolean }).x_unserved, true);
	// Hours 03..08 of the 03Z run sit in its first block alone.
	assert.equal(res.tileReads, 1);
	const gets = bucket.gets;
	await answer(req, src, MINI_MODELS, NOW);
	assert.ok(bucket.gets - gets <= 2, 'the archive head stays open in the isolate');
});

void test('a member whose grid holds no requested point is never asked for its pointer', async () => {
	const { src } = source();
	const asked: string[] = [];
	const spy: Source = {
		pointer: (model: string) => {
			asked.push(model);
			return src.pointer(model);
		},
		descriptor: src.descriptor.bind(src),
		tile: src.tile.bind(src),
		tiles: src.tiles.bind(src),
	};
	// North-west of the fine grid, inside the wide one alone.
	const req = parseRequest(
		url({ latitude: '50.8', longitude: '0.5', hourly: 'temperature_850hPa', start_hour: '2026-10-06T06:00', end_hour: '2026-10-06T09:00' }),
		MINI_CHAINS,
	);
	const loc = (await answer(req, spy, MINI_MODELS, NOW)).locations[0] as { x_unserved?: boolean; x_runs: Record<string, number>; hourly: Record<string, (number | null)[]> };
	assert.deepEqual(asked, ['miniwide']);
	assert.equal(loc.x_unserved, undefined);
	assert.deepEqual(Object.keys(loc.x_runs), ['miniwide']);
	assert.ok(loc.hourly.temperature_850hPa.every((v) => v !== null));
	// A point the fine grid holds asks both.
	asked.length = 0;
	await answer(parseRequest(url({ latitude: '49.775', longitude: '1.5', hourly: 'temperature_850hPa', start_hour: '2026-10-06T06:00', end_hour: '2026-10-06T09:00' }), MINI_CHAINS), spy, MINI_MODELS, NOW);
	assert.deepEqual(asked.sort(), ['mini', 'miniwide']);
});

void test('the ground under each hour is the model that served it, where a chain switches', async () => {
	const { src } = source();
	const req = parseRequest(
		url({ models: 'wide_first', latitude: '49.775', longitude: '1.5', hourly: 'surface_pressure,elevation', start_hour: '2026-10-06T03:00', end_hour: '2026-10-06T15:00' }),
		MINI_CHAINS,
	);
	const loc = (await answer(req, src, MINI_MODELS, NOW)).locations[0] as { elevation: number; hourly: Record<string, (number | null)[]>; x_runs: Record<string, number> };
	// The column states the first covering member's ground, the wide grid's
	// (15, 12); its run stops at 12Z, and the fine grid's (18, 11) serves on.
	assert.equal(loc.elevation, 162);
	assert.deepEqual(loc.hourly.elevation, [...Array<number>(10).fill(162), 191, 191, 191]);
	assert.deepEqual(loc.x_runs, { miniwide: hourUnix(R00) + 1, mini: hourUnix(R03) + 1 });
	assert.equal(loc.hourly.surface_pressure[10], expected(18, 11, 10, 40, 3, 1, 1).surface_pressure);
});

void test('an older run serving past a truncated newest one: x_runs names it, x_latest the newest', async () => {
	const { src, bucket } = source();
	// 03Z published truncated, its first block alone: hours 10..12 come
	// from the 00Z run, whole.
	const recs = chainReceipts();
	let p = publishAll('mini', [R00], recs);
	const st = runState(R03, recs.filter((r) => r.model === 'mini' && r.run === R03 && r.first === 0));
	p = nextPointer(p, 'mini' as never, st, Object.keys(st.blocks), true, NOW);
	bucket.objects.set('latest/mini.json', { data: new TextEncoder().encode(JSON.stringify(p)) });
	const req = parseRequest(
		url({ models: 'mini_only', latitude: '49.775', longitude: '1.5', hourly: 'pressure_msl', start_hour: '2026-10-06T10:00', end_hour: '2026-10-06T12:00' }),
		MINI_CHAINS,
	);
	const loc = (await answer(req, src, MINI_MODELS, NOW)).locations[0] as { x_runs: Record<string, number>; x_latest: Record<string, number>; hourly: Record<string, unknown[]> };
	assert.ok(loc.hourly.pressure_msl.every((v) => v != null));
	assert.deepEqual(loc.x_runs, { mini: hourUnix(R00) + 1 });
	// Judged by x_runs the column read stale against 03Z on landing; and the
	// truncated 03Z is named at its start, so its whole publication (a
	// second later) outdates the column.
	assert.deepEqual(loc.x_latest, { mini: hourUnix(R03) });
});

void test('hours past every member\'s reach are the horizon, not an unserved point', async () => {
	const { src } = source();
	// From 16Z the day of the runs: past the fine model's 15Z and the wide
	// one's 12Z, the point inside both grids.
	const req = parseRequest(
		url({ latitude: '49.775', longitude: '1.5', hourly: 'pressure_msl', start_hour: '2026-10-06T16:00', end_hour: '2026-10-06T18:00' }),
		MINI_CHAINS,
	);
	const loc = (await answer(req, src, MINI_MODELS, NOW)).locations[0] as { x_unserved?: boolean; x_runs: Record<string, number>; x_latest: Record<string, number>; hourly: Record<string, unknown[]> };
	assert.equal(loc.x_unserved, undefined);
	assert.deepEqual(loc.hourly.pressure_msl, [null, null, null]);
	assert.deepEqual(loc.x_runs, {});
	// Either member publishing further could answer them: both count.
	assert.deepEqual(loc.x_latest, { mini: hourUnix(R03) + 1, miniwide: hourUnix(R00) + 1 });
});

/** Three points in three native tiles of the masked model, each served by
 *  its 03Z run's two archives over 03..15Z: six reads. */
const SPREAD = { latitude: '49.775,49.95,49.6', longitude: '1.5,1.25,1.9', start_hour: '2026-10-06T03:00', end_hour: '2026-10-06T15:00' };

void test('a request heavier than one answer is told how many parts to ask, before any tile is read', async () => {
	const { src, bucket } = source();
	const req = parseRequest(url({ ...SPREAD, hourly: 'pressure_msl,wind_speed_850hPa' }), MINI_CHAINS);
	await assert.rejects(
		answer(req, src, MINI_MODELS, NOW, { ...LIMITS, splitReads: 4 }),
		(err: unknown) => err instanceof SplitError && err.status === 400 && err.parts === 2,
	);
	// The two pointers, and no archive opened.
	assert.equal(bucket.gets, 2);
	// Never more parts than points.
	await assert.rejects(
		answer(req, src, MINI_MODELS, NOW, { ...LIMITS, splitReads: 1 }),
		(err: unknown) => err instanceof SplitError && err.parts === 3,
	);
	// At the budget it is answered, and the estimate was the reads made.
	const res = await answer(req, src, MINI_MODELS, NOW, { ...LIMITS, splitReads: 6 });
	assert.equal(res.tileReads, 6);
	assert.equal(res.locations.length, 3);
});

void test('the read ceiling splits what the estimate missed; a single point is never split', async () => {
	const { src } = source();
	const req = parseRequest(url({ ...SPREAD, hourly: 'pressure_msl' }), MINI_CHAINS);
	await assert.rejects(
		answer(req, src, MINI_MODELS, NOW, { ...LIMITS, splitReads: 100, tileReads: 4 }),
		(err: unknown) => err instanceof SplitError && err.parts === 2,
	);
	const one = parseRequest(url({ ...SPREAD, latitude: '49.775', longitude: '1.5', hourly: 'pressure_msl' }), MINI_CHAINS);
	const res = await answer(one, src, MINI_MODELS, NOW, { ...LIMITS, splitReads: 1, tileReads: 1 });
	assert.equal(res.tileReads, 2);
	assert.ok((res.locations[0] as { hourly: Record<string, (number | null)[]> }).hourly.pressure_msl.every((v) => v != null));
});

void test('an archive the bucket no longer holds reads as not covering, never as a failure', async () => {
	const { src, bucket } = source();
	// The lifecycle rule took the 03Z run's later block while publishing
	// stood still: hours 10..15 fall to the wide model (to its 12 h), the
	// rest past it are the horizon.
	bucket.objects.delete('blocks/mini/2026100603/b007-012.pmtiles');
	const req = parseRequest(
		url({ latitude: '49.775', longitude: '1.5', hourly: 'pressure_msl,elevation', start_hour: '2026-10-06T03:00', end_hour: '2026-10-06T15:00' }),
		MINI_CHAINS,
	);
	const res = await answer(req, src, MINI_MODELS, NOW);
	assert.deepEqual(res.missing, ['blocks/mini/2026100603/b007-012.pmtiles']);
	const loc = res.locations[0] as { hourly: Record<string, (number | null)[]>; x_unserved?: boolean };
	assert.deepEqual(loc.hourly.elevation.slice(0, 7), Array<number>(7).fill(191));
	assert.deepEqual(loc.hourly.elevation.slice(7, 10), [162, 162, 162]);
	assert.deepEqual(loc.hourly.pressure_msl.slice(10), [null, null, null]);
	assert.equal(loc.x_unserved, undefined);
});

void test('a failed read is thrown once the reads in flight have settled', async () => {
	const { src } = source();
	const settled: string[] = [];
	const slow: Source = {
		pointer: (m) => src.pointer(m),
		descriptor: (k) => src.descriptor(k),
		tile: async (key, z, x, y) => {
			if (key.startsWith('first/')) {
				throw new Error('a read failed');
			}
			await new Promise((r) => setTimeout(r, 30));
			settled.push(key);
			return src.tile(key, z, x, y);
		},
	};
	const req = parseRequest(url({ ...SPREAD, latitude: '49.775', longitude: '1.5', hourly: 'pressure_msl' }), MINI_CHAINS);
	await assert.rejects(answer(req, slow, MINI_MODELS, NOW), /a read failed/);
	assert.deepEqual(settled, ['blocks/mini/2026100603/b007-012.pmtiles']);
});

void test('a promise the isolate shares outlives the request that started it', async () => {
	const { bucket } = source();
	const kept: Promise<unknown>[] = [];
	const ctx = { waitUntil: (p: Promise<unknown>) => void kept.push(p) };
	const src = new R2Source(bucket.asR2(), null, '', ctx);
	await src.pointer('mini');
	await src.descriptor('first/mini/2026100603.pmtiles');
	// The pointer's read and the archive's opening, each kept alive.
	assert.equal(kept.length, 2);
});

void test('a ranged read that fails is never retried as a read of the whole archive', async () => {
	const { bucket } = source();
	let whole = 0;
	const r2 = {
		get: (key: string, opts?: { range?: unknown }) => {
			if (!opts?.range) {
				whole++;
				return bucket.get(key);
			}
			return Promise.reject(new Error('network connection lost'));
		},
	} as unknown as R2Bucket;
	const src = new R2Source(r2, null, '', null);
	await assert.rejects(src.descriptor('first/mini/2026100603.pmtiles'), /network connection lost/);
	assert.equal(whole, 0);
});

/** An answer's locations without their timing. */
function values(locs: Record<string, unknown>[]): Record<string, unknown>[] {
	return locs.map(({ generationtime_ms: _, ...rest }) => rest);
}

/** A per-tile source over the same bucket: what the read path did before
 *  it read neighbours together. */
function perTile(src: R2Source): Source {
	return { pointer: (m) => src.pointer(m), descriptor: (k) => src.descriptor(k), tile: (k, z, x, y) => src.tile(k, z, x, y) };
}

void test('an archive\'s neighbouring tiles are read in one request, the values unchanged', async () => {
	const req = parseRequest(url({ ...SPREAD, hourly: 'pressure_msl,wind_speed_850hPa,cloud_cover_850hPa' }), MINI_CHAINS);
	const a = source();
	const one = await answer(req, perTile(a.src), MINI_MODELS, NOW);
	const tileGets = a.bucket.gets;
	resetStoreCaches();
	const b = source();
	const together = await answer(req, b.src, MINI_MODELS, NOW);
	assert.deepEqual(values(together.locations), values(one.locations));
	// Two pointers, two archive heads, then three tiles of each of the two
	// archives: six reads one by one, two together.
	assert.equal(tileGets, 2 + 2 + 6);
	assert.equal(b.bucket.gets, 2 + 2 + 2);
});

void test('a tile in the edge cache is not read again, and the reads fill it', async () => {
	const store = new Map<string, Uint8Array>();
	const cache = {
		match: (k: string) => Promise.resolve(store.has(k) ? new Response(store.get(k)) : undefined),
		put: async (k: string, r: Response) => {
			store.set(k, new Uint8Array(await r.arrayBuffer()));
		},
	} as unknown as Cache;
	const req = parseRequest(url({ ...SPREAD, hourly: 'pressure_msl' }), MINI_CHAINS);
	const { bucket } = source();
	const first = await answer(req, new R2Source(bucket.asR2(), cache, 'https://nwp.test', null), MINI_MODELS, NOW);
	assert.ok(store.size >= 6, `${store.size} tiles cached`);
	const before = bucket.gets;
	resetStoreCaches();
	const again = await answer(req, new R2Source(bucket.asR2(), cache, 'https://nwp.test', null), MINI_MODELS, NOW);
	assert.deepEqual(values(again.locations), values(first.locations));
	// The pointers again; the heads and tiles from the cache.
	assert.equal(bucket.gets - before, 2);
});

void test('a gust asked alone still needs the archive to hold the point', async () => {
	const { src } = source();
	// The fine model's masked corner at 00Z, the first run's first hour,
	// where no gust exists to read: the hour planned no archive at all and
	// was served vacuously, elevation 0, x_runs naming nobody.
	const req = parseRequest(
		url({ models: 'mini_only', latitude: '50.025', longitude: '1.075', hourly: 'wind_gusts_10m', start_hour: '2026-10-06T00:00', end_hour: '2026-10-06T00:00' }),
		MINI_CHAINS,
	);
	const loc = (await answer(req, src, MINI_MODELS, NOW)).locations[0] as { x_unserved?: boolean; elevation: number; x_runs: Record<string, number> };
	assert.equal(loc.x_unserved, true);
	assert.deepEqual(loc.x_runs, {});
});

void test('requests outside the contract are refused with the reason', () => {
	const bad = (params: Record<string, string>, reason: RegExp): void => {
		assert.throws(
			() => parseRequest(url({ latitude: '50', longitude: '2', hourly: 'pressure_msl', start_hour: '2026-10-06T00:00', end_hour: '2026-10-06T01:00', ...params }), MINI_CHAINS),
			(err: unknown) => err instanceof RequestError && err.status === 400 && reason.test(err.message),
		);
	};
	bad({ hourly: 'snowfall' }, /Unsupported variable/);
	bad({ hourly: 'wind_speed_123hPa' }, /Unsupported level/);
	bad({ models: 'icon_seamless' }, /Unsupported model/);
	bad({ latitude: '50,51' }, /same number/);
	bad({ latitude: '95' }, /Invalid coordinates/);
	bad({ end_hour: '2026-09-01T00:00' }, /hour window/);
	bad({ end_hour: '2026-11-01T00:00' }, /hour window/);
	bad({ start_hour: '2026-10-06' }, /start_hour/);
	bad({ start_hour: '2026-10-06T25:00' }, /not a date/);
	bad({ end_hour: '2026-04-31T00:00', start_hour: '2026-04-30T00:00' }, /not a date/);
	bad({ models: 'constructor' }, /Unsupported model/);
	bad({ models: '__proto__' }, /Unsupported model/);
	bad({ wind_speed_unit: 'ms' }, /wind_speed_unit/);
	bad({ latitude: Array(201).fill('50').join(','), longitude: Array(201).fill('2').join(',') }, /At most 200/);
});

void test('hour brackets and gust periods', () => {
	const slots = [0, 3, 6].map((idx) => ({ key: 'k', idx }));
	const tl = { h: [100, 103, 106], slots, period: [0, 3, 3] };
	assert.deepEqual(bracket(tl, 103), { a: slots[1], b: slots[1], w: 0 });
	assert.deepEqual(bracket(tl, 104), { a: slots[1], b: slots[2], w: 1 / 3 });
	assert.equal(bracket(tl, 99), null);
	assert.equal(bracket(tl, 107), null);
	assert.equal(gustSlot(tl, 100), null, 'no gust at the analysis');
	assert.equal(gustSlot(tl, 101), slots[1]);
	assert.equal(gustSlot(tl, 103), slots[1]);
	assert.equal(gustSlot(tl, 104), slots[2]);
});

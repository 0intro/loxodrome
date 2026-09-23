import { describe, expect, it } from 'vitest';
import { OPERA_GRID, OPERA_GRID_2KM } from '$lib/weather/laea';
import {
	DISPLAY_FLOOR_DBZ,
	DISPLAY_FLOOR_MMH,
	FRAME_MIN,
	INDEX_RETRY_MS,
	INDEX_RETRY_SLACK_MS,
	LUT_OFFSET,
	NODATA,
	OPERA_PRODUCT_INFO,
	PUBLICATION_LAG_MS,
	RADAR_SCALE,
	RADAR_SCALES,
	RATE_CELL_MAX,
	RATE_SCALE,
	STALENESS_MIN,
	UNDETECT,
	ageMinutes,
	buildPaint,
	cellClass,
	decodedTileBytes,
	frameAgeMs,
	frameSlot,
	frameUrl,
	framesUrl,
	gridBoxOfBounds,
	hexRgba,
	hhmmZ,
	loopFrameCap,
	loopFrames,
	marshallPalmerDbz,
	marshallPalmerMmH,
	nextFrame,
	nextIndexPollMs,
	indexElapsedMs,
	parseFramesIndex,
	poolingAt,
	poolingFor,
	radarStaleness,
	radarTipLines,
	sampleCell,
	slotHHMM,
	slotMs,
	tilesCovering,
	valueClass,
	type FramesIndex,
	type OperaProduct,
	type RadarFrame,
	type RadarScale,
} from '$lib/weather/opera';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 20, 8, 10);

function frames(count: number, endMs = T0, stepMin = FRAME_MIN): RadarFrame[] {
	const out: RadarFrame[] = [];
	for (let i = count - 1; i >= 0; i--) {
		const ms = endMs - i * stepMin * MIN;
		out.push({ t: frameSlot(ms, stepMin), ms, bytes: 1000, publishedMs: ms + 4 * MIN });
	}
	return out;
}

describe('the product registry', () => {
	it('names each product on its own grid, cadence, lag and tiers', () => {
		expect(OPERA_PRODUCT_INFO.DBZH.grid).toBe(OPERA_GRID);
		expect(OPERA_PRODUCT_INFO.RATE.grid).toBe(OPERA_GRID_2KM);
		expect([OPERA_PRODUCT_INFO.DBZH.cadenceMin, OPERA_PRODUCT_INFO.RATE.cadenceMin]).toEqual([5, 15]);
		expect(OPERA_PRODUCT_INFO.DBZH.publicationLagMs).toBe(4.5 * MIN);
		expect(OPERA_PRODUCT_INFO.RATE.publicationLagMs).toBe(10.5 * MIN);
		expect(OPERA_PRODUCT_INFO.DBZH.staleness).toEqual({ aging: 15, stale: 20, expired: 30 });
		expect(OPERA_PRODUCT_INFO.RATE.staleness).toEqual({ aging: 30, stale: 35, expired: 45 });
		expect(STALENESS_MIN).toBe(OPERA_PRODUCT_INFO.DBZH.staleness);
		expect([OPERA_PRODUCT_INFO.DBZH.unit, OPERA_PRODUCT_INFO.RATE.unit]).toEqual(['dBZ', 'mm/h']);
		expect(RADAR_SCALES.DBZH).toBe(RADAR_SCALE);
		expect(RADAR_SCALES.RATE).toBe(RATE_SCALE);
	});

	it('keeps the RATE tiers behind the successor: one lands about 26 min after the previous nominal time, and after one missing frame at about 41', () => {
		const info = OPERA_PRODUCT_INFO.RATE;
		const successorMs = info.cadenceMin * MIN + info.publicationLagMs;
		expect(info.staleness.aging * MIN).toBeGreaterThan(successorMs + 4 * MIN);
		// One missing frame: the next lands at nominal + 2 cadences + lag and
		// is listed by the poll that follows; the expiry must not fire first.
		const afterOneGapMs = 2 * info.cadenceMin * MIN + info.publicationLagMs;
		expect(info.staleness.expired * MIN).toBeGreaterThan(afterOneGapMs + 4 * MIN);
	});
});

describe('frame slots', () => {
	it('floors to the 5-minute grid and spells the bucket key', () => {
		expect(frameSlot(Date.UTC(2026, 8, 20, 23, 57, 30))).toBe('20260920T2355');
		expect(frameSlot(Date.UTC(2026, 8, 21, 0, 2))).toBe('20260921T0000');
		expect(frameSlot(T0)).toBe('20260920T0810');
	});

	it('floors to the 15-minute grid for RATE', () => {
		expect(frameSlot(Date.UTC(2026, 8, 20, 8, 14), 15)).toBe('20260920T0800');
		expect(frameSlot(Date.UTC(2026, 8, 20, 8, 59), 15)).toBe('20260920T0845');
	});

	it('stamps a key and an instant as HH:MMZ', () => {
		expect(slotHHMM('20260920T0810')).toBe('08:10Z');
		expect(hhmmZ(Date.UTC(2026, 8, 20, 16, 49, 30))).toBe('16:49Z');
		expect(hhmmZ(Date.UTC(2026, 8, 20, 0, 5))).toBe('00:05Z');
	});

	it('parses a key back and refuses anything else', () => {
		expect(slotMs('20260920T2355')).toBe(Date.UTC(2026, 8, 20, 23, 55));
		expect(slotMs('2026-09-20T23:55')).toBeNull();
		expect(slotMs('20260931T0000')).toBeNull();
		expect(slotMs('')).toBeNull();
	});
});

describe('parseFramesIndex', () => {
	it('validates field by field and orders the frames', () => {
		const idx = parseFramesIndex(
			{
				product: 'DBZH',
				frames: [
					{ t: '20260920T0810', bytes: 3521572, publishedAt: '2026-09-20T08:14:11.545Z' },
					{ t: '20260920T0805' },
					{ t: 'bad' },
					null,
					{ t: '20260920T0810', bytes: 1 },
				],
				now: '2026-09-20T08:15:00Z',
			},
			123,
		)!;
		expect(idx).not.toBeNull();
		expect(idx.product).toBe('DBZH');
		expect(idx.frames.map((f) => f.t)).toEqual(['20260920T0805', '20260920T0810']);
		expect(idx.frames[1].bytes).toBe(1);
		expect(idx.frames[0].publishedMs).toBeNull();
		expect(idx.upstreamNowMs).toBe(Date.UTC(2026, 8, 20, 8, 15));
		expect(idx.fetchedAtMs).toBe(123);
	});

	it('answers null for a malformed document', () => {
		expect(parseFramesIndex(null, 0)).toBeNull();
		expect(parseFramesIndex({ frames: [] }, 0)).toBeNull();
		expect(parseFramesIndex({ product: 'DBZH', frames: 'x' }, 0)).toBeNull();
		const noNow = parseFramesIndex({ product: 'RATE', frames: [] }, 55)!;
		expect(noNow.upstreamNowMs).toBe(55);
	});

	it('drops a slot dated past the proxy\'s clock, or published before its own time', () => {
		// A producer keying a frame ahead of its scan (an hour-offset bug):
		// taken at face value the feed read 0 min old though the real one had
		// stopped 40 min earlier (expired, echoes withdrawn), the next poll
		// went out past the bogus slot, and the hour's loop slid off every
		// real frame onto it.
		const served = Date.UTC(2026, 8, 23, 10, 0);
		const real = Array.from({ length: 6 }, (_, i) => frameSlot(served - (65 - 5 * i) * MIN));
		const doc = {
			product: 'DBZH',
			frames: [
				...real.map((t) => ({ t, bytes: 3e6, publishedAt: new Date(slotMs(t)! + 4 * MIN).toISOString() })),
				// Two hours ahead, and published four minutes after its own
				// time like any frame: the clock alone gives it away.
				{ t: frameSlot(served + 120 * MIN), bytes: 3e6, publishedAt: new Date(served + 124 * MIN).toISOString() },
				// Published a quarter of an hour before its own nominal time.
				{ t: frameSlot(served - 20 * MIN), bytes: 3e6, publishedAt: new Date(served - 35 * MIN).toISOString() },
			],
			now: new Date(served).toISOString(),
		};
		const idx = parseFramesIndex(doc, served, served, 0)!;
		expect(idx.frames.map((f) => f.t)).toEqual(real);
		const newest = idx.frames[idx.frames.length - 1];
		expect(radarStaleness(frameAgeMs(newest, idx, served, 0), 'DBZH')).toBe('expired');
		expect(loopFrames(idx.frames, 60, Infinity).map((f) => f.t)).toEqual(real.slice(-6));
		// Overdue: asked again within the minute, not two hours out.
		expect(nextIndexPollMs(idx, served, served + 1000) - served).toBeLessThanOrEqual(INDEX_RETRY_MS);
		// A minute of slack either way, the two upstream clocks' own.
		const edge = parseFramesIndex(
			{
				product: 'DBZH',
				frames: [{ t: frameSlot(served + 1 * MIN), bytes: 1, publishedAt: new Date(served).toISOString() }],
				now: new Date(served).toISOString(),
			},
			served,
			served,
			0,
		)!;
		expect(edge.frames).toHaveLength(1);
	});

	it('never drops a slot against the device\'s own clock', () => {
		// With no upstream clock stated, a device minutes slow would put the
		// real newest frame "ahead": nothing is judged then.
		const device = Date.UTC(2026, 8, 23, 9, 50);
		const t = frameSlot(Date.UTC(2026, 8, 23, 10, 0));
		const idx = parseFramesIndex({ product: 'DBZH', frames: [{ t, bytes: 1 }] }, device)!;
		expect(idx.frames.map((f) => f.t)).toEqual([t]);
	});

	it('measures from the serve time when the proxy states one, the listing instant otherwise', () => {
		// The body's `now` is the LISTING's instant, up to the edge's minute
		// behind a hit; the x-opera-now header is the answer's own.
		const doc = { product: 'DBZH', frames: [], now: '2026-09-20T08:15:00Z' };
		expect(parseFramesIndex(doc, 1, Date.UTC(2026, 8, 20, 8, 15, 45))!.upstreamNowMs).toBe(Date.UTC(2026, 8, 20, 8, 15, 45));
		expect(parseFramesIndex(doc, 1, Number.NaN)!.upstreamNowMs).toBe(Date.UTC(2026, 8, 20, 8, 15));
		expect(parseFramesIndex(doc, 1)!.upstreamNowMs).toBe(Date.UTC(2026, 8, 20, 8, 15));
	});
});

describe('loopFrames / nextFrame', () => {
	it('holds an hour as thirteen frames, both ends included', () => {
		const all = frames(25);
		expect(loopFrames(all, 60, 99)).toHaveLength(13);
		expect(loopFrames(all, 30, 99)).toHaveLength(7);
		expect(loopFrames(all, 120, 99)).toHaveLength(25);
		expect(loopFrames(all, 60, 99)[12].t).toBe('20260920T0810');
	});

	it('holds an hour of RATE as five frames', () => {
		const all = frames(12, Date.UTC(2026, 8, 20, 8, 15), 15);
		expect(loopFrames(all, 60, 99)).toHaveLength(5);
		expect(loopFrames(all, 30, 99)).toHaveLength(3);
		expect(loopFrames(all, 120, 99)).toHaveLength(9);
	});

	it('keeps the newest frames under a cap and survives a production gap', () => {
		const all = frames(25);
		const capped = loopFrames(all, 60, 4);
		expect(capped.map((f) => f.t)).toEqual(all.slice(21).map((f) => f.t));
		const gap = all.filter((f) => f.t !== '20260920T0745');
		expect(loopFrames(gap, 60, 99)).toHaveLength(12);
		expect(loopFrames([], 60, 4)).toEqual([]);
	});

	it('steps through the loop and wraps', () => {
		const three = frames(3);
		expect(nextFrame(three, null, 1)).toBe(three[0].t);
		expect(nextFrame(three, three[1].t, -1)).toBe(three[0].t);
		expect(nextFrame(three, three[0].t, -1)).toBe(three[2].t);
		expect(nextFrame(three, 'unknown', 1)).toBe(three[0].t);
		expect(nextFrame([], null, 1)).toBeNull();
	});
});

describe('nextIndexPollMs', () => {
	const index = (f: RadarFrame[], product: OperaProduct = 'DBZH'): FramesIndex => ({
		product,
		frames: f,
		upstreamNowMs: T0,
		fetchedAtMs: T0,
		fetchedAtMono: 0,
	});

	it('asks at the expected publication of the next frame, then once a minute', () => {
		expect(nextIndexPollMs(null, 0, T0)).toBe(0);
		expect(nextIndexPollMs(null, T0, T0)).toBe(T0 + MIN);
		const idx = index(frames(3));
		const expected = T0 + FRAME_MIN * MIN + PUBLICATION_LAG_MS;
		expect(nextIndexPollMs(idx, T0, T0 + 2 * MIN)).toBe(expected);
		// Overdue: once a minute, due a few seconds early so a tick that
		// lands a hair under the minute does not skip its poll.
		expect(INDEX_RETRY_SLACK_MS).toBe(5_000);
		expect(nextIndexPollMs(idx, T0 + 11.5 * MIN, T0 + 12 * MIN)).toBe(T0 + 12.5 * MIN - INDEX_RETRY_SLACK_MS);
		expect(nextIndexPollMs(idx, T0 + 9.5 * MIN, T0 + 12 * MIN)).toBe(T0 + 10.5 * MIN - INDEX_RETRY_SLACK_MS);
	});

	it('polls at every beat of a jittered minute tick while overdue', () => {
		// The shared minute tick and the ensure's debounce land a few ms
		// either side of 60 000 apart; gated on the full minute, a beat a hair
		// early skipped its poll and the next came two minutes out (six polls
		// in ten beats), the margin RATE's expiry is reasoned on.
		const idx = index(frames(3, T0 - 30 * MIN));
		let last = T0;
		let now = T0;
		let polls = 0;
		for (const d of [60_000, 59_998, 60_003, 59_999, 60_001, 60_000, 59_997, 60_002, 60_000, 59_999]) {
			now += d;
			if (now >= nextIndexPollMs(idx, last, now)) {
				last = now;
				polls++;
			}
		}
		expect(polls).toBe(10);
	});

	it('moves the instant onto the device clock by the offset the index carries', () => {
		// The slots are on the proxy's clock. A device 20 min slow reads its
		// own clock 20 min behind the proxy's (fetchedAt behind upstreamNow):
		// the poll lands at the same proxy instant, 20 min earlier by the
		// device's own count, rather than 20 min late while the age (on the
		// proxy's clock) ran through every tier. A device ahead, the reverse.
		const idx = { ...index(frames(3)), upstreamNowMs: T0, fetchedAtMs: T0 - 20 * MIN };
		const expectedOnProxy = T0 + FRAME_MIN * MIN + PUBLICATION_LAG_MS;
		expect(nextIndexPollMs(idx, T0 - 30 * MIN, T0 - 25 * MIN)).toBe(expectedOnProxy - 20 * MIN);
		const ahead = { ...index(frames(3)), upstreamNowMs: T0, fetchedAtMs: T0 + 20 * MIN };
		expect(nextIndexPollMs(ahead, T0 + 10 * MIN, T0 + 15 * MIN)).toBe(expectedOnProxy + 20 * MIN);
	});

	it('reads the cadence and the lag off the index product: RATE at nominal + 15 + 10.5 min', () => {
		const t = Date.UTC(2026, 8, 20, 8, 15);
		const idx = index(frames(3, t, 15), 'RATE');
		expect(nextIndexPollMs(idx, t, t + 2 * MIN)).toBe(t + 25.5 * MIN);
		expect(nextIndexPollMs(idx, t + 26 * MIN, t + 26.5 * MIN)).toBe(t + 27 * MIN - INDEX_RETRY_SLACK_MS);
	});
});

describe('ageMinutes', () => {
	it('prints the minutes floored, so the figure never reads past a tier its ink has not reached', () => {
		// Rounded, 14.6 min printed "15" in the fresh ink, 19.6 "20" in the
		// orange and 29.6 "30" over echoes the expiry had not yet withdrawn.
		for (const [min, printed, tier] of [
			[14.6, 14, 'fresh'],
			[19.6, 19, 'aging'],
			[29.6, 29, 'stale'],
			[30, 30, 'expired'],
		] as const) {
			expect(ageMinutes(min * MIN)).toBe(printed);
			expect(radarStaleness(min * MIN, 'DBZH')).toBe(tier);
		}
		expect(ageMinutes(-1)).toBe(0);
	});
});

describe('frameAgeMs / radarStaleness', () => {
	it('counts from the nominal time on the proxy clock plus local elapsed time', () => {
		const idx: FramesIndex = {
			product: 'DBZH',
			frames: frames(2),
			upstreamNowMs: T0 + 6 * MIN,
			fetchedAtMs: 5_000_000,
			fetchedAtMono: 0,
		};
		expect(frameAgeMs(idx.frames[1], idx, 5_000_000 + 3 * MIN, 0)).toBe(9 * MIN);
		// A device clock hours off changes nothing: only the elapsed time counts.
		expect(frameAgeMs(idx.frames[1], idx, 5_000_000 + 3 * MIN, 0)).toBe(
			frameAgeMs(idx.frames[1], { ...idx, fetchedAtMs: 9_000_000 }, 9_000_000 + 3 * MIN, 0),
		);
	});

	it('keeps ageing through a device clock stepped back, and through a paused monotonic one', () => {
		const idx: FramesIndex = {
			product: 'DBZH',
			frames: frames(2),
			upstreamNowMs: T0 + 6 * MIN,
			fetchedAtMs: 5_000_000,
			fetchedAtMono: 1_000,
		};
		// 26 real minutes on the monotonic clock, while the device clock was
		// corrected 30 minutes back: the age once froze at the index's own.
		expect(frameAgeMs(idx.frames[1], idx, 5_000_000 - 4 * MIN, 1_000 + 26 * MIN)).toBe(32 * MIN);
		expect(radarStaleness(frameAgeMs(idx.frames[1], idx, 5_000_000 - 4 * MIN, 1_000 + 26 * MIN))).toBe('expired');
		// A device asleep: the monotonic clock paused, the device's ran on.
		expect(frameAgeMs(idx.frames[1], idx, 5_000_000 + 26 * MIN, 1_000)).toBe(32 * MIN);
		expect(indexElapsedMs(idx, 5_000_000 - 60 * MIN, 1_000)).toBe(0);
	});

	it('tiers the age at 15, 20 and 30 minutes for DBZH', () => {
		expect(radarStaleness(14.99 * MIN)).toBe('fresh');
		expect(radarStaleness(15 * MIN)).toBe('aging');
		expect(radarStaleness(20 * MIN)).toBe('stale');
		expect(radarStaleness(30 * MIN)).toBe('expired');
		expect(radarStaleness(30 * MIN, 'DBZH')).toBe('expired');
	});

	it('tiers the age at 30, 35 and 45 minutes for RATE', () => {
		expect(radarStaleness(29.99 * MIN, 'RATE')).toBe('fresh');
		expect(radarStaleness(30 * MIN, 'RATE')).toBe('aging');
		expect(radarStaleness(35 * MIN, 'RATE')).toBe('stale');
		expect(radarStaleness(40 * MIN, 'RATE')).toBe('stale');
		expect(radarStaleness(45 * MIN, 'RATE')).toBe('expired');
	});
});

describe('budgets and pooling', () => {
	it('caps the loop by the tiles a view needs', () => {
		const tier = (budgetBytes: number, bytesPerTile = OPERA_PRODUCT_INFO.DBZH.p90TileBytes) => ({ budgetBytes, bytesPerTile });
		expect(loopFrameCap(11, tier(16e6))).toBe(14);
		expect(loopFrameCap(34, tier(16e6))).toBe(4);
		expect(loopFrameCap(70, tier(16e6))).toBe(2);
		expect(loopFrameCap(11, tier(64e6))).toBe(58);
		expect(loopFrameCap(0, tier(1e6))).toBe(1);
		expect(loopFrameCap(72, tier(1))).toBe(1);
		// A phone's France view of RATE (four tiles at 150 KB) under the 16 MB tier: 26 frames.
		expect(loopFrameCap(4, tier(16e6, OPERA_PRODUCT_INFO.RATE.p90TileBytes))).toBe(26);
		expect(OPERA_PRODUCT_INFO.RATE.p90TileBytes).toBe(150_000);
	});

	it('caps the loop by the DECODED tier too, whichever of the two holds fewer', () => {
		// The review's phone: six DBZH tiles at pooling 1. Their compressed
		// bytes fit 25 frames in tier A many times over; decoded, one tile is
		// 512 x 512 Int8 cells and 25 frames of six want 39 MB of a 32 MB
		// tier, so tier B is the bound, at 28.8 MB / (6 x 262 144) = 18.
		const compressed = { budgetBytes: 16e6 * 0.9, bytesPerTile: 22_000 };
		const decoded = { budgetBytes: 32e6 * 0.9, bytesPerTile: decodedTileBytes('DBZH', 1) };
		expect(decodedTileBytes('DBZH', 1)).toBe(262_144);
		expect(loopFrameCap(6, compressed)).toBe(109);
		expect(loopFrameCap(6, compressed, decoded)).toBe(18);
		expect(loopFrameCap(6, decoded, compressed)).toBe(18);
		// The tighter tier wins whichever it is: a rainy day's 2 MB tiles
		// bring tier A below tier B.
		expect(loopFrameCap(6, { budgetBytes: 14.4e6, bytesPerTile: 2_000_000 }, decoded)).toBe(1);
	});

	it('sizes a decoded tile by its pooling and its cell type', () => {
		// DBZH is Int8, RATE Int16 tenths: the same 512-cell tile costs twice.
		expect(decodedTileBytes('DBZH', 1)).toBe(512 * 512);
		expect(decodedTileBytes('RATE', 1)).toBe(512 * 512 * 2);
		expect(decodedTileBytes('DBZH', 4)).toBe(128 * 128);
		expect(decodedTileBytes('RATE', 16)).toBe(32 * 32 * 2);
	});

	it('pools by the smallest power of two whose cell spans sqrt(2) pixels', () => {
		expect(poolingFor(100, 1000)).toBe(1);
		expect(poolingFor(700, 1000)).toBe(1);
		// A 1 km cell at 1 km a pixel is one pixel wide: turned against the
		// screen it can hold no pixel centre, and its echo is never drawn.
		expect(poolingFor(1000, 1000)).toBe(2);
		expect(poolingFor(1400, 1000)).toBe(2);
		expect(poolingFor(1500, 1000)).toBe(4);
		expect(poolingFor(3000, 1000)).toBe(8);
		expect(poolingFor(6000, 1000)).toBe(16);
		expect(poolingFor(20000, 1000)).toBe(32);
		// The tile's own 512 cells is the ceiling.
		expect(poolingFor(1e6, 1000)).toBe(512);
		expect(poolingFor(NaN, 1000)).toBe(1);
		for (let mpp = 50; mpp < 400_000; mpp *= 1.07) {
			const p = poolingFor(mpp, 1000);
			if (p < 512) {
				// At least sqrt(2) pixels, never more than twice that.
				expect((p * 1000) / mpp).toBeGreaterThanOrEqual(Math.SQRT2 - 1e-9);
				if (p > 1) {
					expect((p * 1000) / mpp).toBeLessThan(2 * Math.SQRT2 + 1e-9);
				}
			}
		}
	});

	it('pools one step less on the 2 km grid at the same zoom', () => {
		for (const mpp of [1500, 3000, 6000, 20000]) {
			expect(poolingFor(mpp, 2000)).toBe(poolingFor(mpp, 1000) / 2);
		}
		expect(poolingFor(1400, 2000)).toBe(1);
		expect(poolingFor(1e6, 2000)).toBe(512);
	});
});

describe('poolingAt', () => {
	it("is the draw and the prefetch's one recipe, read where a pixel covers the most ground", () => {
		// Web Mercator at 48 N: 818 m/px at zoom 7, 3.3 km at 5, 13 km at 3.
		expect(poolingAt(7, 47, 48, 1000)).toBe(2);
		expect(poolingAt(5, 47, 48, 1000)).toBe(8);
		expect(poolingAt(3, 47, 48, 1000)).toBe(32);
		expect(poolingAt(12, 47, 48, 1000)).toBe(1);
		// The 2 km grid pools half as much at the same zoom.
		expect(poolingAt(5, 47, 48, 2000)).toBe(4);
		expect(poolingAt(3, 47, 48, 2000)).toBe(16);
		// The view's latitude nearest the equator decides: its south edge in
		// the north, its north edge in the south, the equator across it.
		expect(poolingAt(5, 40, 60, 1000)).toBe(poolingAt(5, 40, 40, 1000));
		expect(poolingAt(5, -60, -40, 1000)).toBe(poolingAt(5, 40, 40, 1000));
		expect(poolingAt(4, -10, 10, 1000)).toBe(poolingAt(4, 0, 0, 1000));
		expect(poolingAt(4, 0, 0, 1000)).toBe(16);
		expect(poolingAt(4, 60, 60, 1000)).toBe(8);
	});
});

describe('tilesCovering', () => {
	const tiles = (b: { west: number; south: number; east: number; north: number }): number[] | null => {
		const box = gridBoxOfBounds(b, OPERA_GRID);
		return box ? tilesCovering(box, OPERA_GRID) : null;
	};
	const tiles2 = (b: { west: number; south: number; east: number; north: number }): number[] | null => {
		const box = gridBoxOfBounds(b, OPERA_GRID_2KM);
		return box ? tilesCovering(box, OPERA_GRID_2KM) : null;
	};
	const FRANCE = { west: -5.5, south: 41, east: 10, north: 51.5 };

	it('names the tiles of the usual views', () => {
		expect(tiles({ west: -1.5, south: 46.5, east: 6.5, north: 51.5 })).toHaveLength(4);
		expect(tiles(FRANCE)).toHaveLength(12);
		expect(tiles({ west: -25, south: 32, east: 45, north: 70 })).toHaveLength(72);
		expect(tiles({ west: 6, south: 41, east: 10, north: 44.5 })).toHaveLength(2);
	});

	it('answers null off the composite and the whole grid around it', () => {
		expect(tiles({ west: -100, south: 30, east: -90, north: 40 })).toBeNull();
		expect(tiles({ west: -180, south: -85, east: 180, north: 85 })).toHaveLength(72);
		// A box whose every edge lies north of the grid (over the pole) or on
		// the far hemisphere still holds the grid: the interior reaches it.
		expect(tiles({ west: -179, south: -80, east: 179, north: 84 })).toHaveLength(72);
		// A viewport around the antipode of the projection centre read as the
		// whole grid while the far hemisphere projected.
		expect(tiles({ west: -170.4, south: -55.2, east: -169.6, north: -54.8 })).toBeNull();
		expect(tiles({ west: -175, south: -60, east: -165, north: -50 })).toBeNull();
	});

	it('reads Leaflet\'s unwrapped bounds: Europe a turn east or west is still Europe', () => {
		// A drag round the world leaves the map at 350..370 E; a clamp to
		// 180 read that as off the composite.
		const here = tiles(FRANCE)!;
		expect(tiles({ ...FRANCE, west: FRANCE.west + 360, east: FRANCE.east + 360 })).toEqual(here);
		expect(tiles({ ...FRANCE, west: FRANCE.west - 720, east: FRANCE.east - 720 })).toEqual(here);
	});

	it('lists tiles ascending and row-major', () => {
		const t = tiles(FRANCE)!;
		for (let i = 1; i < t.length; i++) {
			expect(t[i]).toBeGreaterThan(t[i - 1]);
		}
		expect(t).toContain(42);
	});

	it('names the 2 km tiles from the same boxes: the whole grid is 20, Paris is on tile 9', () => {
		expect(tiles2({ west: -25, south: 32, east: 45, north: 70 })).toHaveLength(20);
		expect(tiles2({ west: -180, south: -85, east: 180, north: 85 })).toHaveLength(20);
		expect(tiles2({ west: -100, south: 30, east: -90, north: 40 })).toBeNull();
		const fr = tiles2(FRANCE)!;
		expect(fr).toContain(9);
		expect(fr.length).toBeLessThanOrEqual(12);
		for (let i = 1; i < fr.length; i++) {
			expect(fr[i]).toBeGreaterThan(fr[i - 1]);
		}
		expect(fr.every((i) => i >= 0 && i < 20)).toBe(true);
	});

	it('keeps the two grids in step: a 2 km tile is 1024 cells of the 1 km box', () => {
		for (const b of [FRANCE, { west: -1.5, south: 46.5, east: 6.5, north: 51.5 }, { west: 6, south: 41, east: 10, north: 44.5 }]) {
			const box1 = gridBoxOfBounds(b, OPERA_GRID)!;
			const expected: number[] = [];
			for (let ty = Math.floor(box1.r0 / 1024); ty <= Math.floor(box1.r1 / 1024); ty++) {
				for (let tx = Math.floor(box1.c0 / 1024); tx <= Math.floor(box1.c1 / 1024); tx++) {
					expected.push(ty * 4 + tx);
				}
			}
			expect(tiles2(b)).toEqual(expected);
		}
	});
});

function checkScale(scale: RadarScale, floor: number): void {
	expect(scale.steps[0].min).toBe(floor);
	expect(scale.floor).toBe(floor);
	for (let i = 1; i < scale.steps.length; i++) {
		expect(scale.steps[i].min).toBeGreaterThan(scale.steps[i - 1].min);
		expect(scale.steps[i].level).toBeGreaterThanOrEqual(scale.steps[i - 1].level);
	}
	expect(scale.steps.map((s) => s.word)).toEqual([
		'light', 'light', 'moderate', 'moderate', 'heavy', 'heavy', 'extreme', 'extreme',
	]);
	expect(scale.steps.map((s) => s.level)).toEqual([1, 1, 2, 2, 3, 4, 5, 6]);
}

describe('the reflectivity scale', () => {
	it('is strictly ascending from the display floor with the ICAO levels in order', () => {
		checkScale(RADAR_SCALE, DISPLAY_FLOOR_DBZ);
		expect(RADAR_SCALE.unit).toBe('dBZ');
		expect(RADAR_SCALE.perUnit).toBe(1);
		const at = (dbz: number): number => RADAR_SCALE.steps[cellClass(dbz, RADAR_SCALE)].level;
		expect([at(20), at(30), at(40), at(45), at(50), at(55)]).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it('classes every reflectivity and reaches every step', () => {
		expect(cellClass(14, RADAR_SCALE)).toBe(-1);
		expect(cellClass(15, RADAR_SCALE)).toBe(0);
		expect(cellClass(29, RADAR_SCALE)).toBe(1);
		expect(cellClass(30, RADAR_SCALE)).toBe(2);
		expect(cellClass(80, RADAR_SCALE)).toBe(RADAR_SCALE.steps.length - 1);
		const reached = new Set<number>();
		for (let v = -128; v <= 127; v++) {
			reached.add(cellClass(v, RADAR_SCALE));
		}
		expect(reached.size).toBe(RADAR_SCALE.steps.length + 1);
	});

	it('paints with transparent sentinels and floor, the texture from the top step', () => {
		const paint = buildPaint('DBZH');
		const lut = paint.lut;
		expect(lut.length).toBe(256);
		expect(lut[NODATA + LUT_OFFSET]).toBe(0);
		expect(lut[UNDETECT + LUT_OFFSET]).toBe(0);
		expect(lut[14 + LUT_OFFSET]).toBe(0);
		expect(lut[15 + LUT_OFFSET]).toBe(hexRgba('#a5d6a7'));
		expect(lut[55 + LUT_OFFSET]).toBe(hexRgba('#8e24aa'));
		expect(lut[127 + LUT_OFFSET]).toBe(hexRgba('#8e24aa'));
		expect(paint.textureFrom).toBe(55);
		expect(paint.textureRgba).toBe(hexRgba('#4a148c'));
		expect(hexRgba('#ff0000') >>> 0).not.toBe(0);
	});

	it('relates dBZ to mm/h by Marshall-Palmer, both ways', () => {
		expect(marshallPalmerMmH(23)).toBeGreaterThan(0.95);
		expect(marshallPalmerMmH(23)).toBeLessThan(1.05);
		expect(marshallPalmerMmH(40)).toBeGreaterThan(11);
		expect(marshallPalmerMmH(40)).toBeLessThan(12);
		expect(marshallPalmerMmH(55)).toBeGreaterThan(marshallPalmerMmH(50));
		for (const dbz of [15, 23, 40, 55]) {
			expect(marshallPalmerDbz(marshallPalmerMmH(dbz))).toBeCloseTo(dbz, 9);
		}
		// The 0.4 mm/h floor reads 16.6 dBZ: the doc's "16 dBZ through
		// Marshall-Palmer", a hair above the 15 dBZ the FAA floor uses.
		expect(marshallPalmerDbz(0.4)).toBeGreaterThan(16);
		expect(marshallPalmerDbz(0.4)).toBeLessThan(17);
	});
});

describe('the rain-rate scale', () => {
	it('carries the Météo-France bin edges on the dBZ hue ramp, from the 0.4 mm/h floor', () => {
		checkScale(RATE_SCALE, DISPLAY_FLOOR_MMH);
		expect(RATE_SCALE.unit).toBe('mm/h');
		expect(RATE_SCALE.perUnit).toBe(10);
		expect(RATE_SCALE.steps.map((s) => s.min)).toEqual([0.4, 1, 2, 5, 11, 20, 65, 115]);
		expect(RATE_SCALE.steps.map((s) => s.color)).toEqual(RADAR_SCALE.steps.map((s) => s.color));
	});

	it('classes the stored tenths and reaches every step', () => {
		expect(cellClass(0, RATE_SCALE)).toBe(-1);
		expect(cellClass(3, RATE_SCALE)).toBe(-1);
		expect(cellClass(4, RATE_SCALE)).toBe(0);
		expect(cellClass(10, RATE_SCALE)).toBe(1);
		expect(cellClass(20, RATE_SCALE)).toBe(2);
		expect(cellClass(24, RATE_SCALE)).toBe(2);
		expect(cellClass(110, RATE_SCALE)).toBe(4);
		expect(cellClass(1150, RATE_SCALE)).toBe(7);
		expect(cellClass(RATE_CELL_MAX, RATE_SCALE)).toBe(7);
		const reached = new Set<number>();
		for (let v = -128; v <= RATE_CELL_MAX; v++) {
			reached.add(cellClass(v, RATE_SCALE));
		}
		expect(reached.size).toBe(RATE_SCALE.steps.length + 1);
		expect(valueClass(2.4, RATE_SCALE)).toBe(2);
		// A value is rounded to its stored tenth first: 0.39 IS 0.4.
		expect(valueClass(0.34, RATE_SCALE)).toBe(-1);
		expect(valueClass(0.39, RATE_SCALE)).toBe(0);
		expect(valueClass(0.4, RATE_SCALE)).toBe(0);
		expect(valueClass(34, RADAR_SCALE)).toBe(2);
	});

	it('paints the tenths through a LUT at the shared offset, the texture from 115 mm/h', () => {
		const paint = buildPaint('RATE');
		const lut = paint.lut;
		expect(lut.length).toBe(LUT_OFFSET + RATE_CELL_MAX + 1);
		expect(lut[NODATA + LUT_OFFSET]).toBe(0);
		expect(lut[UNDETECT + LUT_OFFSET]).toBe(0);
		expect(lut[0 + LUT_OFFSET]).toBe(0);
		expect(lut[3 + LUT_OFFSET]).toBe(0);
		expect(lut[4 + LUT_OFFSET]).toBe(hexRgba('#a5d6a7'));
		expect(lut[24 + LUT_OFFSET]).toBe(hexRgba('#ffee58'));
		expect(lut[1150 + LUT_OFFSET]).toBe(hexRgba('#8e24aa'));
		expect(lut[RATE_CELL_MAX + LUT_OFFSET]).toBe(hexRgba('#8e24aa'));
		expect(paint.textureFrom).toBe(1150);
	});
});

describe('urls and words', () => {
	it('builds the two proxy routes', () => {
		expect(framesUrl('https://p', 'DBZH', 3)).toBe('https://p/opera/frames?product=DBZH&hours=3');
		expect(framesUrl('https://p', 'RATE', 40)).toBe('https://p/opera/frames?product=RATE&hours=6');
		expect(frameUrl('https://p', '20260920T0810', 'DBZH', [3, 4, 11])).toBe(
			'https://p/opera/20260920T0810/DBZH.tiff?tiles=3,4,11',
		);
		expect(frameUrl('https://p', '20260920T0815', 'RATE', [5])).toBe('https://p/opera/20260920T0815/RATE.tiff?tiles=5');
	});

	it('words a sample in its unit, the rate to the tenth in the locale', () => {
		const words = {
			radar: 'Radar',
			noCoverage: 'No radar coverage',
			words: { light: 'light', moderate: 'moderate', heavy: 'heavy', extreme: 'extreme' },
			number: (v: number, d: number) => v.toFixed(d),
		};
		expect(radarTipLines({ kind: 'echo', product: 'DBZH', value: 34, t: 'x' }, words)).toEqual(['Radar 34 dBZ, moderate']);
		expect(radarTipLines({ kind: 'echo', product: 'DBZH', value: 5, t: 'x' }, words)).toEqual(['Radar 5 dBZ']);
		expect(radarTipLines({ kind: 'nocoverage', product: 'DBZH', value: null, t: 'x' }, words)).toEqual(['No radar coverage']);
		expect(radarTipLines({ kind: 'none', product: 'DBZH', value: null, t: 'x' }, words)).toEqual([]);
		expect(radarTipLines({ kind: 'echo', product: 'RATE', value: 2.4, t: 'x' }, words)).toEqual(['Radar 2.4 mm/h, moderate']);
		expect(radarTipLines({ kind: 'echo', product: 'RATE', value: 0.2, t: 'x' }, words)).toEqual(['Radar 0.2 mm/h']);
		expect(radarTipLines({ kind: 'echo', product: 'RATE', value: 137, t: 'x' }, words)).toEqual(['Radar 137.0 mm/h, extreme']);
		const fr = {
			...words,
			words: { light: 'faible', moderate: 'modérée', heavy: 'forte', extreme: 'extrême' },
			number: (v: number, d: number) => v.toFixed(d).replace('.', ','),
		};
		expect(radarTipLines({ kind: 'echo', product: 'RATE', value: 2.4, t: 'x' }, fr)).toEqual(['Radar 2,4 mm/h, modérée']);
		expect(sampleCell({ kind: 'echo', product: 'RATE', value: 2.4, t: 'x' })).toBe(24);
		expect(sampleCell({ kind: 'echo', product: 'DBZH', value: 34, t: 'x' })).toBe(34);
		expect(sampleCell({ kind: 'none', product: 'DBZH', value: null, t: 'x' })).toBeNull();
	});
});

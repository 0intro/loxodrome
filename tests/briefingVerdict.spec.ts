/* The NOTAM briefing judged against the planned flight
 * (notam/briefingVerdict.ts). Every surface that reads NOTAMs states this
 * one verdict, so each reason is pinned here at its edges: the route
 * coverage (a nudge stays covered, a move does not, a lost route is a
 * failure), the window with its head and tail tolerances (a dated flight on
 * an untouched plan reads covered), the RTBA release and its two proofs,
 * and the age, judged on the ground only. */

import { describe, expect, it } from 'vitest';
import {
	AGE_LIMIT_MS,
	aerodromeReach,
	briefedAt,
	briefingVerdict,
	rtbaReleaseMs,
	viewGaps,
	type AskedRegion,
	type PlanTrack,
	type VerdictInput,
} from '$lib/notam/briefingVerdict';

const H = 3_600_000;
const DAY = Date.UTC(2026, 10, 25);
const NOW = Date.UTC(2026, 10, 24, 19, 0);

// Toussus, Rambouillet, Etampes, Orleans: about 60 NM.
const TRACK = [
	{ lat: 48.75194, lon: 2.10611 },
	{ lat: 48.644, lon: 1.836 },
	{ lat: 48.433, lon: 2.16 },
	{ lat: 47.89694, lon: 2.16333 },
];
const PLAN: PlanTrack = { label: 'LFPN-LFOZ', path: TRACK };

/** The track moved `nm` north at its middle waypoint. */
function nudged(nm: number): PlanTrack {
	return {
		label: 'LFPN-LFOZ',
		path: TRACK.map((p, i) => (i === 1 ? { lat: p.lat + nm / 60, lon: p.lon } : p)),
	};
}

/** A SOFIA fetch over `tracks`, each briefing its two end aerodromes whole
 *  unless it says otherwise. */
const asked = (
	tracks: { label: string; path: typeof TRACK; landed: boolean; ends?: readonly string[] | null }[],
	halfWidthNM = 15.3,
): AskedRegion => ({
	region: { kind: 'tracks', tracks: tracks.map((t) => ({ ends: ['LFPN', 'LFOZ'], ...t })), halfWidthNM },
	aim: 'flight',
});

/** A SOFIA briefing of the flight's day, fetched after the RTBA release. */
function input(over: Partial<VerdictInput> = {}): VerdictInput {
	return {
		nowMs: NOW,
		loaded: true,
		fetch: {
			at: NOW - 10 * 60_000,
			briefed: { from: DAY, to: DAY + 23 * H + 59 * 60_000 },
			asked: asked([{ label: 'LFPN-LFOZ', path: TRACK, landed: true }]),
		},
		byHand: null,
		gaps: null,
		rtbaDays: new Set(),
		plan: { tracks: [PLAN], halfWidthNM: 15 },
		span: { from: DAY, to: DAY + 24 * H - 1 },
		onGround: true,
		crossesRtba: false,
		...over,
	};
}

const codes = (i: VerdictInput) => briefingVerdict(i).reasons.map((r) => r.code);

describe('the verdict', () => {
	it('covers a dated flight on an untouched plan', () => {
		expect(briefingVerdict(input())).toMatchObject({ plan: true, source: 'fetch', reasons: [] });
	});

	it('judges nothing with no plan to judge', () => {
		expect(briefingVerdict(input({ plan: null }))).toMatchObject({ plan: false, reasons: [] });
		expect(briefingVerdict(input({ plan: { tracks: [], halfWidthNM: 15 } })).plan).toBe(false);
	});

	it('reads none with nothing loaded', () => {
		expect(codes(input({ loaded: false, fetch: null }))).toEqual(['none']);
	});
});

describe('the route', () => {
	const cases: [string, Partial<VerdictInput>, string[]][] = [
		['a 0.2 NM nudge stays covered', { plan: { tracks: [nudged(0.2)], halfWidthNM: 15 } }, []],
		['a 2 NM move falls outside', { plan: { tracks: [nudged(2)], halfWidthNM: 15 } }, ['route']],
		['a narrower corridor stays covered', { plan: { tracks: [PLAN], halfWidthNM: 10 } }, []],
		['a wider corridor falls outside', { plan: { tracks: [PLAN], halfWidthNM: 20 } }, ['route']],
		[
			'a new alternate falls outside',
			{
				plan: {
					tracks: [PLAN, { label: 'LFOZ-LFOQ', path: [TRACK[3], { lat: 47.678, lon: 1.209 }] }],
					halfWidthNM: 15,
				},
			},
			['route'],
		],
	];
	for (const [name, over, want] of cases) {
		it(name, () => {
			expect(codes(input(over))).toEqual(want);
		});
	}

	it('names the tracks that fell outside', () => {
		const v = briefingVerdict(input({ plan: { tracks: [nudged(2)], halfWidthNM: 15 } }));
		expect(v.reasons[0]).toMatchObject({ code: 'route', labels: ['LFPN-LFOZ'], cause: 'track' });
	});

	it('says the corridor is wider than the briefing’s, whatever the track', () => {
		const wide = (halfWidthNM: number) =>
			briefingVerdict(input({ plan: { tracks: [PLAN], halfWidthNM } })).reasons.map((r) => r.code === 'route' && r.cause);
		expect(wide(20)).toEqual(['width']);
		// SOFIA takes 99 NM at most: a 98.5 NM corridor is briefed 98.3 NM
		// each side of the drawn line, never a changed route.
		const f = input().fetch;
		const capped = input({
			plan: { tracks: [PLAN], halfWidthNM: 98.5 },
			fetch: f && { ...f, asked: asked([{ label: 'LFPN-LFOZ', path: TRACK, landed: true }], 98.3) },
		});
		expect(briefingVerdict(capped).reasons).toMatchObject([{ code: 'route', cause: 'width' }]);
		// A route the fetch lost still reads failed under a wider corridor.
		const lost = input({
			plan: { tracks: [PLAN], halfWidthNM: 20 },
			fetch: f && { ...f, asked: asked([{ label: 'LFPN-LFOZ', path: TRACK, landed: false }]) },
		});
		expect(briefingVerdict(lost).reasons).toEqual([{ code: 'failed', labels: ['LFPN-LFOZ'], total: 1 }]);
	});

	it('reads a route the fetch asked and lost as failed, not changed', () => {
		const f = input().fetch;
		const v = input({
			fetch: f && { ...f, asked: asked([{ label: 'LFPN-LFOZ', path: TRACK, landed: false }]) },
		});
		expect(briefingVerdict(v).reasons).toEqual([{ code: 'failed', labels: ['LFPN-LFOZ'], total: 1 }]);
	});

	it('reads the lost routes from the gaps when the fetch recorded no tracks', () => {
		const f = input().fetch;
		const v = input({ fetch: f && { ...f, asked: null }, gaps: { total: 2, labels: ['LFOZ-LFOQ'] } });
		expect(briefingVerdict(v).reasons).toEqual([{ code: 'failed', labels: ['LFOZ-LFOQ'], total: 2 }]);
	});

	it('judges a map view against its box', () => {
		const f = input().fetch;
		const box = (minLat: number): AskedRegion => ({
			region: { kind: 'box', bbox: { minLat, minLon: 1, maxLat: 49.5, maxLon: 3.2 } },
			aim: 'period',
		});
		expect(codes(input({ fetch: f && { ...f, asked: box(47.4) } }))).toEqual([]);
		expect(codes(input({ fetch: f && { ...f, asked: box(48.2) } }))).toEqual(['route']);
		expect(briefingVerdict(input({ fetch: f && { ...f, asked: box(48.2) } })).reasons[0]).toMatchObject({ cause: 'area' });
	});
});

describe('the window', () => {
	it('tolerates the briefing opening within the hour after a fetch made in the window', () => {
		const at = DAY + 10 * H;
		const v = input({
			nowMs: at,
			fetch: {
				at,
				briefed: { from: at + 2 * 60_000, to: at + 24 * H },
				asked: asked([{ label: 'LFPN-LFOZ', path: TRACK, landed: true }]),
			},
			span: { from: DAY + 9 * H, to: DAY + 14 * H },
		});
		expect(codes(v)).toEqual([]);
	});

	it('reads a briefing of another day as short of the period', () => {
		const v = briefingVerdict(input({ span: { from: DAY + 3 * 24 * H, to: DAY + 4 * 24 * H - 1 } }));
		expect(v.reasons.map((r) => r.code)).toEqual(['period']);
	});

	it('reads a flight running past the briefing as short', () => {
		expect(codes(input({ span: { from: DAY + 20 * H, to: DAY + 26 * H } }))).toEqual(['period']);
	});

	it('judges a window already open with the fetch’s margin alone, its ramp hour gone', () => {
		// A Fly tap at 12:20 over a briefing from 13:00, fetched for an ETD of
		// 14:00: the window rolls from now, and the flight from 12:20 to 13:00
		// is in no briefing.
		const now = DAY + 12 * H + 20 * 60_000;
		const later = { at: DAY + 8 * H, briefed: { from: DAY + 13 * H, to: DAY + 37 * H }, asked: null };
		const v = input({ nowMs: now, fetch: later, span: { from: now, to: now + 2 * H } });
		expect(codes(v)).toContain('period');
		// SOFIA's bulletin of a fetch made now opens a minute or two later.
		const fresh = { at: now, briefed: { from: now + 2 * 60_000, to: now + 24 * H }, asked: null };
		expect(codes(input({ nowMs: now, fetch: fresh, span: { from: now, to: now + 2 * H } }))).toEqual([]);
	});
});

describe('the RTBA release', () => {
	it('falls at 17:30 UTC the day before', () => {
		expect(rtbaReleaseMs(DAY + 10 * H)).toBe(DAY - 6 * H - 30 * 60_000);
	});

	const before = { at: DAY - 8 * H, briefed: { from: DAY, to: DAY + 24 * H }, asked: null };
	it('reads a briefing fetched before it as short for a plan crossing the network', () => {
		const v = briefingVerdict(input({ crossesRtba: true, fetch: before, nowMs: DAY - 8 * H }));
		expect(v.reasons).toEqual([{ code: 'rtba', dayMs: DAY, releaseMs: DAY - 6 * H - 30 * 60_000 }]);
	});

	it('takes a fetch after it, or an RTBA NOTAM of the day, as knowing the day', () => {
		expect(codes(input({ crossesRtba: true }))).toEqual([]);
		expect(codes(input({ crossesRtba: true, fetch: before, nowMs: DAY - 8 * H, rtbaDays: new Set(['2026-11-25']) }))).toEqual([]);
	});

	it('names the first day of a longer window whose activity the briefing lacks', () => {
		// Wednesday 09:00Z to Thursday 11:00Z: the releases fall on Tuesday
		// and Wednesday at 17:30Z.
		const span = { from: DAY + 9 * H, to: DAY + 35 * H };
		const rtba = (at: number, rtbaDays = new Set<string>()) =>
			briefingVerdict(
				input({ crossesRtba: true, span, nowMs: at, rtbaDays, fetch: { at, briefed: { from: DAY, to: DAY + 48 * H }, asked: null } }),
			).reasons.find((r) => r.code === 'rtba');
		const wed = { code: 'rtba', dayMs: DAY, releaseMs: DAY - 6 * H - 30 * 60_000 };
		const thu = { code: 'rtba', dayMs: DAY + 24 * H, releaseMs: DAY + 17 * H + 30 * 60_000 };
		expect(rtba(DAY - 20 * H)).toEqual(wed);
		expect(rtba(DAY - 6 * H)).toEqual(thu);
		expect(rtba(DAY - 20 * H, new Set(['2026-11-25']))).toEqual(thu);
		expect(rtba(DAY + 18 * H)).toBeUndefined();
	});

	it('asks nothing of a plan away from the network', () => {
		expect(codes(input({ crossesRtba: false, fetch: before, nowMs: DAY - 8 * H }))).toEqual([]);
	});
});

describe('the age', () => {
	it('reads short past three hours on the ground, plain in the air', () => {
		const old = input().fetch;
		const late = old && { ...old, at: NOW - AGE_LIMIT_MS - 60_000 };
		expect(codes(input({ fetch: late }))).toEqual(['age']);
		expect(codes(input({ fetch: late, onGround: false }))).toEqual([]);
	});
});

describe('a bulletin by hand', () => {
	it('is judged by its age and the RTBA proof alone', () => {
		const hand = input({ fetch: null, byHand: { at: NOW - 60_000 }, plan: { tracks: [nudged(5)], halfWidthNM: 15 } });
		expect(briefingVerdict(hand)).toMatchObject({ source: 'hand', reasons: [] });
		expect(codes({ ...hand, byHand: { at: NOW - 4 * H } })).toEqual(['age']);
		expect(codes({ ...hand, crossesRtba: true })).toEqual(['rtba']);
		expect(codes({ ...hand, crossesRtba: true, rtbaDays: new Set(['2026-11-25']) })).toEqual([]);
	});
});

describe('a position and an instant', () => {
	const at = (lat: number, lon: number, ms: number) => ({ lat, lon, ms });
	it('is covered inside a landed track and the briefed window', () => {
		expect(briefedAt(input(), at(48.6, 1.9, DAY + 10 * H))).toEqual({ notam: true, rtba: true, miss: null });
	});

	it('reads aerodromes fetched by name alone as no briefing of the area', () => {
		const byName = input({ fetch: null, byHand: null });
		expect(briefingVerdict(byName).source).toBe('none');
		expect(briefedAt(byName, at(48.6, 1.9, DAY + 10 * H))).toEqual({ notam: false, rtba: false, miss: 'none' });
	});

	it('is outside off the corridor or out of the window, and says which', () => {
		expect(briefedAt(input(), at(48.6, 4.5, DAY + 10 * H))).toEqual({ notam: false, rtba: false, miss: 'position' });
		expect(briefedAt(input(), at(48.6, 1.9, DAY + 3 * 24 * H))).toEqual({ notam: false, rtba: false, miss: 'period' });
		// Before the briefing's departure, with no head hour.
		expect(briefedAt(input(), at(48.6, 1.9, DAY - 30 * 60_000))).toEqual({ notam: false, rtba: false, miss: 'period' });
		// The fetch's own margin: a bulletin fetched now opens a minute or two
		// later, and the alerts read the minutes in between as briefed.
		expect(briefedAt(input(), at(48.6, 1.9, DAY - 90_000)).notam).toBe(true);
	});

	it('knows the RTBA day only past the release or through a NOTAM of that day', () => {
		const early = input({ fetch: { at: DAY - 8 * H, briefed: { from: DAY, to: DAY + 24 * H }, asked: null } });
		expect(briefedAt(early, at(48.6, 1.9, DAY + 10 * H))).toEqual({ notam: true, rtba: false, miss: null });
		expect(briefedAt({ ...early, rtbaDays: new Set(['2026-11-25']) }, at(48.6, 1.9, DAY + 10 * H)).rtba).toBe(true);
	});

	it('covers wherever a bulletin by hand is read, and nothing with no briefing', () => {
		expect(briefedAt(input({ fetch: null, byHand: { at: NOW } }), at(10, 10, DAY)).notam).toBe(true);
		expect(briefedAt(input({ loaded: false, fetch: null }), at(48.6, 1.9, DAY))).toEqual({
			notam: false,
			rtba: false,
			miss: 'none',
		});
	});
});

describe('where the briefing leaves the viewing period', () => {
	const briefed = { from: DAY + 9 * H, to: DAY + 33 * H };
	it('states the head a period opening hours before it, and the tail past it', () => {
		expect(viewGaps(briefed, { from: DAY - 15 * H, to: Infinity })).toEqual({ from: DAY + 9 * H, until: DAY + 33 * H });
	});

	it('tolerates the ramp hour, and says nothing of a period inside it', () => {
		expect(viewGaps(briefed, { from: DAY + 8.5 * H, to: DAY + 14 * H })).toEqual({ from: null, until: null });
	});

	it('allows the minute a day runs past a bulletin of 23 h 59', () => {
		const day = { from: DAY, to: DAY + 24 * H - 60_000 };
		expect(viewGaps(day, { from: DAY, to: DAY + 24 * H - 1 })).toEqual({ from: null, until: null });
	});
});

describe('how the briefing holds an aerodrome', () => {
	const LFPN = { ident: 'LFPN', lat: 48.75194, lon: 2.10611 };
	// Etampes-Mondesir, inside the corridor between the ends.
	const LFOX = { ident: 'LFOX', lat: 48.38139, lon: 2.07528 };
	// Lille, far off it.
	const LFQQ = { ident: 'LFQQ', lat: 50.56333, lon: 3.08694 };
	const sofia = asked([{ label: 'LFPN-LFOZ', path: TRACK, landed: true }]);
	const cases: [string, AskedRegion | null, typeof LFPN, string][] = [
		['a SOFIA end, whole', sofia, LFPN, 'full'],
		['a SOFIA field between the ends, thinly', sofia, LFOX, 'thin'],
		['a field off every corridor, not at all', sofia, LFQQ, 'none'],
		['an end of a lost track, not at all', asked([{ label: 'LFPN-LFOZ', path: TRACK, landed: false }]), LFPN, 'none'],
		['inside an autorouter corridor, whole', asked([{ label: 'LFPN-LFOZ', path: TRACK, landed: true, ends: null }]), LFOX, 'full'],
		['outside an autorouter corridor, not at all', asked([{ label: 'LFPN-LFOZ', path: TRACK, landed: true, ends: null }]), LFQQ, 'none'],
		['inside a map view, whole', { region: { kind: 'box', bbox: { minLat: 48, minLon: 1.5, maxLat: 49, maxLon: 2.5 } }, aim: 'period' }, LFOX, 'full'],
		['outside a map view, not at all', { region: { kind: 'box', bbox: { minLat: 48, minLon: 1.5, maxLat: 49, maxLon: 2.5 } }, aim: 'period' }, LFQQ, 'none'],
		['a fetch with no geometry, whole', null, LFQQ, 'full'],
	];
	for (const [name, a, ad, want] of cases) {
		it(name, () => {
			expect(aerodromeReach(a, ad)).toBe(want);
		});
	}
});

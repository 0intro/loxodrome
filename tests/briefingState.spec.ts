/* The verdict over the app's own state (state/briefing.svelte.ts): the
 * loaded briefing, the routes on screen, the flight's window, the RTBA
 * zones a plan corridor crosses and the SUP AIP list in use. The rules are
 * briefingVerdict.spec.ts's and briefingSupaip.spec.ts's. This one pins
 * what feeds them. */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rowToAirspace } from '$lib/data/airspaces';

// An RTBA zone astride the plan's second leg, near Rambouillet.
const RTBA = rowToAirspace(
	[
		'LFR45X', 'R', 'TEST RTBA', '',
		['STD', '065', 'FL'], ['HEI', '800', 'FT'], null, null, 'NOTAM', 'NOTAM', '', [],
		[[48.55, 1.7], [48.55, 2.0], [48.75, 2.0], [48.75, 1.7]],
		'',
	],
	'fr',
);
const air = vi.hoisted(() => ({ rows: [] as unknown[] }));
// The French SUP AIP list: its build time, null while unread, and what it holds.
const sup = vi.hoisted(() => ({ list: null as { at: number | null } | null, listed: new Set<string>() }));
vi.mock('$lib/state/data.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/state/data.svelte')>()),
	getAirspaces: () => air.rows,
	frSupaipList: () => sup.list,
	supaipByRef: (number: number, year: number) => (sup.listed.has(`${year}/${number}`) ? {} : null),
}));
vi.mock('$lib/map/airspaceSymbology', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/map/airspaceSymbology')>()),
	isRtba: (id: string) => id === 'LFR45X',
}));

const { briefingActivityUnknown, briefingNoticeNow, briefingRun, briefingVerdictNow, briefingWatch } = await import(
	'$lib/state/briefing.svelte'
);
const { display } = await import('$lib/state/display.svelte');
const { ensureBriefing } = await import('$lib/state/briefingFetch');
const { alertInputGaps } = await import('$lib/state/airspaceAlert.svelte');
const { routeEndpointsLabel } = await import('$lib/state/routeNotamFetch');
const { clearNotams, commitBriefing } = await import('$lib/state/notam.svelte');
const { installFlightScope } = await import('$lib/state/flightScope');
const { flightPrep } = await import('$lib/state/flightPrep.svelte');
const { routes, routeSettings } = await import('$lib/state/route.svelte');
import type { Route, Waypoint } from '$lib/state/route.svelte';

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 24, 19, 0);
const DAY = Date.UTC(2026, 10, 25);
const PATH = [
	{ lat: 48.75194, lon: 2.10611 },
	{ lat: 48.644, lon: 1.836 },
	{ lat: 48.433, lon: 2.16 },
	{ lat: 47.89694, lon: 2.16333 },
];

function route(path = PATH): Route {
	const wp = (i: number, p: { lat: number; lon: number }): Waypoint =>
		({ id: `w${i}`, lat: p.lat, lon: p.lon, kind: 'free', alt: 2500, altAuto: true }) as unknown as Waypoint;
	return { id: 'r1', name: null, waypoints: path.map((p, i) => wp(i, p)), selectedWaypointId: null };
}

/** A route briefing fetched at `at`, the clock left there. */
function fetched(at: number, path = PATH): void {
	vi.setSystemTime(at);
	commitBriefing('', {
		source: 'sofia',
		kind: 'route',
		briefed: { from: DAY, to: DAY + 23 * H + 59 * 60_000 },
		asked: {
			region: { kind: 'tracks', tracks: [{ label: '?', path, landed: true, ends: ['LFPN', 'LFOZ'] }], halfWidthNM: 15.3 },
			aim: 'flight',
		},
	});
}

const radius = routeSettings.corridorRadiusNM;
beforeAll(() => {
	installFlightScope();
});
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	clearNotams();
	air.rows = [];
	sup.list = null;
	sup.listed.clear();
	routeSettings.corridorRadiusNM = 15;
	routes.list = [route()];
	flightPrep.dossier.flightDate = '2026-11-25';
	flightPrep.dossier.departureTime = null;
});
afterEach(() => {
	vi.useRealTimers();
	routes.list = [];
	routeSettings.corridorRadiusNM = radius;
	flightPrep.dossier.flightDate = null;
});

describe('the map notice', () => {
	it('folds for this briefing and this plan, and unfolds on another', () => {
		const auto = display.autoNotams;
		display.autoNotams = false;
		briefingWatch.folded = null;
		const n = briefingNoticeNow(NOW);
		expect(n.show).toBe(true);
		briefingWatch.folded = n.key;
		expect(briefingNoticeNow(NOW).show).toBe(false);
		const moved = PATH.map((p, i) => (i === 2 ? { lat: p.lat - 0.1, lon: p.lon + 0.1 } : p));
		routes.list = [route(moved)];
		expect(briefingNoticeNow(NOW).show).toBe(true);
		briefingWatch.folded = briefingNoticeNow(NOW).key;
		fetched(NOW - 4 * H, moved);
		vi.setSystemTime(NOW);
		expect(briefingNoticeNow(NOW).reason?.code).toBe('age');
		expect(briefingNoticeNow(NOW).show).toBe(true);
		display.autoNotams = auto;
		briefingWatch.folded = null;
	});
});

describe('the map notice’s reason and fold', () => {
	const t0 = DAY - 9 * H;

	it('states the first reason a fetch cures, an RTBA release still to come after it', () => {
		fetched(t0);
		air.rows = [RTBA];
		routeSettings.corridorRadiusNM = 14;
		flightPrep.perf.manualIcaos = ['LFOX'];
		try {
			expect(briefingVerdictNow().reasons.map((r) => r.code)).toEqual(['rtba', 'aerodromes']);
			expect(briefingNoticeNow(t0).reason?.code).toBe('aerodromes');
		} finally {
			flightPrep.perf.manualIcaos = [];
		}
	});

	it('unfolds once the release passes, a run fails or the day turns', () => {
		fetched(t0);
		air.rows = [RTBA];
		routeSettings.corridorRadiusNM = 14;
		const key = briefingNoticeNow(t0).key;
		vi.setSystemTime(DAY - 6 * H);
		expect(briefingNoticeNow(DAY - 6 * H).key).not.toBe(key);
		vi.setSystemTime(t0);
		briefingRun.failures = 1;
		briefingRun.failedMs = t0;
		try {
			expect(briefingNoticeNow(t0).key).not.toBe(key);
		} finally {
			briefingRun.failures = 0;
			briefingRun.failedMs = null;
		}
		vi.setSystemTime(t0 + 24 * H);
		expect(briefingNoticeNow(t0 + 24 * H).key).not.toBe(key);
	});
});

describe('the verdict over the plan on screen', () => {
	it('reads none, then covered once the route is briefed', () => {
		expect(briefingVerdictNow().reasons.map((r) => r.code)).toEqual(['none']);
		fetched(NOW);
		expect(briefingVerdictNow()).toMatchObject({ plan: true, source: 'fetch', reasons: [] });
	});

	it('reads the route changed once a waypoint moves', () => {
		fetched(NOW);
		routes.list = [route(PATH.map((p, i) => (i === 2 ? { lat: p.lat - 0.1, lon: p.lon + 0.1 } : p)))];
		expect(briefingVerdictNow().reasons.map((r) => r.code)).toEqual(['route']);
	});

	it('judges nothing without a route', () => {
		routes.list = [];
		expect(briefingVerdictNow().plan).toBe(false);
	});

	it('asks for the RTBA release only of a plan crossing the network', () => {
		fetched(DAY - 8 * H);
		expect(briefingVerdictNow().reasons.map((r) => r.code)).toEqual([]);
		air.rows = [RTBA];
		routeSettings.corridorRadiusNM = 14;
		expect(briefingVerdictNow().reasons.map((r) => r.code)).toEqual(['rtba']);
	});

	it('fetches nothing for a print or the Fly tap before the RTBA release', async () => {
		fetched(DAY - 8 * H);
		air.rows = [RTBA];
		routeSettings.corridorRadiusNM = 14;
		briefingRun.lastMs = null;
		expect(await ensureBriefing()).toBe('skipped');
		expect(briefingRun.lastMs).toBeNull();
	});
});

describe('what the briefing leaves unknown of the zones activated by NOTAM', () => {
	const label = () => routeEndpointsLabel(routes.list[0]);

	it('along a route: everything with none, nothing once covered', () => {
		expect(briefingActivityUnknown(label())).toEqual({ notam: true, rtba: true });
		fetched(NOW);
		expect(briefingActivityUnknown(label())).toEqual({ notam: false, rtba: false });
	});

	it('along the route that left the briefing, the others kept', () => {
		fetched(NOW);
		// A turning point 30 NM east: the track leaves the corridor briefed.
		routes.list = [route(PATH.map((p, i) => (i === 2 ? { lat: p.lat, lon: p.lon + 0.75 } : p)))];
		expect(briefingActivityUnknown(label())).toEqual({ notam: true, rtba: true });
		expect(briefingActivityUnknown('LFOZ-LFOQ')).toEqual({ notam: false, rtba: false });
	});

	it('on a track still inside the corridor briefed, nothing, whatever the route reason', () => {
		fetched(NOW);
		// 7 NM off: the plan's corridor reaches outside, the track does not.
		routes.list = [route(PATH.map((p, i) => (i === 2 ? { lat: p.lat - 0.1, lon: p.lon + 0.1 } : p)))];
		expect(briefingVerdictNow().reasons.map((r) => r.code)).toEqual(['route']);
		expect(briefingActivityUnknown(label())).toEqual({ notam: false, rtba: false });
		// A wider corridor leaves the tracks as briefed.
		routes.list = [route()];
		routeSettings.corridorRadiusNM = 20;
		expect(briefingVerdictNow().reasons.map((r) => r.code)).toEqual(['route']);
		expect(briefingActivityUnknown(label())).toEqual({ notam: false, rtba: false });
	});

	it('names a track by its endpoints as they read now', () => {
		const moved = PATH.map((p, i) => (i === 2 ? { lat: p.lat - 0.1, lon: p.lon + 0.1 } : p));
		const named = (name: string): Route => {
			const r = route(moved);
			const last = r.waypoints.length - 1;
			return { ...r, waypoints: r.waypoints.map((w, i) => (i === last ? { ...w, label: name } : w)) };
		};
		fetched(NOW);
		routes.list = [named('Farm')];
		expect(briefingVerdictNow().reasons.find((x) => x.code === 'route')).toMatchObject({ labels: ['?-Farm'] });
		routes.list = [named('Barn')];
		expect(briefingVerdictNow().reasons.find((x) => x.code === 'route')).toMatchObject({ labels: ['?-Barn'] });
	});

	it('an RTBA zone alone before the day’s release', () => {
		fetched(DAY - 8 * H);
		air.rows = [RTBA];
		routeSettings.corridorRadiusNM = 14;
		expect(briefingActivityUnknown(label())).toEqual({ notam: false, rtba: true });
	});

	it('names the alerts’ caveat at the desk by the verdict', () => {
		expect(alertInputGaps()?.briefingMiss).toBe('none');
		fetched(NOW);
		expect(alertInputGaps()?.briefingMiss ?? null).toBeNull();
		flightPrep.dossier.flightDate = '2026-11-28';
		expect(alertInputGaps()?.briefingMiss).toBe('period');
		flightPrep.dossier.flightDate = '2026-11-25';
		routes.list = [route(PATH.map((p, i) => (i === 2 ? { lat: p.lat - 0.1, lon: p.lon + 0.1 } : p)))];
		expect(alertInputGaps()?.briefingMiss).toBe('route');
	});
});

describe('the SUP AIP list in use', () => {
	const LIST_AT = Date.UTC(2026, 9, 29, 10);
	// A trigger in force over the flight's day, announcing a supplement.
	const TRIGGER = [
		'R1234/26 NOTAMN',
		'Q) LFFF/QRTTT/IV/BO/W/000/065/4838N00150E010',
		'A) LFFF B) 2611200000 C) 2612312359',
		'E) TRIGGER NOTAM - AIP SUP 247/26 ZRT TEST.',
	].join('\n');

	function briefed(text: string): void {
		vi.setSystemTime(NOW);
		commitBriefing(text, { source: 'sofia', kind: 'route', briefed: { from: DAY, to: DAY + 23 * H + 59 * 60_000 } });
	}

	it('names a supplement a trigger cites and the list lacks', () => {
		sup.list = { at: LIST_AT };
		briefed(TRIGGER);
		expect(briefingVerdictNow().reasons).toEqual([
			{ code: 'supaip', listAt: LIST_AT, sups: [{ ref: 'AIP SUP 247/26', notam: 'R1234/26' }] },
		]);
	});

	it('names it with the list’s date unread', () => {
		sup.list = { at: null };
		briefed(TRIGGER);
		expect(briefingVerdictNow().reasons).toEqual([
			{ code: 'supaip', listAt: null, sups: [{ ref: 'AIP SUP 247/26', notam: 'R1234/26' }] },
		]);
	});

	it('raises nothing once the list holds it, or while the list is unread', () => {
		briefed(TRIGGER);
		expect(briefingVerdictNow().reasons).toEqual([]);
		sup.list = { at: LIST_AT };
		sup.listed.add('2026/247');
		expect(briefingVerdictNow().reasons).toEqual([]);
	});

	it('reads the triggers in force over the flight alone', () => {
		sup.list = { at: LIST_AT };
		briefed(TRIGGER.replace('B) 2611200000 C) 2612312359', 'B) 2612010000 C) 2612312359'));
		expect(briefingVerdictNow().reasons).toEqual([]);
	});
});

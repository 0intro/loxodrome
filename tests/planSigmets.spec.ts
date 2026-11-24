/* The SIGMETs a planned flight meets (weather/sigmet.ts sigmetsOnPlan, over
 * state/planSigmets.svelte.ts), which the Overview's box B states and the
 * print review names: valid during the flight's window, reaching below its
 * highest level, inside a route's corridor by their own ring or their FIR's,
 * one record per bulletin. Then the state's three answers: off without live
 * weather, unknown before any feed has answered, the list otherwise. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwcIsigmet } from '$lib/weather/awc';
import { fromIsigmet, sigmetsOnPlan, type Sigmet, type SigmetPlan } from '$lib/weather/sigmet';

const awc = vi.hoisted(() => ({ intl: [] as unknown[], fail: false }));
vi.mock('$lib/weather/awc', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/weather/awc')>()),
	fetchIsigmets: () => (awc.fail ? Promise.reject(new Error('weather fetch failed: 503')) : Promise.resolve(awc.intl)),
	fetchAirsigmets: () => (awc.fail ? Promise.reject(new Error('weather fetch failed: 503')) : Promise.resolve([])),
}));
vi.mock('$lib/state/data.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/state/data.svelte')>()),
	ensureAirports: () => Promise.resolve([]),
}));

const { planSigmetsNow } = await import('$lib/state/planSigmets.svelte');
const { sigmetsSettled } = await import('$lib/state/sigmets.svelte');
const { display } = await import('$lib/state/display.svelte');
const { routes } = await import('$lib/state/route.svelte');
const { flightPrep } = await import('$lib/state/flightPrep.svelte');
const { sigmetBoxLine } = await import('$lib/components/flightprep/weatherBox');
const { i18n } = await import('$lib/state/i18n.svelte');
import type { Route, Waypoint } from '$lib/state/route.svelte';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 25, 9, 0);
const S = (ms: number) => Math.round(ms / 1000);

// Toussus to Orleans, 2500 ft.
const PATH = [
	{ lat: 48.75194, lon: 2.10611 },
	{ lat: 48.433, lon: 2.16 },
	{ lat: 47.89694, lon: 2.16333 },
];
/** A square of `half` degrees around a point, as AWC lists a ring. */
const square = (lat: number, lon: number, half: number) => [
	{ lat: lat - half, lon: lon - half },
	{ lat: lat - half, lon: lon + half },
	{ lat: lat + half, lon: lon + half },
	{ lat: lat + half, lon: lon - half },
];
function isigmet(over: Partial<AwcIsigmet> = {}): AwcIsigmet {
	return {
		icaoId: 'LFPW',
		firId: 'LFFF',
		firName: 'PARIS',
		seriesId: '3',
		hazard: 'TS',
		qualifier: 'EMBD',
		base: 1500,
		top: 35000,
		geom: 'AREA',
		coords: square(48.4, 2.2, 0.2),
		validTimeFrom: S(T0),
		validTimeTo: S(T0 + 4 * H),
		rawSigmet: 'LFFF SIGMET 3 VALID ...',
		...over,
	};
}
const PLAN: SigmetPlan = {
	paths: [PATH],
	halfWidthM: 15 * 1852,
	window: { from: T0 + H, to: T0 + 3 * H },
	ceilingFt: 2500,
};
const own = (s: Sigmet) => (s.ring ? [s.ring] : []);

describe('the advisories a planned flight meets', () => {
	it('keeps one on the route, in the window and below the plan’s top', () => {
		const on = fromIsigmet(isigmet());
		expect(sigmetsOnPlan([on], PLAN, own).map((s) => s.id)).toEqual([on.id]);
	});

	it('leaves one off the corridor, out of the window, or above the plan', () => {
		const far = fromIsigmet(isigmet({ seriesId: '4', coords: square(45.0, 5.0, 0.2) }));
		const later = fromIsigmet(isigmet({ seriesId: '5', validTimeFrom: S(T0 + 5 * H), validTimeTo: S(T0 + 8 * H) }));
		const high = fromIsigmet(isigmet({ seriesId: '6', hazard: 'TURB', qualifier: 'SEV', base: 24000, top: 30000 }));
		expect(sigmetsOnPlan([far, later, high], PLAN, own)).toEqual([]);
	});

	it('reaches a FIR-wide advisory through its FIR’s rings', () => {
		const wide = fromIsigmet(isigmet({ seriesId: '7', coords: null }));
		const fir = (s: Sigmet) => (s.fir === 'LFFF' ? [[[47, 1], [47, 4], [50, 4], [50, 1]] as [number, number][]] : []);
		expect(sigmetsOnPlan([wide], PLAN, own)).toEqual([]);
		expect(sigmetsOnPlan([wide], PLAN, fir).map((s) => s.fir)).toEqual(['LFFF']);
	});

	it('names apart the bulletins one office issues for two FIRs', () => {
		const paris = fromIsigmet(isigmet({ seriesId: '1' }));
		const marseille = fromIsigmet(isigmet({ seriesId: '1', firId: 'LFMM', firName: 'MARSEILLE', coords: square(48.0, 2.2, 0.2) }));
		expect(sigmetsOnPlan([paris, marseille], PLAN, own).map((s) => s.fir)).toEqual(['LFFF', 'LFMM']);
	});

	it('names a multi-area bulletin once, in the order the advisories start', () => {
		const a = fromIsigmet(isigmet({ seriesId: '8', validTimeFrom: S(T0 + 2 * H) }));
		const b = fromIsigmet(isigmet({ seriesId: '8', validTimeFrom: S(T0 + 2 * H), coords: square(48.0, 2.2, 0.2) }));
		const first = fromIsigmet(isigmet({ seriesId: '9' }));
		expect(sigmetsOnPlan([a, b, first], PLAN, own).map((s) => s.id)).toEqual([first.id, a.id]);
	});
});

describe('box B’s line', () => {
	const one = fromIsigmet(isigmet());
	const two = fromIsigmet(isigmet({ seriesId: '4', hazard: 'ICE', qualifier: 'SEV', base: 0, top: 9000 }));

	it('names the first advisory and counts the rest, in both languages', () => {
		i18n.locale = 'en';
		expect(sigmetBoxLine({ status: 'ok', list: [one], fromMs: T0 }, 1)?.text).toBe(
			'SIGMET on the route: LFFF EMBD TS FL015-FL350 09:00–13:00Z',
		);
		expect(sigmetBoxLine({ status: 'ok', list: [one, two], fromMs: T0 }, 1)?.text).toBe(
			'2 SIGMETs on the route: LFFF EMBD TS FL015-FL350 09:00–13:00Z and 1 more',
		);
		expect(sigmetBoxLine({ status: 'unknown' }, 1)).toEqual({ text: 'SIGMETs unavailable for the route', ink: 'manual' });
		expect(sigmetBoxLine({ status: 'ok', list: [], fromMs: T0 }, 1)).toBeNull();
		expect(sigmetBoxLine({ status: 'off' }, 1)).toBeNull();
		i18n.locale = 'fr';
		expect(sigmetBoxLine({ status: 'ok', list: [one, two], fromMs: T0 }, 1)?.text).toBe(
			'2 SIGMET sur la route\u202f: LFFF EMBD TS FL015-FL350 09:00–13:00Z et 1 autre',
		);
		i18n.locale = 'en';
	});

	it('dates an advisory starting on another day than the flight', () => {
		const evening = fromIsigmet(isigmet({ seriesId: '5', validTimeFrom: S(T0 - 11 * H), validTimeTo: S(T0 - 7 * H) }));
		expect(sigmetBoxLine({ status: 'ok', list: [evening], fromMs: T0 + 24 * H }, 1)?.text).toBe(
			'SIGMET on the route: LFFF EMBD TS FL015-FL350 2026-11-24 22:00–02:00Z (+1)',
		);
	});
});

describe('the state', () => {
	const route = (): Route => ({
		id: 'r1',
		name: null,
		selectedWaypointId: null,
		waypoints: PATH.map((p, i) => ({ id: `w${i}`, lat: p.lat, lon: p.lon, kind: 'free', alt: 2500, altAuto: true }) as unknown as Waypoint),
	});

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(T0 - H);
		routes.list = [route()];
		flightPrep.dossier.flightDate = '2026-11-25';
		flightPrep.dossier.departureTime = '10:00';
		display.liveWeather = true;
		awc.intl = [isigmet()];
		awc.fail = false;
	});
	afterEach(() => {
		vi.useRealTimers();
		routes.list = [];
		flightPrep.dossier.flightDate = null;
		flightPrep.dossier.departureTime = null;
	});

	it('reads unknown once the last attempt failed, and a print asks again at once', async () => {
		await sigmetsSettled();
		expect(planSigmetsNow().status).toBe('ok');
		vi.setSystemTime(T0 - H + 10 * 60_000);
		awc.fail = true;
		await sigmetsSettled();
		expect(planSigmetsNow()).toEqual({ status: 'unknown' });
		awc.fail = false;
		vi.setSystemTime(T0 - H + 11 * 60_000);
		await sigmetsSettled();
		expect(planSigmetsNow().status).toBe('ok');
	});

	it('is off without live weather, unknown before any answer, then lists what the flight meets', async () => {
		display.liveWeather = false;
		expect(planSigmetsNow()).toEqual({ status: 'off' });
		display.liveWeather = true;
		awc.fail = true;
		await sigmetsSettled();
		expect(planSigmetsNow()).toEqual({ status: 'unknown' });
		vi.setSystemTime(T0 - H + 10 * 60_000);
		awc.fail = false;
		await sigmetsSettled();
		const ps = planSigmetsNow();
		expect(ps.status).toBe('ok');
		expect(ps.status === 'ok' && ps.list.map((s) => s.fir)).toEqual(['LFFF']);
	});

	it('dates an advisory from the day before a departure just past midnight', async () => {
		// ETD 00:30Z: the ramp hour starts the day before, the flight does not.
		vi.setSystemTime(Date.UTC(2026, 10, 24, 20, 0));
		flightPrep.dossier.departureTime = '00:30';
		awc.intl = [
			isigmet({ validTimeFrom: S(Date.UTC(2026, 10, 24, 22, 0)), validTimeTo: S(Date.UTC(2026, 10, 25, 2, 0)) }),
		];
		await sigmetsSettled();
		const ps = planSigmetsNow();
		expect(ps.status === 'ok' && ps.fromMs).toBe(Date.UTC(2026, 10, 25, 0, 30));
		expect(sigmetBoxLine(ps, 1)?.text).toBe(
			'SIGMET on the route: LFFF EMBD TS FL015-FL350 2026-11-24 22:00–02:00Z (+1)',
		);
	});

	it('takes the plan’s top from the legs flown, never the last waypoint', async () => {
		// The destination deleted, its leg's 7500 ft kept on the new last one.
		const r = route();
		r.waypoints = r.waypoints.map((w, i) => (i === r.waypoints.length - 1 ? { ...w, alt: 7500 } : w));
		routes.list = [r];
		awc.intl = [isigmet({ hazard: 'ICE', qualifier: 'SEV', base: 5000, top: 12000 })];
		await sigmetsSettled();
		const ps = planSigmetsNow();
		expect(ps.status === 'ok' && ps.list).toEqual([]);
	});
});

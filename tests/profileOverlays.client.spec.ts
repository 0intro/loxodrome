/* The route profile's crossings strip is a verdict, so neither the NOTAMs
 * layer toggle, a display choice, nor a list filter or the viewing period
 * may change it (components/profileOverlays.svelte.ts): a prohibited-area
 * NOTAM band the drawn line penetrates stays a NO-GO row with the layer off,
 * with a search hiding the NOTAM, and with a bounded look-ahead ending
 * before the planned flight, while the chart's NOTAM bands follow all three.
 * The deriveds run in the client runtime (tests/env/webnode.ts). */

import { flushSync } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
// The data store before the NOTAM state: its root effect reads the NOTAM
// state, which the client runtime has not finished evaluating when the
// NOTAM module comes first and pulls the store in.
import '$lib/state/data.svelte';
import type { ProfileOverlaySource } from '$lib/components/profileOverlays.svelte';
import type { Notam } from '$lib/notam/types';
import type { Waypoint } from '$lib/state/route.svelte';
import { notamState } from '$lib/state/notam.svelte';
import { filter } from '$lib/state/filter.svelte';
import { profileLayers } from '$lib/state/profileLayers.svelte';
import { mountOverlays } from './helpers/profileOverlaysHost.svelte';
import { fake } from './helpers/reminderFake.svelte';

// A prohibited-area NOTAM publishing a 2 NM circle on the route, SFC to
// 3000 ft AMSL, in force from 1 January 2026 for good.
const RP: Notam = {
	id: 'A1234/26',
	fullContent: 'E) PROHIBITED AREA ACTIVATED',
	coordinates: [{ lat: 48.5, lon: 2, original: '', type: 'psn', radius: 2, radiusUnit: 'NM' }],
	icaoCodes: ['LFFF'],
	isPolygon: false,
	startDate: new Date('2026-01-01T00:00:00Z'),
	endDate: null,
	permanent: true,
	estimated: false,
	qCode: 'QRPCA',
	obstacleType: '',
	serviceStatus: '',
	qualifier: null,
	fgLower: { ft: 0, ref: 'AGL', value: 0, unit: '', sfc: true },
	fgUpper: { ft: 3000, ref: 'AMSL', value: 3000, unit: 'ft' },
	replaces: null,
};

const wp = (id: string, lat: number): Waypoint => ({ id, lat, lon: 2, kind: 'free', alt: 1500, altAuto: true });

// North along the 2E meridian, 48N to 49N (about 60 NM), level at 1500 ft.
const SRC: ProfileOverlaySource = {
	enough: () => true,
	pts: () => [
		{ lat: 48, lon: 2 },
		{ lat: 49, lon: 2 },
	],
	cumNM: () => [0, 60],
	bandWaypoints: () => [wp('a', 48), wp('b', 49)],
	terrain: () => [
		{ distNM: 0, elevFt: 300 },
		{ distNM: 60, elevFt: 300 },
	],
	corridorBands: () => [],
	placedBands: () => [],
	pathVertices: () => [
		{ distNM: 0, altFt: 1500 },
		{ distNM: 60, altFt: 1500 },
	],
	vfr: () => true,
	verdictWindow: () => verdict,
};

/** The window the strip judges: the planned flight's, set per case. */
let verdict = { from: Date.now(), to: Date.now() + 3_600_000 };

const rows = (cx: { key: string; forbidden: boolean }[]) => cx.map((c) => [c.key, c.forbidden]);

describe('the crossings strip ignores the NOTAMs layer toggle', () => {
	afterEach(() => {
		notamState.notams = [];
		profileLayers.notams = true;
	});

	it('keeps the NOTAM NO-GO row with the layer off', () => {
		notamState.notams = [RP];
		profileLayers.notams = false;
		const { overlays, stop } = mountOverlays(SRC);
		expect(overlays.profileNotamBands).toBeNull();
		expect(rows(overlays.crossings)).toEqual([[`notam:${RP.id}`, true]]);
		stop();
	});

	it('reads the same strip whichever way the toggle stands', () => {
		notamState.notams = [RP];
		profileLayers.notams = true;
		const { overlays, stop } = mountOverlays(SRC);
		const on = rows(overlays.crossings);
		expect(overlays.profileNotamBands?.map((b) => b.key)).toEqual([`notam:${RP.id}`]);
		profileLayers.notams = false;
		flushSync();
		expect(overlays.profileNotamBands).toBeNull();
		expect(rows(overlays.crossings)).toEqual(on);
		stop();
	});
});

describe('the crossings strip ignores the list filters and the viewing period', () => {
	const H = 3_600_000;
	afterEach(() => {
		notamState.notams = [];
		filter.query = '';
		filter.window.horizonH = null;
		verdict = { from: Date.now(), to: Date.now() + H };
	});

	it('keeps the NO-GO row a search hides from the chart', () => {
		notamState.notams = [RP];
		filter.query = 'nothing matches this';
		const { overlays, stop } = mountOverlays(SRC);
		expect(overlays.profileNotamBands).toBeNull();
		expect(rows(overlays.crossings)).toEqual([[`notam:${RP.id}`, true]]);
		stop();
	});

	it('keeps the NO-GO row of a flight past the look-ahead', () => {
		// In force tomorrow from 08:00 for eight hours. The map reads the
		// next six hours, and the flight is tomorrow.
		const start = Date.now() + 24 * H;
		const tomorrow = { ...RP, startDate: new Date(start), endDate: new Date(start + 8 * H), permanent: false };
		notamState.notams = [tomorrow];
		filter.window.horizonH = 6;
		verdict = { from: start + H, to: start + 4 * H };
		const { overlays, stop } = mountOverlays(SRC);
		expect(overlays.profileNotamBands).toBeNull();
		expect(rows(overlays.crossings)).toEqual([[`notam:${RP.id}`, true]]);
		// Over a flight before it starts, there is nothing to cross.
		verdict = { from: Date.now(), to: Date.now() + H };
		const { overlays: before, stop: stop2 } = mountOverlays(SRC);
		expect(rows(before.crossings)).toEqual([]);
		stop();
		stop2();
	});
});

describe('the crossings strip during a recording', () => {
	it('is rebuilt only when what the briefing leaves unknown changes, never per fix', () => {
		// The verdict behind activityUnknown re-runs with each fix: a read
		// of a state that changes while its answer stays the same.
		const src: ProfileOverlaySource = {
			...SRC,
			activityUnknown: () => ({ notam: fake.reasons.length > 1, rtba: false }),
		};
		fake.reasons = [];
		const { overlays, stop } = mountOverlays(src);
		const before = overlays.crossings;
		fake.reasons = [];
		flushSync();
		expect(overlays.crossings).toBe(before);
		stop();
	});
});

describe('the crossings strip judges each crossing at the time it is flown', () => {
	const H = 3_600_000;
	afterEach(() => {
		notamState.notams = [];
		verdict = { from: Date.now(), to: Date.now() + H };
	});

	it('reads the prohibition at the crossing by the source’s clock', () => {
		// In force tomorrow for eight hours, the verdict window around its start.
		const start = Date.now() + 24 * H;
		notamState.notams = [{ ...RP, startDate: new Date(start), endDate: new Date(start + 8 * H), permanent: false }];
		verdict = { from: start - 4 * H, to: start + 4 * H };
		const at = (departure: number) => (nm: number) => departure + (nm / 100) * H;
		const whole = mountOverlays(SRC);
		// At 100 kt the circle, 28 to 32 NM out, is crossed 17 to 19 min after
		// the departure: three hours early it is clear, an hour in it is not.
		const early = mountOverlays({ ...SRC, crossingClock: () => at(start - 3 * H) });
		const late = mountOverlays({ ...SRC, crossingClock: () => at(start + H) });
		expect(rows(whole.overlays.crossings)).toEqual([[`notam:${RP.id}`, true]]);
		expect(rows(early.overlays.crossings)).toEqual([[`notam:${RP.id}`, false]]);
		expect(rows(late.overlays.crossings)).toEqual([[`notam:${RP.id}`, true]]);
		whole.stop();
		early.stop();
		late.stop();
	});
});

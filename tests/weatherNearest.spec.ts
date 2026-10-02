/* The nearest-station half of the live-weather session cache
 * (src/lib/state/weather.svelte.ts): what counts as an observation the
 * flight-prep grid may compute from (usableNearest), what a failed refresh
 * does to the one it holds, and the print prefetch's adopt. These records
 * feed printed performance figures, so "no observation" and "the request
 * failed" have to stay different answers. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	adoptNearestMetar,
	ensureNearestMetar,
	nearestWx,
	refreshWeather,
	usableNearest,
	weatherState,
	type NearestWx,
} from '$lib/state/weather.svelte';
import type { AwcMetar } from '$lib/weather/awc';

const NOW = Date.UTC(2026, 7, 18, 20, 0, 0);
/** Toussus, the anchor every case measures from. */
const LFPN = { lat: 48.752, lon: 2.114 };

function metar(over: Partial<AwcMetar> = {}): AwcMetar {
	return {
		icaoId: 'LFPN',
		obsTime: NOW / 1000 - 30 * 60,
		rawOb: 'METAR LFPN 181930Z AUTO 28007KT CAVOK 24/17 Q1013 NOSIG',
		lat: 48.752,
		lon: 2.114,
		altim: 1013,
		temp: 24,
		wdir: 280,
		wspd: 7,
		...over,
	};
}

function record(over: Partial<NearestWx> = {}): NearestWx {
	return { status: 'ok', metar: metar(), distanceM: 0, fetchedAt: NOW, ...over };
}

/** The /wx duck-typed response the awc client reads (ok + text()). */
function bbox(rows: AwcMetar[]): unknown {
	return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(rows)) };
}

beforeEach(() => {
	weatherState.nearest = {};
	weatherState.byIdent = {};
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('usableNearest', () => {
	it('takes the observation when it is close enough and fresh enough', () => {
		expect(usableNearest(record(), NOW)).toEqual({ metar: metar(), distanceM: 0 });
	});

	it('reads a missing record, a station-less record and a missing distance as no observation', () => {
		expect(usableNearest(null, NOW)).toBeNull();
		expect(usableNearest(record({ metar: null }), NOW)).toBeNull();
		expect(usableNearest(record({ distanceM: null }), NOW)).toBeNull();
	});

	it('drops a station beyond 50 NM and an observation beyond 3 h', () => {
		expect(usableNearest(record({ distanceM: 94_000 }), NOW)).toBeNull();
		expect(usableNearest(record({ distanceM: 92_000 }), NOW)).not.toBeNull();
		expect(usableNearest(record({ metar: metar({ obsTime: NOW / 1000 - 181 * 60 }) }), NOW)).toBeNull();
	});

	it('ignores the fetch status: a refresh in flight or one that failed keeps its observation', () => {
		// The whole point: gating on the status is what reverted a printed
		// performance grid to ISA for the length of a TTL refetch.
		expect(usableNearest(record({ status: 'loading' }), NOW)).not.toBeNull();
		expect(usableNearest(record({ status: 'error' }), NOW)).not.toBeNull();
	});
});

describe('a failed refresh', () => {
	it('keeps the observation it had and says the refresh failed', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(bbox([metar()])));
		ensureNearestMetar('LFPN', LFPN.lat, LFPN.lon);
		await vi.waitFor(() => expect(nearestWx('LFPN')?.status).toBe('ok'));
		expect(nearestWx('LFPN')?.metar?.icaoId).toBe('LFPN');

		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('502')));
		refreshWeather();
		await vi.waitFor(() => expect(nearestWx('LFPN')?.status).toBe('error'));
		expect(nearestWx('LFPN')?.metar?.rawOb).toContain('Q1013');
		expect(usableNearest(nearestWx('LFPN'), NOW)).not.toBeNull();
	});
});

describe('adoptNearestMetar', () => {
	it('records the pick as a fresh lookup, so the print document does not refetch it', () => {
		const pick = { metar: metar(), distanceM: 1200 };
		adoptNearestMetar('LFPN', LFPN.lat, LFPN.lon, pick, Date.now());
		expect(nearestWx('LFPN')).toMatchObject({ status: 'ok', metar: pick.metar, distanceM: 1200 });

		const fetchMock = vi.fn().mockResolvedValue(bbox([metar()]));
		vi.stubGlobal('fetch', fetchMock);
		ensureNearestMetar('LFPN', LFPN.lat, LFPN.lon);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('records an empty pick when nothing better is held', () => {
		adoptNearestMetar('LFXX', 45, 3, null, Date.now());
		expect(nearestWx('LFXX')).toMatchObject({ status: 'ok', metar: null, distanceM: null });
	});

	it('never deletes a usable observation with an empty pick', () => {
		// The whole case runs on the fixture clock: the held observation is
		// 30 min old AT the adopt instant. Judging it at the real Date.now()
		// let the wall clock age it past the 3 h window, a time bomb that
		// went off hours after the spec landed.
		weatherState.nearest.LFPN = record();
		adoptNearestMetar('LFPN', LFPN.lat, LFPN.lon, null, NOW);
		expect(nearestWx('LFPN')?.metar?.icaoId).toBe('LFPN');
	});

	it('anchors the ident, so the refresh buttons still cover it', async () => {
		adoptNearestMetar('LFPN', LFPN.lat, LFPN.lon, { metar: metar(), distanceM: 0 }, Date.now());
		const fetchMock = vi.fn().mockResolvedValue(bbox([metar({ altim: 1008, temp: 19 })]));
		vi.stubGlobal('fetch', fetchMock);
		refreshWeather();
		await vi.waitFor(() => expect(nearestWx('LFPN')?.metar?.altim).toBe(1008));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

/* One SOFIA PIB per route and day (sofia/fetch.ts): a narrow-route PIB
 * covers 23 h 59 from its departure, so a window longer than that is asked
 * as a chain of PIBs, each departing where the one before ends, three days
 * at most. The briefing is stamped with the days every landed route got, and
 * a route missing a day reads as lost. SOFIA is stubbed at the network. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SofiaNotam } from '$lib/sofia/client';

vi.mock('$lib/state/data.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/state/data.svelte')>()),
	ensureAirports: () => Promise.resolve([]),
	ensureAirspaces: () => Promise.resolve([]),
}));

const { SOFIA_DURATION_MS } = await import('$lib/sofia/client');
const { SOFIA_MAX_DAYS, briefFromSofia, fetchAerodromeFromSofia, sofiaDays } = await import('$lib/sofia/fetch');
const { clearNotams, notamState } = await import('$lib/state/notam.svelte');
const { autorouter } = await import('$lib/autorouter/state.svelte');
const { sofia } = await import('$lib/sofia/state.svelte');

const H = 3_600_000;
const D = SOFIA_DURATION_MS;
const T = Date.UTC(2026, 10, 24, 9, 0);
const DEP = Date.UTC(2026, 10, 25, 6, 30);

function record(number: number): SofiaNotam {
	return {
		id: `S${number}`,
		series: 'W',
		number,
		year: 26,
		type: 'N',
		qLine: { fir: 'LFFF', code23: 'WP', code45: 'LW', traffic: 'IV', purpose: 'BO', scope: 'W', lower: 0, upper: 115 },
		coordinates: '4826N00209E',
		radius: 3,
		itemA: 'LFFF',
		startValidity: '2026-01-01T00:00:00Z',
		endValidity: 'PERM',
		itemE: `PJE ${number}.`,
	};
}

/** Every PIB asked: its first token and departure. `answer` gives each its
 *  NOTAMs, a 429 for null. */
let asked: { token: string; departure: number }[] = [];
let answer: (token: string, day: number) => SofiaNotam[] | null = () => [];
function departureOf(body: URLSearchParams): number {
	const d = /^(\d\d)-(\d\d)-(\d{4})$/.exec(body.get('departure_date') ?? '');
	const t = /^(\d\d)(\d\d)$/.exec(body.get('departure_time') ?? '');
	return d && t ? Date.UTC(+d[3], +d[2] - 1, +d[1], +t[1], +t[2]) : NaN;
}
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T);
	clearNotams();
	asked = [];
	answer = () => [];
	autorouter.proxyUrl = 'https://proxy.test';
	vi.stubGlobal(
		'fetch',
		vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			if (url.endsWith('/sofia/session')) {
				return Promise.resolve(new Response(JSON.stringify({ session: 'S1' })));
			}
			const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
			const token = body.getAll('route[]')[0] ?? '';
			const departure = departureOf(body);
			asked.push({ token, departure });
			const day = Math.round((departure - DEP) / D);
			const list = answer(token, day);
			if (list === null) {
				return Promise.resolve(new Response('busy', { status: 429 }));
			}
			const status = JSON.stringify({ nbNotams: list.length, listnotams: { Other: { g: list } } });
			return Promise.resolve(new Response(JSON.stringify({ 'status.message': status })));
		}),
	);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const track = (from: string, to: string) => ({
	label: `${from}-${to}`,
	points: [
		{ token: from, aerodrome: true },
		{ token: to, aerodrome: true },
	],
	path: [
		{ lat: 48.75, lon: 2.1 },
		{ lat: 47.9, lon: 2.16 },
	],
});
const brief = (tracks: ReturnType<typeof track>[], to: number) =>
	briefFromSofia(tracks, { widthNM: 15, window: { from: DEP, to }, kind: 'route', aim: 'flight' });

describe('how many days', () => {
	it('asks one PIB a day to the window’s end, three at most, one for an open window', () => {
		expect(sofiaDays(DEP, DEP + 23 * H)).toBe(1);
		// A whole day runs a minute past 23 h 59, which the verdict allows.
		expect(sofiaDays(DEP, DEP + 24 * H - 1)).toBe(1);
		expect(sofiaDays(DEP, DEP + 24 * H + 60_000)).toBe(2);
		expect(sofiaDays(DEP, DEP + 26 * H)).toBe(2);
		expect(sofiaDays(DEP, DEP + 6 * 24 * H)).toBe(SOFIA_MAX_DAYS);
		expect(SOFIA_MAX_DAYS).toBe(3);
		expect(sofiaDays(DEP, Infinity)).toBe(1);
	});
});

describe('a window longer than a day', () => {
	it('chains the PIBs, merges their NOTAMs, and stamps the days covered', async () => {
		answer = (_t, day) => (day === 0 ? [record(1), record(2)] : [record(2), record(3)]);
		expect(await brief([track('LFPN', 'LFOZ')], DEP + 40 * H)).toBe('committed');
		expect(asked).toEqual([
			{ token: 'LFPN', departure: DEP },
			{ token: 'LFPN', departure: DEP + D },
		]);
		expect(notamState.notams.map((n) => n.id).sort()).toEqual(['W0001/26', 'W0002/26', 'W0003/26']);
		expect(notamState.lastFetch?.briefed).toEqual({ from: DEP, to: DEP + 2 * D });
	}, 20_000);

	it('counts a route missing a day as lost, keeping what its other days brought', async () => {
		answer = (token, day) => (token === 'LFOZ' && day === 1 ? null : [record(token === 'LFPN' ? 10 + day : 20 + day)]);
		expect(await brief([track('LFPN', 'LFOZ'), track('LFOZ', 'LFOQ')], DEP + 40 * H)).toBe('committed');
		const asks = notamState.lastFetch?.asked;
		expect(asks?.region.kind === 'tracks' && asks.region.tracks.map((tr) => tr.landed)).toEqual([true, false]);
		expect(notamState.gaps?.routes.map((g) => g.label)).toEqual(['LFOZ-LFOQ']);
		expect(notamState.lastFetch?.briefed).toEqual({ from: DEP, to: DEP + 2 * D });
		expect(notamState.notams.map((n) => n.id).sort()).toEqual(['W0010/26', 'W0011/26', 'W0020/26']);
	}, 30_000);

	it('commits nothing when no route landed, whatever days came back', async () => {
		answer = (_t, day) => (day === 1 ? null : [record(1)]);
		expect(await brief([track('LFPN', 'LFOZ')], DEP + 40 * H)).toBe('failed');
		expect(notamState.notams).toEqual([]);
		expect(notamState.lastFetch).toBeNull();
		expect(sofia.error).not.toBeNull();
	}, 20_000);

	it('asks a day’s PIB alone for a flight within one', async () => {
		answer = () => [record(1)];
		expect(await brief([track('LFPN', 'LFOZ')], DEP + 5 * H)).toBe('committed');
		expect(asked.map((a) => a.departure)).toEqual([DEP]);
		expect(notamState.lastFetch?.briefed).toEqual({ from: DEP, to: DEP + D });
	});
});

describe('an aerodrome fetched by name', () => {
	it('is asked one PIB a day too, its NOTAMs merged and its span the days asked', async () => {
		answer = (_t, day) => [{ ...record(day + 1), itemA: 'LFOQ' }];
		const got = await fetchAerodromeFromSofia('LFOQ', DEP, new AbortController().signal, undefined, DEP + 40 * H);
		expect(asked).toEqual([
			{ token: 'LFOQ', departure: DEP },
			{ token: 'LFOQ', departure: DEP + D },
		]);
		expect(got.answer.length).toBe(2);
		expect(got.briefed).toEqual({ from: DEP, to: DEP + 2 * D });
	}, 20_000);
});

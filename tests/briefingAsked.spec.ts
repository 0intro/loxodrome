/* A briefing records what it was asked for (FetchProvenance.asked): the
 * route tracks, whether each landed, the half-width its answer covers
 * around them, and the time it aimed at. A SOFIA briefing kept only its
 * period and its lost routes, so a route edited after the fetch still read
 * as briefed. And a bulletin loaded by hand says so (notamState.byHand),
 * the one thing that can be judged of it being its age. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SofiaNotam } from '$lib/sofia/client';

vi.mock('$lib/state/data.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/state/data.svelte')>()),
	ensureAirports: () => Promise.resolve([]),
	ensureAirspaces: () => Promise.resolve([]),
	ensureNavaids: () => Promise.resolve([]),
}));
vi.mock('$lib/autorouter/viewport', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/autorouter/viewport')>()),
	routeIcaos: () => ({ airports: ['LFPN'], firs: ['LFFF'], overCap: false }),
}));

const { aerodromeBriefed, amendBriefing, clearNotams, commitBriefing, notamState, parseInput } = await import(
	'$lib/state/notam.svelte'
);
const { fetchRouteNotamsFromSofia } = await import('$lib/state/routeNotamFetch');
const { fetchNotamsForRoute } = await import('$lib/autorouter/fetch');
const { autorouter } = await import('$lib/autorouter/state.svelte');
const { routes, routeSettings } = await import('$lib/state/route.svelte');
const { filter, setWindowMode } = await import('$lib/state/filter.svelte');
import type { Route, Waypoint } from '$lib/state/route.svelte';

const PROXY = 'https://proxy.test';

const wp = (id: string, lat: number, lon: number, ident?: string): Waypoint =>
	({ id, lat, lon, kind: ident ? 'airport' : 'free', ident, alt: 2500, altAuto: true }) as unknown as Waypoint;
const route = (id: string, waypoints: Waypoint[]): Route => ({ id, name: null, waypoints, selectedWaypointId: null });

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
		itemE: 'PJE WI 3NM ETAMPES.',
	};
}

function serve(handler: (url: string) => Response): void {
	vi.stubGlobal(
		'fetch',
		vi.fn((input: RequestInfo | URL) =>
			Promise.resolve(handler(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)),
		),
	);
}

const proxyUrl = autorouter.proxyUrl;
const radius = routeSettings.corridorRadiusNM;

beforeEach(() => {
	clearNotams();
	autorouter.proxyUrl = PROXY;
	routeSettings.corridorRadiusNM = 15;
	setWindowMode('now');
});

afterEach(() => {
	vi.unstubAllGlobals();
	autorouter.proxyUrl = proxyUrl;
	routeSettings.corridorRadiusNM = radius;
	routes.list = [];
	filter.query = '';
});

describe('a SOFIA briefing records the tracks it asked', () => {
	it('each with its path and whether it landed, and the width it covers', async () => {
		routes.list = [
			route('r1', [wp('a', 48.75, 2.11, 'LFPN'), wp('b', 47.9, 2.16, 'LFOZ')]),
			// No aerodrome to anchor on: SOFIA is never asked, the route is lost.
			route('r2', [wp('c', 48.5, 2.5), wp('d', 48.2, 2.9)]),
		];
		serve((url) =>
			url.endsWith('/sofia/session')
				? new Response(JSON.stringify({ session: 'S1' }))
				: new Response(
						JSON.stringify({
							'status.message': JSON.stringify({ nbNotams: 1, listnotams: { Other: { g: [record(3001)] } } }),
						}),
					),
		);
		await fetchRouteNotamsFromSofia();
		const asked = notamState.lastFetch?.asked;
		expect(asked?.aim).toBe('flight');
		expect(asked?.region.kind).toBe('tracks');
		if (asked?.region.kind !== 'tracks') {
			throw new Error('no tracks recorded');
		}
		expect(asked.region.tracks.map((t) => [t.label, t.landed, t.path.length, t.ends])).toEqual([
			['LFPN-LFOZ', true, 2, ['LFPN', 'LFOZ']],
			['?', false, 2, []],
		]);
		// 16 NM asked (15 rounded up, plus the token's minute), 0.7 of it the
		// rounding of a coordinate token.
		expect(asked.region.halfWidthNM).toBeCloseTo(15.3, 6);
	});

	it('names the first and last aerodrome of a track, the ones SOFIA briefs whole', async () => {
		routes.list = [
			route('r1', [
				wp('x', 48.9, 2.0),
				wp('a', 48.75, 2.11, 'LFPN'),
				wp('m', 48.38, 2.08, 'LFOX'),
				wp('b', 47.9, 2.16, 'LFOZ'),
				wp('y', 47.7, 2.2),
			]),
		];
		serve((url) =>
			url.endsWith('/sofia/session')
				? new Response(JSON.stringify({ session: 'S1' }))
				: new Response(JSON.stringify({ 'status.message': JSON.stringify({ nbNotams: 0, listnotams: {} }) })),
		);
		await fetchRouteNotamsFromSofia();
		const region = notamState.lastFetch?.asked?.region;
		expect(region?.kind === 'tracks' ? region.tracks.map((t) => t.ends) : null).toEqual([['LFPN', 'LFOZ']]);
	});

	it('aims at the period a typed custom range names', async () => {
		routes.list = [route('r1', [wp('a', 48.75, 2.11, 'LFPN'), wp('b', 47.9, 2.16, 'LFOZ')])];
		filter.window.fromDate = '2099-01-01';
		filter.window.fromTime = '08:00';
		filter.window.toDate = '2099-01-01';
		filter.window.toTime = '18:00';
		setWindowMode('custom');
		serve((url) =>
			url.endsWith('/sofia/session')
				? new Response(JSON.stringify({ session: 'S1' }))
				: new Response(JSON.stringify({ 'status.message': JSON.stringify({ nbNotams: 0, listnotams: {} }) })),
		);
		await fetchRouteNotamsFromSofia();
		expect(notamState.lastFetch?.asked?.aim).toBe('period');
	});
});

describe('an autorouter route fetch records its corridor', () => {
	it('every route landed, at the corridor it selected from', async () => {
		routes.list = [route('r1', [wp('a', 48.75, 2.11, 'LFPN'), wp('b', 47.9, 2.16, 'LFOZ')])];
		serve(() => new Response(JSON.stringify({ total: 0, rows: [] })));
		await fetchNotamsForRoute();
		const asked = notamState.lastFetch?.asked;
		if (asked?.region.kind !== 'tracks') {
			throw new Error('no tracks recorded');
		}
		expect(asked.region.halfWidthNM).toBe(15);
		// Its corridor carries every aerodrome inside it.
		expect(asked.region.tracks.map((t) => [t.label, t.landed, t.ends])).toEqual([['LFPN-LFOZ', true, null]]);
	});
});

describe('a bulletin loaded by hand says so', () => {
	const TEXT = `W0001/26 NOTAMN
Q) LFFF/QWPLW/IV/BO/W/000/115/4826N00209E003
A) LFFF B) 2601010000 C) PERM
E) PJE WI 3NM ETAMPES.
`;

	it('from its parse, kept by a re-parse and an aerodrome fetch, gone with a fetch', () => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.UTC(2026, 10, 24, 9, 30));
		try {
			notamState.rawText = TEXT;
			parseInput();
			expect(notamState.byHand).toEqual({ at: Date.UTC(2026, 10, 24, 9, 30) });
			parseInput({ reparse: true });
			expect(notamState.byHand).toEqual({ at: Date.UTC(2026, 10, 24, 9, 30) });
			amendBriefing('LFPN', [], { source: 'sofia', at: Date.now(), briefed: { from: 0, to: 1 } }, () => null);
			expect(notamState.byHand).not.toBeNull();
			commitBriefing(TEXT, { source: 'sofia', kind: 'route', briefed: null });
			expect(notamState.byHand).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('only when it holds NOTAMs, and never past a Clear', () => {
		notamState.rawText = 'not a notam';
		parseInput();
		expect(notamState.byHand).toBeNull();
		notamState.rawText = TEXT;
		parseInput();
		expect(notamState.byHand).not.toBeNull();
		clearNotams();
		expect(notamState.byHand).toBeNull();
	});
});

describe('aerodromes fetched by name alone', () => {
	it('hold their own fields, and no other', () => {
		clearNotams();
		amendBriefing('LFOZ', [], { source: 'sofia', at: Date.now(), briefed: { from: Date.now(), to: Date.now() + 86_340_000 } }, () => true);
		expect(notamState.lastFetch).toBeNull();
		expect(aerodromeBriefed({ ident: 'LFOZ', lat: 47.897, lon: 2.163 })).toBe('full');
		expect(aerodromeBriefed({ ident: 'LFPN', lat: 48.752, lon: 2.106 })).toBe('none');
		clearNotams();
		expect(aerodromeBriefed({ ident: 'LFPN', lat: 48.752, lon: 2.106 })).toBeNull();
	});
});

import { afterEach, describe, it, expect, vi } from 'vitest';
import { rowToIcaoText, type AutorouterRow } from '$lib/autorouter/client';
import {
	fetchAerodromeFromAutorouter,
	fetchNotamsForIdents,
	fetchNotamsForRoute,
	fetchNotamsForViewport,
} from '$lib/autorouter/fetch';
import { autorouter } from '$lib/autorouter/state.svelte';
import { parseNotams } from '$lib/notam/parser';
import { mapState } from '$lib/state/map.svelte';
import { clearNotams, notamState } from '$lib/state/notam.svelte';
import { routes } from '$lib/state/route.svelte';

// The reference datasets the tab fetches place their idents with: two
// aerodromes and no airspaces, so no FIR joins the request, answered at
// once instead of read from /data/.
const { AIRPORTS } = vi.hoisted(() => ({
	AIRPORTS: [
		{ ident: 'LFPN', type: 'small_airport', lat: 48.7519, lon: 2.1061 },
		{ ident: 'LFPO', type: 'large_airport', lat: 48.7253, lon: 2.3594 },
	],
}));
vi.mock('$lib/state/data.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/state/data.svelte')>();
	return {
		...real,
		ensureAirports: () => Promise.resolve(AIRPORTS),
		ensureAirspaces: () => Promise.resolve([]),
		ensureNavaids: () => Promise.resolve([]),
		getAirports: () => AIRPORTS,
		getAirspaces: () => [],
		airportByIdent: (ident: string) => AIRPORTS.find((a) => a.ident === ident.toUpperCase()) ?? null,
	};
});

// autorouter encodes lat/lon as Garmin int32 (×90 / 2^30). The tests build
// rows in the same format so the reconstruction is exercised end-to-end.
const degToGarmin = (d: number): number => Math.round((d * 0x40000000) / 90);

describe('rowToIcaoText', () => {
	it('reconstructs an ICAO-format NOTAM block from a typical row', () => {
		const text = rowToIcaoText({
			series: 'A',
			number: 234,
			year: 2026,
			code23: 'OB',
			code45: 'CE',
			fir: 'LFFF',
			traffic: 'IV',
			purpose: 'M ',  // trailing space in autorouter's actual shape
			scope: 'AE',
			lower: 0,
			upper: 50,
			lat: degToGarmin(49.5),
			lon: degToGarmin(2.5),
			radius: 5,
			itema: ['LFPG'],
			itemd: 'DAILY 0800-1700',
			iteme: 'CRANE ERECTED',
			itemf: 'GND',
			itemg: '500FT AGL',
			startvalidity: 1779456000,
			endvalidity: 1782048000,
		});
		// The id and its type on their own line, then Q) line with the
		// leading Q prepended, then A) / B) / C) / D) / E) / F) / G) in order.
		expect(text.split('\n')[0]).toBe('A0234/26 NOTAMN');
		expect(text).toMatch(/^A0234\/26 NOTAMN\nQ\) LFFF\/QOBCE\/IV\/M\/AE\/000\/050\/4930N00230E005/);
		expect(text).toContain('A) LFPG');
		expect(text).toContain('D) DAILY 0800-1700');
		expect(text).toContain('E) CRANE ERECTED');
		expect(text).toContain('F) GND');
		expect(text).toContain('G) 500FT AGL');
	});

	it('round-trips through parseNotams into a complete Notam', () => {
		const text = rowToIcaoText({
			series: 'A',
			number: 234,
			year: 2026,
			code23: 'OB',
			code45: 'CE',
			fir: 'LFFF',
			traffic: 'IV',
			purpose: 'M',
			scope: 'AE',
			lower: 0,
			upper: 50,
			lat: degToGarmin(49.5),
			lon: degToGarmin(2.5),
			radius: 5,
			itema: ['LFPG'],
			iteme: 'CRANE ERECTED NEAR THE FIELD',
			startvalidity: 1779456000,
			endvalidity: 1782048000,
		});
		const [n] = parseNotams(text);
		expect(n.id).toBe('A0234/26');
		expect(n.qCode).toBe('QOBCE');
		expect(n.qualifier?.fir).toBe('LFFF');
		expect(n.qualifier?.traffic).toBe('IV');
		expect(n.qualifier?.scope).toBe('AE');
		expect(n.qualifier?.lower).toBe(0);
		expect(n.qualifier?.upper).toBe(50);
		expect(n.qualifier?.lat).toBeCloseTo(49.5, 1);
		expect(n.qualifier?.lon).toBeCloseTo(2.5, 1);
		expect(n.qualifier?.radius).toBe(5);
		expect(n.icaoCodes).toEqual(['LFPG']);
		expect(n.startDate?.toISOString()).toBe('2026-05-22T13:20:00.000Z');
		expect(n.obstacleType).toBe('crane');
	});

	it('accepts itema and fir as arrays (the real autorouter shape)', () => {
		const text = rowToIcaoText({
			itema: ['LFPG', 'LFPB'],
			fir: ['LFFF'],
			code23: 'OB',
			code45: 'CE',
			scope: 'A',
			lat: degToGarmin(49.0),
			lon: degToGarmin(2.5),
			radius: 5,
			iteme: 'CRANE',
		});
		expect(text).toContain('A) LFPG LFPB');
		expect(text).toMatch(/Q\) LFFF\//);
	});

	it('formats a permanent NOTAM with C) PERM', () => {
		const text = rowToIcaoText({
			series: 'C',
			number: 1,
			year: 26,
			code23: 'OB',
			code45: 'CE',
			fir: 'LFFF',
			lat: degToGarmin(48),
			lon: degToGarmin(2),
			startvalidity: 1779456000,
			endvalidity: 2147483647,
			iteme: 'PERMANENT CLOSURE',
		});
		expect(text).toContain('C) PERM');
		expect(text).not.toContain('3801190314');
	});

	// The row shape of the API: type and referred* name the NOTAM a NOTAMR
	// replaces, estimation is 'EST' or null, and the year comes in two digits.
	const base: AutorouterRow = {
		series: 'A',
		number: 112,
		year: 26,
		code23: 'MR',
		code45: 'LC',
		fir: 'LFFF',
		traffic: 'IV',
		purpose: 'NBO ',
		scope: 'A  ',
		lower: 0,
		upper: 999,
		lat: degToGarmin(49),
		lon: degToGarmin(2.5),
		radius: 5,
		itema: ['LFPG'],
		iteme: 'RWY 09L/27R CLSD',
		startvalidity: 1779456000,
		endvalidity: 1782048000,
	};

	it('names the NOTAM a NOTAMR replaces', () => {
		const text = rowToIcaoText({ ...base, type: 'R', referredseries: 'A', referrednumber: 89, referredyear: 26 });
		expect(text.split('\n')[0]).toBe('A0112/26 NOTAMR A0089/26');
		expect(parseNotams(text)[0].replaces).toBe('A0089/26');
	});

	it('leaves a NOTAMC out of the briefing', () => {
		// A briefing holds the NOTAMs in force, and a NOTAMC cancels one.
		expect(
			rowToIcaoText({ ...base, type: 'C', referredseries: 'A', referrednumber: 89, referredyear: 26 }),
		).toBe('');
	});

	it('joins EST to an estimated item C', () => {
		const text = rowToIcaoText({ ...base, type: 'N', estimation: 'EST' });
		expect(text).toContain('B) 2605221320 C) 2606211320EST\n');
		expect(rowToIcaoText({ ...base, type: 'N', estimation: null })).toContain('C) 2606211320\n');
	});

	it('writes a year of one digit in two', () => {
		expect(rowToIcaoText({ ...base, type: 'N', year: 7 }).split('\n')[0]).toBe('A0112/07 NOTAMN');
	});

	it('returns the empty string for a row without enough data to form a Q-line', () => {
		// No coordinates, no FIR; nothing the parser can do with this row.
		expect(rowToIcaoText({})).toBe('');
	});

	it('matches the wiki example coordinates (Stuttgart EDDS, Garmin format)', () => {
		const text = rowToIcaoText({
			itema: ['EDDS'],
			fir: 'EDGG',
			code23: 'FA',
			code45: 'LT',
			lat: 580814790,
			lon: 109959116,
			radius: 5,
			iteme: 'MIL SIDE NO TRANSIENT ALERT AVBL',
		});
		// EDDS sits at ~(48.69, 9.22); Q-line reconstruction should reflect.
		expect(text).toMatch(/Q\) EDGG\/QFALT\/.*4841N00913E005/);
	});

	it('uses the Q-line for an en-route NOTAM with no E-section coordinates (blue marker)', () => {
		// Real-world: F0710/26; Le Mans trigger NOTAM. The E section has no
		// parseable PSN, so the parser falls back to the Q-line position and
		// tags it qualifierLine (blue).
		const text = rowToIcaoText({
			series: 'F',
			number: 710,
			year: 26,
			itema: ['LFFF', 'LFRR'],
			fir: 'LFXX',
			code23: 'AT',
			code45: 'TT',
			scope: 'E',
			traffic: 'IV',
			purpose: 'BO',
			lower: 0,
			upper: 115,
			lat: degToGarmin(47.93),
			lon: degToGarmin(-0.20),
			radius: 39,
			iteme: 'TRIGGER NOTAM - AIRAC AIP SUP 072/26.',
		});
		const [n] = parseNotams(text);
		expect(n.coordinates).toHaveLength(1);
		expect(n.coordinates[0].type).toBe('qualifierLine');
	});

	it('promotes a NOTAM to a PSN marker when the E section has parseable coordinates', () => {
		// Simulates an obstacle NOTAM that includes a DMS coordinate in
		// the comment. parseNotams should pick that as the authoritative
		// position and tag the coord 'psn' (red).
		const text = rowToIcaoText({
			series: 'B',
			number: 100,
			year: 26,
			itema: ['LFPG'],
			fir: 'LFFF',
			code23: 'OB',
			code45: 'CE',
			scope: 'A',
			lat: degToGarmin(49.0),
			lon: degToGarmin(2.5),
			radius: 5,
			iteme: 'CRANE ERECTED PSN 490230N 0023045E HEIGHT 50M',
		});
		const [n] = parseNotams(text);
		expect(n.coordinates.length).toBeGreaterThanOrEqual(1);
		expect(n.coordinates[0].type).toBe('psn');
	});
});

describe('the /notam paging', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** A NOTAM filed under LFPN, numbered n. */
	function row(n: number): AutorouterRow {
		return {
			series: 'A', number: n, year: 2026, code23: 'MR', code45: 'LC', fir: 'LFFF', traffic: 'IV',
			purpose: 'NBO', scope: 'A', lower: 0, upper: 999, lat: degToGarmin(48.75), lon: degToGarmin(2.11),
			radius: 5, itema: ['LFPN'], iteme: 'RWY 07/25 CLSD.', startvalidity: 1767225600, endvalidity: 2147483647,
		};
	}

	/** Answer every page of a /notam request from `total` rows, as autorouter
	 *  does: `total` stated on each page, `limit` rows from `offset`. Counts
	 *  the pages asked for. */
	function serve(total: number | undefined, rows: number): { pages: number } {
		const asked = { pages: 0 };
		vi.stubGlobal(
			'fetch',
			vi.fn((input: RequestInfo | URL) => {
				const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
				const offset = Number(u.searchParams.get('offset'));
				const limit = Number(u.searchParams.get('limit'));
				asked.pages++;
				const page = [];
				for (let i = offset; i < Math.min(offset + limit, rows); i++) {
					page.push(row(i + 1));
				}
				return Promise.resolve(
					new Response(JSON.stringify(total === undefined ? { rows: page } : { total, rows: page }), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					}),
				);
			}),
		);
		return asked;
	}

	it('pages to the total the service states, past 5000 rows', async () => {
		// A zoomed-out view puts up to 40 whole FIRs in one chunk, each a few
		// hundred NOTAMs over the 30-day window: the runaway guard stopped such
		// a chunk at 5000 rows with the stated total still ahead, and the
		// briefing committed short with nothing said.
		const asked = serve(6000, 6000);
		const { answer } = await fetchAerodromeFromAutorouter('LFPN', new AbortController().signal);
		expect(answer).toHaveLength(6000);
		expect(asked.pages).toBe(60);
	});

	it('still stops at 5000 rows when no total is stated', async () => {
		const asked = serve(undefined, 9000);
		const { answer } = await fetchAerodromeFromAutorouter('LFPN', new AbortController().signal);
		expect(answer).toHaveLength(5000);
		expect(asked.pages).toBe(50);
	});
});

describe('the window a tab fetch states', () => {
	const DAY_S = 86400;

	afterEach(() => {
		vi.unstubAllGlobals();
		clearNotams();
		routes.list = [];
		mapState.map = null;
		autorouter.error = null;
		autorouter.lastKind = null;
	});

	/** Answer every /notam request with one NOTAM filed under LFPN, and
	 *  keep the validity window each one asked for. */
	function serveWindows(): { start: number; end: number }[] {
		const asked: { start: number; end: number }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((input: RequestInfo | URL) => {
				const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
				asked.push({ start: Number(u.searchParams.get('startvalidity')), end: Number(u.searchParams.get('endvalidity')) });
				const page = Number(u.searchParams.get('offset')) === 0 ? [{
					series: 'A', number: 1, year: 2026, code23: 'MR', code45: 'LC', fir: 'LFFF', traffic: 'IV',
					purpose: 'NBO', scope: 'A', lower: 0, upper: 999, lat: degToGarmin(48.75), lon: degToGarmin(2.11),
					radius: 5, itema: ['LFPN'], iteme: 'RWY 07/25 CLSD.', startvalidity: 1767225600, endvalidity: 2147483647,
				}] : [];
				return Promise.resolve(
					new Response(JSON.stringify({ total: 1, rows: page }), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					}),
				);
			}),
		);
		return asked;
	}

	// autorouter is asked for now to 30 days on, and the briefing said it
	// covered no period at all, so the fetch view's caution never told a
	// period past day 30, or one opening before the fetch, from a whole one.
	const cases: [string, () => Promise<unknown>][] = [
		['the aerodrome list', () => fetchNotamsForIdents(['LFPN', 'LFPO'])],
		[
			'the route',
			() => {
				const wp = (id: string, lat: number, lon: number) => ({ id, lat, lon, kind: 'free' as const, alt: 3000, altAuto: true });
				routes.list = [{ id: 'r1', name: null, waypoints: [wp('a', 48.7519, 2.1061), wp('b', 48.7253, 2.3594)], selectedWaypointId: null }];
				return fetchNotamsForRoute();
			},
		],
		[
			'the view',
			() => {
				const bounds = { getSouth: () => 48.6, getNorth: () => 48.9, getWest: () => 1.9, getEast: () => 2.6 };
				mapState.map = { getBounds: () => bounds } as unknown as typeof mapState.map;
				return fetchNotamsForViewport();
			},
		],
	];

	for (const [name, run] of cases) {
		it(`is the window every request for ${name} asked for`, async () => {
			const asked = serveWindows();
			await run();
			expect(autorouter.error).toBeNull();
			expect(notamState.notams.length).toBe(1);
			expect(asked.length).toBeGreaterThan(0);
			const { start, end } = asked[0];
			expect(asked.every((w) => w.start === start && w.end === end)).toBe(true);
			expect(end - start).toBe(30 * DAY_S);
			expect(notamState.lastFetch?.briefed).toEqual({ from: start * 1000, to: end * 1000 });
		});
	}
});

describe('the viewer\u2019s aerodrome fetch', () => {
	// The record of what it asked tells the airport panel a field outside
	// the corridor, which read fully briefed (state/notam.svelte.ts
	// aerodromeBriefed).
	it('records the corridor along the named aerodromes', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve(
					new Response(JSON.stringify({ total: 0, rows: [] }), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					}),
				),
			),
		);
		await fetchNotamsForIdents(['LFPN', 'LFPO']);
		expect(autorouter.error).toBeNull();
		const { aerodromeBriefed } = await import('$lib/state/notam.svelte');
		expect(aerodromeBriefed({ ident: 'LFPO', lat: 48.7253, lon: 2.3594 })).toBe('full');
		// Villacoublay, 3 NM off the track: asked by name along it.
		expect(aerodromeBriefed({ ident: 'LFPV', lat: 48.774, lon: 2.201 })).toBe('full');
		expect(aerodromeBriefed({ ident: 'LFOK', lat: 48.776, lon: 4.184 })).toBe('none');
		await fetchNotamsForIdents(['LFPN']);
		expect(aerodromeBriefed({ ident: 'LFPN', lat: 48.7519, lon: 2.1061 })).toBe('full');
		expect(aerodromeBriefed({ ident: 'LFPO', lat: 48.7253, lon: 2.3594 })).toBe('none');
	});
});

describe('a refusal of an empty answer over a covering briefing', () => {
	it('says why', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve(
					new Response(JSON.stringify({ total: 0, rows: [] }), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					}),
				),
			),
		);
		const wp = (id: string, lat: number, lon: number) => ({ id, lat, lon, kind: 'free' as const, alt: 3000, altAuto: true });
		routes.list = [{ id: 'r1', name: null, waypoints: [wp('a', 48.7519, 2.1061), wp('b', 48.7253, 2.3594)], selectedWaypointId: null }];
		expect(await fetchNotamsForRoute({ wholeOnly: true })).toBe('refused');
		expect(autorouter.error?.()).toBe('The answer held no NOTAM, so the briefing loaded stands.');
	});
});

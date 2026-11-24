/* An "RDL .../... ARP <ident>" NOTAM is placed by whichever airport merge
 * first knows its aerodrome, in either app and whatever the map shows.
 *
 * The re-parse that places it lived in the flight app's airport-LAYER effect,
 * once: a briefing loaded with the airports layer off never re-parsed, the NOTAM
 * Viewer (whose map has no such effect) never did either, and an aerodrome only
 * a late country's overlay carries was missed even where it ran, the one shot
 * having been spent on the first merge. It is now the state's own business,
 * driven by the merge itself: the parse notes the anchors it could not place,
 * and a merge that places one re-parses, keeping the open panel.
 *
 * Real modules end to end over a served site: a baseline carrying LFPL, a
 * French overlay carrying LFZZ as well (an aerodrome no baseline has), a UK one
 * carrying EGZZ, and every other publisher's rows out of the coverage. */

import { afterAll, describe, expect, it, vi } from 'vitest';

const HEADER = {
	fields: [
		'ident', 'type', 'name', 'lat', 'lon', 'elev_ft', 'iso_country', 'municipality', 'iata',
		'runways', 'access', 'military', 'vfr', 'ifr', 'joint', 'frequencies',
	],
	runwayFields: [],
	frequencyFields: ['freq', 'unit', 'call'],
};
const row = (ident: string, lat: number, lon: number) =>
	[ident, 'small_airport', ident, lat, lon, 300, 'FR', '', '', [], null, false, true, false, false, []];

const FRANCE = [-5, 41.3, 9.6, 51.1];
const UK = [-8.2, 49.9, 1.8, 60.9];
const ELSEWHERE = [170, -80, 171, -79];
const SITE: Record<string, unknown> = {
	'/data/airports.json': { ...HEADER, rows: [row('LFPL', 48.8231, 2.6239)] },
	'/data/fr-airports.json': {
		...HEADER,
		rows: [row('LFPL', 48.8231, 2.6239), row('LFZZ', 45.5, 4.5)],
	},
	'/data/uk-airports.json': { ...HEADER, rows: [row('EGZZ', 52.5, -1.5)] },
};
const COUNTRIES = ['fr', 'uk', 'es', 'be', 'de', 'at', 'ge', 'nl', 'it', 'faa'];
for (const cc of COUNTRIES) {
	SITE[`/data/${cc}-airports.meta.json`] = {
		effective: '2026-01-01T00:00:00Z',
		bbox: cc === 'fr' ? FRANCE : cc === 'uk' ? UK : ELSEWHERE,
	};
}

vi.stubGlobal('fetch', (input: string | URL): Promise<Response> => {
	const path = typeof input === 'string' ? input : input.pathname;
	const body = SITE[path];
	return Promise.resolve(
		body === undefined
			? new Response('not found', { status: 404 })
			: new Response(JSON.stringify(body), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
	);
});
afterAll(() => {
	vi.unstubAllGlobals();
});

const { ensureAirports, extendCoverage } = await import('$lib/state/data.svelte');
const { setCoverageViewport } = await import('$lib/state/coverage.svelte');
const { notamState, parseInput } = await import('$lib/state/notam.svelte');
const { selectNotam, ui } = await import('$lib/state/ui.svelte');

const BRIEFING = `A3001/26 NOTAMN
Q) LFFF/QOBCE/IV/M/A/000/005/4849N00237E005
A) LFPL B) 2609010000 C) 2612312359
E) CRANE ERECTED RDL 194/0.25NM ARP LFPL. HGT 150FT.

A3002/26 NOTAMN
Q) LFMM/QOBCE/IV/M/A/000/005/4530N00430E005
A) LFZZ B) 2609010000 C) 2612312359
E) CRANE ERECTED RDL 090/1NM ARP LFZZ. HGT 120FT.

A3003/26 NOTAMN
Q) LFFF/QMRLC/IV/NBO/A/000/999/4849N00237E005
A) LFPL B) 2609010000 C) 2612312359
E) RWY 08/26 CLSD.

A3004/26 NOTAMN
Q) LFFF/QOBCE/IV/M/A/000/005/4700N00100E005
A) LFYY B) 2609010000 C) 2612312359
E) CRANE ERECTED RDL 270/2NM ARP LFYY. HGT 90FT.`;

/** Where the entry for this NOTAM was drawn from: its RDL anchor, or the
 *  Q-line centre it falls back to. */
function drawnFrom(id: string): string {
	const n = notamState.notams.find((x) => x.id === id);
	return n?.coordinates[0]?.original.startsWith('RDL') ? 'anchor' : 'qline';
}

describe('the airport merges place the anchors the briefing could not', () => {
	it('re-parses when a merge places one, keeping the panel, and only then', async () => {
		// Loaded before any airport: nothing can be placed yet.
		notamState.rawText = BRIEFING;
		parseInput();
		expect(drawnFrom('A3001/26')).toBe('qline');
		expect(drawnFrom('A3002/26')).toBe('qline');

		// The first merge (the baseline alone, the map having reported no view
		// yet) knows LFPL, and no map is mounted to do anything about it.
		await ensureAirports();
		expect(drawnFrom('A3001/26')).toBe('anchor');
		expect(drawnFrom('A3002/26')).toBe('qline');

		// The pilot opens the LFZZ NOTAM; France then loads late.
		selectNotam(notamState.notams.findIndex((n) => n.id === 'A3002/26'));
		setCoverageViewport({ minLat: 44, minLon: 3, maxLat: 47, maxLon: 6 });
		await extendCoverage();
		expect(drawnFrom('A3002/26')).toBe('anchor');
		expect(ui.detail?.kind === 'notam' && notamState.notams[ui.detail.index]?.id).toBe('A3002/26');

		// A merge that places nothing the briefing is waiting for leaves the
		// parse alone: LFYY is still unknown when the UK arrives. (The pause
		// makes a re-parse visible: it would stamp a later parsedAt.)
		expect(drawnFrom('A3004/26')).toBe('qline');
		const parsedAt = notamState.parsedAt;
		await new Promise((r) => setTimeout(r, 5));
		setCoverageViewport({ minLat: 51, minLon: -3, maxLat: 54, maxLon: 0 });
		await extendCoverage();
		expect(notamState.parsedAt).toBe(parsedAt);
	});
});

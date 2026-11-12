/* Pins the flights library's pure row helpers (src/lib/state/flightRows.ts):
 * the footer check-sums, the period scope and the AMC-shaped CSV mapping
 * over stored metas. The IndexedDB layer has its own harness now
 * (tests/flightsDb.spec.ts, tests/flightArchive.spec.ts); everything pure
 * is pinned here and in tests/logbook.spec.ts. Contract:
 * docs/flights-library.md. */

import { describe, expect, it } from 'vitest';
import { buildLogbookCsv, type FlightSummary } from '$lib/nav/logbook';
import {
	flownRouteLabelsFor,
	libraryLogbookRows,
	libraryTotals,
	totalsOfFlights,
	flightYear,
	outingSpan,
	overlapsAnyOuting,
	flightChainTokens,
	routeCellTokens,
	supersededLogbookIds,
	type FlownRoute,
} from '$lib/state/flightRows';
import type { OutingMeta } from '$lib/state/flightsDb';
import type { RouteSegment } from '$lib/nav/routeAssign';
import type { Waypoint } from '$lib/state/route.svelte';

const T0 = Date.UTC(2026, 7, 9, 10, 0);

function flight(over: Partial<FlightSummary> = {}): FlightSummary {
	return {
		blockOffMs: T0,
		takeoffMs: T0 + 2 * 60_000,
		landingMs: T0 + 50 * 60_000,
		blockOnMs: T0 + 55 * 60_000,
		distanceNM: 42.4,
		depPlace: 'LFPL',
		arrPlace: 'LFFN',
		landingsDay: 1,
		landingsNight: 0,
		nightMin: 0,
		...over,
	};
}

function meta(id: number, flights: FlightSummary[], over: Partial<OutingMeta> = {}): OutingMeta {
	return {
		id,
		savedAtMs: id,
		datum: 'msl',
		aircraftKey: 'F-GORQ',
		remarks: '',
		source: 'trace',
		derivedV: 1,
		flights,
		...over,
	};
}

function wp(ident: string, lat: number, lon: number): Waypoint {
	return { id: ident, lat, lon, kind: 'airport', ident, alt: 0, altAuto: true };
}

function seg(routeId: string, over: Partial<RouteSegment> = {}): RouteSegment {
	return {
		routeId,
		fromIdx: 0,
		fromMs: T0,
		toIdx: 10,
		arrivalMs: T0 + 60 * 60_000,
		offNM: 0.2,
		chained: false,
		pinned: false,
		startFinal: true,
		...over,
	};
}

// A two-trip workspace with one alternate attached to the first trip.
const trip1: FlownRoute = {
	id: 'r1',
	name: null,
	waypoints: [wp('LFPL', 48.6, 2.61), wp('LFFN', 48.05, 2.03)],
};
const alt1: FlownRoute = {
	id: 'a1',
	name: null,
	alternate: true,
	waypoints: [wp('LFFN', 48.05, 2.03), wp('LFAB', 49.87, 1.09)],
};
const trip2: FlownRoute = {
	id: 'r2',
	name: 'Retour',
	waypoints: [wp('LFFN', 48.05, 2.03), wp('LFPL', 48.6, 2.61)],
};
const plan: FlownRoute[] = [trip1, alt1, trip2];

describe('flownRouteLabelsFor', () => {
	it('labels the flown chain first-seen, endpoints for unnamed routes', () => {
		const labels = flownRouteLabelsFor(plan, [seg('r1'), seg('r1'), seg('r2')]);
		expect(labels).toEqual(['LFPL → LFFN', 'Retour']);
	});

	it('skips unknown ids and under-two-waypoint routes', () => {
		const stub: FlownRoute = { id: 's', name: null, waypoints: [wp('LFPL', 48.6, 2.61)] };
		expect(flownRouteLabelsFor([...plan, stub], [seg('gone'), seg('s')])).toEqual([]);
	});
});

describe('flightChainTokens', () => {
	it('chains dep, touches and landing; only intermediate touchdowns ink', () => {
		expect(flightChainTokens(flight({ touchPlaces: ['LFPK', 'LFPL'] }))).toEqual([
			{ text: 'LFPL', touched: false },
			{ text: ' → ', touched: false },
			{ text: 'LFPK', touched: true },
			{ text: ' → ', touched: false },
			{ text: 'LFPL', touched: false },
		]);
	});

	it('collapses repeated touches into one counted element', () => {
		const f = flight({ touchPlaces: ['LFPK', 'LFPK', 'LFPK', 'LFPK', 'LFPK', 'LFPL'] });
		expect(flightChainTokens(f).map((tk) => tk.text).join('')).toBe('LFPL → LFPK (5x) → LFPL');
	});

	it('a circuit session is one counted element', () => {
		const f = flight({ depPlace: 'LFPL', arrPlace: 'LFPL', touchPlaces: ['LFPL', 'LFPL', 'LFPL'] });
		expect(flightChainTokens(f)).toEqual([{ text: 'LFPL (3x)', touched: false }]);
	});

	it('multiple touchdowns at an endpoint count without inking', () => {
		// Two circuits at LFPK, then a circuit and the landing back home.
		const f = flight({ touchPlaces: ['LFPK', 'LFPK', 'LFPL', 'LFPL'] });
		expect(flightChainTokens(f)).toEqual([
			{ text: 'LFPL', touched: false },
			{ text: ' → ', touched: false },
			{ text: 'LFPK (2x)', touched: true },
			{ text: ' → ', touched: false },
			{ text: 'LFPL (2x)', touched: false },
		]);
	});

	it('rows stored before touchPlaces fall back to the landed block-on place', () => {
		expect(flightChainTokens(flight()).map((tk) => tk.text).join('')).toBe('LFPL → LFFN');
		expect(flightChainTokens(flight({ landingMs: null, blockOnMs: null }))).toEqual([
			{ text: 'LFPL', touched: false },
		]);
	});
});

describe('routeCellTokens', () => {
	it('shows the chain when an intermediate touchdown exists, else the link labels', () => {
		const withStop = meta(T0, [flight({ touchPlaces: ['LFPK', 'LFPL'] })]);
		expect(
			routeCellTokens(['LFPL → LFFZ / LFFZ → LFPL'], withStop, withStop.flights[0])
				.map((tk) => tk.text)
				.join(''),
		).toBe('LFPL → LFPK → LFPL');
		// A round trip with only the final landing reduces to one ident:
		// the linked plan's labels say more.
		const plain = meta(T0, [flight({ depPlace: 'LFPL', touchPlaces: ['LFPL'] })]);
		expect(
			routeCellTokens(['LFPL → LFGO / LFGO → LFPL'], plain, plain.flights[0]),
		).toEqual([{ text: 'LFPL → LFGO / LFGO → LFPL', touched: false }]);
		// Unlinked: the chain, however short.
		const local = meta(T0, [flight({ depPlace: 'LFPL', touchPlaces: ['LFPL'] })]);
		expect(routeCellTokens([], local, local.flights[0])).toEqual([
			{ text: 'LFPL', touched: false },
		]);
		// A circuit session that links a plan keeps its COUNT visible: the
		// chain wins over the labels whenever it carries one.
		const circuits = meta(T0, [
			flight({ depPlace: 'LFPL', touchPlaces: ['LFPL', 'LFPL', 'LFPL'] }),
		]);
		expect(
			routeCellTokens(['LFPL → LFAI / LFAI → LFPL'], circuits, circuits.flights[0]),
		).toEqual([{ text: 'LFPL (3x)', touched: false }]);
	});

	it('a multi-flight outing describes each line by its own flight, never the labels', () => {
		// The trace holds two flights (a stopover day); the outing-level
		// link labels would misdescribe either line, so both rows chain
		// their own places and the labels stay in the tooltip.
		const day = meta(T0, [
			flight({ touchPlaces: ['LFFH'], arrPlace: 'LFFH' }),
			flight({
				blockOffMs: T0 + 90 * 60_000,
				depPlace: 'LFFH',
				touchPlaces: ['LFPL'],
				arrPlace: 'LFPL',
			}),
		]);
		const labels = ['LFPL - LFFH', 'LFFH - LFPL'];
		expect(routeCellTokens(labels, day, day.flights[0]).map((tk) => tk.text).join('')).toBe(
			'LFPL → LFFH',
		);
		expect(routeCellTokens(labels, day, day.flights[1]).map((tk) => tk.text).join('')).toBe(
			'LFFH → LFPL',
		);
	});
});

describe('logbook overlap', () => {
	it('spans an outing over all its flights', () => {
		const m = meta(T0, [
			flight(),
			flight({ blockOffMs: T0 + 60 * 60_000, blockOnMs: T0 + 90 * 60_000 }),
		]);
		expect(outingSpan(m)).toEqual({ fromMs: T0, toMs: T0 + 90 * 60_000 });
		expect(outingSpan(meta(1, []))).toBeNull();
	});

	it('touching endpoints are not an overlap', () => {
		const metas = [meta(T0, [flight()])]; // block T0 .. T0+55 min
		expect(overlapsAnyOuting(metas, T0 + 55 * 60_000, T0 + 80 * 60_000)).toBe(false);
		expect(overlapsAnyOuting(metas, T0 + 54 * 60_000, T0 + 80 * 60_000)).toBe(true);
		expect(overlapsAnyOuting(metas, T0 - 60_000, T0)).toBe(false);
	});

	it('a trace supersedes only the logbook rows it overlaps', () => {
		const lb = meta(T0, [flight()], { source: 'logbook' });
		const dayBefore = T0 - 86_400_000;
		const tr = meta(dayBefore, [
			flight({ blockOffMs: dayBefore, blockOnMs: dayBefore + 3_600_000 }),
		]);
		expect(supersededLogbookIds([lb, tr], T0 + 10 * 60_000, T0 + 20 * 60_000)).toEqual([T0]);
		expect(supersededLogbookIds([lb, tr], dayBefore, dayBefore + 60_000)).toEqual([]);
	});
});

describe('libraryTotals', () => {
	it('sums closed blocks, landings and night over every listed flight', () => {
		const t = libraryTotals([
			meta(T0, [
				flight(),
				flight({
					blockOffMs: T0 + 60 * 60_000,
					blockOnMs: T0 + 90 * 60_000,
					landingsDay: 2,
					landingsNight: 1,
					nightMin: 12,
				}),
			]),
			meta(T0 - 86_400_000, [flight({ landingMs: null, blockOnMs: null, landingsDay: null, landingsNight: null, nightMin: null })]),
		]);
		expect(t.totalMin).toBe(55 + 30); // the open flight contributes nothing
		expect(t.landings).toBe(1 + 3);
		expect(t.nightLandings).toBe(1);
		expect(t.nightMin).toBe(12);
	});

	it('sums exactly the flights it is given, which is what scopes the footer', () => {
		// The table narrows to a period, and the check-sums have to narrow
		// with it: a total that covered rows the sheet does not show would
		// be worse than no total at all.
		const a = flight();
		const b = flight({
			blockOffMs: T0 + 60 * 60_000,
			blockOnMs: T0 + 90 * 60_000,
			landingsDay: 2,
			landingsNight: 1,
			nightMin: 12,
		});
		expect(totalsOfFlights([a, b])).toEqual(libraryTotals([meta(T0, [a, b])]));
		expect(totalsOfFlights([a]).totalMin).toBe(55);
		expect(totalsOfFlights([]).totalMin).toBe(0);
	});
});

describe('flightYear', () => {
	it('is the UTC day the block opens, the date the row shows', () => {
		expect(flightYear(flight())).toBe('2026');
		// A block opening on 31 December UTC belongs to that year, whatever
		// the local calendar or the landing say: the row's own date is the
		// AMC (i)(1) date, and the scope must agree with it.
		const newYear = Date.UTC(2026, 11, 31, 23, 30);
		expect(
			flightYear(flight({ blockOffMs: newYear, blockOnMs: newYear + 60 * 60_000 })),
		).toBe('2026');
	});
});

describe('libraryLogbookRows', () => {
	const resolve = {
		make: () => 'ROBIN',
		model: () => 'DR400/120',
		registration: (key: string | null) => key ?? '',
		picName: 'SELF',
		// The dynamic link's labels, injected like the app resolves them.
		labelsFor: (): string[] | null => ['LFPL - LFFN'],
	};

	it('flattens metas chronologically ascending with the resolvers applied', () => {
		const later = meta(T0, [flight()]);
		const earlier = meta(T0 - 86_400_000, [
			flight({ blockOffMs: T0 - 86_400_000 }),
			flight({ blockOffMs: T0 - 86_400_000 + 60 * 60_000 }),
		]);
		// Listed DESC on screen; the CSV mapping re-sorts ASC itself.
		const rows = libraryLogbookRows([later, earlier], resolve);
		expect(rows.length).toBe(3);
		expect(rows[0].slice.blockOffMs).toBe(T0 - 86_400_000);
		expect(rows[2].slice.blockOffMs).toBe(T0);
		expect(rows[0].registration).toBe('F-GORQ');
		expect(rows[0].picName).toBe('SELF');
		expect(rows[0].remarks).toBe('LFPL - LFFN');
		// And the whole set feeds the shipped CSV builder unchanged.
		const csv = buildLogbookCsv(rows);
		expect(csv.split('\r\n').length).toBe(5); // header + 3 rows + trailing
		expect(csv).toContain('SELF');
	});
});

describe('an open logbook row against a filed flight', () => {
	// The failure this pins was found on the phone: exporting the logbook CSV
	// and importing it back REPLACED every trace outing. A row whose flight
	// has no arrival is a zero-width span, which the strict overlap test never
	// matched, and its id (the block-off instant) collides with the trace's.
	const trace = meta(Date.UTC(2026, 7, 11, 14, 2), [
		flight({
			blockOffMs: Date.UTC(2026, 7, 11, 14, 2),
			blockOnMs: Date.UTC(2026, 7, 11, 15, 30),
		}),
	]);

	it('counts a departure standing inside a filed span as covered', () => {
		const at = Date.UTC(2026, 7, 11, 14, 2);
		expect(overlapsAnyOuting([trace], at, at)).toBe(true);
		const mid = Date.UTC(2026, 7, 11, 15, 0);
		expect(overlapsAnyOuting([trace], mid, mid)).toBe(true);
	});

	it('still lets a genuinely separate open row through', () => {
		const later = Date.UTC(2026, 7, 11, 16, 0);
		expect(overlapsAnyOuting([trace], later, later)).toBe(false);
	});

	it('keeps endpoint-touching CLOSED rows separate, as before', () => {
		// One flight may land the minute the next departs.
		const from = Date.UTC(2026, 7, 11, 15, 30);
		const to = Date.UTC(2026, 7, 11, 16, 30);
		expect(overlapsAnyOuting([trace], from, to)).toBe(false);
	});
});

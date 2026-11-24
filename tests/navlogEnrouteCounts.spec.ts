/* The kneeboard estimator's lines per waypoint (state/navlogEnroute.ts
 * routeNavlogLineCounts) are the lines NavLogSheet prints: an aerodrome's
 * own, guard left out, and the airspace lines, one per CHANNEL the leg
 * meets, SIV SEINE 3 then SEINE 4 being two. The estimator was only ever fed
 * hand-counted figures; here the count and the sheet's own lines come off
 * one route over the same data, rendered on the server. */

import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { NO_ENTRY } from '$lib/data/airspaceEntry';
import type { Airspace } from '$lib/data/airspaces';
import { fromTriple } from '$lib/vertical/limits';
import { installLeafletNode } from './helpers/leafletNode';

/** A SIV sector over a ring, surface to FL115, on its channels. */
function siv(name: string, ring: [number, number][], ...freqs: string[]): Airspace {
	const lats = ring.map(([lat]) => lat);
	const lons = ring.map(([, lon]) => lon);
	return {
		id: name,
		key: `${name}|${name}`,
		type: 'SIV',
		name,
		airClass: 'G',
		upper: ['STD', '115', 'FL'],
		lower: ['HEI', '0', 'FT'],
		vUpper: fromTriple(['STD', '115', 'FL']),
		vLower: fromTriple(['HEI', '0', 'FT']),
		vMax: null,
		vMnm: null,
		workHr: '',
		rmkWorkHr: '',
		rmk: '',
		entry: NO_ENTRY,
		radio: freqs.map((freq) => ({ freq, unit: 'INFO', call: 'SEINE - INFORMATION' })),
		ring,
		subtype: '',
		category: 'siv',
		source: 'fr',
		area: 1,
		bbox: { minLat: Math.min(...lats), minLon: Math.min(...lons), maxLat: Math.max(...lats), maxLon: Math.max(...lons) },
	} as unknown as Airspace;
}

/** A class D CTR over `ring` from the surface to `ceilingFt`, worked on
 *  `radio`. */
function ctr(name: string, ring: [number, number][], ceilingFt: number, radio: { freq: string; call: string }[]): Airspace {
	const base = siv(name, ring);
	return {
		...base,
		type: 'CTR',
		airClass: 'D',
		category: 'controlled',
		upper: ['ALT', String(ceilingFt), 'FT'],
		vUpper: fromTriple(['ALT', String(ceilingFt), 'FT']),
		radio: radio.map((r) => ({ ...r, unit: 'FIELD' })),
	} as unknown as Airspace;
}

const AIRSPACES = [
	siv('SEINE 3', [[48, 1.9], [49, 1.9], [49, 2.5], [48, 2.5]], '134.300'),
	siv('SEINE 4', [[48, 2.5], [49, 2.5], [49, 3.1], [48, 3.1]], '120.330'),
	// Two aerodromes' CTRs, well below the route's 3000 ft.
	ctr('LFDA', [[48.1, 2.1], [48.3, 2.1], [48.3, 2.3], [48.1, 2.3]], 2000, [
		{ freq: '118.100', call: 'LFDA - TOUR' },
		{ freq: '121.100', call: 'LFDA - APPROCHE' },
	]),
	ctr('LFDB', [[48.1, 2.7], [48.3, 2.7], [48.3, 2.9], [48.1, 2.9]], 1500, [
		{ freq: '122.100', call: 'LFDB - APPROCHE' },
	]),
];

/** EGKK publishes guard under its tower and its director alike, which
 *  coalescing turns into a "TWR / APP: 121.500" line the sheet leaves out. */
const AIRPORTS: Record<string, unknown> = {
	LFDA: {
		ident: 'LFDA',
		type: 'small_airport',
		name: 'DEPART',
		lat: 48.2,
		lon: 2.2,
		radios: [
			{ freq: '118.100', unit: 'TWR', call: 'LFDA - TOUR' },
			{ freq: '121.100', unit: 'APP', call: 'LFDA - APPROCHE' },
		],
	},
	LFDB: { ident: 'LFDB', type: 'small_airport', name: 'ARRIVEE', lat: 48.2, lon: 2.8, radios: [{ freq: '119.000', unit: 'TWR', call: 'LFDB - TOUR' }] },
	EGKK: {
		ident: 'EGKK',
		type: 'large_airport',
		name: 'GATWICK',
		lat: 48.5,
		lon: 2.0,
		radios: [
			{ freq: '126.825', unit: 'APP', call: 'GATWICK DIRECTOR' },
			{ freq: '121.500', unit: 'APP', call: 'GATWICK DIRECTOR' },
			{ freq: '124.230', unit: 'TWR', call: 'GATWICK TOWER' },
			{ freq: '121.500', unit: 'TWR', call: 'GATWICK TOWER' },
		],
	},
};

vi.mock('$lib/state/data.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/data.svelte')>();
	return {
		...actual,
		getAirspaces: () => AIRSPACES,
		airportByIdent: (ident: string) => AIRPORTS[ident.toUpperCase()] ?? null,
		dataState: { ...actual.dataState, airspacesLoaded: true, airspacesError: null, airportsLoaded: true },
	};
});

/** What the obstacle retries say about the route's MSA (routeMsaIncomplete),
 *  and what the sheet asked it: its own route, over its own corridor. */
let msaIncomplete = false;
const msaAsked: { route: unknown; halfWidthNM: number }[] = [];
vi.mock('$lib/state/routeMsa.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/routeMsa.svelte')>();
	return {
		...actual,
		routeMsaIncomplete: (route: unknown, halfWidthNM: number) => {
			msaAsked.push({ route, halfWidthNM });
			return msaIncomplete;
		},
	};
});

installLeafletNode();
const { routeNavlogLineCounts } = await import('$lib/state/navlogEnroute');
const { routeSettings } = await import('$lib/state/route.svelte');
const { default: NavLogSheet } = await import('$lib/components/NavLogSheet.svelte');

type Route = import('$lib/state/route.svelte').Route;

const route: Route = {
	id: 'enroute-counts',
	name: null,
	selectedWaypointId: null,
	waypoints: [2.0, 3.0].map((lon, i) => ({
		id: `enroute-counts-${i}`,
		lat: 48.5,
		lon,
		kind: 'free' as const,
		alt: 3000,
		altAuto: false,
	})),
};

/** The frequency lines the rendered sheet prints, in order. */
function printedLines(r: Route): string[] {
	const { body } = render(NavLogSheet, { props: { route: r } });
	return [...body.matchAll(/class="rep-freq(?:\s[^"]*)?"[^>]*>([^<]*)</g)].map((m) => m[1].trim());
}

describe('the lines the estimator prices', () => {
	it('are the lines the sheet prints, a line per channel', () => {
		routeSettings.enrouteFreqsInNavlog = true;
		expect(routeNavlogLineCounts(route)).toEqual([
			{ aerodrome: 0, airspace: 2 },
			{ aerodrome: 0, airspace: 0 },
		]);
		expect(printedLines(route)).toEqual(['SEINE - INFORMATION: 134.300', 'SEINE - INFORMATION: 120.330']);
	});

	const between: Route = {
		...route,
		id: 'enroute-counts-aerodromes',
		waypoints: [
			{ id: 'lfda', lat: 48.2, lon: 2.2, kind: 'airport', ident: 'LFDA', alt: 3000, altAuto: false },
			{ id: 'lfdb', lat: 48.2, lon: 2.8, kind: 'airport', ident: 'LFDB', alt: 3000, altAuto: false },
		],
	};

	it('name the airspaces the climb and the descent cross at the aerodromes', () => {
		// Both CTRs lie below the legs' 3000 ft: the departure row lists the
		// climb's approach before the leg's sectors, the destination row the
		// descent's. The aerodrome keeps its tower and leaves the approach
		// its CTR publishes to the airspace lines.
		routeSettings.enrouteFreqsInNavlog = true;
		routeSettings.airportFreqsInNavlog = true;
		expect(printedLines(between)).toEqual([
			'TWR: 118.100',
			'LFDA - APPROCHE: 121.100',
			'SEINE - INFORMATION: 134.300',
			'SEINE - INFORMATION: 120.330',
			'TWR: 119.000',
			'LFDB - APPROCHE: 122.100',
		]);
		expect(routeNavlogLineCounts(between)).toEqual([
			{ aerodrome: 1, airspace: 3 },
			{ aerodrome: 1, airspace: 1 },
		]);
	});

	it('keep the approach under its aerodrome while the airspace lines are off', () => {
		routeSettings.enrouteFreqsInNavlog = false;
		routeSettings.airportFreqsInNavlog = true;
		try {
			expect(printedLines(between)).toEqual(['TWR: 118.100', 'APP: 121.100', 'TWR: 119.000']);
		} finally {
			routeSettings.enrouteFreqsInNavlog = true;
		}
	});

	it("count an aerodrome's lines as the sheet prints them, guard left out", () => {
		routeSettings.enrouteFreqsInNavlog = true;
		routeSettings.airportFreqsInNavlog = true;
		const fromEgkk: Route = {
			...route,
			id: 'enroute-counts-egkk',
			waypoints: [{ ...route.waypoints[0], kind: 'airport', ident: 'EGKK' }, route.waypoints[1]],
		};
		expect(routeNavlogLineCounts(fromEgkk)).toEqual([
			{ aerodrome: 2, airspace: 2 },
			{ aerodrome: 0, airspace: 0 },
		]);
		expect(printedLines(fromEgkk)).toEqual([
			'TWR: 124.230',
			'APP: 126.825',
			'SEINE - INFORMATION: 134.300',
			'SEINE - INFORMATION: 120.330',
		]);
	});

	it('come with the MSA note while the route\'s obstacles are being read again', () => {
		// The sheet says so beside its title, on screen and on paper: the
		// MSA may read low.
		const note = 'MSA without some obstacle data';
		msaIncomplete = false;
		msaAsked.length = 0;
		expect(render(NavLogSheet, { props: { route } }).body).not.toContain(note);
		// Asked of this route, over the corridor its MSAs were read over.
		expect(msaAsked).toEqual([{ route, halfWidthNM: routeSettings.minAltCorridorRadiusNM }]);
		msaIncomplete = true;
		expect(render(NavLogSheet, { props: { route } }).body).toContain(note);
		expect(render(NavLogSheet, { props: { route, kneeboard: true } }).body).toContain(note);
		msaIncomplete = false;
	});

	it('bold, in flight, the one line carrying the channel the band sets', () => {
		// The live display names the contact airspace and its channel
		// (nav/contactChain contactInk); the sheet inks the line carrying
		// both, and none when the channel the band sets is on no line of that
		// airspace: inked by the airspace alone, SEINE 4's line read as the
		// one to set while the band set another channel.
		routeSettings.enrouteFreqsInNavlog = true;
		const wpts = route.waypoints.map((_, i) => ({ eto: '', ato: '', passed: false, target: i === 1 }));
		const inked = (contactFreq: string): string[] => {
			const live = { wpts, currentLegIdx: 0, currentLegFrac: 0.6, arrived: false, contactKey: 'SEINE 4|SEINE 4', contactFreq };
			const { body } = render(NavLogSheet, { props: { route, interactive: true, live } });
			return [...body.matchAll(/class="rep-freq(?:\s[^"]*)?"[^>]*>([^<]*)</g)]
				.filter((m) => /\scontact[\s"]/.test(m[0]))
				.map((m) => m[1].trim());
		};
		expect(inked('120.330')).toEqual(['SEINE - INFORMATION: 120.330']);
		// SEINE 3's channel, set while the band names SEINE 4.
		expect(inked('134.300')).toEqual([]);
		expect(inked('118.000')).toEqual([]);
	});
});

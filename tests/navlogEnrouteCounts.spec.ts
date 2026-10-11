/* The kneeboard estimator's enroute lines per leg (state/navlogEnroute.ts
 * routeEnrouteLineCounts) are the lines NavLogSheet prints: one per CHANNEL
 * the leg meets, SIV SEINE 3 then SEINE 4 being two. The estimator was only
 * ever fed hand-counted figures; here the count and the sheet's own lines
 * come off one route over the same airspaces, rendered on the server. */

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

const AIRSPACES = [
	siv('SEINE 3', [[48, 1.9], [49, 1.9], [49, 2.5], [48, 2.5]], '134.300'),
	siv('SEINE 4', [[48, 2.5], [49, 2.5], [49, 3.1], [48, 3.1]], '120.330'),
];

vi.mock('$lib/state/data.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/data.svelte')>();
	return {
		...actual,
		getAirspaces: () => AIRSPACES,
		dataState: { ...actual.dataState, airspacesLoaded: true, airspacesError: null },
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
const { routeEnrouteLineCounts } = await import('$lib/state/navlogEnroute');
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

describe('the enroute lines the estimator prices', () => {
	it('are the lines the sheet prints, a line per channel', () => {
		routeSettings.enrouteFreqsInNavlog = true;
		expect(routeEnrouteLineCounts(route)).toEqual([2]);
		const { body } = render(NavLogSheet, { props: { route } });
		const printed = [...body.matchAll(/class="rep-freq(?:\s[^"]*)?"[^>]*>([^<]*)</g)].map((m) => m[1].trim());
		expect(printed).toEqual(['SEINE - INFORMATION: 134.300', 'SEINE - INFORMATION: 120.330']);
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

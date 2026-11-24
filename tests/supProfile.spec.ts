/* The supplements' zones on the route profile (route/supProfile.ts): a
 * band per zone the route crosses, keyed `sup:<supId>#<zone>`, graded as
 * the alerts grade the zone, and the strip's verdict on it from its state. */

import { describe, expect, it } from 'vitest';
import type { ActivityAnswer } from '$lib/data/activity';
import type { SupAip, SupAipPenetration } from '$lib/data/supaip';
import { supaipVolumes } from '$lib/nav/alertVolumes';
import { ringBbox } from '$lib/notam/geometry';
import { bandCrossings } from '$lib/route/routeProfile';
import { computeSupProfileBands, placeSupBands, supBandRef, SUP_PROFILE_COLOR } from '$lib/route/supProfile';
import type { Waypoint } from '$lib/state/route.svelte';
import { fromTriple } from '$lib/vertical/limits';

// A square from 48.0 to 48.2 N, 2.0 to 2.2 E, SFC to 3000 ft AMSL.
const RING: [number, number][] = [
	[48.0, 2.0],
	[48.0, 2.2],
	[48.2, 2.2],
	[48.2, 2.0],
];

function sup(name: string, penetration: SupAipPenetration | null, over: Partial<SupAip> = {}): SupAip {
	return {
		id: 'metropole-2026-100',
		title: '100/2026',
		number: 100,
		year: 2026,
		region: 'metropole',
		descriptionFr: '',
		descriptionEn: '',
		lieu: '',
		urlPdf: '',
		urlPdfEn: '',
		validFrom: '2026-11-01',
		validTo: '2026-12-31',
		ifr: true,
		vfr: true,
		airac: false,
		fir: [],
		adhp: [],
		zones: [
			{
				name,
				geometry: { type: 'polygon', ring: RING },
				bbox: ringBbox(RING),
				lower: ['HEI', '0', 'FT'],
				upper: ['ALT', '3000', 'FT'],
				vLower: fromTriple(['HEI', '0', 'FT']),
				vUpper: fromTriple(['ALT', '3000', 'FT']),
				geometrySource: 'pdf-polygon',
				sameAs: '',
				exclusions: [],
				excluded: [],
				standing: [],
				activations: [],
			},
		],
		bbox: ringBbox(RING),
		geometrySource: 'pdf-polygon',
		parseConfidence: 'high',
		warnings: [],
		contacts: [],
		penetration,
		manager: '',
		phones: [],
		...over,
	};
}

// West to east across the square at 48.1 N.
const ROUTE = [
	{ lat: 48.1, lon: 1.8 },
	{ lat: 48.1, lon: 2.4 },
] as Waypoint[];
const PATH = [
	{ distNM: 0, altFt: 2000 },
	{ distNM: 30, altFt: 2000 },
];

function placed(s: SupAip) {
	const bands = computeSupProfileBands(ROUTE, supaipVolumes([s]));
	return placeSupBands(bands, [], new Map([[s.id, s.title]]));
}

describe('supplement bands on the route profile', () => {
	it('bands a zone the route crosses, over the span it crosses it', () => {
		const [b] = placed(sup('ZRT TEST', { kind: 'circumvent', text: '' }));
		expect([b.key, b.supId, b.zoneIndex, b.color, b.label, b.badge]).toEqual([
			'sup:metropole-2026-100#0',
			'metropole-2026-100',
			0,
			SUP_PROFILE_COLOR,
			'ZRT TEST',
			null,
		]);
		expect(b.spans).toHaveLength(1);
		expect(b.spans[0].enterNM).toBeGreaterThan(7);
		expect(b.spans[0].leaveNM).toBeLessThan(23);
		expect(b.tooltip).toBe('SUP AIP 100/2026\nZRT TEST\nSFC – 3000 ft AMSL');
		expect(supBandRef(b.key)).toEqual({ supId: 'metropole-2026-100', zoneIndex: 0 });
		expect(supBandRef('LFR151|151')).toBeNull();
	});

	it('grades the zone as the alerts do', () => {
		const grade = (s: SupAip) => {
			const [b] = placed(s);
			return [b.type, b.entry.vfr, b.entry.ifr];
		};
		expect(grade(sup('ZRT A', { kind: 'circumvent', text: '' }))).toEqual(['R', 'forbidden', 'forbidden']);
		expect(grade(sup('ZIT B', null))).toEqual(['R', 'forbidden', 'forbidden']);
		expect(grade(sup('ZRT C', { kind: 'conditional', text: '' }))).toEqual(['R', 'clearance', 'clearance']);
		expect(grade(sup('ZDT D', { kind: 'forbidden', text: '' }))).toEqual(['D', null, null]);
		// A supplement for IFR traffic alone exempts a VFR flight.
		expect(grade(sup('ZRT E', { kind: 'circumvent', text: '' }, { vfr: false }))).toEqual(['R', 'exempt', 'forbidden']);
	});

	it('is NO-GO while active, a caution while it may be active', () => {
		const bands = placed(sup('ZRT TEST', { kind: 'circumvent', text: '' }));
		const at = (state: ActivityAnswer['state'], reason: ActivityAnswer['reason']) =>
			bandCrossings(bands, PATH, { vfr: true, states: new Map([[bands[0].key, { state, reason, period: null }]]) })[0];
		expect([at('active', 'published').forbidden, at('active', 'published').active]).toEqual([true, true]);
		expect([at('activable', 'activable').forbidden, at('activable', 'activable').unknown]).toEqual([false, true]);
		expect(at('inactive', 'outside').forbidden).toBe(false);
	});
});

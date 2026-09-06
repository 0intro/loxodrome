import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNotams } from '$lib/notam';
import type { SupAip } from '$lib/data/supaip';
import { notamState } from '$lib/state/notam.svelte';
import { filter } from '$lib/state/filter.svelte';
import { layers } from '$lib/state/layers.svelte';
import { ensureSupaip, supaipByRef } from '$lib/state/data.svelte';
import { supaipAt, supaipZonesAt } from '$lib/state/supaip.svelte';
import {
	activatedNotamsForSup,
	activatedZoneIndices,
	activatesSupZones,
	notamActivatesZone,
	notamsReferencingSup,
	supZoneActivations,
} from '$lib/state/supaipLinks.svelte';

/* ------------------------------------------------------------------ */
/* Pure zone-name matcher (no dataset needed)                          */
/* ------------------------------------------------------------------ */

// A minimal SUP AIP with just the named zones the matcher reads. 167/25 and
// 093/26 aren't in the committed snapshot, so the matcher cases are synthetic.
function makeSup(number: number, year: number, zoneNames: string[]): SupAip {
	return {
		id: `metropole-${year}-${String(number).padStart(3, '0')}`,
		title: `${String(number).padStart(3, '0')}/${year}`,
		number,
		year,
		region: 'metropole',
		descriptionFr: '',
		descriptionEn: '',
		lieu: '',
		urlPdf: '',
		urlPdfEn: '',
		validFrom: null,
		validTo: null,
		ifr: false,
		vfr: false,
		airac: false,
		fir: [],
		adhp: [],
		zones: zoneNames.map((name) => ({
			name,
			geometry: null,
			bbox: null,
			lower: null,
			upper: null,
			vLower: null,
			vUpper: null,
			geometrySource: 'none',
			sameAs: '',
			activations: [],
		})),
		bbox: null,
		geometrySource: 'none',
		parseConfidence: 'none',
		warnings: [],
		contacts: [],
		penetration: null,
		manager: '',
	};
}

function notam(qCode: string, sup: string, eExtra: string): ReturnType<typeof parseNotams>[number] {
	return parseNotams(`R9999/26
Q) LFRR/${qCode}/IV/BO/AW/000/055/4800N00430W005
A) LFRN
B) 2606010000 C) 2606012359
E) AIP SUP ${sup} : ${eExtra}
F) SFC
G) 5500FT AMSL
`)[0];
}

describe('activatedZoneIndices (named zone, else all)', () => {
	it('scopes to the single named zone', () => {
		const sup = makeSup(93, 2026, ['ZRT LOURDES', 'ZRT TARBES']);
		const n = notam('QRTCA', '093/26', "'ZRT LOURDES' ACT");
		expect(activatedZoneIndices(n, sup)).toEqual([0]);
		expect(notamActivatesZone(n, sup, 0)).toBe(true);
		expect(notamActivatesZone(n, sup, 1)).toBe(false);
	});

	it('falls back to ALL zones when nothing matches', () => {
		const sup = makeSup(167, 2025, ['OCHEY', 'TOUL']);
		const n = notam('QRTCA', '167/25', 'TEMPORARY RESTRICTED AREA ACTIVATED.');
		expect(activatedZoneIndices(n, sup)).toEqual([0, 1]);
	});

	it('matches across accents and quote styles (« AVEL » <-> \'AVEL\')', () => {
		const sup = makeSup(200, 2026, [
			'LF-R17 A tempo « AVEL »',
			'LF-R17 C tempo « CORSEN »',
		]);
		const n = notam('QRTCA', '200/26', "'AVEL' ACT");
		expect(activatedZoneIndices(n, sup)).toEqual([0]);
	});

	it('does not over-match a shorter designator (R17 != R170)', () => {
		const sup = makeSup(201, 2026, ['R17', 'R170']);
		const n = notam('QRTCA', '201/26', "'R17' ACT");
		expect(activatedZoneIndices(n, sup)).toEqual([0]);
	});

	it('matches several zones sharing a place word', () => {
		const sup = makeSup(202, 2026, [
			'ZRT 1 LE CROISIC',
			'ZRT 2 LE CROISIC',
			'ZRT 3 LE CROISIC',
		]);
		const n = notam('QRTCA', '202/26', "'LE CROISIC' ACT");
		expect(activatedZoneIndices(n, sup)).toEqual([0, 1, 2]);
	});

	it('reads the unquoted "ZRT <name>" form, stopping at the parenthesis', () => {
		const sup = makeSup(203, 2026, ['ZRT OCHEY', 'ZRT TOUL']);
		const n = parseNotams(`R9998/26
Q) LFEE/QRTCA/IV/BO/AW/000/075/4835N00557E007
A) LFSO
B) 2606010000 C) 2606012359
E) ZRT OCHEY (AIP SUP 203/26) ACT.
F) SFC
G) FL075
`)[0];
		expect(activatedZoneIndices(n, sup)).toEqual([0]);
	});
});

/* ------------------------------------------------------------------ */
/* Forward + reverse links over a stubbed dataset                      */
/* ------------------------------------------------------------------ */

// Two metropole supplements served to ensureSupaip via a stubbed fetch, in the
// positional row layout of fr-supaip.json (see cmd/supaip/api.go outputFields).
type ZoneSpec = { name: string; ring?: [number, number][] };
function rawRow(
	id: string,
	title: string,
	specs: ZoneSpec[],
	region = 'metropole',
): unknown[] {
	const zones = specs.map((z) => ({
		name: z.name,
		geometry: z.ring ? { type: 'polygon', ring: z.ring } : null,
		bbox: z.ring
			? [
					Math.min(...z.ring.map((p) => p[0])), Math.min(...z.ring.map((p) => p[1])),
					Math.max(...z.ring.map((p) => p[0])), Math.max(...z.ring.map((p) => p[1])),
				]
			: null,
		lower: null,
		upper: null,
		geometrySource: z.ring ? 'pdf-polygon' : 'none',
		activations: [],
	}));
	return [
		id, title, region, '', '', '', '', '', '',
		false, false, false, [], [], zones, null, 'none', 'none', [], '',
		[], null, '',
	];
}

// A small square around Lourdes (~43.1N, 0.05W), so supaipZonesAt has geometry
// to point-test the activated hatch against.
const LOURDES_RING: [number, number][] = [
	[43.0, -0.1], [43.0, 0.1], [43.2, 0.1], [43.2, -0.1],
];

const RAW = {
	fields: [],
	rows: [
		rawRow('metropole-2025-167', '167/2025', [{ name: 'OCHEY' }, { name: 'TOUL' }]),
		rawRow('metropole-2026-093', '093/2026', [
			{ name: 'ZRT LOURDES', ring: LOURDES_RING },
			{ name: 'ZRT TARBES' },
		]),
	],
};

// A Spanish supplement numbered EXACTLY like the French one above: the
// two publishers number from one each year, so 093/2026 names a
// different document in each country. Anything keyed by number alone
// would answer a French NOTAM with a Spanish zone.
const ES_RAW = {
	fields: [],
	rows: [
		rawRow(
			'es-2026-093',
			'093/2026',
			[{ name: 'DFN-26 ZONA E' }, { name: 'DFN-26 ZONA C' }],
			'es',
		),
	],
};

// Spanish activations: the bare citation form, and a Q-line FIR that
// says who published it.
const ACT_ES_NAMED = `A1484/26
Q) LECM/QRTCA/IV/BO/AW/000/100/4025N00348W020
A) LECM
B) 2606010000 C) 2606012359
E) TRA 'DFN-26 ZONA E' ACTIVADA SEGUN SUP 093/26.
F) SFC
G) FL100
`;

const ACT_ES_ALL = `A1485/26
Q) LECM/QRTCA/IV/BO/AW/000/100/4025N00348W020
A) LECM
B) 2606010000 C) 2606012359
E) AREAS RESERVADAS ACTIVADAS SEGUN SUP 093/26.
F) SFC
G) FL100
`;

const ACT_LOURDES = `R1484/26
Q) LFBB/QRTCA/IV/BO/AW/000/055/4305N00003W005
A) LFBT
B) 2606010000 C) 2606012359
E) AIP SUP 093/26 : 'ZRT LOURDES' ACT
F) SFC
G) 5500FT AMSL
`;

// Trigger framework citing the same SUP; QRTTT is not an activation, so it
// reads as a reference, never an activation.
const FRAMEWORK_LOURDES = `R1420/26
Q) LFBB/QRTTT/IV/BO/AW/000/055/4305N00003W005
A) LFBT
B) 2606010000 C) 2606012359
E) TRIGGER NOTAM - AIP SUP 093/26.
CREATION OF A TEMPORARY RESTRICTED AREA AROUND LOURDES.
F) SFC
G) 5500FT AMSL
`;

// Obstacle NOTAM that merely refers to the SUP; not an activation.
const OBSTACLE_LOURDES = `D1500/26
Q) LFBB/QOBCE/IV/M/A/000/005/4305N00003W001
A) LFBT
B) 2606010000 C) 2606012359
E) CRANE ERECTED. REF AIP SUP 093/26.
F) SFC
G) 200FT AGL
`;

// Activation citing TWO supplements with no zone-name match: else-all on both.
const ACT_MULTI = `R1490/26
Q) LFEE/QRTCA/IV/BO/AW/000/075/4835N00557E007
A) LFSO
B) 2606010000 C) 2606012359
E) AIP SUP 167/25 AND AIP SUP 093/26 ACTIVATED.
F) SFC
G) FL075
`;

describe('SUP AIP activation links (stubbed dataset)', () => {
	beforeAll(async () => {
		vi.stubGlobal(
			'fetch',
			// ensureSupaip fetches BOTH the FR and BE files: serve the fixture
			// for the FR URL only, and an empty dataset for everything else, so
			// no supplement loads twice (a duplicate would double every zone in
			// supaipZonesAt's ungated visible loop).
			vi.fn((url: unknown) => Promise.resolve({
				ok: true,
				status: 200,
				headers: { get: () => 'application/json' },
				json: () => Promise.resolve(
					String(url).includes('fr-supaip')
						? RAW
						: String(url).includes('es-supaip')
							? ES_RAW
							: { fields: [], rows: [] },
				),
			})),
		);
		await ensureSupaip();
	});

	afterAll(() => {
		vi.unstubAllGlobals();
	});

	describe('activatesSupZones (forward, qCode-gated, no time filter)', () => {
		it('returns the named zone for a single-SUP activation', () => {
			const zones = activatesSupZones(parseNotams(ACT_LOURDES)[0]);
			expect(zones.map((z) => `${z.sup.id}#${z.zoneIndex}`)).toEqual([
				'metropole-2026-093#0',
			]);
		});

		it('else-all across BOTH supplements for a multi-SUP activation', () => {
			const zones = activatesSupZones(parseNotams(ACT_MULTI)[0]);
			expect(zones.map((z) => `${z.sup.title}#${z.zoneIndex}:${z.zone.name}`)).toEqual([
				'167/2025#0:OCHEY',
				'167/2025#1:TOUL',
				'093/2026#0:ZRT LOURDES',
				'093/2026#1:ZRT TARBES',
			]);
		});

		it('is empty for a non-activation NOTAM (qCode gate)', () => {
			expect(activatesSupZones(parseNotams(FRAMEWORK_LOURDES)[0])).toEqual([]);
			expect(activatesSupZones(parseNotams(OBSTACLE_LOURDES)[0])).toEqual([]);
		});

		it('resolves a Spanish citation in the Spanish namespace', () => {
			const zones = activatesSupZones(parseNotams(ACT_ES_NAMED)[0]);
			expect(zones.map((z) => `${z.sup.id}#${z.zoneIndex}`)).toEqual([
				'es-2026-093#0',
			]);
		});

		it('else-alls a Spanish activation that names no zone', () => {
			const zones = activatesSupZones(parseNotams(ACT_ES_ALL)[0]);
			expect(zones.map((z) => z.zone.name)).toEqual([
				'DFN-26 ZONA E',
				'DFN-26 ZONA C',
			]);
		});

		it('keeps the two publishers\' 093/2026 apart', () => {
			// The French NOTAM cites the same number and must still reach
			// only the French supplement.
			const fr = activatesSupZones(parseNotams(ACT_LOURDES)[0]);
			expect(fr.every((z) => z.sup.region === 'metropole')).toBe(true);
			const es = activatesSupZones(parseNotams(ACT_ES_NAMED)[0]);
			expect(es.every((z) => z.sup.region === 'es')).toBe(true);
		});
	});

	describe('reverse links (time-gated)', () => {
		beforeEach(() => {
			notamState.notams = [];
			// Fixed eval window over the synthetic 2026-06-01 activation windows, so
			// the assertions don't depend on wall-clock time.
			filter.window.mode = 'custom';
			filter.window.fromDate = '2026-06-01';
			filter.window.fromTime = '00:00';
			filter.window.toDate = '2026-06-02';
			filter.window.toTime = '00:00';
			filter.altitude.enabled = false;
		});

		afterEach(() => {
			filter.window.mode = 'now';
			filter.altitude.enabled = true;
			notamState.notams = [];
		});

		function seed(...texts: string[]): void {
			notamState.notams = texts.flatMap((t) => parseNotams(t));
			notamState.parsedAt = Date.now();
		}

		it('hatches only the named zone (supZoneActivations key)', () => {
			seed(ACT_LOURDES);
			expect([...supZoneActivations().keys()]).toEqual(['metropole-2026-093#0']);
		});

		it('hatches the Spanish zone from its own namespace', () => {
			seed(ACT_ES_NAMED);
			expect([...supZoneActivations().keys()]).toEqual(['es-2026-093#0']);
		});

		it('lists the activation under "Activated by"', () => {
			seed(ACT_LOURDES, FRAMEWORK_LOURDES, OBSTACLE_LOURDES);
			const sup = supaipByRef(93, 2026);
			expect(activatedNotamsForSup(sup).map((it) => it.notam.id)).toEqual([
				'R1484/26',
			]);
		});

		it('splits referenced-not-activated into "Referenced by"', () => {
			seed(ACT_LOURDES, FRAMEWORK_LOURDES, OBSTACLE_LOURDES);
			expect(notamsReferencingSup(93, 2026).map((it) => it.notam.id)).toEqual([
				'R1420/26',
				'D1500/26',
			]);
		});

		it('drops the hatch once the activation window leaves the eval range', () => {
			seed(ACT_LOURDES);
			// Move the filter to a day before the NOTAM's B) window.
			filter.window.fromDate = '2026-05-01';
			filter.window.toDate = '2026-05-02';
			expect([...supZoneActivations().keys()]).toEqual([]);
			// The panel list, which is NOT time-gated, still resolves the link.
			expect(activatesSupZones(parseNotams(ACT_LOURDES)[0])).toHaveLength(1);
		});

		it('keeps an activated zone listed AND clickable with the SUP layer OFF', () => {
			seed(ACT_LOURDES);
			const prev = layers.supaip;
			layers.supaip = false;
			try {
				// The context-menu gather is a location query, ungated by the
				// display-only layer toggle, so the zone lists regardless; the
				// left-click hit (supaipAt) also resolves it because the magenta
				// activation hatch is drawn on screen, mirroring the
				// activated-airspace exception.
				const hits = supaipZonesAt(43.1, 0.0);
				expect(hits.map((h) => `${h.sup.id}#${h.zoneIndex}`)).toEqual([
					'metropole-2026-093#0',
				]);
				const click = supaipAt(43.1, 0.0);
				expect(click && `${click.sup.id}#${click.zoneIndex}`).toBe(
					'metropole-2026-093#0',
				);
			} finally {
				layers.supaip = prev;
			}
		});

		it('with the layer OFF a non-activated zone lists in the menu but takes no click', () => {
			seed(FRAMEWORK_LOURDES); // reference only, never an activation
			const prev = layers.supaip;
			layers.supaip = false;
			try {
				// Menu (ungated): the date-visible zone is listed as a location fact.
				expect(
					supaipZonesAt(43.1, 0.0).map((h) => `${h.sup.id}#${h.zoneIndex}`),
				).toEqual(['metropole-2026-093#0']);
				// Left-click (WYSIWYG): nothing of it is drawn, so nothing is clickable.
				expect(supaipAt(43.1, 0.0)).toBeNull();
			} finally {
				layers.supaip = prev;
			}
		});
	});
});

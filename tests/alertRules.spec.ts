import { describe, it, expect } from 'vitest';
import {
	airspaceVolumes,
	notamVolumes,
	supActivationWindows,
	supaipVolumes,
	type AlertVolume,
} from '$lib/nav/alertVolumes';
import {
	NO_ENTRY,
	remarkCondition,
	type EntryCondition,
	type EntryConditions,
} from '$lib/data/airspaceEntry';
import {
	ACTION_RANK,
	classifyVolume,
	tierPref,
	type ActivityState,
} from '$lib/nav/alertRules';
import { isForbiddenCrossing } from '$lib/route/routeProfile';
import type { Airspace } from '$lib/data/airspaces';
import type { SupAip } from '$lib/data/supaip';
import type { Notam } from '$lib/notam/types';
import { airspaceCategory } from '$lib/data/airspaces';
import { ringBbox } from '$lib/notam/geometry';

const RING: [number, number][] = [
	[0, 0],
	[0, 1],
	[1, 1],
	[1, 0],
];

function mkAirspace(over: Partial<Airspace>): Airspace {
	const type = over.type ?? 'R';
	const ring = over.ring ?? RING;
	return {
		id: 'LFR1',
		key: 'LFR1|R 1',
		type,
		name: 'R 1',
		airClass: '',
		upper: null,
		lower: null,
		vUpper: { ft: 3000, ref: 'AMSL', value: 3000, unit: 'ft' },
		vLower: { ft: 0, ref: 'AGL', value: 0, unit: 'ft', sfc: true },
		vMax: null,
		vMnm: null,
		workHr: '',
		rmkWorkHr: '',
		rmk: '',
		entry: NO_ENTRY,
		radio: [],
		ring,
		subtype: '',
		category: airspaceCategory(type),
		source: 'fr',
		area: 1,
		bbox: ringBbox(ring),
		...over,
	};
}

function vol(over: Partial<AlertVolume>): AlertVolume {
	return {
		key: 'k',
		id: 'k',
		name: 'X',
		source: 'airspace',
		rings: [RING],
		circles: [],
		bbox: ringBbox(RING),
		vLower: null,
		vUpper: null,
		knownExtent: true,
		extent: 'known',
		type: '',
		airClass: '',
		category: 'controlled',
		entry: NO_ENTRY,
		rtba: false,
		qSubject: '',
		supKind: '',
		supIfrOnly: false,
		radios: [],
		activity: { kind: 'permanent' },
		...over,
	};
}

const VFR = { vfr: true };
const IFR = { vfr: false };

/** LF-R 275's shape: permanently in force, VFR must avoid, IFR may enter on
 *  radio contact with one of the administrators. */
const PERMANENT_VFR_NOGO: EntryConditions = { vfr: 'forbidden', ifr: 'radio', permanent: true };
/** The entry axis of the equality pin below: nothing read, the LF-R 275
 *  shape, and each condition on its own. */
const ENTRIES: EntryConditions[] = [
	NO_ENTRY,
	PERMANENT_VFR_NOGO,
	{ vfr: 'forbidden', ifr: 'forbidden', permanent: false },
	{ vfr: 'clearance', ifr: 'clearance', permanent: false },
	{ vfr: 'radio', ifr: 'radio', permanent: false },
	{ vfr: 'radio-ats', ifr: 'radio-ats', permanent: true },
];

describe('airspaceVolumes', () => {
	it('skips the information tier and keeps the classification inputs', () => {
		const rows = [
			mkAirspace({ key: 'a', type: 'FIR', id: 'LFFF' }),
			mkAirspace({ key: 'b', type: 'SIV', id: 'SEINE' }),
			mkAirspace({ key: 'c', type: 'FIC', id: 'PARIS' }),
			mkAirspace({ key: 'd', type: 'CTR', id: 'LFPT', airClass: 'D' }),
		];
		const vols = airspaceVolumes(rows);
		expect(vols.map((v) => v.key)).toEqual(['d']);
		expect(vols[0].airClass).toBe('D');
		expect(vols[0].category).toBe('controlled');
	});

	it('leads the label with the charted type designation', () => {
		const label = (over: Partial<Airspace>): string =>
			airspaceVolumes([mkAirspace(over)])[0].name;
		expect(label({ type: 'P', id: 'LFP23', key: 'LFP23|23', name: '23' })).toBe('P 23');
		expect(label({ name: 'R 1' })).toBe('R 1');
		expect(label({ type: 'W', name: 'W-291' })).toBe('W-291');
		expect(label({ type: 'TMA', airClass: 'D', name: 'ROUEN 1' })).toBe('TMA ROUEN 1');
		expect(label({ type: 'PARACHUTE', name: 'PARACHUTAGE DE GAP' })).toBe('PARACHUTAGE DE GAP');
	});

	it('parses the R-zone entry condition, avoidance dominant', () => {
		// LF-R 324: entry permitted, mandatory listening watch, and the clause
		// itself exempts aircraft already working an ATS frequency.
		expect(
			remarkCondition(
				'Entry conditions :#\nGAT / OAT : for purposes of identification, for radio-equipped ACFT, except during listening or trafic period on a frequency A/A, ATS or ATC required for  conduct of the flight, standby of frequency 120.075 MHz is mandatory.',
			),
		).toBe('radio-ats');
		// The Lyon R 32xx family: entry after radio contact, no exemption, so
		// the requirement stands whatever the flight is already working.
		expect(
			remarkCondition(
				'Administrator : LYON APP#OAT/GAT : entry after radio contact with LYON APP,  mandatory radio listening watch and transponder.',
			),
		).toBe('radio');
		// An authorization gate is the clearance tier.
		expect(
			remarkCondition('IFR/VFR/OAT: upon COGNAC APP authorisation during activity hours.'),
		).toBe('clearance');
		// A per-profile split buries a watch inside an avoidance rule: read as
		// one clause, the strictest phrase grades. (The per-category reading
		// that separates the two halves is parseEntryConditions.)
		expect(
			remarkCondition(
				'GAT IFR: Avoidance mandatory.#GAT VFR, OAT: mandatory STRASBOURG APP listening watch.',
			),
		).toBe('forbidden');
		expect(remarkCondition('Pénétration interdite pendant l’activité.')).toBe('forbidden');
		// The word orders the SIA actually uses are all the same statement.
		expect(remarkCondition('VFR GAT flights:\nCompulsory avoidance except for ACFT ...')).toBe(
			'forbidden',
		);
		expect(remarkCondition('GAT IFR / OAT I and T :#Mandatory avoidance except for ACFT')).toBe(
			'forbidden',
		);
		expect(remarkCondition('IFR GAT: Avoidance compulsory unless further authorization')).toBe(
			'forbidden',
		);
		// A zone reserved to a named group is not enterable on a clearance.
		expect(
			remarkCondition(
				'- VFR : entry strictly reserved for pilots of flying clubs which signed a protocol with the managing authority and their duly informed guests.',
			),
		).toBe('forbidden');
		// A parenthesis qualifies the clause, it is not the clause: LF-R 41
		// gates everyone on an authorization and only the non-radio aircraft
		// on avoidance.
		expect(
			remarkCondition(
				'GAT/OAT: entry subject to MADIRAN authorization 129.900 MHz (during activity, ACFT without radio bypassing mandatory).',
			),
		).toBe('clearance');
		// TFR 2: the radio phrase describes the hazard (traffic you cannot
		// talk to), it is not a requirement to call anyone.
		expect(
			remarkCondition(
				'- VFR/OAT : except ACFT of companies which signed a protocol with the managing authority and their duty informed guests, avoidance recommended due to the presence of ACFT without any radio contact nor any transponder onboard.',
			),
		).toBeNull();
		expect(remarkCondition('Activity known on: Luxeuil APP 129.925')).toBeNull();
		expect(remarkCondition('')).toBeNull();
		// The extraction is type-gated at the loader: only an R row carries
		// conditions, and a volume shows what its row was parsed with.
		const vols = airspaceVolumes([
			mkAirspace({
				workHr: 'H24',
				entry: { vfr: 'radio', ifr: 'radio', permanent: true },
			}),
			mkAirspace({ key: 'tma', type: 'TMA', airClass: 'D' }),
		]);
		expect(vols[0].entry).toEqual({ vfr: 'radio', ifr: 'radio', permanent: true });
		expect(vols[1].entry).toEqual(NO_ENTRY);
	});

	it('resolves the activity model from the published hours', () => {
		const kinds = (over: Partial<Airspace>): string =>
			airspaceVolumes([mkAirspace(over)])[0].activity.kind;
		expect(kinds({ workHr: 'H24' })).toBe('permanent');
		expect(kinds({ workHr: 'NOTAM' })).toBe('notam');
		// The UK free-text form still names the NOTAM mechanism.
		expect(kinds({ workHr: 'Activated by NOTAM 24HR in advance' })).toBe('notam');
		expect(kinds({ workHr: 'HX' })).toBe('unknown');
		expect(kinds({ workHr: '' })).toBe('unknown');
		// RTBA rides its AZBA activation NOTAMs whatever the hours say.
		expect(kinds({ id: 'LFR45C', key: 'LFR45C|R 45 C', workHr: 'HX' })).toBe('notam');
		// Controlled airspace's requirement holds whenever it exists.
		expect(kinds({ type: 'TMA', airClass: 'D', workHr: 'HJ' })).toBe('permanent');
	});
});

describe('supActivationWindows', () => {
	it('expands a date range into one window per day (strict reading)', () => {
		const w = supActivationWindows([
			{ date: '2026-07-03', dateTo: '2026-07-05', from: '08:00', to: '12:00' },
		]);
		expect(w).toHaveLength(3);
		expect(new Date(w[0].startMs).toISOString()).toBe('2026-07-03T08:00:00.000Z');
		expect(new Date(w[0].endMs).toISOString()).toBe('2026-07-03T12:00:00.000Z');
		expect(new Date(w[2].startMs).toISOString()).toBe('2026-07-05T08:00:00.000Z');
	});

	it('rolls an overnight slot past midnight and defaults empty times to all day', () => {
		const night = supActivationWindows([
			{ date: '2026-07-03', from: '22:30', to: '01:00' },
		]);
		expect(new Date(night[0].endMs).toISOString()).toBe('2026-07-04T01:00:00.000Z');
		const allDay = supActivationWindows([{ date: '2026-07-03' }]);
		expect(new Date(allDay[0].startMs).toISOString()).toBe('2026-07-03T00:00:00.000Z');
		expect(new Date(allDay[0].endMs).toISOString()).toBe('2026-07-04T00:00:00.000Z');
	});
});

function mkSup(over: Partial<SupAip>): SupAip {
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
		validFrom: '2026-07-01',
		validTo: '2026-07-20',
		ifr: true,
		vfr: true,
		airac: false,
		fir: [],
		adhp: [],
		zones: [],
		bbox: null,
		geometrySource: 'pdf-polygon',
		parseConfidence: 'high',
		warnings: [],
		contacts: [],
		penetration: null,
		manager: '',
		...over,
	};
}

describe('supaipVolumes', () => {
	it('grades by zone-name token, then the penetration rule', () => {
		const sup = mkSup({
			penetration: { kind: 'conditional', text: '' },
			zones: [
				{
					name: 'ZIT FOO',
					geometry: { type: 'polygon', ring: RING },
					bbox: ringBbox(RING),
					lower: null,
					upper: null,
					vLower: null,
					vUpper: null,
					geometrySource: 'pdf-polygon',
					sameAs: '',
					activations: [],
				},
				{
					name: 'TMA TEMPORAIRE',
					geometry: { type: 'circle', center: [48, 2], radiusM: 5000 },
					bbox: { minLat: 47.9, minLon: 1.9, maxLat: 48.1, maxLon: 2.1 },
					lower: null,
					upper: null,
					vLower: null,
					vUpper: null,
					geometrySource: 'pdf-circle',
					sameAs: '',
					activations: [{ date: '2026-07-03', from: '08:00', to: '12:00' }],
				},
			],
		});
		const vols = supaipVolumes([sup]);
		expect(vols).toHaveLength(2);
		expect(vols[0].supKind).toBe('zit');
		// Empty activations fall back to the supplement validity as one window.
		expect(vols[0].activity.kind).toBe('windows');
		expect(vols[1].supKind).toBe('conditional');
		expect(vols[1].circles).toHaveLength(1);
		expect(vols[1].activity).toEqual({
			kind: 'windows',
			windows: [
				{
					startMs: Date.UTC(2026, 6, 3, 8, 0),
					endMs: Date.UTC(2026, 6, 3, 12, 0),
				},
			],
		});
	});
});

function mkNotam(over: Partial<Notam>): Notam {
	return {
		id: 'A0001/26',
		qCode: 'QRTCA',
		isPolygon: true,
		coordinates: [
			{ lat: 0, lon: 0 },
			{ lat: 0, lon: 1 },
			{ lat: 1, lon: 1 },
		],
		fgLower: null,
		fgUpper: null,
		qualifier: null,
		startDate: new Date('2026-07-01T00:00:00Z'),
		endDate: new Date('2026-07-30T00:00:00Z'),
		permanent: false,
		...over,
	} as unknown as Notam;
}

describe('notamVolumes', () => {
	it('keeps restriction and warning families with published geometry only', () => {
		const vols = notamVolumes([
			mkNotam({}),
			mkNotam({ id: 'B0002/26', qCode: 'QWULW' }),
			mkNotam({ id: 'C0003/26', qCode: 'QOBCE' }),
			// Q-line circle only: a radius of influence, never a volume.
			mkNotam({
				id: 'D0004/26',
				isPolygon: false,
				coordinates: [{ type: 'qualifierLine', lat: 0, lon: 0, radius: 25, radiusUnit: 'NM' }],
			} as unknown as Partial<Notam>),
		]);
		expect(vols.map((v) => v.id).sort()).toEqual(['A0001/26', 'B0002/26']);
		expect(vols.find((v) => v.id === 'A0001/26')?.qSubject).toBe('RT');
	});

	it('unions a multi-area NOTAM into one volume and carries validity windows', () => {
		const second: [number, number][] = [
			[2, 2],
			[2, 3],
			[3, 3],
		];
		const vols = notamVolumes([
			mkNotam({}),
			mkNotam({ coordinates: second.map(([lat, lon]) => ({ lat, lon })) } as unknown as Partial<Notam>),
			mkNotam({ id: 'P0005/26', qCode: 'QRRCA', permanent: true }),
		]);
		const merged = vols.find((v) => v.id === 'A0001/26');
		expect(merged?.rings).toHaveLength(2);
		expect(merged?.activity).toEqual({
			kind: 'windows',
			windows: [
				{
					startMs: Date.parse('2026-07-01T00:00:00Z'),
					endMs: Date.parse('2026-07-30T00:00:00Z'),
				},
			],
		});
		expect(vols.find((v) => v.id === 'P0005/26')?.activity).toEqual({ kind: 'permanent' });
	});
});

describe('classifyVolume: the tier table', () => {
	const cases: [Partial<AlertVolume>, ActivityState, boolean, string][] = [
		// Unconditional prohibitions (the isForbiddenCrossing set).
		[{ type: 'P', category: 'restricted' }, 'cold', true, 'avoid'],
		[{ airClass: 'A' }, 'active', true, 'avoid'],
		[{ airClass: 'A' }, 'active', false, 'none'],
		// LF-R 275: permanently in force, so it answers even when the
		// activation model has nothing to call hot, and only for VFR.
		[
			{ type: 'R', category: 'restricted', entry: PERMANENT_VFR_NOGO },
			'cold',
			true,
			'avoid',
		],
		[
			{ type: 'R', category: 'restricted', entry: PERMANENT_VFR_NOGO },
			'cold',
			false,
			'radio',
		],
		// RTBA: the windows are authoritative, cold is silent, never a caution.
		[{ type: 'R', category: 'restricted', rtba: true }, 'active', true, 'avoid'],
		[{ type: 'R', category: 'restricted', rtba: true }, 'cold', true, 'none'],
		// Unknown is not cold: no briefing means no AZBA windows to be
		// authoritative, so the network earns the general unknown-schedule
		// caution instead of the silence a briefing would justify.
		[{ type: 'R', category: 'restricted', rtba: true }, 'unknown', true, 'caution'],
		// R / TSA active are segregated; unknown schedules earn a caution.
		[{ type: 'R', category: 'restricted' }, 'active', true, 'avoid'],
		[{ type: 'R', category: 'restricted' }, 'unknown', true, 'caution'],
		[{ type: 'R', category: 'restricted' }, 'cold', true, 'none'],
		[{ type: 'TSA', category: 'transit' }, 'active', true, 'avoid'],
		[{ type: 'TRA', category: 'transit' }, 'active', true, 'clearance'],
		[{ type: 'TRA', category: 'transit' }, 'cold', true, 'none'],
		// Danger and the hazard family inform, they never forbid (Annex 15).
		[{ type: 'D', category: 'restricted' }, 'active', true, 'caution'],
		[{ type: 'D', category: 'restricted' }, 'unknown', true, 'caution'],
		[{ type: 'D', category: 'restricted' }, 'cold', true, 'none'],
		[{ type: 'MOA', category: 'restricted' }, 'unknown', true, 'caution'],
		// Equipment zones (SERA.6005), suppressed under IFR.
		[{ type: 'TMZ', category: 'trafficmgmt' }, 'active', true, 'transponder'],
		[{ type: 'RMZ', category: 'trafficmgmt' }, 'active', true, 'radio'],
		[{ type: 'TMZ-RMZ', category: 'trafficmgmt' }, 'active', true, 'radio'],
		[{ type: 'RMZ', category: 'trafficmgmt' }, 'active', false, 'none'],
		// Activity zones are hazard information for both profiles.
		[{ type: 'PARACHUTE', category: 'activity' }, 'active', true, 'caution'],
		[{ type: 'PARACHUTE', category: 'activity' }, 'active', false, 'caution'],
		// The clearance tier: class-driven, VFR only.
		[{ type: 'ATZ', airClass: 'G' }, 'active', true, 'clearance'],
		[{ type: 'TMA', airClass: 'D' }, 'active', true, 'clearance'],
		[{ type: 'TMA', airClass: 'D' }, 'active', false, 'none'],
		[{ type: 'CTR', airClass: '' }, 'active', true, 'clearance'],
		[{ type: 'TMA', airClass: 'E' }, 'active', true, 'none'],
		[{ type: 'TRSA', airClass: '' }, 'active', true, 'none'],
		[{ type: 'FIR', category: 'fir' }, 'active', true, 'none'],
		[{ type: 'SIV', category: 'siv' }, 'active', true, 'none'],
	];
	it.each(cases)('%o act=%s vfr=%s -> %s', (over, act, vfr, want) => {
		expect(classifyVolume(vol(over), act, vfr ? VFR : IFR)).toBe(want);
	});

	// docs/nav-alerts.md: "The avoid tier equals the route profile's
	// isForbiddenCrossing set, so the live banner and the briefed profile
	// crossings can never disagree about what is forbidden." An active TSA
	// drifted out of the profile's half of that equality once, while 76 TSA
	// rows shipped in the be / at / es datasets; this pins the two together.
	it('the avoid tier equals the route profile forbidden-crossing set', () => {
		const types: [string, AlertVolume['category']][] = [
			['P', 'restricted'],
			['R', 'restricted'],
			['TSA', 'transit'],
			['TFR', 'restricted'],
			['TRA', 'transit'],
			['D', 'restricted'],
			['CTR', 'controlled'],
			['MOA', 'restricted'],
		];
		for (const [type, category] of types) {
			for (const act of ['active', 'cold'] as ActivityState[]) {
				for (const vfr of [true, false]) {
					for (const rtba of [false, true]) {
						for (const entry of ENTRIES) {
							const v = vol({ type, category, rtba, entry });
							const band = { type, airClass: '', rtba, prohibited: false, entry };
							const cell = [type, act, vfr, rtba, JSON.stringify(entry)];
							expect(
								[...cell, classifyVolume(v, act, vfr ? VFR : IFR) === 'avoid'].join('|'),
							).toBe(
								[
									...cell,
									isForbiddenCrossing(band, { vfr, active: act === 'active' }),
								].join('|'),
							);
						}
					}
				}
			}
		}
	});

	it('grades an active R by its published entry condition', () => {
		const r = (cond: EntryCondition | null): AlertVolume =>
			vol({
				type: 'R',
				category: 'restricted',
				entry: { vfr: cond, ifr: cond, permanent: false },
			});
		// LF-R 324: a listening-watch condition whose own text exempts an
		// aircraft already working an ATS frequency, which an IFR flight is.
		expect(classifyVolume(r('radio-ats'), 'active', VFR)).toBe('radio');
		expect(classifyVolume(r('radio-ats'), 'active', IFR)).toBe('none');
		// A contact requirement with no such exemption (LF-R 275's "entry
		// allowed when radio contact established with one of the
		// administrators") binds both rules; the tier is the quiet one.
		expect(classifyVolume(r('radio'), 'active', VFR)).toBe('radio');
		expect(classifyVolume(r('radio'), 'active', IFR)).toBe('radio');
		expect(classifyVolume(r('clearance'), 'active', VFR)).toBe('clearance');
		expect(classifyVolume(r('clearance'), 'active', IFR)).toBe('clearance');
		expect(classifyVolume(r('forbidden'), 'active', VFR)).toBe('avoid');
		expect(classifyVolume(r(null), 'active', VFR)).toBe('avoid');
		// Cold and unknown states are untouched by the condition.
		expect(classifyVolume(r('radio'), 'cold', VFR)).toBe('none');
		expect(classifyVolume(r('radio'), 'unknown', VFR)).toBe('caution');
		// RTBA doctrine outranks any parsed condition.
		expect(
			classifyVolume(
				vol({
					type: 'R',
					category: 'restricted',
					rtba: true,
					entry: { vfr: 'radio', ifr: 'radio', permanent: false },
				}),
				'active',
				VFR,
			),
		).toBe('avoid');
	});

	it('grades an active R per traffic category, each by its own clause', () => {
		// LF-R 275 PARIS, verbatim from AIP France ENR 5.1: "IFR GAT / OAT:
		// entry allowed when radio contact established with one of the
		// administrators. / VFR GAT : avoidance mandatory except for : ..."
		const r275 = vol({
			type: 'R',
			category: 'restricted',
			entry: PERMANENT_VFR_NOGO,
		});
		expect(classifyVolume(r275, 'active', VFR)).toBe('avoid');
		expect(classifyVolume(r275, 'active', IFR)).toBe('radio');
		// LF-R 8 NIMES GARONS, the other polarity: VFR entry on a transponder
		// and a radio call, IFR avoidance mandatory.
		const r8 = vol({
			type: 'R',
			category: 'restricted',
			entry: { vfr: 'radio', ifr: 'forbidden', permanent: false },
		});
		expect(classifyVolume(r8, 'active', VFR)).toBe('radio');
		expect(classifyVolume(r8, 'active', IFR)).toBe('avoid');
	});

	it('grades SUP AIP zones by kind, active only', () => {
		const sup = (k: AlertVolume['supKind']): AlertVolume =>
			vol({ source: 'supaip', supKind: k, category: '' });
		expect(classifyVolume(sup('zit'), 'active', VFR)).toBe('avoid');
		expect(classifyVolume(sup('forbidden'), 'active', VFR)).toBe('avoid');
		expect(classifyVolume(sup('zrt'), 'active', VFR)).toBe('clearance');
		expect(classifyVolume(sup('conditional'), 'active', VFR)).toBe('clearance');
		expect(classifyVolume(sup('circumvent'), 'active', VFR)).toBe('caution');
		expect(classifyVolume(sup('zit'), 'cold', VFR)).toBe('none');
		expect(classifyVolume(sup('zit'), 'unknown', VFR)).toBe('caution');
		// A ZRT binds IFR traffic too: no IFR suppression outside the
		// class-driven tier.
		expect(classifyVolume(sup('zrt'), 'active', IFR)).toBe('clearance');
		expect(
			classifyVolume(vol({ source: 'supaip', supKind: 'zrt', supIfrOnly: true, category: '' }), 'active', VFR),
		).toBe('none');
	});

	it('grades NOTAM volumes by Q subject, in force only', () => {
		const nv = (q: string): AlertVolume =>
			vol({ source: 'notam', qSubject: q, category: '' });
		expect(classifyVolume(nv('RP'), 'active', VFR)).toBe('avoid');
		expect(classifyVolume(nv('RR'), 'active', VFR)).toBe('avoid');
		expect(classifyVolume(nv('RT'), 'active', VFR)).toBe('clearance');
		expect(classifyVolume(nv('RT'), 'active', IFR)).toBe('clearance');
		expect(classifyVolume(nv('RD'), 'active', VFR)).toBe('caution');
		expect(classifyVolume(nv('WU'), 'active', VFR)).toBe('caution');
		expect(classifyVolume(nv('RP'), 'cold', VFR)).toBe('none');
	});

	it('ranks avoid over clearance over equipment over caution', () => {
		expect(ACTION_RANK.avoid).toBeGreaterThan(ACTION_RANK.clearance);
		expect(ACTION_RANK.clearance).toBeGreaterThan(ACTION_RANK.radio);
		expect(ACTION_RANK.radio).toBeGreaterThan(ACTION_RANK.caution);
		expect(ACTION_RANK.caution).toBeGreaterThan(ACTION_RANK.none);
		expect(tierPref('avoid')).toBe('avoid');
		expect(tierPref('transponder')).toBe('equipment');
		expect(tierPref('none')).toBeNull();
	});
});

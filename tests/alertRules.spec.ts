import { readFileSync } from 'node:fs';
import { beforeAll, describe, it, expect, vi } from 'vitest';
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
import { loadSupAip, SUPAIP_URL, type SupAip } from '$lib/data/supaip';
import type { Notam } from '$lib/notam/types';
import { airspaceCategory, rowToAirspace } from '$lib/data/airspaces';
import { ringBbox } from '$lib/notam/geometry';
import { resolveActivity, rulePeriods, type ActivePeriod } from '$lib/data/activity';

const RING: [number, number][] = [
	[0, 0],
	[0, 1],
	[1, 1],
	[1, 0],
];

/** Every period a volume's rules hold. */
function periodsOf(v: AlertVolume): ActivePeriod[] {
	return v.activity.rules.flatMap((r) => rulePeriods(r, -Infinity, Infinity, v.activity.sun));
}

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
		publisher: 'fr',
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
		supRule: '',
		supIfrOnly: false,
		radios: [],
		knownFrom: [],
		activity: { rules: [{ mode: 'firm' }] },
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
	{ vfr: 'exempt', ifr: 'exempt', permanent: true },
	{ vfr: null, ifr: 'exempt', permanent: true },
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
			airspaceVolumes([mkAirspace(over)])[0].activity.rules.map((r) => r.mode).join();
		// A firm rule with no bounds: the zone holds at all times.
		expect(kinds({ workHr: 'H24' })).toBe('firm');
		// Coded H24, its remark saying it may be activated in them (LF-R 151).
		expect(kinds({ workHr: 'H24', rmkWorkHr: 'Possible activation H24.' })).toBe('activable');
		// skeyes and the FAA word it their own way.
		expect(kinds({ workHr: 'PERM' })).toBe('firm');
		expect(kinds({ workHr: 'CONTINUOUS' })).toBe('firm');
		expect(kinds({ workHr: 'NOTAM' })).toBe('notam');
		// The UK free-text form still names the NOTAM mechanism.
		expect(kinds({ workHr: 'Activated by NOTAM 24HR in advance' })).toBe('notam');
		expect(kinds({ workHr: 'HX' })).toBe('unread');
		expect(kinds({ workHr: '' })).toBe('unread');
		// RTBA rides its AZBA activation NOTAMs whatever the hours say.
		expect(kinds({ id: 'LFR45C', key: 'LFR45C|R 45 C', workHr: 'HX' })).toBe('notam');
		// Controlled airspace's requirement holds whenever it exists.
		expect(kinds({ type: 'TMA', airClass: 'D', workHr: 'HJ' })).toBe('firm');
	});

	it('reads the published hours of a French zone, the RTBA silent outside its slots', () => {
		const rows = (
			JSON.parse(readFileSync('public/data/fr-airspaces.json', 'utf8')) as { rows: unknown[][] }
		).rows;
		const a = rowToAirspace(rows.find((r) => r[0] === 'LFR590A') ?? [], 'fr') as Airspace;
		const [v] = airspaceVolumes([a]);
		const at = (t: number) => {
			const act = resolveActivity({ ...v.activity, rtba: true, briefed: false }, t, t);
			return [act.state, classifyVolume(v, act.state, VFR)];
		};
		// A Sunday, outside every slot: inactive before any briefing, silent.
		expect(at(Date.UTC(2026, 10, 22, 10))).toEqual(['inactive', 'none']);
		// Monday 09:00Z, in its 08:30-11:00 slot: may be active, a caution.
		expect(at(Date.UTC(2026, 10, 23, 9))).toEqual(['activable', 'caution']);
	});

	it('grades LF-R 151 caution from the shipped row, and keeps it off the NO-GO set', () => {
		const rows = (
			JSON.parse(readFileSync('public/data/fr-airspaces.json', 'utf8')) as { rows: unknown[][] }
		).rows;
		const a = rowToAirspace(rows.find((r) => r[0] === 'LFR151') ?? [], 'fr') as Airspace;
		expect(a).not.toBeNull();
		const [v] = airspaceVolumes([a]);
		const act = resolveActivity({ ...v.activity, briefed: false }, Date.UTC(2026, 10, 23, 10), Date.UTC(2026, 10, 23, 10));
		expect([act.state, act.reason]).toEqual(['activable', 'activable']);
		expect(classifyVolume(v, act.state, VFR)).toBe('caution');
		const band = { type: 'R', airClass: '', rtba: false, prohibited: false, entry: a.entry };
		expect(isForbiddenCrossing(band, { vfr: true, active: false })).toBe(false);
		expect(isForbiddenCrossing(band, { vfr: true, active: true })).toBe(true);
	});

	it('grades EBR11 TIHANGE avoid from the shipped row, with no briefing', () => {
		const rows = (
			JSON.parse(readFileSync('public/data/be-airspaces.json', 'utf8')) as { rows: unknown[][] }
		).rows;
		const a = rowToAirspace(rows.find((r) => r[0] === 'EBR11') ?? [], 'be');
		expect(a).not.toBeNull();
		const [v] = airspaceVolumes([a as Airspace]);
		expect(v.activity).toEqual({ rules: [{ mode: 'firm' }] });
		expect(classifyVolume(v, 'active', VFR)).toBe('avoid');
		expect(classifyVolume(v, 'active', IFR)).toBe('avoid');
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

	it('reads a range with no hours as one window to its last day', () => {
		// 246/2026's ZRT BLAYE - LESPARRE-MEDOC, H24 for 407 days.
		expect(supActivationWindows([{ date: '2026-11-20', dateTo: '2027-12-31' }])).toEqual([
			{ startMs: Date.UTC(2026, 10, 20), endMs: Date.UTC(2028, 0, 1) },
		]);
	});

	it('holds no window on a day the rule takes off', () => {
		// 235/2026's ZRT BARRERE, H24 Monday to Friday off the public
		// holidays: Friday 13 to Thursday 26 November 2026.
		expect(
			supActivationWindows([{ date: '2026-11-13', dateTo: '2026-11-26', days: [1, 2, 3, 4, 5], exceptHolidays: true }]),
		).toEqual([
			{ startMs: Date.UTC(2026, 10, 13), endMs: Date.UTC(2026, 10, 14) },
			{ startMs: Date.UTC(2026, 10, 16), endMs: Date.UTC(2026, 10, 21) },
			{ startMs: Date.UTC(2026, 10, 23), endMs: Date.UTC(2026, 10, 27) },
		]);
		const w = supActivationWindows([
			{ date: '2026-12-23', dateTo: '2026-12-28', from: '09:00', to: '16:00', days: [1, 2, 3, 4, 5], exceptHolidays: true },
		]);
		expect(w.map((x) => new Date(x.startMs).toISOString())).toEqual([
			'2026-12-23T09:00:00.000Z',
			'2026-12-24T09:00:00.000Z',
			'2026-12-28T09:00:00.000Z',
		]);
	});

	it('keeps every day of a long daily schedule', () => {
		// Daily windows over 639 days, the span of 022/2026's ZRT CUIRASSIER.
		const w = supActivationWindows([
			{ date: '2026-03-02', dateTo: '2027-11-30', from: '04:00', to: '23:00' },
		]);
		expect(w).toHaveLength(639);
		expect(w[w.length - 1]).toEqual({
			startMs: Date.UTC(2027, 10, 30, 4, 0),
			endMs: Date.UTC(2027, 10, 30, 23, 0),
		});
	});

	it('reads an impossible time as none', () => {
		expect(supActivationWindows([{ date: '2026-09-24', dateTo: '2026-09-27', from: '30:26', to: '27:10' }])).toEqual([
			{ startMs: Date.UTC(2026, 8, 24), endMs: Date.UTC(2026, 8, 28) },
		]);
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
		phones: [],
		...over,
	};
}

describe('the shipped supplements', () => {
	let sups: SupAip[] = [];
	beforeAll(async () => {
		vi.stubGlobal('fetch', (url: string) =>
			Promise.resolve(
				new Response(readFileSync(new URL(`../public${url}`, import.meta.url), 'utf-8'), {
					headers: { 'content-type': 'application/json' },
				}),
			),
		);
		try {
			sups = await loadSupAip(SUPAIP_URL);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	// 088/2025: five ZRT, "CAM/CAG : contournement obligatoire sauf pour :".
	// 065/2025: a zone whose name carries no token, "CAM et CAG :
	// contournement obligatoire."
	it.each(['metropole-2025-088', 'metropole-2025-065'])('%s zones grade avoid while active', (id) => {
		const sup = sups.find((s) => s.id === id);
		expect(sup).toBeDefined();
		const vols = supaipVolumes([sup as SupAip]);
		expect(vols.length).toBeGreaterThan(0);
		expect(vols.map((v) => classifyVolume(v, 'active', VFR))).toEqual(vols.map(() => 'avoid'));
	});
});

describe('who knows the real activity', () => {
	it('carries the units each publication names', () => {
		const rows = (JSON.parse(readFileSync('public/data/fr-airspaces.json', 'utf8')) as { rows: unknown[][] }).rows;
		const r174 = rowToAirspace(rows.find((r) => r[0] === 'LFR174') ?? [], 'fr') as Airspace;
		expect(airspaceVolumes([r174])[0].knownFrom).toEqual([{ unit: 'BASEL INFO', freq: '130.900', phone: null }]);
		// A supplement's "Activité réelle connue de" units first, then those
		// named for users' information.
		const sup = mkSup({
			contacts: [
				{ unit: 'SEINE INFO', freqs: ['120.325'], users: true },
				{ unit: 'BLOIS INFO', freqs: ['118.455'] },
			],
			zones: [
				{
					name: 'ZRT BLOIS',
					geometry: { type: 'polygon', ring: RING },
					bbox: ringBbox(RING),
					lower: null,
					upper: null,
					vLower: null,
					vUpper: null,
					geometrySource: 'pdf-polygon',
					sameAs: '',
					exclusions: [],
					excluded: [],
					standing: [],
					activations: [],
				},
			],
		});
		expect(supaipVolumes([sup])[0].knownFrom).toEqual([
			{ unit: 'BLOIS INFO', freq: '118.455', phone: null },
			{ unit: 'SEINE INFO', freq: '120.325', phone: null },
		]);
		const [area] = notamVolumes([
			mkNotam({ fullContent: 'R0564/26\nE) 7-INFO :\n  ACTIVITE REELLE CONNUE DE LILLE INFO 132.540MHZ\nF) SFC' }),
		]);
		expect(area.knownFrom).toEqual([{ unit: 'LILLE INFO', freq: '132.540', phone: null }]);
	});
});

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
					exclusions: [],
					excluded: [],
					standing: [],
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
					exclusions: [],
					excluded: [],
					standing: [],
					activations: [{ date: '2026-07-03', from: '08:00', to: '12:00' }],
				},
			],
		});
		const vols = supaipVolumes([sup]);
		expect(vols).toHaveLength(2);
		// The name's token and the supplement's rule ride apart.
		expect([vols[0].supKind, vols[0].supRule]).toEqual(['zit', 'conditional']);
		// Empty activations fall back to the supplement validity as one window.
		expect(periodsOf(vols[0])).toHaveLength(1);
		expect([vols[1].supKind, vols[1].supRule]).toEqual(['', 'conditional']);
		expect(vols[1].circles).toHaveLength(1);
		expect(periodsOf(vols[1])).toEqual([
			{
				startMs: Date.UTC(2026, 6, 3, 8, 0),
				endMs: Date.UTC(2026, 6, 3, 12, 0),
			},
		]);
	});

	function zrt(activations: SupAip['zones'][number]['activations']): SupAip['zones'][number] {
		return {
			name: 'ZRT BLAYE - LESPARRE-MEDOC',
			geometry: { type: 'polygon', ring: RING },
			bbox: ringBbox(RING),
			lower: null,
			upper: null,
			vLower: null,
			vUpper: null,
			geometrySource: 'pdf-polygon',
			sameAs: '',
			exclusions: [],
			excluded: [],
			standing: [],
			activations,
		};
	}

	it('reads a period by the mode its supplement prints', () => {
		// 153/2026's "Activable de SR à SS-1HR", 178/2026's "Activable par
		// NOTAM avec préavis de 48 h", and a period in force.
		const sup = mkSup({
			validFrom: '2026-11-01',
			validTo: '2026-11-30',
			zones: [
				zrt([
					{ date: '2026-11-23', from: '08:00', to: '12:00', mode: 'activable' },
					{ date: '2026-11-24', from: '08:00', to: '12:00', mode: 'notam', noticeMin: 2880 },
					{ date: '2026-11-25', from: '08:00', to: '12:00' },
				]),
			],
		});
		const [v] = supaipVolumes([sup]);
		const at = (day: number, briefed = false) => {
			const t = Date.UTC(2026, 10, day, 9);
			const a = resolveActivity({ ...v.activity, briefed }, t, t);
			return [a.state, a.reason];
		};
		expect(at(23)).toEqual(['activable', 'activable']);
		expect(at(24)).toEqual(['activable', 'notam-unbriefed']);
		expect(at(24, true)).toEqual(['inactive', 'notam-none']);
		expect(at(25)).toEqual(['active', 'published']);
		// A period that may be active grades caution, one in force by its rule.
		expect(classifyVolume(v, 'activable', VFR)).toBe('caution');
		expect(classifyVolume(v, 'active', VFR)).not.toBe('caution');
	});

	it('holds a standing rule over the days of the validity, an hour earlier in summer', () => {
		// 191/2025: "ZRT activable par NOTAM avec un préavis minimum de 48
		// heures : 2030-0530 (ETE : -1HR)".
		const sup = mkSup({
			validFrom: '2025-11-20',
			validTo: '2026-12-31',
			zones: [
				{
					...zrt([]),
					standing: [{ from: '20:30', to: '05:30', mode: 'notam', noticeMin: 2880, summerEarlier: true }],
				},
			],
		});
		const [v] = supaipVolumes([sup]);
		const at = (ms: number) => resolveActivity({ ...v.activity, briefed: false }, ms, ms).state;
		expect(at(Date.UTC(2026, 0, 10, 5, 0))).toBe('activable');
		expect(at(Date.UTC(2026, 0, 10, 19, 45))).toBe('inactive');
		expect(at(Date.UTC(2026, 6, 10, 5, 0))).toBe('inactive');
		expect(at(Date.UTC(2026, 6, 10, 19, 45))).toBe('activable');
		// Its last night runs on to its morning, and the night before its
		// first day holds none.
		expect(at(Date.UTC(2027, 0, 1, 5, 0))).toBe('activable');
		expect(at(Date.UTC(2027, 0, 2, 5, 0))).toBe('inactive');
		expect(at(Date.UTC(2025, 10, 20, 3, 0))).toBe('inactive');
	});

	it('reads an unread standing rule as may be active over the validity', () => {
		const sup = mkSup({ validFrom: '2026-01-01', validTo: '2026-03-31', zones: [{ ...zrt([]), standing: [{ mode: 'unread' }] }] });
		const [v] = supaipVolumes([sup]);
		const at = (ms: number) => {
			const a = resolveActivity({ ...v.activity, briefed: false }, ms, ms);
			return [a.state, a.reason];
		};
		expect(at(Date.UTC(2026, 1, 1))).toEqual(['activable', 'unread']);
		expect(at(Date.UTC(2026, 4, 1))).toEqual(['inactive', 'outside']);
	});

	it('holds no window for a supplement cancelled before it came into force', () => {
		// 240/2026: listed 20 November to 12 November, the SIA's form for a
		// supplement 246/2026 replaced before it began, while its own PDF
		// still schedules the zone to the end of 2027.
		const cancelled = mkSup({
			validFrom: '2026-11-20',
			validTo: '2026-11-12',
			zones: [zrt([{ date: '2026-11-20', dateTo: '2027-12-31' }]), { ...zrt([]), name: 'ZRT SANS HORAIRE' }],
		});
		const vols = supaipVolumes([cancelled]);
		expect(vols.map((v) => v.activity.rules)).toEqual([[], []]);
	});

	it('ends a zone schedule with its supplement', () => {
		// 133/2026 was listed to 14 August once 173/2026 replaced it. Its PDF
		// schedules the ZRT to 31 December.
		const replaced = mkSup({
			validFrom: '2026-08-10',
			validTo: '2026-08-14',
			zones: [zrt([{ date: '2026-08-12', dateTo: '2026-12-31', from: '22:00', to: '05:00' }])],
		});
		const vols = supaipVolumes([replaced]);
		expect(periodsOf(vols[0])).toEqual(
			[12, 13, 14].map((d) => ({
				startMs: Date.UTC(2026, 7, d, 22, 0),
				endMs: Date.UTC(2026, 7, d + 1, 5, 0),
			})),
		);
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
		expect(merged && periodsOf(merged)).toEqual([
			{
				startMs: Date.parse('2026-07-01T00:00:00Z'),
				endMs: Date.parse('2026-07-30T00:00:00Z'),
			},
		]);
		// A permanent NOTAM is in force from its B), for good.
		const perm = vols.find((v) => v.id === 'P0005/26');
		expect(perm && periodsOf(perm)).toEqual([{ startMs: Date.parse('2026-07-01T00:00:00Z'), endMs: Infinity }]);
	});

	it('holds a NOTAM area in the windows of its D) item', () => {
		const [v] = notamVolumes([
			mkNotam({ fullContent: 'A0001/26\nB) 2607010000 C) 2607300000\nD) MON-FRI 0800-1700\nE) AREA ACTIVE' }),
		]);
		const at = (iso: string) => {
			const t = Date.parse(iso);
			return resolveActivity({ ...v.activity, briefed: false }, t, t);
		};
		// Tuesday 7 July 2026 at noon, in its window, then the Saturday.
		expect(at('2026-07-07T12:00:00Z')).toEqual({
			state: 'active',
			reason: 'published',
			period: { startMs: Date.parse('2026-07-07T08:00:00Z'), endMs: Date.parse('2026-07-07T17:00:00Z') },
		});
		expect(at('2026-07-11T12:00:00Z').state).toBe('inactive');
	});

	// F) and G) parse apart, so one can stand alone. The evaluator reads the
	// missing side as unbounded, which the NOTAM never said, and the banner's
	// caveat rides `extent`, as it does for an airspace in the same state.
	it('marks the extent open when F) or G) stands alone', () => {
		const floor = { ft: 1000, ref: 'AMSL', value: 1000, unit: 'ft' } as const;
		const ceiling = { ft: 3000, ref: 'AMSL', value: 3000, unit: 'ft' } as const;
		const extent = (over: Partial<Notam>) => {
			const [v] = notamVolumes([mkNotam(over)]);
			return [v.extent, v.knownExtent];
		};
		expect(extent({ fgLower: floor })).toEqual(['open', true]);
		expect(extent({ fgUpper: ceiling })).toEqual(['open', true]);
		expect(extent({ fgLower: floor, fgUpper: ceiling })).toEqual(['known', true]);
		expect(extent({})).toEqual(['unknown', false]);
	});
});

describe('classifyVolume: the tier table', () => {
	const cases: [Partial<AlertVolume>, ActivityState, boolean, string][] = [
		// Unconditional prohibitions (the isForbiddenCrossing set).
		[{ type: 'P', category: 'restricted' }, 'inactive', true, 'avoid'],
		[{ airClass: 'A' }, 'active', true, 'avoid'],
		[{ airClass: 'A' }, 'active', false, 'none'],
		// LF-R 275: permanently in force, so it answers even when the
		// activation model has nothing to call hot, and only for VFR.
		[
			{ type: 'R', category: 'restricted', entry: PERMANENT_VFR_NOGO },
			'inactive',
			true,
			'avoid',
		],
		[
			{ type: 'R', category: 'restricted', entry: PERMANENT_VFR_NOGO },
			'inactive',
			false,
			'radio',
		],
		// RTBA: the windows are authoritative, inactive is silent, never a
		// caution.
		[{ type: 'R', category: 'restricted', rtba: true }, 'active', true, 'avoid'],
		[{ type: 'R', category: 'restricted', rtba: true }, 'inactive', true, 'none'],
		// Activable is not inactive: no briefing means no AZBA windows to be
		// authoritative, so the network earns the caution a zone that may be
		// active earns instead of the silence a briefing would justify.
		[{ type: 'R', category: 'restricted', rtba: true }, 'activable', true, 'caution'],
		// R / TSA active are segregated; a zone that may be active earns a
		// caution.
		[{ type: 'R', category: 'restricted' }, 'active', true, 'avoid'],
		[{ type: 'R', category: 'restricted' }, 'activable', true, 'caution'],
		[{ type: 'R', category: 'restricted' }, 'inactive', true, 'none'],
		[{ type: 'TSA', category: 'transit' }, 'active', true, 'avoid'],
		[{ type: 'TRA', category: 'transit' }, 'active', true, 'clearance'],
		[{ type: 'TRA', category: 'transit' }, 'inactive', true, 'none'],
		// Danger and the hazard family inform, they never forbid (Annex 15).
		[{ type: 'D', category: 'restricted' }, 'active', true, 'caution'],
		[{ type: 'D', category: 'restricted' }, 'activable', true, 'caution'],
		[{ type: 'D', category: 'restricted' }, 'inactive', true, 'none'],
		[{ type: 'MOA', category: 'restricted' }, 'activable', true, 'caution'],
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
			for (const act of ['active', 'inactive'] as ActivityState[]) {
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
		// A restriction on unmanned aircraft alone (UG-R 25) is the none tier
		// for a manned flight in force.
		expect(classifyVolume(r('exempt'), 'active', VFR)).toBe('none');
		expect(classifyVolume(r('exempt'), 'active', IFR)).toBe('none');
		// The inactive and activable states are untouched by the condition.
		expect(classifyVolume(r('radio'), 'inactive', VFR)).toBe('none');
		expect(classifyVolume(r('radio'), 'activable', VFR)).toBe('caution');
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
		// ED-R 4 WANNSEE, the DFS's shape: "IFR flights are exempt from the
		// regulation.", in force H24, its VFR side read as null.
		const edr4 = vol({
			type: 'R',
			category: 'restricted',
			entry: { vfr: null, ifr: 'exempt', permanent: true },
		});
		expect(classifyVolume(edr4, 'active', VFR)).toBe('avoid');
		expect(classifyVolume(edr4, 'active', IFR)).toBe('none');
	});

	it('grades SUP AIP zones by token and published rule, active only', () => {
		const sup = (
			supKind: AlertVolume['supKind'],
			supRule: AlertVolume['supRule'],
			supIfrOnly = false,
		): AlertVolume => vol({ source: 'supaip', supKind, supRule, supIfrOnly, category: '' });
		expect(classifyVolume(sup('zit', ''), 'active', VFR)).toBe('avoid');
		expect(classifyVolume(sup('', 'forbidden'), 'active', VFR)).toBe('avoid');
		expect(classifyVolume(sup('zrt', ''), 'active', VFR)).toBe('clearance');
		expect(classifyVolume(sup('zrt', 'conditional'), 'active', VFR)).toBe('clearance');
		expect(classifyVolume(sup('', 'conditional'), 'active', VFR)).toBe('clearance');
		expect(classifyVolume(sup('', 'other'), 'active', VFR)).toBe('caution');
		expect(classifyVolume(sup('', ''), 'active', VFR)).toBe('caution');
		expect(classifyVolume(sup('zit', ''), 'inactive', VFR)).toBe('none');
		expect(classifyVolume(sup('zit', ''), 'activable', VFR)).toBe('caution');
		// A ZRT binds IFR traffic too: no IFR suppression outside the
		// class-driven tier.
		expect(classifyVolume(sup('zrt', ''), 'active', IFR)).toBe('clearance');
		expect(classifyVolume(sup('zrt', '', true), 'active', VFR)).toBe('none');
	});

	it('grades a published avoidance or prohibition avoid, whatever the name (SERA.3145)', () => {
		const sup = (
			supKind: AlertVolume['supKind'],
			supRule: AlertVolume['supRule'],
			supIfrOnly = false,
		): AlertVolume => vol({ source: 'supaip', supKind, supRule, supIfrOnly, category: '' });
		// 088/2025's ZRT: "CAM/CAG : contournement obligatoire sauf pour : ..."
		expect(classifyVolume(sup('zrt', 'circumvent'), 'active', VFR)).toBe('avoid');
		expect(classifyVolume(sup('zrt', 'circumvent'), 'active', IFR)).toBe('avoid');
		expect(classifyVolume(sup('zrt', 'forbidden'), 'active', VFR)).toBe('avoid');
		// 065/2025's zones carry no token: "CAM et CAG : contournement
		// obligatoire."
		expect(classifyVolume(sup('', 'circumvent'), 'active', VFR)).toBe('avoid');
		// The gates come first: inactive, IFR-only under VFR, activable.
		expect(classifyVolume(sup('zrt', 'circumvent'), 'inactive', VFR)).toBe('none');
		expect(classifyVolume(sup('', 'circumvent', true), 'active', VFR)).toBe('none');
		expect(classifyVolume(sup('zrt', 'circumvent'), 'activable', VFR)).toBe('caution');
		// A ZDT informs: its supplement's one rule is the strictest of its
		// parts, the ZRT part's (207/2025), and the ZDT part's own text
		// draws the pilot's attention to the danger.
		expect(classifyVolume(sup('zdt', 'circumvent'), 'active', VFR)).toBe('caution');
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
		expect(classifyVolume(nv('RP'), 'inactive', VFR)).toBe('none');
		// An area that may be active is a caution whatever its subject.
		expect(classifyVolume(nv('RT'), 'activable', VFR)).toBe('caution');
		expect(classifyVolume(nv('RR'), 'activable', VFR)).toBe('caution');
	});

	it('cautions over a NOTAM area its text says may be activated', () => {
		// R0564/26's ZRT SOMME 2, "ZRT ACTIVABLE H24 AVEC UN PREAVIS DE 24
		// HEURES": a clearance while it was read in force.
		const [v] = notamVolumes([
			mkNotam({
				fullContent: 'R0564/26\nB) 2607010000 C) 2607300000\nE) -ZRT ACTIVABLE H24 AVEC UN PREAVIS DE 24 HEURES,',
			}),
		]);
		const t = Date.parse('2026-07-07T12:00:00Z');
		const act = resolveActivity({ ...v.activity, briefed: false }, t, t);
		expect([act.state, act.reason]).toEqual(['activable', 'activable']);
		expect(classifyVolume(v, act.state, VFR)).toBe('caution');
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

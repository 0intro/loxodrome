/* The published-entry-condition reader ($lib/data/airspaceEntry) and its
 * effect on the committed datasets. Every unit case below is a VERBATIM
 * shape from AIP France ENR 5.1's "Organisme, conditions de penetration"
 * column, so a wording change at the source surfaces here rather than in a
 * pilot's alert; the corpus pins name zones rather than counting them,
 * because a population bound hides exactly the substitution that matters
 * (the aircraftData.spec precedent, with the tolerance lesson learnt). */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
	activableHours,
	airspaceActivityKind,
	parseEntryConditions,
	permanentHours,
	remarkCondition,
	zoneEntryAction,
	type EntryCondition,
} from '$lib/data/airspaceEntry';

describe('remarkCondition', () => {
	it('reads every word order the SIA uses for avoidance', () => {
		expect(remarkCondition('VFR GAT : avoidance mandatory except for :')).toBe('forbidden');
		expect(remarkCondition('GAT/OAT : mandatory avoidance during activity')).toBe('forbidden');
		expect(remarkCondition('VFR GAT flights:\nCompulsory avoidance except for aircraft')).toBe(
			'forbidden',
		);
		expect(remarkCondition('IFR GAT: Avoidance compulsory unless further authorization')).toBe(
			'forbidden',
		);
		expect(remarkCondition('VFR GAT / OAT: mandatory bypassing during activity')).toBe(
			'forbidden',
		);
		expect(remarkCondition('Pénétration interdite pendant l’activité.')).toBe('forbidden');
		expect(remarkCondition('GAT / OAT : Entry prohibited for all aircrafts')).toBe('forbidden');
	});

	it('reads a zone reserved to a named group as a prohibition', () => {
		// The LF-R 3100 / 3103 family: the app cannot know the reader signed
		// the protocol, and no clearance is obtainable in flight.
		expect(
			remarkCondition(
				'- VFR : entry strictly reserved for pilots of flying clubs which signed a protocol with the managing authority and their duly informed guests.',
			),
		).toBe('forbidden');
		// The corpus spells it "reseverved" in five rows.
		expect(remarkCondition('-VFR : Entry strictly reseverved for pilots of flying clubs')).toBe(
			'forbidden',
		);
		expect(
			remarkCondition('CAG/VFR and CAM V : reserved for aircraft outbound or inbound BERRE LA FARE AD.'),
		).toBe('forbidden');
	});

	it('grades an authorization gate as a clearance', () => {
		expect(remarkCondition('IFR/VFR/OAT: upon COGNAC APP authorisation during activity hours.')).toBe(
			'clearance',
		);
		// LF-R 322 below FL160: a notification is still a gate.
		expect(remarkCondition('GAT IFR :\n-FL 160 : upon notification.')).toBe('clearance');
	});

	it('separates a contact requirement from a watch that exempts ATS traffic', () => {
		// LF-R 324, the identification zone: the clause exempts an aircraft
		// already working an A/A, ATS or ATC frequency, which an IFR flight is.
		expect(
			remarkCondition(
				'GAT / OAT : for purposes of identification, for radio-equipped ACFT, except during listening or trafic period on a frequency A/A, ATS or ATC required for  conduct of the flight, standby of frequency 120.075 MHz is mandatory.',
			),
		).toBe('radio-ats');
		// LF-R 275's IFR clause names the units to call and exempts nobody.
		expect(
			remarkCondition(
				'IFR GAT / OAT: entry allowed when radio contact established with one of the administrators.',
			),
		).toBe('radio');
	});

	it('reads a parenthesis as a qualifier, not as the clause', () => {
		// LF-R 41: everyone is gated on an authorization, only the non-radio
		// aircraft in the parenthesis must bypass.
		expect(
			remarkCondition(
				'GAT/OAT: entry subject to MADIRAN authorization 129.900 MHz (during activity, ACFT without radio bypassing mandatory).',
			),
		).toBe('clearance');
	});

	it('keeps an unbalanced parenthesis local to its clause', () => {
		// LF-R 173 A opens one in its administrator block and never closes it;
		// pairing it with the next ")" swallows the avoidance rule between.
		expect(
			remarkCondition(
				'Administrator: #NICE APP (< FL175).#MARSEILLE ACC (> FL175 #GAT IFR/OAT I and T: avoidance mandatory throughout activity.#GAT VFR :#-Other ACFT : entry after mandatory radio contact with MARSEILLE INFO 120.550#(> FL175) or NICE INFO 120.850 (< FL175).',
			),
		).toBe('forbidden');
	});

	it('refuses a radio phrase that describes the hazard', () => {
		// TFR 2: the traffic you cannot talk to is the reason to stay out, so
		// reading a contact requirement out of it would invent a frequency.
		expect(
			remarkCondition(
				'- VFR/OAT : except ACFT of companies which signed a protocol with the managing authority and their duty informed guests, avoidance recommended due to the presence of ACFT without any radio contact nor any transponder onboard.',
			),
		).toBeNull();
	});

	it('returns null when the remark states no condition it reads', () => {
		expect(remarkCondition('Activity known on: Luxeuil APP 129.925')).toBeNull();
		expect(remarkCondition('GAT IFR : penetration as per protocol.')).toBeNull();
		expect(remarkCondition('')).toBeNull();
	});
});

describe('activableHours', () => {
	it('reads the hours a zone may be activated in', () => {
		expect(activableHours('Possible activation H24.')).toBe(true);
		expect(activableHours('Activable H24 #Horaires d\'activation planifiés spécifiés dans l\'AUP France')).toBe(true);
		expect(activableHours('Possible activation H24 except SUN and HOL.')).toBe(true);
		expect(activableHours('')).toBe(false);
		expect(activableHours('Activation by NOTAM.')).toBe(false);
	});

	it('reads LF-R 151 as activable at all times, and LF-R 275 as permanent', () => {
		// LF-R 151 is coded H24 and remarks "Possible activation H24.": read
		// off the code alone, it was a NO-GO on every route across it.
		const kind = (id: string) => {
			const r = rowById(id);
			return airspaceActivityKind({ id, category: 'restricted', workHr: cell(r[8]), rmkWorkHr: cell(r[9]) });
		};
		expect(kind('LFR151')).toBe('activable');
		expect(kind('LFR228A')).toBe('activable');
		expect(kind('LFR275')).toBe('permanent');
		expect(entryOf(rowById('LFR151')).permanent).toBe(false);
		expect(entryOf(rowById('LFR275')).permanent).toBe(true);
	});
});

describe('permanentHours', () => {
	it('accepts the codes and the free-text forms', () => {
		expect(permanentHours('H24')).toBe(true);
		expect(permanentHours(' h24 ')).toBe(true);
		expect(permanentHours('Permanently active.; OTHER')).toBe(true);
		expect(permanentHours('NOTAM')).toBe(false);
		expect(permanentHours('HX')).toBe(false);
		expect(permanentHours('')).toBe(false);
	});

	it('accepts the words the other publishers print', () => {
		// skeyes prints PERM in ENR 5.1's time column (EBR01 BRUSSELS CITY,
		// EBR11 TIHANGE), the FAA CONTINUOUS (R-2306A).
		expect(permanentHours('PERM')).toBe(true);
		expect(permanentHours('CONTINUOUS')).toBe(true);
		// Continuous for part of the time is a schedule.
		expect(permanentHours('CONTINUOUS, MON - FRI; OTHER TIMES BY NOTAM')).toBe(false);
		expect(
			permanentHours('MAY 1 - SEP 15, CONTINUOUS; OTHER TIMES BY NOTAM 24 HRS IN ADVANCE'),
		).toBe(false);
	});

	it('does not read permanence out of its negation', () => {
		// NATS publishes this on EGR610A and friends; reading permanence out
		// of it would make a NOTAM-activated area permanently hot.
		expect(
			permanentHours(
				'Not permanently active. Periods when restrictions in place promulgated by J Series NOTAM.; Activated by NOTAM.',
			),
		).toBe(false);
	});
});

type Row = unknown[];
const cell = (v: unknown): string => (typeof v === 'string' ? v : '');
function rows(publisher: string): Row[] {
	return (
		JSON.parse(readFileSync(`public/data/${publisher}-airspaces.json`, 'utf8')) as { rows: Row[] }
	).rows;
}
const FR = rows('fr');
const entryOf = (r: Row) => parseEntryConditions(cell(r[10]), cell(r[8]), cell(r[9]));
const rowById = (id: string): Row => {
	const r = FR.find((x) => x[0] === id);
	if (!r) {
		throw new Error(`fr-airspaces has no row ${id}`);
	}
	return r;
};

describe('fr-airspaces corpus', () => {
	// Named zones, not a population count: these are the rows whose grade a
	// pilot would notice, each with the clause it comes from.
	const CASES: [string, EntryCondition | null][] = [
		['LFR275', 'forbidden'], // VFR GAT : avoidance mandatory (the IFR half is per-category)
		['LFR322', 'forbidden'], // GAT VFR :Avoidance mandatory
		['LFR205/7', 'forbidden'], // VFR GAT flights: Compulsory avoidance
		['LFR205/9', 'forbidden'],
		['LFR205/11', 'forbidden'],
		['LFR271', 'forbidden'], // GAT/OAT : mandatory avoidance during activity
		['LFR173A', 'forbidden'], // guarded by the unbalanced-parenthesis rule
		['LFR3107', 'forbidden'], // - VFR : entry strictly reserved for users authorised by DSAC Nord
		['LFR262', 'forbidden'], // GAT VFR : entry strictly reserved for :
		['TFR2', 'forbidden'], // from its IFR clause; the VFR clause reads nothing
		['LFR324', 'radio-ats'], // the identification zone, ATS traffic exempted
		['LFR41', 'clearance'], // the avoidance sits in a parenthesis
		['LFR20B2N', 'clearance'], // IFR : with AVORD APP authorization
		['LFR110A', 'radio'], // Mandatory Ochey APP frequency listening watch
	];

	it.each(CASES)('reads %s as %s', (id, want) => {
		expect(remarkCondition(cell(rowById(id)[10]))).toBe(want);
	});

	it('holds the permanently in-force no-go zones, R 275 and the R 205 family', () => {
		const nogo = FR.filter((r) => {
			if (cell(r[1]) !== 'R') {
				return false;
			}
			const e = entryOf(r);
			return e.permanent && e.vfr === 'forbidden';
		}).map((r) => String(r[0]));
		// These answer with no NOTAM in sight, on the map, in the banner and
		// on the printed crossings strip, so each is named rather than
		// counted: LF-R 275 and the R 205 parts over Paris, the Versailles
		// pair, the overseas H24 zones.
		for (const id of ['LFR275', 'LFR205/2', 'LFR205/7', 'LFR205/11', 'LFR84A', 'LFR84B', 'NWR5']) {
			expect(nogo).toContain(id);
		}
		// A zone whose avoidance is gated on an activity schedule is not one
		// of them; it answers through the activation model instead. Nor is
		// one coded H24 whose hours remark says "Possible activation H24".
		for (const id of ['LFR212', 'LFR92', 'LFR242', 'LFR204T1', 'LFR151', 'LFR228A', 'LFR327']) {
			expect(nogo).not.toContain(id);
		}
		// The population is the H24 slice of the R corpus, its zones that may
		// only be activated left out, so it moves with a regeneration but not
		// by much.
		expect(nogo.length).toBeGreaterThan(30);
		expect(nogo.length).toBeLessThan(80);
	});

	it('splits the two categories on one permanent zone only', () => {
		// Every other permanently in-force zone asks the same of both, which
		// is why this reading changes so little while it is in force: the
		// split is the exception the AIP prints, not the rule. LF-R 322 and
		// 323 split them too, and are "Activable H24", their activation
		// planned in the AUP France.
		const split = FR.filter((r) => {
			if (cell(r[1]) !== 'R') {
				return false;
			}
			const e = entryOf(r);
			return e.permanent && e.vfr !== e.ifr;
		}).map((r) => String(r[0]));
		expect([...split].sort()).toEqual(['LFR275']);
	});
});

describe('fr-airspaces corpus, per traffic category', () => {
	// The zones where the two categories part company, each verbatim from
	// ENR 5.1. These are the rows a pilot notices, in both directions.
	const SPLIT: [string, EntryCondition | null, EntryCondition | null][] = [
		// "IFR GAT / OAT: entry allowed when radio contact established with
		// one of the administrators. / VFR GAT : avoidance mandatory ..."
		['LFR275', 'forbidden', 'radio'],
		// "GAT VFR :Avoidance mandatory / GAT IFR : -FL 160 : upon
		// notification. -FL >160 : upon authorization."
		['LFR322', 'forbidden', 'clearance'],
		['LFR323', 'forbidden', 'clearance'],
		['LFR321', 'forbidden', 'clearance'],
		// The other polarity, where VFR is the permitted one: "GAT VFR and
		// OAT V: entry after radio contact with AQUITAINE INFO / GAT IFR and
		// OAT A, B, C: avoidance mandatory."
		['LFR204T1', 'radio', 'forbidden'],
		['LFR8', 'radio', 'forbidden'],
		['LFR97', 'radio', 'forbidden'],
		['LFR513W', 'clearance', 'forbidden'],
		['LFR605A', 'clearance', 'forbidden'],
		['LFR20B2N', 'radio', 'clearance'],
	];
	it.each(SPLIT)('%s: vfr %s, ifr %s', (id, vfr, ifr) => {
		const e = entryOf(rowById(id));
		expect({ vfr: e.vfr, ifr: e.ifr }).toEqual({ vfr, ifr });
	});

	// The rows where a per-category reading MUST NOT soften anything.
	const BOTH: [string, EntryCondition | null][] = [
		// LF-R 205: the permissive clause is for Paris inbound / outbound
		// traffic, and "- Other IFR GAT flights: Compulsory avoidance"
		// dominates it.
		['LFR205/7', 'forbidden'],
		['LFR205/2', 'forbidden'],
		// The drone clause has its own subject and cannot reach the VFR one,
		// which reserves the zone to Berre la Fare traffic.
		['LFR88', 'forbidden'],
		// The club-protocol family, and a zone reserved to DSAC-authorised users.
		['LFR3100A', 'forbidden'],
		['LFR3107', 'forbidden'],
		['LFR262', 'forbidden'],
		// TFR 2: its VFR clause reads nothing, so the whole-remark fallback
		// carries the IFR avoidance across.
		['TFR2', 'forbidden'],
		// LF-R 324: the watch that exempts ATS traffic, for both categories.
		['LFR324', 'radio-ats'],
		// A zone that opens on its unmanned users still binds a manned
		// flight by its GAT clause ("Unmanned aircraft.# ... GAT: Avoidance
		// mandatory during activity.").
		['LFR233B', 'forbidden'],
		['LFR570', 'forbidden'],
	];
	it.each(BOTH)('%s: both categories %s', (id, want) => {
		const e = entryOf(rowById(id));
		expect({ vfr: e.vfr, ifr: e.ifr }).toEqual({ vfr: want, ifr: want });
	});

	it('leaves a category the publication does not address on the whole remark', () => {
		// The guarantee that bounds this whole feature: a per-category
		// verdict can only differ where the AIP addresses that category.
		let differ = 0;
		for (const r of FR.filter((x) => cell(x[1]) === 'R')) {
			const e = entryOf(r);
			const whole = remarkCondition(cell(r[10]));
			if (e.vfr !== whole || e.ifr !== whole) {
				differ++;
				expect(cell(r[10]).toUpperCase()).toMatch(/\b(GAT|CAG|OAT|CAM|VFR|IFR)\b/);
			}
		}
		// 164 rows publish per-category clauses; on 38 of them the reading
		// actually parts from the whole-remark one.
		expect(differ).toBeGreaterThan(20);
		expect(differ).toBeLessThan(80);
	});
});

describe('other publishers', () => {
	// The DFS exempts IFR flights from its nuclear sites, ED-R 1 to 41:
	// "IFR-Flüge sind von der Beschränkung ausgenommen./IFR flights are
	// exempt from the regulation.; H24".
	const DE_IFR_EXEMPT = [
		'EDR1', 'EDR23', 'EDR24', 'EDR25', 'EDR27', 'EDR3', 'EDR38',
		'EDR4', 'EDR40', 'EDR41', 'EDR5', 'EDR6', 'EDR7', 'EDR8',
	];
	const SPLIT: Record<string, string[]> = { de: DE_IFR_EXEMPT };

	// France structures its entry conditions per traffic category. The
	// others carry legal prose, purpose notes, or nothing, with the DFS's
	// IFR exemption the one condition for a single category. Pinned so a
	// future dataset gaining conditions is a visible event rather than a
	// silent behaviour change.
	it.each(['uk', 'es', 'be', 'de', 'at'])('%s R rows part the categories where the AIP does', (publisher) => {
		const split = rows(publisher).filter((r) => {
			if (cell(r[1]) !== 'R') {
				return false;
			}
			const e = entryOf(r);
			return e.vfr !== e.ifr || e.vfr !== remarkCondition(cell(r[10]));
		});
		expect(split.map((r) => String(r[0])).sort()).toEqual(SPLIT[publisher] ?? []);
	});

	it.each(DE_IFR_EXEMPT)('de %s exempts IFR flights and VFR ones avoid it', (id) => {
		const r = rows('de').find((x) => x[0] === id);
		expect(r).toBeDefined();
		const entry = entryOf(r as Row);
		expect(entry.permanent).toBe(true);
		const zone = { type: 'R', rtba: false, entry };
		expect(zoneEntryAction(zone, { vfr: true, active: false })).toBe('forbidden');
		expect(zoneEntryAction(zone, { vfr: false, active: false })).toBeNull();
	});

	it('reads every PERM and CONTINUOUS R zone as permanently in force', () => {
		const perm = [...rows('be'), ...rows('faa')].filter(
			(r) => cell(r[1]) === 'R' && (cell(r[8]) === 'PERM' || cell(r[8]) === 'CONTINUOUS'),
		);
		// 15 Belgian rows, 107 FAA ones.
		expect(perm.length).toBeGreaterThan(100);
		expect(perm.filter((r) => !entryOf(r).permanent).map((r) => r[0])).toEqual([]);
	});

	// The DFS and Georgia file a whole day as the AIXM timesheet ANY
	// 00:00-00:00, which their builders write H24. Kept as filed, it reads
	// as a schedule this app cannot place, and an alert grades the zone a
	// caution where its conditions bind at every hour (ED-R 146 BERLIN).
	it('reads every H24 R zone of the DFS and Georgia as permanently in force', () => {
		const h24 = [...rows('de'), ...rows('ge')].filter(
			(r) => cell(r[1]) === 'R' && /^(H24|ANY 00:00-(00|24):00)$/.test(cell(r[8])),
		);
		// 29 German rows, 33 Georgian ones.
		expect(h24.length).toBeGreaterThan(50);
		expect(h24.filter((r) => !entryOf(r).permanent).map((r) => r[0])).toEqual([]);
	});

	it('grades EBR11 TIHANGE a no-go with no NOTAM in sight', () => {
		// "Entry prohibited, unless instructed by ATC. Nuclear installation.",
		// time of activity PERM.
		const r = rows('be').find((x) => x[0] === 'EBR11');
		expect(r).toBeDefined();
		const zone = { type: 'R', rtba: false, entry: entryOf(r as Row) };
		expect(zoneEntryAction(zone, { vfr: true, active: false })).toBe('forbidden');
		expect(zoneEntryAction(zone, { vfr: false, active: false })).toBe('forbidden');
	});

	// A prohibition is the strictest clause whatever its exemption says: the
	// approval or the radio call in the exemption is for the aircraft it
	// names.
	const PROHIBITED: [string, string][] = [
		// "Prohibited to non-participating aircraft. Zone allowed for manned
		// traffic ... approved by the Duty Aerodrome Commander (DAC) of EBST.
		// ... Permanent 2-way radio contact with EBST mandatory."
		['be', 'EBR73'],
		// "Unless instructed by ATC, prohibited for all aircraft, except:
		// inspection flights, ... with prior approval of Port Authority"
		['be', 'EBR54'],
		// "Overflight is prohibited, except for State aircraft and flights for
		// Park preservation authorised by the National Park Manager."
		['es', 'LER146'],
		// "Overflying is prohibited. Permanent. Flights authorised with
		// destination/departure from Ceuta civil and military heliports"
		['es', 'LER12'],
	];
	it.each(PROHIBITED)('%s %s reads as a prohibition', (publisher, id) => {
		const r = rows(publisher).find((x) => x[0] === id);
		expect(r).toBeDefined();
		const e = entryOf(r as Row);
		expect({ vfr: e.vfr, ifr: e.ifr }).toEqual({ vfr: 'forbidden', ifr: 'forbidden' });
	});

	// Georgia restricts unmanned aircraft alone over Tbilisi (UG-R 25,
	// "Unmanned aircraft flights are not allowed") and around its
	// aerodromes (UG-R 26 to 31 and 53, "Unmanned aircraft flight
	// restriction zone for open and specific categories. Unmanned aircraft
	// flights are allowed only by permission from Aerodrome operator").
	// In force H24, they still ask nothing of a manned flight.
	it.each(['UGR25', 'UGR26', 'UGR27', 'UGR28', 'UGR29', 'UGR30', 'UGR31', 'UGR53'])(
		'ge %s binds unmanned aircraft alone',
		(id) => {
			const r = rows('ge').find((x) => x[0] === id);
			expect(r).toBeDefined();
			const entry = entryOf(r as Row);
			expect(entry.permanent).toBe(true);
			const zone = { type: 'R', rtba: false, entry };
			expect(zoneEntryAction(zone, { vfr: true, active: false })).toBeNull();
			expect(zoneEntryAction(zone, { vfr: false, active: false })).toBeNull();
		},
	);
});

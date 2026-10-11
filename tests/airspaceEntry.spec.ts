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
	parseEntryConditions,
	permanentHours,
	remarkCondition,
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

describe('permanentHours', () => {
	it('accepts the codes and the free-text forms', () => {
		expect(permanentHours('H24')).toBe(true);
		expect(permanentHours(' h24 ')).toBe(true);
		expect(permanentHours('Permanently active.; OTHER')).toBe(true);
		expect(permanentHours('NOTAM')).toBe(false);
		expect(permanentHours('HX')).toBe(false);
		expect(permanentHours('')).toBe(false);
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
const entryOf = (r: Row) => parseEntryConditions(cell(r[10]), cell(r[8]));
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
		// of them; it answers through the activation model instead.
		for (const id of ['LFR212', 'LFR92', 'LFR242', 'LFR204T1']) {
			expect(nogo).not.toContain(id);
		}
		// The population is the H24 slice of the R corpus, so it moves with a
		// regeneration but not by much.
		expect(nogo.length).toBeGreaterThan(40);
		expect(nogo.length).toBeLessThan(80);
	});

	it('splits the two categories on three permanent zones only', () => {
		// Every other permanently in-force zone asks the same of both, which
		// is why this reading changes so little while it is in force: the
		// split is the exception the AIP prints, not the rule.
		const split = FR.filter((r) => {
			if (cell(r[1]) !== 'R') {
				return false;
			}
			const e = entryOf(r);
			return e.permanent && e.vfr !== e.ifr;
		}).map((r) => String(r[0]));
		expect([...split].sort()).toEqual(['LFR275', 'LFR322', 'LFR323']);
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
	// France is the only AIP in the loaded set that structures its entry
	// conditions per traffic category; the others carry legal prose, purpose
	// notes, or nothing. Pinned so a future dataset gaining conditions is a
	// visible event rather than a silent behaviour change.
	it.each(['uk', 'es', 'be', 'de', 'at'])('%s R rows read the same for both categories', (publisher) => {
		const split = rows(publisher).filter((r) => {
			if (cell(r[1]) !== 'R') {
				return false;
			}
			const e = entryOf(r);
			return e.vfr !== e.ifr || e.vfr !== remarkCondition(cell(r[10]));
		});
		expect(split.map((r) => r[0])).toEqual([]);
	});
});

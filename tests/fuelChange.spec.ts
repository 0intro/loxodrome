import { describe, it, expect } from 'vitest';
import { applyFuelChange, parseFuelChange } from '$lib/notam/fuelChange';

/* Every text here is verbatim from a real French NOTAM in force, labelled
 * with its aerodrome and, where the pair exists, given in both languages.
 * Sources: the 2108 NOTAMs in force over metropolitan France on 2026-09-10
 * (autorouter), and the bilingual pairs in tests/fixtures/world-{fr,en} and
 * local/france-{fr,en}.txt. */

interface Case {
	name: string;
	text: string;
	/** The grades withdrawn, or 'ALL' for the whole supply, or null for a
	 *  statement the grammar refuses to act on, or [] for a line it drops. */
	want: string[] | 'ALL' | null | 'DROP';
}

/* --- lines that withdraw: subject, outage, nothing else --- */
const closed: Case[] = [
	{ name: 'LFQF, the bare form', text: '100LL NOT AVBL', want: ['100LL'] },
	{ name: 'LFBZ, the French bare form', text: '100LL INDISPONIBLE', want: ['100LL'] },
	{ name: 'LFEV', text: 'JET A1 U/S', want: ['JET A-1'] },
	{ name: 'LFKO, French', text: 'JET A1 INDISPONIBLE.', want: ['JET A-1'] },
	{ name: 'LFMZ', text: 'AVGAS 100LL NOT AVBL.', want: ['100LL'] },
	{ name: 'LFQV, French', text: 'AVGAS 100LL INDISPONIBLE.', want: ['100LL'] },
	{ name: 'LFQW, two grades', text: 'AVGAS 100LL AND JET A1 NOT AVBL.', want: ['100LL', 'JET A-1'] },
	{
		// Two grades each with their own outage phrase. The line is still
		// nothing but its subject and its outage, so it still withdraws:
		// isClosed consumes every phrase, not merely the first, or the
		// second would read as a qualifier and refuse a plain statement.
		name: 'two outage phrases in one line',
		text: '100LL NOT AVBL AND JET A1 NOT AVBL',
		want: ['100LL', 'JET A-1'],
	},
	{ name: 'LFCI, the family beside a grade', text: 'AVGAS AND JET A1 U/S', want: ['AVGAS', 'JET A-1'] },
	{ name: 'LFRW, the family alone', text: 'AVGAS NOT AVBL', want: ['AVGAS'] },
	{
		// The French half of D3065/26 names the family where the English
		// half names the grade. Both are closed; the resolver's `covers`
		// makes them meet on the published row.
		name: 'LFKO, French, the family alone',
		text: 'AVGAS NON DISPONIBLE',
		want: ['AVGAS'],
	},
	{ name: 'LFEB, a supply noun before the grade', text: 'FUEL 100 LL NOT AVAILABLE', want: ['100LL'] },
	{ name: 'LFSM, a supply noun before the grade', text: 'REFUELLING UL AERO SUPER NOT AVBL.', want: ['SUPER AERO+'] },
	{ name: 'LFLP, a supply noun after it', text: "'UL AERO SUPER PLUS' FUEL NOT AVBL.", want: ['SUPER AERO+'] },
	{ name: 'LFLY, the + form', text: 'UL AERO SUPER+ NOT AVBL.', want: ['SUPER AERO+'] },
	{
		// The quote falls between UL and AERO, so the UL prefix cannot be
		// required for the token to read.
		name: 'LFPE, a quote inside the grade name',
		text: "UL 'AERO SUPER PLUS' NOT AVBL",
		want: ['SUPER AERO+'],
	},
	{ name: 'LFBH', text: 'JET A1 NOT AVBL', want: ['JET A-1'] },
	{ name: 'LFBD, a station of one grade', text: 'AVGAS STATION NOT AVBL', want: ['AVGAS'] },
	{ name: 'LFRZ, a station of one grade', text: 'JET A1 FUELING STATION U/S', want: ['JET A-1'] },
	{
		// The gloss names the same fuel; read as a second grade it would put
		// a NATO code on a civil list, or the reverse at an air base.
		name: 'LFKS, the NATO gloss',
		text: 'REFUELING IN 100LL (F18) NOT AVBL.',
		want: ['100LL'],
	},
	{ name: 'LFKS, French', text: 'AVITAILLEMENT EN 100LL (F18) NON DISPONIBLE.', want: ['100LL'] },
];

/* --- lines that withdraw the whole supply: no grade, a supply noun --- */
const whole: Case[] = [
	{ name: 'LFEF', text: 'FUEL AVAILABILITY NOT AVAILABLE', want: 'ALL' },
	{ name: 'LFFN, with an intensifier', text: 'FUEL AVAILABILITY COMPLETELY WITHDRAWN', want: 'ALL' },
	{ name: 'LFPK', text: 'REFUELLING STATION U/S.', want: 'ALL' },
	{ name: 'LFPK, French', text: 'STATION CARBURANT HORS SERVICE.', want: 'ALL' },
	{ name: 'LFDI, with a cause', text: 'REFUELING STATION NOT AVBL DUE TO MAINT.', want: 'ALL' },
];

/* --- lines carrying a qualifier: a note, never a withdrawal --- */
const qualified: Case[] = [
	{ name: 'LFMV, one dispenser', text: "AUTOMATIC DISTRIBUTION 'UL AERO SUPER+' NOT AVBL", want: null },
	{ name: 'LFMP, French, one dispenser', text: 'AUTOMATE AVGAS 100LL INDISPONIBLE', want: null },
	{ name: 'LFRB, one dispenser and one operator', text: 'GENERAL AVIATION : JET A1 SELF DISPENSER U/S.', want: null },
	{ name: 'LFRB, French', text: 'AVIATION GENERALE : AUTOMATE JET A1 HORS SERVICE.', want: null },
	{ name: 'LFCA, one class of traffic', text: 'AVGAS REFUELLING STATION NOT AVBL FOR NON-BASED ACFT.', want: null },
	{ name: 'LFBU, French, one truck', text: 'CAMION AVITAILLEUR JET A1 INDISPONIBLE :', want: null },
	{ name: 'LFCK, French, one stand', text: 'JET A1 EN POSTE FIXE INDISPONIBLE.', want: null },
	{ name: 'LFCK', text: 'JET A1 STATIC STAND NOT AVBL.', want: null },
];

/* --- lines that are not about fuel at all --- */
const dropped: Case[] = [
	{
		// The one that would empty an aerodrome selling 100LL and Jet A-1.
		name: 'LFSM, an electric charging point',
		text: 'AVIATION ELECTRIC CHARGING STATION U/S',
		want: 'DROP',
	},
	{ name: 'LFRH, a part of the day', text: '- DE NUIT : INDISPONIBLE.', want: 'DROP' },
];

function only(text: string): Case['want'] {
	const st = parseFuelChange(text);
	if (st.length === 0) {
		return 'DROP';
	}
	expect(st).toHaveLength(1);
	if (!st[0].bare) {
		return null;
	}
	// Sorted: which grades a line names is the contract, the order they come
	// out in is not.
	return st[0].scope === 'all' ? 'ALL' : [...st[0].grades].sort();
}

describe('parseFuelChange', () => {
	for (const c of [...closed, ...whole, ...qualified, ...dropped]) {
		it(c.name, () => {
			expect(only(c.text)).toEqual(c.want);
		});
	}
});

describe('the line is the clause', () => {
	it('reads two bullets of one NOTAM apart (D2159/26 LFLJ)', () => {
		// Jet A-1 is available on request; 100LL is not available. A rule
		// over the whole E-text gets one of the two wrong whichever way it
		// goes.
		const st = parseFuelChange(
			[
				'FUELLING RESTRICTIONS :',
				'- JET A1 AVBL FOR HEL ONLY UPON 24HR PPR :',
				'  . BY EMAIL TO : COURCHEVEL(A)SAF-HELICO.COM',
				'- AVGAS 100LL NOT AVBL',
			].join('\n'),
		);
		expect(st).toHaveLength(1);
		expect(st[0].bare).toBe(true);
		expect(st[0].grades).toEqual(['100LL']);
	});

	it('finds the outage buried under an hours list (A2091/26 LFLB)', () => {
		const st = parseFuelChange(
			[
				'JET A1 REFUELLING SKED :',
				'- MON-FRI : 0600-1830',
				'- SAT-SUN : 0730-1630',
				'AVGAS 100LL : NOT AVBL.',
			].join('\n'),
		);
		expect(st).toHaveLength(1);
		expect(st[0].grades).toEqual(['100LL']);
		expect(st[0].bare).toBe(true);
	});

	it('ignores the reference line beside a withdrawal (LFFN)', () => {
		const st = parseFuelChange(
			'FUEL AVAILABILITY COMPLETELY WITHDRAWN\nREF AIP FRANCE : AD 2 LFFN TXT 01',
		);
		expect(st).toHaveLength(1);
		expect(st[0].scope).toBe('all');
	});

	it('says nothing about a NOTAM that withdraws nothing', () => {
		expect(parseFuelChange('REFUELLING SKED : MON-FRI : 0500-1900 EXC SAT')).toEqual([]);
		expect(parseFuelChange('JET A1 LIMITED : PLAN FOR A DOUBLE FUEL LOAD.')).toEqual([]);
		expect(parseFuelChange('UL91 RESERVED FOR HOME BASED ACFT')).toEqual([]);
		expect(parseFuelChange('')).toEqual([]);
		expect(parseFuelChange(null)).toEqual([]);
	});
});

/* The AVGAS family, as the resolver supplies it. */
const covers = (published: string, stated: string): boolean => {
	const family = ['100LL', 'UL91', 'SUPER AERO+'];
	if (published === stated) return true;
	if (published === 'AVGAS') return family.includes(stated);
	if (stated === 'AVGAS') return family.includes(published);
	return false;
};

describe('applyFuelChange', () => {
	const offers = [{ grade: '100LL' }, { grade: 'JET A-1' }];
	const cand = (text: string, active: boolean | null = true) => [
		{ source: 'N1' as const, statements: parseFuelChange(text), active },
	];

	it('withdraws the grade it names and leaves the rest', () => {
		const r = applyFuelChange(offers, cand('JET A1 NOT AVBL'), covers);
		expect(r.offers.map((o) => o.withdrawn ?? null)).toEqual([null, 'N1']);
		expect(r.withdrawnAll).toBeNull();
		expect(r.notes).toEqual([]);
	});

	it('withdraws everything when the whole supply is out', () => {
		const r = applyFuelChange(offers, cand('REFUELLING STATION U/S.'), covers);
		expect(r.offers.every((o) => o.withdrawn === 'N1')).toBe(true);
		expect(r.withdrawnAll).toBe('N1');
	});

	it('meets the family from either side', () => {
		// Corte publishes the unqualified AVGAS; its NOTAM names the family
		// in French and the grade in English. Both must strike the same row.
		const avgas = [{ grade: 'AVGAS' }, { grade: 'JET A-1' }];
		for (const text of ['AVGAS NON DISPONIBLE', 'AVGAS 100LL NOT AVBL.']) {
			const r = applyFuelChange(avgas, cand(text), covers);
			expect(r.offers.map((o) => o.withdrawn ?? null)).toEqual(['N1', null]);
		}
	});

	it('notes a qualified statement instead of acting on it', () => {
		const r = applyFuelChange(offers, cand('GENERAL AVIATION : JET A1 SELF DISPENSER U/S.'), covers);
		expect(r.offers.every((o) => o.withdrawn === undefined)).toBe(true);
		expect(r.notes.map((n) => n.kind)).toEqual(['partial']);
	});

	it('notes a grade the aerodrome does not publish', () => {
		// LFPE withdraws UL Aero Super+ where the AIP lists UL91; LFKS
		// withdraws 100LL where only F-34 is listed. Silence would lose a
		// NOTAM that usually means the AIP is behind.
		const r = applyFuelChange(offers, cand("UL 'AERO SUPER PLUS' NOT AVBL"), covers);
		expect(r.offers.every((o) => o.withdrawn === undefined)).toBe(true);
		expect(r.notes.map((n) => n.kind)).toEqual(['unmatched']);
	});

	it('never withdraws on an unreadable schedule', () => {
		const r = applyFuelChange(offers, cand('JET A1 NOT AVBL', null), covers);
		expect(r.offers.every((o) => o.withdrawn === undefined)).toBe(true);
		expect(r.notes.map((n) => n.kind)).toEqual(['schedule']);
	});

	it('says nothing when the schedule puts it out of force', () => {
		const r = applyFuelChange(offers, cand('JET A1 NOT AVBL', false), covers);
		expect(r.offers.every((o) => o.withdrawn === undefined)).toBe(true);
		expect(r.notes).toEqual([]);
	});

	it('says one thing once, however often the NOTAM repeats it', () => {
		// A0703/26 LFBH is a JET A1 hours-of-service NOTAM whose exception
		// line is restated verbatim, and A0542/26 restates one of three.
		// Two identical rows under the chips are noise to read AND a
		// duplicate key in the list that renders them, which Svelte throws
		// on in production as well as in dev.
		const twice =
			'JET A1 REFUELLING HOURS OF OPS :\n' +
			'.EXC 03,04,10,11,14,15,22,24,25,28: JET A1 NOT AVBL\n' +
			'.EXC  03,10,11,14,15,22,24,25,28: JET A1 NOT AVBL';
		const r = applyFuelChange(offers, cand(twice), covers);
		expect(r.notes.map((n) => n.kind)).toEqual(['partial']);
		const keys = r.notes.map((n) => `${n.source}|${n.kind}|${n.grades.join(',')}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('cites one NOTAM for the whole supply, the one the chips cite', () => {
		// Two NOTAMs both emptying the field: the heading line and the marks
		// on the grades must not blame different ones for the same fact.
		const r = applyFuelChange(
			offers,
			[
				{ source: 'N1', statements: parseFuelChange('REFUELLING STATION U/S.'), active: true },
				{ source: 'N2', statements: parseFuelChange('FUEL NOT AVBL'), active: true },
			],
			covers,
		);
		expect(r.withdrawnAll).toBe('N1');
		expect(r.offers.every((o) => o.withdrawn === 'N1')).toBe(true);
	});

	it('leaves the caller\u2019s offers alone', () => {
		const r = applyFuelChange(offers, cand('JET A1 NOT AVBL'), covers);
		expect(offers.every((o) => !('withdrawn' in o))).toBe(true);
		expect(r.offers[1]).not.toBe(offers[1]);
	});
});

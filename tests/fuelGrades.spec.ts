import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	civilGrades,
	fuelRefusal,
	gradeCovers,
	gradeLabel,
	loadFrFuel,
	sellsGrade,
	FUEL_GRADES,
	type AerodromeFuel,
	type FuelGrade,
} from '$lib/data/fuel';
import { FUEL_TYPES } from '$lib/aircraft/schema';
import type { FrFuelMeta } from '$lib/data/meta';

const doc = JSON.parse(readFileSync('public/data/fr-fuel.json', 'utf8')) as {
	fields: string[];
	rows: unknown[][];
};
const meta = JSON.parse(readFileSync('public/data/fr-fuel.meta.json', 'utf8')) as FrFuelMeta;

/* The grade codes are spelled the same on both sides of the language
 * boundary, which is what lets the app match an aeroplane to a pump with a
 * membership test and no mapping table. Nothing in either language would
 * fail if one side were renamed, so this is the pin that would. */
describe('the fuel vocabulary spans the language boundary', () => {
	it('every aircraft grade is a grade cmd/fuel can emit', () => {
		for (const t of FUEL_TYPES) {
			expect(meta.grades).toContain(t);
		}
	});

	it('the two vocabularies are the same list', () => {
		// FUEL_TYPES being a subset says the aircraft grades are spelled
		// alike; this says neither side has grown one the other does not
		// know, which is what would let a NOTAM withdraw a grade no chip
		// can carry.
		expect([...FUEL_GRADES].sort()).toEqual([...meta.grades].sort());
	});

	it('the dataset emits no grade outside the vocabulary it declares', () => {
		const known = new Set(meta.grades);
		for (const row of doc.rows) {
			for (const [grade] of row[doc.fields.indexOf('grades')] as [string, string][]) {
				expect(known).toContain(grade);
			}
		}
	});

	it('labels the four the aeroplanes know as their data sheets do', () => {
		expect(gradeLabel('100LL')).toBe('AVGAS 100LL');
		expect(gradeLabel('SUPER AERO+')).toBe('UL Aéro Super+');
		// A grade with no aircraft counterpart wears its own code.
		expect(gradeLabel('F-34')).toBe('F-34');
	});
});

describe('committed fr-fuel.json', () => {
	it('has the schema src/lib/data/fuel.ts decodes', () => {
		expect(doc.fields).toEqual(['ident', 'avail', 'grades', 'flags', 'src', 'text']);
		expect(doc.rows.length).toBeGreaterThan(400);
		for (const r of doc.rows) {
			expect(r).toHaveLength(6);
			expect(typeof r[0]).toBe('string');
			expect(['yes', 'no']).toContain(r[1]);
			expect(Array.isArray(r[2])).toBe(true);
			expect(['vac', 'aixm', 'both']).toContain(r[4]);
			expect(typeof r[5]).toBe('string');
		}
	});

	it('agrees with its own sidecar', () => {
		expect(meta.aerodromes).toBe(doc.rows.length);
		const withGrades = doc.rows.filter((r) => (r[2] as unknown[]).length > 0).length;
		expect(meta.withGrades).toBe(withGrades);
		// The steady state: where both sources speak they agree, or one
		// knows more than the other. A contradiction means a reader drifted.
		expect(meta.agreement.diverge ?? 0).toBe(0);
	});

	it('carries the entries the AD 2 directory alone does not', () => {
		const row = (ident: string) => doc.rows.find((r) => r[0] === ident);
		const grades = (ident: string) =>
			((row(ident)?.[2] ?? []) as [string, string][]).map(([g]) => g);

		// Lognes: the case this feature exists for. The AD 2.4 slot carries
		// its opening hours and no grade; the plate carries all three.
		expect(grades('LFPL')).toEqual(['100LL', 'SUPER AERO+', 'JET A-1']);
		// Saint-Cyr and Chavenay have no AD 2.4 fuel entry at all.
		expect(grades('LFPZ')).toEqual(['100LL']);
		expect(grades('LFPX')).toEqual(['100LL']);
		// Orly names 100LL only to say it is not available.
		expect(grades('LFPO')).toEqual(['JET A-1']);
		// Fayence states there is none, which is an answer worth keeping.
		expect(row('LFMF')?.[1]).toBe('no');
		// Dax splits its pump: the F-34 is the air force's.
		expect(row('LFBY')?.[2]).toEqual([
			['100LL', 'civ'],
			['UL91', 'civ'],
			['F-34', 'mil'],
		]);
	});

	it('states its own words beside every grade it asserts', () => {
		for (const r of doc.rows) {
			if ((r[2] as unknown[]).length > 0) {
				expect((r[5] as string).length).toBeGreaterThan(0);
			}
		}
	});
});

function jsonResponse(body: unknown) {
	return {
		ok: true,
		status: 200,
		headers: { get: (): string => 'application/json' },
		json: () => Promise.resolve(body),
	};
}

describe('loadFrFuel', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('resolves columns by name and drops a row it cannot read', async () => {
		const raw = {
			fields: ['ident', 'avail', 'grades', 'flags', 'src', 'text'],
			rows: [
				['lfpl', 'yes', [['100LL', '']], ['h24'], 'both', 'Carburants : 100 LL'],
				['LFXX', 'maybe', [], [], 'vac', ''],
			],
		};
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(raw))));
		const list = await loadFrFuel('/data/x.json');
		expect(list).toHaveLength(1);
		expect(list[0].ident).toBe('LFPL');
		expect(list[0].grades).toEqual([{ grade: '100LL', scope: '' }]);
		expect(list[0].cond).toEqual(['h24']);
	});

	it('reads a non-JSON 200 as no rows, the way Vite dev serves a missing file', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					headers: { get: (): string => 'text/html' },
					json: () => Promise.reject(new Error('not json')),
				}),
			),
		);
		expect(await loadFrFuel('/data/x.json')).toEqual([]);
	});
});

describe('sellsGrade', () => {
	const row = (grades: [FuelGrade, '' | 'civ' | 'mil'][], avail: 'yes' | 'no' = 'yes') =>
		({
			ident: 'LFXX',
			avail,
			grades: grades.map(([grade, scope]) => ({ grade, scope })),
			cond: [],
			src: 'vac',
			text: '',
		}) satisfies AerodromeFuel;

	it('matches on the grades the aeroplane may take', () => {
		expect(sellsGrade(row([['100LL', '']]), ['100LL'])).toBe(true);
		expect(sellsGrade(row([['JET A-1', '']]), ['100LL'])).toBe(false);
	});

	it('never matches a military pump', () => {
		// F-18 IS avgas 100/130, and a civil pilot still cannot uplift it.
		expect(sellsGrade(row([['F-18', 'mil']]), ['100LL'])).toBe(false);
		expect(civilGrades(row([['100LL', 'civ'], ['F-34', 'mil']]))).toEqual(['100LL']);
	});

	it('separates "we do not know" from "no"', () => {
		// No row at all, and a row whose prose no grammar could read: both
		// unknown, and a caller must not turn either into a warning.
		expect(sellsGrade(null, ['100LL'])).toBeNull();
		expect(sellsGrade(row([]), ['100LL'])).toBeNull();
		// An explicit NIL is a real no.
		expect(sellsGrade(row([], 'no'), ['100LL'])).toBe(false);
	});

	it('answers nothing about an aeroplane that states no fuel', () => {
		// No aeroplane selected, or a data sheet with no fuel section. The
		// question "does this field sell what you burn" has no subject, and
		// the honest answer is the unknown, not a no.
		expect(sellsGrade(row([['100LL', '']]), [])).toBeNull();
		// An explicit NIL is still a no: that fact is about the aerodrome.
		expect(sellsGrade(row([], 'no'), [])).toBe(false);
	});

	it('keeps UL91 and UL Aéro Super+ apart, as the data sheets do', () => {
		expect(sellsGrade(row([['SUPER AERO+', '']]), ['UL91'])).toBe(false);
		expect(sellsGrade(row([['SUPER AERO+', '']]), ['100LL', 'UL91', 'SUPER AERO+'])).toBe(true);
	});
});

describe('gradeCovers', () => {
	it('is the identity on a named grade', () => {
		expect(gradeCovers('100LL', '100LL')).toBe(true);
		expect(gradeCovers('100LL', 'JET A-1')).toBe(false);
	});

	it('meets the AVGAS family from either side', () => {
		// Corte publishes the unqualified AVGAS and its NOTAM names the
		// family in French, the grade in English. Each direction settles one
		// of the two halves against the same published row.
		expect(gradeCovers('AVGAS', '100LL')).toBe(true);
		expect(gradeCovers('100LL', 'AVGAS')).toBe(true);
		expect(gradeCovers('AVGAS', 'UL91')).toBe(true);
		expect(gradeCovers('AVGAS', 'SUPER AERO+')).toBe(true);
	});

	it('keeps mogas and the NATO codes out of the family', () => {
		// Car petrol is not an avgas, and a civil pilot cannot uplift from a
		// military pump however close the product is (docs/fr-fuel.md).
		expect(gradeCovers('AVGAS', 'MOGAS')).toBe(false);
		expect(gradeCovers('MOGAS', 'AVGAS')).toBe(false);
		expect(gradeCovers('AVGAS', 'F-18')).toBe(false);
		expect(gradeCovers('F-18', 'AVGAS')).toBe(false);
		expect(gradeCovers('JET A-1', 'F-35')).toBe(false);
	});

	it('keeps UL91 and UL Aéro Super+ apart', () => {
		expect(gradeCovers('UL91', 'SUPER AERO+')).toBe(false);
	});
});

/* The four reasons an aerodrome cannot serve an aeroplane. They are not
 * interchangeable on a flight-prep sheet: two are the AIP's and permanent
 * until the next cycle, two carry a NOTAM id and may be gone by the flight. */
describe('fuelRefusal', () => {
	const offering = (
		grades: [string, '' | 'civ' | 'mil', string?][],
		extra: { avail?: 'yes' | 'no'; withdrawnAll?: unknown } = {},
	) => ({
		avail: extra.avail ?? ('yes' as const),
		grades: grades.map(([grade, scope, withdrawn]) => ({
			grade: grade as FuelGrade,
			scope,
			...(withdrawn === undefined ? {} : { withdrawn }),
		})),
		...(extra.withdrawnAll === undefined ? {} : { withdrawnAll: extra.withdrawnAll }),
	});

	it('says nothing where the aerodrome can serve', () => {
		expect(fuelRefusal(offering([['100LL', '']]), ['100LL'])).toBeNull();
	});

	it('separates the AIP publishing none from publishing the wrong one', () => {
		expect(fuelRefusal(offering([], { avail: 'no' }), ['100LL'])).toEqual({ kind: 'aipNone' });
		expect(fuelRefusal(offering([['JET A-1', '']]), ['100LL'])).toEqual({ kind: 'aipGrade' });
	});

	it('separates a whole-supply NOTAM from a grade one, and names it', () => {
		expect(fuelRefusal(offering([['100LL', '', 'N1']], { withdrawnAll: 'N1' }), ['100LL'])).toEqual({
			kind: 'notamAll',
			by: 'N1',
		});
		expect(fuelRefusal(offering([['100LL', '', 'N2'], ['JET A-1', '']]), ['100LL'])).toEqual({
			kind: 'notamGrade',
			by: 'N2',
			grades: ['100LL'],
		});
	});

	it('blames the AIP where the grade was never published', () => {
		// A NOTAM withdrew something else entirely; the reason this aeroplane
		// cannot fuel here is still the AIP's.
		expect(fuelRefusal(offering([['JET A-1', '', 'N3']]), ['100LL'])).toEqual({ kind: 'aipGrade' });
	});

	it('is silent where the aeroplane states no grades', () => {
		// The two AIP-vs-NOTAM grade reasons are about THIS aeroplane, and
		// there is no aeroplane. Without this the fuel plan marks every stop
		// and prints "LFLL does not publish " with an empty list after it.
		expect(fuelRefusal(offering([['100LL', '']]), [])).toBeNull();
		expect(fuelRefusal(offering([['100LL', '', 'N1']]), [])).toBeNull();
		// The two "no fuel at all" reasons are about the aerodrome and stand.
		expect(fuelRefusal(offering([], { avail: 'no' }), [])).toEqual({ kind: 'aipNone' });
		expect(fuelRefusal(offering([['100LL', '']], { withdrawnAll: 'N1' }), [])).toEqual({
			kind: 'notamAll',
			by: 'N1',
		});
	});

	it('is silent where nothing is known', () => {
		expect(fuelRefusal(null, ['100LL'])).toBeNull();
		// A row whose prose named no grade: the AIP said something we could
		// not read, and that is not a refusal.
		expect(fuelRefusal(offering([]), ['100LL'])).toBeNull();
	});

	it('agrees with sellsGrade in every case', () => {
		const cases = [
			offering([['100LL', '']]),
			offering([], { avail: 'no' }),
			offering([['JET A-1', '']]),
			offering([['100LL', '', 'N1']], { withdrawnAll: 'N1' }),
			offering([['100LL', '', 'N2']]),
			offering([]),
		];
		for (const c of cases) {
			const sells = sellsGrade(c, ['100LL']);
			const refusal = fuelRefusal(c, ['100LL']);
			// A refusal exists exactly where the verdict is false.
			expect(refusal != null, JSON.stringify(c)).toBe(sells === false);
		}
	});
});

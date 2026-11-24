import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseNotams, classifyOwner, firOwnershipIndex } from '$lib/notam';
import type { Notam, OwnerResolvers } from '$lib/notam';

/** Minimal Notam for the pure classification rules. */
function mk(opts: {
	codes: string[];
	scope?: string | null;
	qCode?: string;
}): Notam {
	return {
		id: 'TEST/26',
		icaoCodes: opts.codes,
		qCode: opts.qCode ?? '',
		qualifier:
			opts.scope == null
				? null
				: { scope: opts.scope, fir: '', code: '', traffic: '', purpose: '' },
	} as unknown as Notam;
}

/** Stub resolvers from literal sets. UAAA is deliberately in BOTH (Almaty:
 *  the airport ident equals the FIR id) to exercise the scope tiebreaker. */
const resolvers: OwnerResolvers = {
	isAirport: (c) => ['LFPG', 'KJFK', 'EGLL', 'UAAA'].includes(c),
	isFir: (c) => ['LFFF', 'LFMM', 'LIMM', 'LIRR', 'KZDC', 'UAAA'].includes(c),
};

describe('classifyOwner', () => {
	it('scope A / AE / AW with a known airport is aerodrome-owned', () => {
		for (const scope of ['A', 'AE', 'AW']) {
			expect(classifyOwner(mk({ codes: ['LFPG'], scope }), resolvers)).toEqual({
				kind: 'aerodrome',
				ident: 'LFPG',
			});
		}
	});

	it('scope E / W is FIR-owned, multi-FIR A) keeps every ident', () => {
		expect(classifyOwner(mk({ codes: ['LFFF'], scope: 'E' }), resolvers)).toEqual({
			kind: 'fir',
			firs: ['LFFF'],
		});
		expect(
			classifyOwner(mk({ codes: ['LIMM', 'LIRR'], scope: 'W' }), resolvers),
		).toEqual({ kind: 'fir', firs: ['LIMM', 'LIRR'] });
	});

	it('scope K and Q-code QKKKK are checklists', () => {
		expect(classifyOwner(mk({ codes: ['LFFF'], scope: 'K' }), resolvers)).toEqual({
			kind: 'checklist',
			firs: ['LFFF'],
		});
		expect(
			classifyOwner(mk({ codes: ['LFFF'], scope: '', qCode: 'QKKKK' }), resolvers),
		).toEqual({ kind: 'checklist', firs: ['LFFF'] });
	});

	it('scope A with a FIR-only ident is FIR-owned (French P-series deviation)', () => {
		expect(classifyOwner(mk({ codes: ['LFMM'], scope: 'A' }), resolvers)).toEqual({
			kind: 'fir',
			firs: ['LFMM'],
		});
	});

	it('scope E with an airport-only ident is aerodrome-owned (malformed scope)', () => {
		expect(classifyOwner(mk({ codes: ['LFPG'], scope: 'E' }), resolvers)).toEqual({
			kind: 'aerodrome',
			ident: 'LFPG',
		});
	});

	it('an unknown ident still follows the scope', () => {
		expect(classifyOwner(mk({ codes: ['ZZZZ'], scope: 'A' }), resolvers)).toEqual({
			kind: 'aerodrome',
			ident: 'ZZZZ',
		});
		expect(classifyOwner(mk({ codes: ['ZZZZ'], scope: 'E' }), resolvers)).toEqual({
			kind: 'fir',
			firs: ['ZZZZ'],
		});
	});

	it('airport / FIR ident collision: scope is the tiebreaker', () => {
		expect(classifyOwner(mk({ codes: ['UAAA'], scope: 'A' }), resolvers)).toEqual({
			kind: 'aerodrome',
			ident: 'UAAA',
		});
		expect(classifyOwner(mk({ codes: ['UAAA'], scope: 'E' }), resolvers)).toEqual({
			kind: 'fir',
			firs: ['UAAA'],
		});
	});

	it('no Q-line: the A) ident alone decides, airport first', () => {
		expect(classifyOwner(mk({ codes: ['KJFK'], scope: null }), resolvers)).toEqual({
			kind: 'aerodrome',
			ident: 'KJFK',
		});
		expect(classifyOwner(mk({ codes: ['KZDC'], scope: null }), resolvers)).toEqual({
			kind: 'fir',
			firs: ['KZDC'],
		});
		expect(classifyOwner(mk({ codes: ['XXXX'], scope: null }), resolvers)).toEqual({
			kind: 'unknown',
		});
	});

	it('no A) codes is unknown', () => {
		expect(classifyOwner(mk({ codes: [], scope: 'A' }), resolvers)).toEqual({
			kind: 'unknown',
		});
	});
});

describe('classifyOwner on parsed NOTAMs', () => {
	it('classifies the French P-series deviation from real header shapes', () => {
		const text = `LFFA-P4304/25
DU: 01 01 2026 00:00 AU: 31 12 2026 23:59
A) LFMM
Q) LFMM / QOBCE / IV / M / A / 000/999 / 4555N00605E005
E) PYLONE A 'EXEMPLE'
`;
		const notams = parseNotams(text);
		expect(notams).toHaveLength(1);
		expect(classifyOwner(notams[0], resolvers)).toEqual({
			kind: 'fir',
			firs: ['LFMM'],
		});
	});

	it('keeps every FIR of a multi-FIR A) line', () => {
		const text = `LFFA-R2339/25
DU: 01 01 2026 00:00 AU: 31 12 2026 23:59
A) LFFF LFBB LFRR LFEE
Q) LFXX / QRTTT / IV / BO / W / 095/215 / 4807N00126E272
E) NOTAM TRIGGER - SUP AIP 091/24
`;
		const notams = parseNotams(text);
		expect(notams.length).toBeGreaterThanOrEqual(1);
		expect(classifyOwner(notams[0], resolvers)).toEqual({
			kind: 'fir',
			firs: ['LFFF', 'LFBB', 'LFRR', 'LFEE'],
		});
	});
});

describe('firOwnershipIndex', () => {
	it('indexes FIR-owned items under every A) ident, checklists apart', () => {
		const items = [
			{ notam: mk({ codes: ['LIMM', 'LIRR'], scope: 'W' }), tag: 'w' },
			{ notam: mk({ codes: ['LFPG'], scope: 'A' }), tag: 'a' },
			{ notam: mk({ codes: ['LFFF'], scope: 'K', qCode: 'QKKKK' }), tag: 'k' },
		];
		const { briefing, checklists } = firOwnershipIndex(items, resolvers);
		expect(briefing.get('LIMM')?.map((i) => i.tag)).toEqual(['w']);
		expect(briefing.get('LIRR')?.map((i) => i.tag)).toEqual(['w']);
		expect(briefing.has('LFPG')).toBe(false);
		expect(briefing.has('LFFF')).toBe(false);
		expect(checklists.get('LFFF')?.map((i) => i.tag)).toEqual(['k']);
	});
});

describe('ownership over the Europe briefing fixture', () => {
	const text = readFileSync(
		new URL('./fixtures/Europe-20260203.txt', import.meta.url),
		'utf-8',
	);
	const notams = parseNotams(text);
	// One source NOTAM may yield several entries (one per coordinate group);
	// the ownership tallies below count source NOTAMs, so dedupe by id.
	const byId = new Map<string, Notam>();
	for (const n of notams) {
		if (!byId.has(n.id)) {
			byId.set(n.id, n);
		}
	}
	const unique = [...byId.values()];

	// FIR idents from the committed pruatlas dataset; airports resolve
	// nothing so the tallies are deterministic and dataset-independent.
	const pruatlas = JSON.parse(
		readFileSync(
			new URL('../public/data/pruatlas-firs.json', import.meta.url),
			'utf-8',
		),
	) as { rows: unknown[][] };
	const firIds = new Set(pruatlas.rows.map((r) => String(r[0]).toUpperCase()));
	const r: OwnerResolvers = {
		isAirport: () => false,
		isFir: (c) => firIds.has(c),
	};

	it('parses a stable number of source NOTAMs', () => {
		// 10199 before the parser's false-header guard: the checklist row
		// 'S01/26' inside a MIL SUP listing no longer becomes a bogus entry.
		expect(unique.length).toBe(10198);
	});

	it('classifies every parsed NOTAM, with a stable owner distribution', () => {
		const tally = { aerodrome: 0, fir: 0, checklist: 0, unknown: 0 };
		for (const n of unique) {
			tally[classifyOwner(n, r).kind] += 1;
		}
		// fir was 3647 before dropping the bogus 'S01/26' fragment (see
		// above), whose severed chunk carried a host Q-line and classified
		// as fir.
		expect(tally).toEqual({
			aerodrome: 6425,
			fir: 3646,
			checklist: 127,
			unknown: 0,
		});
	});

	it('builds the LFFF briefing with its checklists split out', () => {
		const items = unique.map((notam) => ({ notam }));
		const { briefing, checklists } = firOwnershipIndex(items, r);
		expect(briefing.get('LFFF')?.length).toBe(135);
		expect(checklists.get('LFFF')?.length).toBe(12);
	});

	it('lists a multi-FIR NOTAM under every FIR it is filed with', () => {
		const items = unique.map((notam) => ({ notam }));
		const { briefing } = firOwnershipIndex(items, r);
		const multi = unique.find((n) => {
			const o = classifyOwner(n, r);
			return o.kind === 'fir' && o.firs.length >= 2;
		});
		expect(multi).toBeTruthy();
		const owner = classifyOwner(multi!, r);
		if (owner.kind !== 'fir') {
			throw new Error('expected a fir owner');
		}
		for (const f of owner.firs) {
			expect(
				briefing.get(f)?.some((i) => i.notam.id === multi!.id),
			).toBe(true);
		}
	});
});

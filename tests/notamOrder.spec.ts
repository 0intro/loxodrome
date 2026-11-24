import { describe, it, expect } from 'vitest';
import { sortNotamsCanonical, notamOwnerBlockKey } from '$lib/notam/order';
import type { CanonicalOrderContext } from '$lib/notam/order';
import type { Notam } from '$lib/notam/types';
import type { NotamOwner } from '$lib/notam/ownership';

// Minimal NOTAM stubs: the sorter reads only id + qCode (for the subject tier);
// the owner is injected through the context, so no dataset is needed.
function n(id: string, qCode: string): Notam {
	return { id, qCode } as unknown as Notam;
}

// Build a context whose owner is looked up by NOTAM id from a table, with a
// route-aerodrome ranking.
function ctx(
	owners: Record<string, NotamOwner>,
	rank: Record<string, number> = {},
): CanonicalOrderContext {
	return {
		ownerOf: (notam) => owners[notam.id] ?? { kind: 'unknown' },
		aerodromeRank: new Map(Object.entries(rank)),
	};
}

const ad = (ident: string): NotamOwner => ({ kind: 'aerodrome', ident });
const fir = (...firs: string[]): NotamOwner => ({ kind: 'fir', firs });

function order(items: { notam: Notam; index: number }[], c: CanonicalOrderContext): string[] {
	return sortNotamsCanonical(items, c).map((x) => x.notam.id);
}

describe('sortNotamsCanonical', () => {
	it('orders aerodrome blocks by route position, not alphabetically', () => {
		// LFPK (departure, rank 0) before LFPL (destination, rank 1), even though
		// LFPL sorts first alphabetically.
		const items = [
			{ notam: n('A1', 'QFAAH'), index: 0 }, // LFPL
			{ notam: n('B1', 'QFAAH'), index: 1 }, // LFPK
		];
		const c = ctx({ A1: ad('LFPL'), B1: ad('LFPK') }, { LFPK: 0, LFPL: 1 });
		expect(order(items, c)).toEqual(['B1', 'A1']);
	});

	it('walks all route aerodromes in sequence (departure -> overflown -> destination)', () => {
		const items = [
			{ notam: n('DEST', 'QFAAH'), index: 0 },
			{ notam: n('MID', 'QFAAH'), index: 1 },
			{ notam: n('DEP', 'QFAAH'), index: 2 },
		];
		const c = ctx(
			{ DEP: ad('LFPL'), MID: ad('LFOB'), DEST: ad('LFPK') },
			{ LFPL: 0, LFOB: 1, LFPK: 2 },
		);
		expect(order(items, c)).toEqual(['DEP', 'MID', 'DEST']);
	});

	it('puts off-route aerodromes after routed ones, before FIR, before other', () => {
		const items = [
			{ notam: n('FIR1', 'QFAAH'), index: 0 },
			{ notam: n('OFF', 'QFAAH'), index: 1 }, // aerodrome not on any route
			{ notam: n('ROUTED', 'QFAAH'), index: 2 },
			{ notam: n('UNK', 'QFAAH'), index: 3 },
		];
		const c = ctx(
			{
				FIR1: fir('LFFF'),
				OFF: ad('LFXX'),
				ROUTED: ad('LFPL'),
				UNK: { kind: 'unknown' },
			},
			{ LFPL: 0 },
		);
		expect(order(items, c)).toEqual(['ROUTED', 'OFF', 'FIR1', 'UNK']);
	});

	it('checklists sit after FIR and before unknown', () => {
		const items = [
			{ notam: n('U', 'QXXXX'), index: 0 },
			{ notam: n('K', 'QKKKK'), index: 1 },
			{ notam: n('F', 'QFAAH'), index: 2 },
		];
		const c = ctx({
			U: { kind: 'unknown' },
			K: { kind: 'checklist', firs: ['LFFF'] },
			F: fir('LFFF'),
		});
		expect(order(items, c)).toEqual(['F', 'K', 'U']);
	});

	it('orders by ICAO subject family within one owner block', () => {
		// Same aerodrome; briefing order is restrictions, warnings, organisation,
		// obstacles, navcom, procedures, services, other.
		const items = [
			{ notam: n('svc', 'QFAAH'), index: 0 }, // services (6)
			{ notam: n('warn', 'QWMLW'), index: 1 }, // warnings (1)
			{ notam: n('restr', 'QRTCA'), index: 2 }, // restrictions (0)
			{ notam: n('obst', 'QOBCE'), index: 3 }, // obstacles (3)
			{ notam: n('navcom', 'QNMAS'), index: 4 }, // navcom (4)
		];
		const c = ctx({
			svc: ad('LFPL'),
			warn: ad('LFPL'),
			restr: ad('LFPL'),
			obst: ad('LFPL'),
			navcom: ad('LFPL'),
		});
		expect(order(items, c)).toEqual(['restr', 'warn', 'obst', 'navcom', 'svc']);
	});

	it('breaks subject ties by id, then keeps multi-area entries stable by index', () => {
		const items = [
			{ notam: n('E9/26', 'QFAAH'), index: 0 },
			{ notam: n('E1/26', 'QFAAH'), index: 1 },
			{ notam: n('E1/26', 'QFAAH'), index: 2 }, // same id: a second area
		];
		const c = ctx({ 'E9/26': ad('LFPL'), 'E1/26': ad('LFPL') });
		const sorted = sortNotamsCanonical(items, c);
		expect(sorted.map((x) => x.notam.id)).toEqual(['E1/26', 'E1/26', 'E9/26']);
		// The two E1/26 areas keep source order (index 1 before 2).
		expect(sorted[0].index).toBe(1);
		expect(sorted[1].index).toBe(2);
	});

	it('does not mutate the input array', () => {
		const items = [
			{ notam: n('A1', 'QFAAH'), index: 0 },
			{ notam: n('B1', 'QFAAH'), index: 1 },
		];
		const before = items.map((x) => x.notam.id);
		sortNotamsCanonical(items, ctx({ A1: ad('LFPK'), B1: ad('LFPL') }, { LFPL: 0, LFPK: 1 }));
		expect(items.map((x) => x.notam.id)).toEqual(before);
	});
});

describe('notamOwnerBlockKey', () => {
	it('keys aerodrome, FIR, checklist and unknown owners distinctly', () => {
		expect(notamOwnerBlockKey(ad('lfpl'))).toBe('AD LFPL');
		expect(notamOwnerBlockKey(fir('LFFF'))).toBe('FIR LFFF');
		// A multi-FIR NOTAM keys to its first sorted FIR.
		expect(notamOwnerBlockKey(fir('LFRR', 'LFBB'))).toBe('FIR LFBB');
		expect(notamOwnerBlockKey({ kind: 'checklist', firs: ['LFFF'] })).toBe('CHK LFFF');
		expect(notamOwnerBlockKey({ kind: 'unknown' })).toBe('?');
	});
});

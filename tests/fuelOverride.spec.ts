/* The fuel resolver ($lib/state/fuelOverride.svelte.ts) against real NOTAMs
 * and the grades fr-fuel.json really publishes: which chip a withdrawal
 * strikes, and what is said when it strikes none.
 *
 * The NOTAM associations are mocked (the freqOverride.spec idiom) so nothing
 * fetches, and the fuel dataset is stubbed per case so each aerodrome's
 * published grades are visible in the test rather than a file away.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseNotams } from '$lib/notam/parser';
import type { Notam } from '$lib/notam/types';
import type { AerodromeFuel } from '$lib/data/fuel';

const m = vi.hoisted(() => ({
	items: [] as { notam: Notam; index: number }[],
	row: null as AerodromeFuel | null,
}));

vi.mock('$lib/state/notam.svelte', async () => {
	const real =
		await vi.importActual<typeof import('$lib/state/notam.svelte')>('$lib/state/notam.svelte');
	return {
		...real,
		filteredNotams: () => m.items,
		notamsByIdent: () => {
			const map = new Map<string, { notam: Notam; index: number }[]>();
			for (const it of m.items) {
				for (const code of it.notam.icaoCodes) {
					const k = code.toUpperCase();
					map.set(k, [...(map.get(k) ?? []), it]);
				}
			}
			return map;
		},
		// Wide open: the date gate has its own contract (notamSchedule.spec)
		// and this file judges what is done with a source it accepts.
		activeEvalWindow: () => ({ from: -8.64e15, to: 8.64e15 }),
	};
});

vi.mock('$lib/state/aerodromeFuel.svelte', () => ({
	fuelForIdent: () => m.row,
	ensureAerodromeFuel: () => Promise.resolve([]),
	aerodromeFuelState: { loaded: true, loading: false, error: null },
}));

import { fuelNotamIdents, resolveAerodromeFuel } from '$lib/state/fuelOverride.svelte';

/** A published row carrying only what the resolver reads. */
function row(ident: string, grades: string[], avail: 'yes' | 'no' = 'yes'): AerodromeFuel {
	return {
		ident,
		avail,
		grades: grades.map((g) => ({ grade: g as AerodromeFuel['grades'][number]['grade'], scope: '' })),
		cond: [],
		src: 'vac',
		text: '',
	};
}

function load(...blocks: string[]): void {
	m.items = parseNotams(blocks.join('\n\n')).map((notam, index) => ({ notam, index }));
}

/** A whole NOTAM, so the Q-code, A) and the dates are the real ones. */
function notam(id: string, qCode: string, ident: string, e: string): string {
	return `${id} NOTAMN\nQ) LFFF/${qCode}/IV/NBO/A/000/999/4849N00237E005\nA) ${ident} B) 2601010000 C) 2712312359\nE) ${e}`;
}

beforeEach(() => {
	m.items = [];
	m.row = null;
});

describe('fuelNotamIdents', () => {
	it('lists only the aerodromes a fuel outage speaks about', () => {
		load(
			notam('A0001/26', 'QFUAU', 'LFQF', '100LL NOT AVBL'),
			// A fuel NOTAM that withdraws nothing: hours, not an outage.
			notam('A0002/26', 'QFUAH', 'LFRE', 'AVGAS 100LL FUELLING SKED : 0700-1000.'),
			// An outage that is not about fuel.
			notam('A0003/26', 'QLPAS', 'LFPL', 'PAPI RWY 08 U/S.'),
		);
		expect([...fuelNotamIdents()]).toEqual(['LFQF']);
	});
});

describe('resolveAerodromeFuel', () => {
	it('says nothing about an aerodrome with no published row', () => {
		load(notam('A0001/26', 'QFUAU', 'LFQF', '100LL NOT AVBL'));
		expect(resolveAerodromeFuel('LFQF', 'fr')).toEqual({ fuel: null, notes: [] });
	});

	it('returns the published row ITSELF when no NOTAM touches it', () => {
		// Identity, not equality: the Airports tab runs this per row on a
		// keystroke and a fresh object would defeat every memo below it.
		m.row = row('LFQF', ['100LL']);
		const r = resolveAerodromeFuel('LFQF', 'fr');
		expect(r.fuel).toBe(m.row);
	});

	it('strikes the grade the NOTAM names and leaves the rest', () => {
		m.row = row('LFQW', ['100LL', 'JET A-1']);
		load(notam('A0001/26', 'QFUAU', 'LFQW', 'AVGAS 100LL AND JET A1 NOT AVBL.'));
		const r = resolveAerodromeFuel('LFQW', 'fr');
		expect(r.fuel?.grades.map((g) => !!g.withdrawn)).toEqual([true, true]);

		m.row = row('LFBH', ['100LL', 'JET A-1']);
		load(notam('A0002/26', 'QFULT', 'LFBH', 'JET A1 NOT AVBL'));
		const r2 = resolveAerodromeFuel('LFBH', 'fr');
		expect(r2.fuel?.grades.map((g) => !!g.withdrawn)).toEqual([false, true]);
		expect(r2.notes).toEqual([]);
	});

	it('meets the family from either language (D3065/26 LFKO)', () => {
		// Corte publishes the unqualified AVGAS. The French half names the
		// family and the English half the grade; both must strike the same
		// chip and leave the Jet A-1 standing.
		for (const e of ['AVGAS NON DISPONIBLE', 'AVGAS 100LL NOT AVBL.']) {
			m.row = row('LFKO', ['AVGAS', 'JET A-1']);
			load(notam('D3065/26', 'QFULT', 'LFKO', e));
			const r = resolveAerodromeFuel('LFKO', 'fr');
			expect(r.fuel?.grades.map((g) => !!g.withdrawn), e).toEqual([true, false]);
		}
	});

	it('withdraws the whole supply without rewriting avail', () => {
		// `avail` means "the AIP states this field is dry"; a dated NOTAM
		// saying otherwise is a different fact with a link, and the panel and
		// the fuel plan both word themselves off that distinction.
		m.row = row('LFPK', ['100LL']);
		load(notam('E2663/26', 'QFULT', 'LFPK', 'FUELLING STATION U/S'));
		const r = resolveAerodromeFuel('LFPK', 'fr');
		expect(r.fuel?.withdrawnAll?.notam.id).toBe('E2663/26');
		expect(r.fuel?.avail).toBe('yes');
		expect(r.fuel?.grades.every((g) => g.withdrawn)).toBe(true);
	});

	it('notes a qualified statement instead of striking a chip', () => {
		m.row = row('LFRB', ['100LL', 'JET A-1']);
		load(notam('B3644/26', 'QFULT', 'LFRB', 'GENERAL AVIATION : JET A1 SELF DISPENSER U/S.'));
		const r = resolveAerodromeFuel('LFRB', 'fr');
		expect(r.fuel?.grades.every((g) => !g.withdrawn)).toBe(true);
		expect(r.notes.map((n) => n.kind)).toEqual(['partial']);
		expect(r.notes[0].source.notam.id).toBe('B3644/26');
	});

	it('notes a grade the aerodrome does not publish', () => {
		m.row = row('LFPE', ['100LL', 'UL91']);
		load(notam('A0001/26', 'QFULT', 'LFPE', "UL 'AERO SUPER PLUS' NOT AVBL"));
		const r = resolveAerodromeFuel('LFPE', 'fr');
		expect(r.fuel?.grades.every((g) => !g.withdrawn)).toBe(true);
		expect(r.notes.map((n) => n.kind)).toEqual(['unmatched']);
	});

	it('leaves a non-fuel outage alone', () => {
		// The one that would empty an aerodrome selling 100LL and Jet A-1.
		m.row = row('LFSM', ['100LL', 'JET A-1']);
		load(notam('A0001/26', 'QFUAU', 'LFSM', 'AVIATION ELECTRIC CHARGING STATION U/S'));
		const r = resolveAerodromeFuel('LFSM', 'fr');
		expect(r.fuel).toBe(m.row);
	});

	it('ignores a fuel NOTAM that withdraws nothing', () => {
		m.row = row('LFRE', ['100LL']);
		load(notam('A0002/26', 'QFUAH', 'LFRE', 'AVGAS 100LL FUELLING SKED : 0700-1000 1200-1600.'));
		expect(resolveAerodromeFuel('LFRE', 'fr').fuel).toBe(m.row);
	});

	it('ignores a withdrawal whose validity has passed', () => {
		m.row = row('LFQF', ['100LL']);
		load(
			'A0001/26 NOTAMN\nQ) LFFF/QFUAU/IV/NBO/A/000/999/4849N00237E005\n' +
				'A) LFQF B) 2401010000 C) 2401312359\nE) 100LL NOT AVBL',
		);
		const at = { fromMs: Date.UTC(2026, 0, 1), toMs: Date.UTC(2026, 0, 2) };
		expect(resolveAerodromeFuel('LFQF', 'fr', at).fuel).toBe(m.row);
	});

	it('notes rather than strikes when the D) schedule cannot be read', () => {
		m.row = row('LFQF', ['100LL']);
		load(
			'A0001/26 NOTAMN\nQ) LFFF/QFUAU/IV/NBO/A/000/999/4849N00237E005\n' +
				'A) LFQF B) 2601010000 C) 2712312359\nD) EVERY OTHER TUESDAY\nE) 100LL NOT AVBL',
		);
		const r = resolveAerodromeFuel('LFQF', 'fr');
		expect(r.fuel?.grades.every((g) => !g.withdrawn)).toBe(true);
		expect(r.notes.map((n) => n.kind)).toEqual(['schedule']);
	});
});

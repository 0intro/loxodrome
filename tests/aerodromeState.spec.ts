/* The aerodrome resolver ($lib/state/aerodromeState.svelte.ts) against real
 * NOTAMs: when a closure reaches the panel, and what is said when one does
 * not.
 *
 * The NOTAM associations are mocked (the runwayOverride.spec idiom) so
 * nothing fetches, and the aerodrome is built per case so its published name
 * is visible in the test rather than a dataset away. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseNotams } from '$lib/notam/parser';
import type { Notam } from '$lib/notam/types';
import type { Airport } from '$lib/data/airports';

const m = vi.hoisted(() => ({ items: [] as { notam: Notam; index: number }[] }));

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
		// and this file judges what is done with a source it accepts. The
		// resolver's default instant is drawnStateAt(); tests/closureInstant
		// pins which range each surface reads.
		activeEvalWindow: () => ({ from: -8.64e15, to: 8.64e15 }),
		drawnStateAt: () => ({ fromMs: -8.64e15, toMs: 8.64e15 }),
	};
});

import {
	resolveAerodromeState,
	aerodromeClosedByNotam,
	aerodromeNotamIdents,
} from '$lib/state/aerodromeState.svelte';

function airport(ident: string, name: string): Airport {
	return { ident, name, lat: 48.5, lon: 2.5, runways: [], radios: [] } as unknown as Airport;
}

/** One NOTAM filed under `ident`, with the Q-code and E text given. */
function load(ident: string, qCode: string, e: string, bc = 'B) 2609010000 C) 2612312359'): void {
	const text = `E4386/26 NOTAMN
Q) LFRR/${qCode}/IV/NBO/A/000/999/4430N00042W005
A) ${ident} ${bc}
E) ${e}`;
	m.items = parseNotams(text).map((notam, index) => ({ notam, index }));
}

beforeEach(() => {
	m.items = [];
});

describe('a closure reaches the panel', () => {
	it('E4386/26 LFOR: AD CLSD DUE TO DRONE SHOW', () => {
		load('LFOR', 'QFALC', 'AD CLSD DUE TO DRONE SHOW IN THE VICINITY OF AD');
		const a = airport('LFOR', 'ORLEANS SAINT DENIS DE L HOTEL');
		const r = resolveAerodromeState(a);
		expect(r.closed?.notam.id).toBe('E4386/26');
		expect(r.notes).toEqual([]);
		expect(aerodromeClosedByNotam(a)).toBe(true);
	});

	it('M1799/26 LFSO: the field named by its own name', () => {
		// The resolver is what supplies the published name to the grammar;
		// without that hand-off this line is a note (aerodromeClosure.spec).
		load('LFSO', 'QFALC', 'TERRAIN NANCY-OCHEY FERME.');
		expect(resolveAerodromeState(airport('LFSO', 'NANCY OCHEY')).closed?.notam.id).toBe(
			'E4386/26',
		);
		// The same line under a field of another name closes nothing.
		expect(resolveAerodromeState(airport('LFSO', 'LYON BRON')).closed).toBe(null);
	});
});

describe('what is said when nothing closes', () => {
	it('a restriction is a note, not a closure (M2599/26 LFOJ)', () => {
		load(
			'LFOJ',
			'QFALT',
			'AD IN AUTO INFORMATION, RESERVED FOR BASED CREWS.\n- AD CLOSED TO OUTSIDE ACFT',
		);
		const r = resolveAerodromeState(airport('LFOJ', 'ORLEANS BRICY'));
		expect(r.closed).toBe(null);
		// Two lines name the aerodrome and neither closes it, but a note says
		// what the NOTAM does rather than which sentence did it, so one note
		// is what reaches the panel.
		expect(r.notes.map((n) => n.kind)).toEqual(['partial']);
		expect(r.notes[0].notam.notam.id).toBe('E4386/26');
	});

	it('an unreadable D) schedule flags rather than closes', () => {
		// A closure whose recurrence is outside the parsed subset: closing the
		// field around the clock would be a claim the NOTAM never made.
		load('LFOR', 'QFALC', 'AD CLSD.', 'B) 2609010000 C) 2612312359 D) SEE AIP SUP');
		const r = resolveAerodromeState(airport('LFOR', 'ORLEANS'));
		expect(r.closed).toBe(null);
		expect(r.notes.map((n) => n.kind)).toEqual(['schedule']);
	});

	it('a D) schedule the parser reads closes only inside it', () => {
		load('LFOR', 'QFALC', 'AD CLSD.', 'B) 2609010000 C) 2612312359 D) MON-FRI 0800-1600');
		const a = airport('LFOR', 'ORLEANS');
		// A Tuesday inside the window.
		const tue = Date.UTC(2026, 8, 15, 10, 0);
		expect(resolveAerodromeState(a, { fromMs: tue, toMs: tue }).closed?.notam.id).toBe(
			'E4386/26',
		);
		// The Sunday after it: in validity, out of schedule, so nothing is
		// closed and nothing is said.
		const sun = Date.UTC(2026, 8, 20, 10, 0);
		const off = resolveAerodromeState(a, { fromMs: sun, toMs: sun });
		expect(off.closed).toBe(null);
		expect(off.notes).toEqual([]);
	});
});

describe('the gates', () => {
	it('a NOTAM out of its own validity closes nothing', () => {
		load('LFOR', 'QFALC', 'AD CLSD.', 'B) 2609210000 C) 2609232359');
		const a = airport('LFOR', 'ORLEANS');
		const before = Date.UTC(2026, 8, 18, 12, 0);
		expect(resolveAerodromeState(a, { fromMs: before, toMs: before }).closed).toBe(null);
		const during = Date.UTC(2026, 8, 22, 12, 0);
		expect(resolveAerodromeState(a, { fromMs: during, toMs: during }).closed?.notam.id).toBe(
			'E4386/26',
		);
	});

	it('another subject is another mechanism', () => {
		// A runway closure at the same field says nothing about the field.
		load('LFOR', 'QMRLC', 'RWY 07/25 CLSD DUE TO WIP');
		const r = resolveAerodromeState(airport('LFOR', 'ORLEANS'));
		expect(r.closed).toBe(null);
		expect(r.notes).toEqual([]);
	});

	it('an aerodrome no NOTAM names gets the shared empty answer', () => {
		// The identity is load-bearing: the Airports tab runs this per row on
		// every keystroke and a fresh object would defeat every memo below.
		load('LFOR', 'QFALC', 'AD CLSD.');
		const a = resolveAerodromeState(airport('LFPO', 'PARIS ORLY'));
		const b = resolveAerodromeState(airport('LFPG', 'PARIS CDG'));
		expect(a).toBe(b);
		expect(a.closed).toBe(null);
	});

	it('aerodromeNotamIdents is the cheap gate the scans read', () => {
		load('LFOR', 'QFALC', 'AD CLSD.');
		expect([...aerodromeNotamIdents()]).toEqual(['LFOR']);
		load('LFOR', 'QMRLC', 'RWY 07 CLSD');
		expect([...aerodromeNotamIdents()]).toEqual([]);
	});
});

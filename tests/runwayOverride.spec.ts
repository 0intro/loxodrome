/* The runway resolver ($lib/state/runwayOverride.svelte.ts) against real
 * NOTAMs and real published runway ends: which end a closure strikes, and
 * what is said when it strikes none.
 *
 * The NOTAM associations are mocked (the freqOverride.spec idiom) so nothing
 * fetches, and the aerodrome is built per case so its published ends are
 * visible in the test rather than a dataset away. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseNotams } from '$lib/notam/parser';
import type { Notam } from '$lib/notam/types';
import type { Airport, Runway } from '$lib/data/airports';

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
	declaredDistanceMark,
	onPublishedEnds,
	resolveAerodromeRunways,
	runwayNotamIdents,
} from '$lib/state/runwayOverride.svelte';

function airport(ident: string, pairs: [string, string][]): Airport {
	return {
		ident,
		name: ident,
		lat: 48.5,
		lon: 2.5,
		runways: pairs.map(([le, he]) => ({ le, he }) as Runway),
	} as Airport;
}

/** One NOTAM filed under `ident`, with the Q-code and E text given. */
function load(ident: string, qCode: string, e: string, extra = ''): void {
	const text = `E4272/26 NOTAMN
Q) LFBB/${qCode}/IV/NBO/A/000/999/4430N00042W005
A) ${ident} B) 2609010000 C) 2612312359${extra}
E) ${e}`;
	m.items = parseNotams(text).map((notam, index) => ({ notam, index }));
}

beforeEach(() => {
	m.items = [];
});

describe('resolveAerodromeRunways', () => {
	it('closes the ends a line closes outright', () => {
		// A5578/26 LFPB, verbatim.
		load('LFPB', 'QMRLC', 'RWY 07/25 AND 09/27 CLOSED');
		const r = resolveAerodromeRunways(airport('LFPB', [['07', '25'], ['09', '27'], ['03', '21']]));
		expect([...r.closed.keys()].sort()).toEqual(['07', '09', '25', '27']);
		expect(r.closed.get('07')!.notam.id).toBe('E4272/26');
		expect(r.notes).toEqual([]);
	});

	it('notes a line that restricts without closing', () => {
		// E3280/26 LFCC: landings prohibited, the runway stays open.
		load('LFCC', 'QMRLT', 'UNPAVED RWY 22 : APPROACH AND LDG PROHIBITED.');
		const r = resolveAerodromeRunways(airport('LFCC', [['04', '22']]));
		expect(r.closed.size).toBe(0);
		expect(r.notes.map((n) => `${n.kind}:${n.ends.join('/')}`)).toEqual(['partial:22']);
	});

	it('says so rather than guessing when the designator is not published', () => {
		// "Exact or nothing": a cited 23 never stands for a published 23L.
		load('LFXX', 'QMRLC', 'RWY 23 CLSD');
		const r = resolveAerodromeRunways(airport('LFXX', [['05L', '23L']]));
		expect(r.closed.size).toBe(0);
		expect(r.notes.map((n) => n.kind)).toEqual(['unmatched']);
	});

	it('notes rather than closes when the schedule cannot be read', () => {
		// "MON 0500-FRI 1530" is a continuous week-long span, not a daily
		// window, and stays unknown (notam/schedule.ts).
		load('LFPB', 'QMRLC', 'RWY 07/25 CLSD', '\nD) MON 0500-FRI 1530');
		const r = resolveAerodromeRunways(airport('LFPB', [['07', '25']]));
		expect(r.closed.size).toBe(0);
		expect(r.notes.map((n) => n.kind)).toEqual(['schedule']);
	});

	it('closes nothing outside the NOTAM validity', () => {
		load('LFPB', 'QMRLC', 'RWY 07/25 CLSD');
		const r = resolveAerodromeRunways(airport('LFPB', [['07', '25']]), {
			fromMs: Date.UTC(2027, 0, 1),
			toMs: Date.UTC(2027, 0, 2),
		});
		expect(r.closed.size).toBe(0);
		expect(r.notes).toEqual([]);
	});

	it('ignores a NOTAM that is not about a runway', () => {
		// The taxiway closure at the same field leaves the runways alone.
		load('LFPB', 'QMXLC', 'TWY E CLSD DUE TO WIP.');
		expect(resolveAerodromeRunways(airport('LFPB', [['07', '25']])).closed.size).toBe(0);
		expect(runwayNotamIdents().has('LFPB')).toBe(false);
	});

	it('hands back the same empty answer when nothing applies', () => {
		const a = airport('LFPB', [['07', '25']]);
		expect(resolveAerodromeRunways(a)).toBe(resolveAerodromeRunways(a));
	});

	it('lists the aerodromes a runway NOTAM speaks about', () => {
		load('LFPB', 'QMRLC', 'RWY 07/25 CLSD');
		expect([...runwayNotamIdents()]).toEqual(['LFPB']);
	});
});

// -------------------------------------------------------------------- //
// DECLARED DISTANCES (mechanism 18). The one override in this family     //
// that changes a NUMBER rather than striking a row, so its refusal is    //
// not silence: the figure left standing is the AIP's and is usually the  //
// longer of the two, which is the direction that matters under a         //
// take-off calculation.                                                  //
// -------------------------------------------------------------------- //
describe('declared distances', () => {
	const lfau = (): Airport => airport('LFAU', [['07', '25']]);

	it('E0479/26 LFAU: both ends take the NOTAM’s 320 m', () => {
		load(
			'LFAU',
			'QMDCH',
			'RWY 07/25 REVISED DECLARED DISTANCES : - RWY 07/25 DIMENSIONS REDUCED TO 320M X 60M - RWY 25 : TODA = 320M, ASDA = 320M, LDA = 320M - RWY 07 : TODA = 320M, ASDA = 320M, LDA = 320M.',
		);
		const r = resolveAerodromeRunways(lfau());
		expect(r.distances.get('07')?.values).toEqual({ toda: 320, asda: 320, lda: 320 });
		expect(r.distances.get('25')?.values).toEqual({ toda: 320, asda: 320, lda: 320 });
		// A value READ is not contested: the pair heading that named the ends
		// without stating figures is answered by the per-end scopes below it.
		expect(r.contested.size).toBe(0);
	});

	it('B1026/26 LFMV: a later scope refines an earlier one', () => {
		load(
			'LFMV',
			'QMDCH',
			'REVISED DECLARED DISTANCES : - RWY 17/35 : TORA = TODA = ASDA = 1875M - RWY 35 : LDA = 1565M.',
		);
		const r = resolveAerodromeRunways(airport('LFMV', [['17', '35']]));
		expect(r.distances.get('17')?.values).toEqual({ tora: 1875, toda: 1875, asda: 1875 });
		expect(r.distances.get('35')?.values).toEqual({
			tora: 1875,
			toda: 1875,
			asda: 1875,
			lda: 1565,
		});
	});

	it('B1025/26 LFMV: an unreadable statement CONTESTS the ends it names', () => {
		// Intersection figures, which are real distances and not these. The
		// published ones stay on the panel, and the panel has to say they are
		// disputed rather than print them plain.
		load(
			'LFMV',
			'QMDCH',
			'RWY 35 : NEW REMAINING DISTANCES FROM : - B = 1320M - C = 1025M RWY 17 : NEW REMAINING DISTANCES FROM : - B = 560M',
		);
		const r = resolveAerodromeRunways(airport('LFMV', [['17', '35']]));
		expect(r.distances.size).toBe(0);
		expect([...r.contested.keys()].sort()).toEqual(['17', '35']);
	});

	it('D0033/26 LFCN: a NOTAM this cannot scope contests the whole field', () => {
		load(
			'LFCN',
			'QMDCH',
			'UNPAVED RWY DIMENSION REDUCED ON THE WEST SIDE : -DIMENSIONS : 450M X 65M -TODA : 32L 450M 14R 450M -LDA : 32L 370M 14R 450M.',
		);
		const r = resolveAerodromeRunways(airport('LFCN', [['14R', '32L']]));
		expect([...r.contested.keys()].sort()).toEqual(['14R', '32L']);
		expect(r.notes.map((n) => n.kind)).toContain('unreadable');
	});

	it('another subject states no distance', () => {
		load('LFAU', 'QMRLC', 'RWY 07/25 CLSD DUE TO WIP');
		const r = resolveAerodromeRunways(lfau());
		expect(r.distances.size).toBe(0);
		expect(r.contested.size).toBe(0);
		expect([...r.closed.keys()].sort()).toEqual(['07', '25']);
	});

	it('a distance NOTAM out of its own validity changes nothing', () => {
		load('LFAU', 'QMDCH', 'RWY 07 : TORA = 320M', ' D) MON-FRI 0800-1600');
		const sat = Date.UTC(2026, 8, 19, 10, 0);
		const r = resolveAerodromeRunways(lfau(), { fromMs: sat, toMs: sat });
		expect(r.distances.size).toBe(0);
		const fri = Date.UTC(2026, 8, 18, 10, 0);
		expect(
			resolveAerodromeRunways(lfau(), { fromMs: fri, toMs: fri }).distances.get('07')?.values,
		).toEqual({ tora: 320 });
	});

	/** Several QMD NOTAMs filed under LFAU, each E text its own NOTAM. */
	function loadAll(...texts: string[]): void {
		const src = texts
			.map(
				(e, i) => `A000${i + 1}/26 NOTAMN
Q) LFBB/QMDCH/IV/NBO/A/000/999/4430N00042W005
A) LFAU B) 2609010000 C) 2612312359
E) ${e}`,
			)
			.join('\n\n');
		m.items = parseNotams(src).map((notam, index) => ({ notam, index }));
	}

	it('a figure one NOTAM states never answers ANOTHER NOTAM’s contest', () => {
		// A0002 states RWY 07's LDA label-first, which this does not read, so it
		// contests the whole field. A0001's TORA used to clear that contest for
		// 07, leaving the AIP's longer LDA plain beside a NOTAM saying 900 m.
		loadAll('RWY 07 : TORA = 1200M', 'LDA 07 : 900M');
		const r = resolveAerodromeRunways(lfau());
		expect(r.distances.get('07')?.values).toEqual({ tora: 1200 });
		expect(r.contested.get('07')?.notam.id).toBe('A0002/26');
		expect(r.contested.get('25')?.notam.id).toBe('A0002/26');
	});

	it('a NOTAM answers its OWN contests, never the other NOTAM’s', () => {
		// E0479/26's shape split across two NOTAMs: each heads the pair, which
		// contests both ends, and then reads only one of them. A NOTAM reading
		// its end answers its own heading for that end and nothing else.
		loadAll(
			'RWY 07/25 REVISED : - RWY 07 : TORA = 320M',
			'RWY 07/25 REVISED : - RWY 25 : TORA = 320M',
		);
		const r = resolveAerodromeRunways(lfau());
		// A0001 heads 25 without reading it; A0002 reads 25 but cannot answer
		// A0001's contest, and the same the other way round.
		expect(r.contested.get('25')?.notam.id).toBe('A0001/26');
		expect(r.contested.get('07')?.notam.id).toBe('A0002/26');
	});

	it('two NOTAMs stating one distance: the shorter stands, and names its own NOTAM', () => {
		loadAll('RWY 07 : TORA = 1500M TODA = 1600M', 'RWY 07 : TORA = 1200M');
		const o = resolveAerodromeRunways(lfau()).distances.get('07');
		expect(o?.values).toEqual({ tora: 1200, toda: 1600 });
		expect(o?.from.tora?.notam.id).toBe('A0002/26');
		expect(o?.from.toda?.notam.id).toBe('A0001/26');
		// Whichever comes first in the briefing.
		loadAll('RWY 07 : TORA = 1200M', 'RWY 07 : TORA = 1500M TODA = 1600M');
		const p = resolveAerodromeRunways(lfau()).distances.get('07');
		expect(p?.values).toEqual({ tora: 1200, toda: 1600 });
		expect(p?.from.tora?.notam.id).toBe('A0001/26');
	});

	it('a cell is marked per end and per distance, a contest first', () => {
		// One NOTAM: RWY 07's TORA read, RWY 25 contested by intersection
		// figures. The panel marked the whole row from 07 and hid 25's contest.
		loadAll('RWY 07 : TORA = 1200M RWY 25 : NEW REMAINING DISTANCES FROM : - B = 800M');
		const r = resolveAerodromeRunways(lfau());
		expect(declaredDistanceMark(r, ['07', '25'], 'tora')?.kind).toBe('contested');
		expect(declaredDistanceMark(r, ['07'], 'tora')?.kind).toBe('notam');
		// 07's LDA is the AIP's own: nothing to mark on that end alone.
		expect(declaredDistanceMark(r, ['07'], 'lda')).toBe(null);
		expect(declaredDistanceMark(r, ['25'], 'lda')?.kind).toBe('contested');
	});

	it('a cell names the NOTAM that stated its own distance', () => {
		// A later NOTAM refines the TORA; the TODA stays the first one's. The
		// mark named the end's latest NOTAM for every cell, the TODA's too.
		loadAll('RWY 07 : TORA = 1500M TODA = 1600M', 'RWY 07 : TORA = 1200M');
		const r = resolveAerodromeRunways(lfau());
		expect(declaredDistanceMark(r, ['07'], 'tora')?.notam.notam.id).toBe('A0002/26');
		expect(declaredDistanceMark(r, ['07'], 'toda')?.notam.notam.id).toBe('A0001/26');
	});
});

// -------------------------------------------------------------------- //
// The OurAirports baseline writes 1,297 fields' ends UNPADDED ('4'),     //
// while the resolver keys ends normalised ('04'). The panel normalises   //
// its lookups; the performance page keys by RunwayEnd.id, the dataset's  //
// own spelling, and missed: a closed runway read open there.             //
// -------------------------------------------------------------------- //
describe('ends as the dataset spells them', () => {
	it('a closure on an unpadded field reaches the dataset spelling', () => {
		load('ENFA', 'QMRLC', 'RWY 04/22 CLSD');
		const a = airport('ENFA', [['4', '22']]);
		const r = resolveAerodromeRunways(a);
		expect([...r.closed.keys()].sort()).toEqual(['04', '22']);
		expect([...onPublishedEnds(a, r.closed).keys()].sort()).toEqual(['22', '4']);
	});

	it('a restated distance does too, and a padded field comes back as it was', () => {
		load('ENFA', 'QMDCH', 'RWY 04 : TORA = 700M');
		const a = airport('ENFA', [['4', '22']]);
		const r = resolveAerodromeRunways(a);
		expect(onPublishedEnds(a, r.distances).get('4')?.values).toEqual({ tora: 700 });
		const padded = airport('LFAU', [['07', '25']]);
		load('LFAU', 'QMRLC', 'RWY 07/25 CLSD');
		const rp = resolveAerodromeRunways(padded);
		expect(onPublishedEnds(padded, rp.closed)).toBe(rp.closed);
	});
});

describe('a statement the table cannot place', () => {
	it('a closure of an end the field does not publish is noted, never struck', () => {
		load('LFPG', 'QMRLC', 'RWY 23 CLSD');
		const r = resolveAerodromeRunways(airport('LFPG', [['05L', '23R'], ['05R', '23L']]));
		expect(r.closed.size).toBe(0);
		expect(r.notes.map((n) => [n.kind, n.ends])).toEqual([['unmatched', ['23']]]);
	});

	it('figures for an end the field does not publish contest the whole field', () => {
		// The dangerous direction: the AIP's own, usually longer, figures
		// would otherwise print plain beside a NOTAM saying they changed.
		load('LFPG', 'QMDCH', 'RWY 23 : TORA = 1200M');
		const r = resolveAerodromeRunways(airport('LFPG', [['05L', '23R'], ['05R', '23L']]));
		expect(r.distances.size).toBe(0);
		expect([...r.contested.keys()].sort()).toEqual(['05L', '05R', '23L', '23R']);
		expect(r.notes.map((n) => n.kind)).toEqual(['unreadable']);
	});
});

/* NOTAM vertical limits: F)/G) parsing on real briefing fixtures, the
 * OPADD precedence over the Q-line band, the visibleNotams() altitude
 * clause, and the malformed-Q-band retention path. */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseNotams, parseQualifierLine } from '$lib/notam';
import type { Notam } from '$lib/notam';
import { notamBandFt } from '$lib/vertical/limits';
import { notamState, visibleNotams } from '$lib/state/notam.svelte';
import { filter } from '$lib/state/filter.svelte';

const areasText = readFileSync(new URL('./fixtures/areas', import.meta.url), 'utf-8');

function one(notams: Notam[], id: string): Notam {
	const n = notams.find((x) => x.id === id);
	expect(n, id).toBeTruthy();
	return n!;
}

// Verbatim briefing extracts (SOFIA DU:/AU: and ICAO B)/C) forms).
const W1345 = `LFFA-W1345/25
DU: 01 07 2025 00:00 AU: PERM
A) LFEE
Q) LFEE / QWULW / IV / BO / W / 000/017 / 4904N00554E005
E) ACTIVITE AEROMODELISME NR8362 'PUXIEUX' MODIFIEE :
- PLAFOND RELEVE A 800FT ASFC
- HORAIRES D'ACTIVITE : 0700-1730 (ETE -1HR) DE JOUR UNIQUEMENT
PSN : 490415N 0055343E
REF ENR5.5
F) SFC
G) 1650FT AMSL
`;

const W1334 = `LFFA-W1334/25
DU: 01 07 2025 00:00 AU: PERM
A) LFGO
Q) LFFF / QWBLW / IV / M / AW / 015/040 / 4817N00310E005
E) ACTIVITE VOLTIGE RESERVEE AUX PILOTES AUTORISES PAR L'EXPLOITANT
D'AERODROME DE PONT-SUR-YONNE (89)
PSN : 481658N 0030930E
REF ENR5.5
F) 1500FT AGL
G) 4000FT AMSL
`;

const A0836 = `A0836/26 NOTAMR A0802/26
Q) DTTC/QRALW/IV/NBO/AW/000/095/3343N00953E026
A) DTTG B) 2606081114 C) 2607262359
E) REF NOTAM A0835/26
AIRSPACE RESERVATION FOR MIL ACT WILL TAKE PLACE OUTSIDE AD HR SER:
340100N 0101600E 332740N 0101600E
332903N 0093100E 334220N 0093100E
335536N 0094800E 340100N 0095000E
F) SFC
G) FL095
`;

const B1099 = `B1099/26 NOTAMN
Q) EFIN/QWULW/IV/BO/AW/000/008/6102N02808E002
A) EFLP B) 2606090800 C) 2606121500
D) TUE 0800-1500, WED-FRI 0500-1500
E) CIVIL BVLOS UAV ACTIVITY PSN 610046N 0280117E, RADIUS 2300M,
MAX HGT 120M AGL
F) SFC
G) 120M AGL
`;

describe('F)/G) parsing on briefing fixtures', () => {
	it('LFFA-W1345/25: F) SFC / G) 1650FT AMSL', () => {
		const n = one(parseNotams(W1345), 'LFFA-W1345/25');
		expect(n.fgLower?.sfc).toBe(true);
		expect(n.fgUpper?.ref).toBe('AMSL');
		expect(n.fgUpper?.ft).toBe(1650);
	});

	it('LFFA-W1334/25: the AGL datum survives where the Q-line flattened it', () => {
		const n = one(parseNotams(W1334), 'LFFA-W1334/25');
		// The publisher turned 1500 ft AGL into Q 015; F) keeps the datum.
		expect(n.qualifier?.lower).toBe(15);
		expect(n.fgLower?.ref).toBe('AGL');
		expect(n.fgLower?.ft).toBe(1500);
		expect(n.fgUpper?.ref).toBe('AMSL');
		expect(n.fgUpper?.ft).toBe(4000);
	});

	it('A0836/26: F) SFC / G) FL095', () => {
		const n = one(parseNotams(A0836), 'A0836/26');
		expect(n.fgLower?.sfc).toBe(true);
		expect(n.fgUpper?.ref).toBe('STD');
		expect(n.fgUpper?.ft).toBe(9500);
		expect(notamBandFt(n.fgLower, n.fgUpper, n.qualifier)).toEqual({
			floor: 0,
			ceiling: 9500,
		});
	});

	it('B1099/26: metric G) 120M AGL converts and stays terrain-relative', () => {
		const n = one(parseNotams(B1099), 'B1099/26');
		expect(n.fgUpper?.ref).toBe('AGL');
		expect(n.fgUpper?.unit).toBe('m');
		expect(n.fgUpper?.ft).toBeCloseTo(393.7, 1);
		// Filtering: an AGL ceiling with unknown terrain is unbounded, so
		// the F/G band keeps the NOTAM where the coarse Q 000/008 band
		// (0..800 ft) would have hidden it above 800 ft.
		const band = notamBandFt(n.fgLower, n.fgUpper, n.qualifier)!;
		expect(band.floor).toBe(0);
		expect(band.ceiling).toBe(Infinity);
	});

	it('ENGM-A0526/26 (areas fixture): F) GND / G) UNL on every emitted area', () => {
		const all = parseNotams(areasText).filter((n) => n.id === 'ENGM-A0526/26');
		expect(all.length).toBeGreaterThanOrEqual(2);
		for (const n of all) {
			expect(n.fgLower?.sfc).toBe(true);
			expect(n.fgUpper?.unl).toBe(true);
		}
	});

	it('LFFA-R2339/25 (areas fixture): NOTAM-level F/G only; per-zone E) limits are out of scope', () => {
		const n = one(parseNotams(areasText), 'LFFA-R2339/25');
		expect(n.fgLower?.ft).toBe(9500);
		expect(n.fgUpper?.ft).toBe(21500);
	});
});

describe('malformed Q-line band retention', () => {
	it('degrades the band to NaN and keeps the rest of the qualifier', () => {
		const q = parseQualifierLine(
			'LFFF / QWULW / IV / BO / W / 0A0/999 / 4840N00305E005',
		);
		expect(q).toBeTruthy();
		expect(q!.fir).toBe('LFFF');
		expect(Number.isNaN(q!.lower)).toBe(true);
		expect(q!.upper).toBe(999);
		expect(q!.radius).toBe(5);
	});

	it('no longer drops a NOTAM whose only coordinate source is the Q-line', () => {
		const text = `X0001/26 NOTAMN
Q) LFFF/QWULW/IV/BO/W/0A0/999/4840N00305E005
A) LFFF B) 2605010000 C) 2612010000
E) TEST WITH NO POSITION IN THE TEXT.
`;
		const notams = parseNotams(text);
		expect(notams.length).toBe(1);
		expect(Number.isNaN(notams[0].qualifier!.lower)).toBe(true);
		// A NaN band means "no vertical statement": never filtered on it.
		expect(notamBandFt(notams[0].fgLower, notams[0].fgUpper, notams[0].qualifier)).toBeNull();
	});
});

describe('visibleNotams() altitude clause', () => {
	// One synthetic NOTAM per case, all IV at the same spot so only the
	// altitude dimension decides.
	const FG_BEATS_Q = `A0101/26
Q) LFFF / QWULW / IV / BO / W / 000/008 / 4500N00300E005
A) LFPG
B) 2605010000 C) 2612010000
E) UAV ACT PSN 450000N 0030000E.
F) SFC
G) 120M AGL
`;
	const Q_ONLY = `A0102/26
Q) LFFF / QWBLW / IV / M / W / 015/040 / 4500N00300E005
A) LFPG
B) 2605010000 C) 2612010000
E) AEROBATICS PSN 450000N 0030000E.
`;
	const Q_DEFAULTS = `A0103/26
Q) LFFF / QOBCE / IV / M / A / 000/999 / 4500N00300E005
A) LFPG
B) 2605010000 C) 2612010000
E) CRANE PSN 450000N 0030000E.
`;
	const NO_QLINE = `A0104/26
A) LFPG
B) 2605010000 C) 2612010000
E) UNSPECIFIED ACT PSN 450000N 0030000E.
`;

	beforeEach(() => {
		filter.query = '';
		filter.kind.area = filter.kind.position = filter.kind.qualifierLine = true;
		// The fixtures run 2605010000 to 2612010000, A0836 to 2607262359; a
		// window inside every one of them leaves altitude the only dimension
		// under test, whatever the wall clock says.
		filter.window.mode = 'custom';
		filter.window.fromDate = '2026-05-15';
		filter.window.fromTime = '00:00';
		filter.window.toDate = '2026-05-16';
		filter.window.toTime = '00:00';
		filter.trafficMode = 'all';
		filter.altitude.enabled = true;
		notamState.notams = parseNotams(
			[FG_BEATS_Q, Q_ONLY, Q_DEFAULTS, NO_QLINE].join('\n\n'),
		);
		notamState.fetchBbox = null;
	});

	function visibleIds(): string[] {
		return visibleNotams()
			.map((v) => v.notam.id)
			.sort();
	}

	it('keeps everything on the default 0..10000 band', () => {
		filter.altitude.floor = 0;
		filter.altitude.ceiling = 10000;
		expect(visibleIds()).toEqual(['A0101/26', 'A0102/26', 'A0103/26', 'A0104/26']);
	});

	it('F)/G) wins over the Q-line band (conservative AGL ceiling)', () => {
		// 1000..2000 ft: the Q band of A0101 (0..800) would exclude it, but
		// its G) 120M AGL ceiling is unbounded without terrain. A0102's
		// Q-only band 1500..4000 overlaps. The 000/999 defaults and the
		// Q-less NOTAM always pass.
		filter.altitude.floor = 1000;
		filter.altitude.ceiling = 2000;
		expect(visibleIds()).toEqual(['A0101/26', 'A0102/26', 'A0103/26', 'A0104/26']);
	});

	it('filters on the Q band when no F)/G) is published', () => {
		// 8000..9000 ft: A0102 (1500..4000) drops out; A0101 stays via its
		// unbounded AGL ceiling; the defaults and Q-less rows stay.
		filter.altitude.floor = 8000;
		filter.altitude.ceiling = 9000;
		expect(visibleIds()).toEqual(['A0101/26', 'A0103/26', 'A0104/26']);
	});

	it('filters on a bounded F)/G) band', () => {
		// A0101 has F) SFC: a floor-anchored band above the surface still
		// intersects [0, inf); but a band wholly below a bounded F/G floor
		// must drop the NOTAM. Reuse A0836-style limits for that.
		notamState.notams = parseNotams(A0836);
		filter.altitude.floor = 10000;
		filter.altitude.ceiling = 20000;
		// F) SFC / G) FL095 = 0..9500 ft: disjoint from 10000..20000.
		expect(visibleIds()).toEqual([]);
	});
});

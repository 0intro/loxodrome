/* Pure RTBA parser/anchoring specs ($lib/notam/rtba). RTBA activation NOTAMs
 * (French air-force low-altitude restricted areas) list several zones, each with
 * its own HHMM-HHMM window, under a "ZONES AIRFORCE RTBA ACT" header. The bare
 * token (R45C, R45S6.1, R45NS, R69) maps to the airspace id by prefixing LF.
 * Covers detection, the line-pair parse (incl. the S6.1 decimal / NS suffix the
 * generic regex can't represent), date anchoring off startDate from BOTH the
 * ICAO B)/C) and the SIA DU:/AU: forms (the "French vs English" requirement), the
 * overnight roll-forward, and the per-zone "active now" boundary. No map/state. */

import { describe, it, expect } from 'vitest';
import { parseNotams } from '$lib/notam';
import {
	isRtbaActivationNotam,
	parseRtbaZones,
	rtbaZoneActivations,
	rtbaActiveAt,
	rtbaActiveDuring,
} from '$lib/notam/rtba';
import { formatActivationWindow } from '$lib/format/datetime';

// The user's NOTAM, ICAO form (B)/C), YYMMDDHHMM): R45C runs 1130-1230 while
// every other zone runs 1130-1330.
const Z0289_ICAO = `LFFA-Z0289/26
Q) LFXX/QRRCA/IV/BO/W/000/085/4721N00505E062
A) LFEE LFFF LFMM
B) 2606011130 C) 2606011330
E) ZONES AIRFORCE RTBA ACT
ZONE R45C ARBOIS
1130-1230:ACTIVE
ZONE R45S2 LANGRES
1130-1330:ACTIVE
ZONE R45S3 YONNE
1130-1330:ACTIVE
ZONE R45S4 MACONNAIS OUEST
1130-1330:ACTIVE
ZONE R45S5 MACONNAIS CENTRE
1130-1330:ACTIVE
ZONE R45S6.1 MACONNAIS NORD EST
1130-1330:ACTIVE
ZONE R45S6.2 MACONNAIS SUD EST
1130-1330:ACTIVE
ZONE R45S7 JURA
1130-1330:ACTIVE
ZONE R45NS DAMBLAIN
1130-1330:ACTIVE
F) SFC
G) FL085
`;

// The SAME NOTAM, SIA French form (DU:/AU:, DD MM YYYY HH:MM). Must anchor to the
// identical instants as the ICAO form.
const Z0289_FRENCH = `LFFA-Z0289/26
DU: 01 06 2026 11:30 AU: 01 06 2026 13:30
A) LFEE LFFF LFMM
Q) LFXX/QRRCA/IV/BO/W/000/085/4721N00505E062
E) ZONES AIRFORCE RTBA ACT
ZONE R45C ARBOIS
1130-1230:ACTIVE
ZONE R45S2 LANGRES
1130-1330:ACTIVE
ZONE R45S6.1 MACONNAIS NORD EST
1130-1330:ACTIVE
ZONE R45NS DAMBLAIN
1130-1330:ACTIVE
F) SFC
G) FL085
`;

// A real overnight RTBA NOTAM (from Europe-20260203.txt): windows that cross
// midnight (R69 1728-0059 ends 00:59 the next day).
const Z0078_OVERNIGHT = `LFFA-Z0078/26
Q) LFXX/QRRCA/IV/BO/W/000/045/4854N00529E052
A) LFEE LFFF
B) 2602051600 C) 2602060638
E) ZONES AIRFORCE RTBA ACT
ZONE R45N2 ARDENNES
1600-0638:ACTIVE
ZONE R69 CHAMPAGNE
1728-0059:ACTIVE
F) 800FT AGL
G) 2700FT AGL
`;

// LFFA-Z0303/26 (SIA DU:/AU: form): each zone is active in a morning AND an
// evening slot, printed as two consecutive ":ACTIVE" lines under one ZONE line.
// The parser must emit BOTH windows; it used to keep only the first, so the
// evening slot never hatched even when the date filter covered it.
const Z0303_TWO_WINDOWS = `LFFA-Z0303/26
DU: 09 06 2026 07:30 AU: 09 06 2026 23:59
A) LFEE LFFF
Q) LFXX / QRRCA / IV / BO / W / 000/065 / 4735N00449E057
E) ZONES AIRFORCE RTBA ACT
ZONE R45A BOURGOGNE
0800-1000:ACTIVE
2013-2259:ACTIVE
ZONE R45NS DAMBLAIN
0730-1000:ACTIVE
2013-2359:ACTIVE
F) SFC
G) FL065
`;

// A plain (non-RTBA) restricted-area activation: by-code, no zone block.
const ENGHIEN = `LFFA-R2112/25
DU: 13 09 2025 00:00 AU: 15 04 2026 23:59
A) LFFE
Q) LFFF / QRRCA / IV / BO / AW / 000/015 / 4904N00220E003
E) ZONE REGLEMENTEE LF-R262 'ENGHIEN' MODIFIEE : HORAIRES MODIFIES : H24
F) SFC
G) 1500FT AMSL
`;

// A non-activation NOTAM that merely mentions RTBA in prose.
const NON_ACTIVATION = `LFFA-Z9999/26
Q) LFFF / QOBCE / IV / M / A / 000/005 / 4900N00210E001
A) LFPG
B) 2606010000 C) 2606012359
E) CRANE ERECTED NEAR THE RTBA.
F) SFC
G) 150FT AGL
`;

const z0289 = parseNotams(Z0289_ICAO)[0];
const z0289fr = parseNotams(Z0289_FRENCH)[0];
const z0078 = parseNotams(Z0078_OVERNIGHT)[0];
const z0303 = parseNotams(Z0303_TWO_WINDOWS)[0];
const enghien = parseNotams(ENGHIEN)[0];
const nonAct = parseNotams(NON_ACTIVATION)[0];

const iso = (d: Date) => d.toISOString();
const findZone = (n: typeof z0289, id: string) =>
	rtbaZoneActivations(n).find((z) => z.airspaceId === id)!;

describe('isRtbaActivationNotam', () => {
	it('flags a QRRCA RTBA block', () => {
		expect(isRtbaActivationNotam(z0289)).toBe(true);
		expect(isRtbaActivationNotam(z0289fr)).toBe(true);
		expect(isRtbaActivationNotam(z0078)).toBe(true);
	});
	it('rejects a plain by-code activation and a non-activation', () => {
		expect(z0289.qCode).toBe('QRRCA');
		expect(isRtbaActivationNotam(enghien)).toBe(false);
		expect(isRtbaActivationNotam(nonAct)).toBe(false);
	});
});

describe('parseRtbaZones', () => {
	it('parses every zone of the user NOTAM, LF-prefixed, in body order', () => {
		const zones = parseRtbaZones(z0289);
		expect(zones.map((z) => z.airspaceId)).toEqual([
			'LFR45C', 'LFR45S2', 'LFR45S3', 'LFR45S4', 'LFR45S5',
			'LFR45S6.1', 'LFR45S6.2', 'LFR45S7', 'LFR45NS',
		]);
		expect(zones[0]).toMatchObject({
			token: 'R45C', name: 'ARBOIS', startHHMM: '1130', endHHMM: '1230',
		});
		// The decimal sub-zone and its name, which the generic regex can't reach.
		expect(zones[5]).toMatchObject({
			airspaceId: 'LFR45S6.1', name: 'MACONNAIS NORD EST', endHHMM: '1330',
		});
	});
	it('returns [] for non-RTBA NOTAMs', () => {
		expect(parseRtbaZones(enghien)).toEqual([]);
		expect(parseRtbaZones(nonAct)).toEqual([]);
	});
});

describe('rtbaZoneActivations (anchoring)', () => {
	it('anchors each window to startDate, per-zone end times distinct', () => {
		const c = findZone(z0289, 'LFR45C');
		const s2 = findZone(z0289, 'LFR45S2');
		expect(iso(c.start)).toBe('2026-06-01T11:30:00.000Z');
		expect(iso(c.end)).toBe('2026-06-01T12:30:00.000Z');
		expect(iso(s2.end)).toBe('2026-06-01T13:30:00.000Z');
	});
	it('anchors identically from the French DU:/AU: form', () => {
		const en = findZone(z0289, 'LFR45C');
		const fr = findZone(z0289fr, 'LFR45C');
		expect(fr.start.getTime()).toBe(en.start.getTime());
		expect(fr.end.getTime()).toBe(en.end.getTime());
		expect(iso(findZone(z0289fr, 'LFR45S2').end)).toBe('2026-06-01T13:30:00.000Z');
	});
	it('rolls a midnight-crossing window onto the next UTC day', () => {
		const n2 = findZone(z0078, 'LFR45N2');
		const r69 = findZone(z0078, 'LFR69');
		expect(iso(n2.start)).toBe('2026-02-05T16:00:00.000Z');
		expect(iso(n2.end)).toBe('2026-02-06T06:38:00.000Z');
		expect(iso(r69.start)).toBe('2026-02-05T17:28:00.000Z');
		expect(iso(r69.end)).toBe('2026-02-06T00:59:00.000Z');
	});
});

describe('rtbaActiveAt (per-zone boundary)', () => {
	it('at 12:45Z includes the 1130-1330 zones, excludes the 1130-1230 zone', () => {
		const now = Date.parse('2026-06-01T12:45:00Z');
		const ids = rtbaActiveAt(z0289, now).map((z) => z.airspaceId);
		expect(ids).toContain('LFR45S2');
		expect(ids).not.toContain('LFR45C');
		expect(ids).toHaveLength(8);
	});
	it('is empty before the window opens and after it closes', () => {
		expect(rtbaActiveAt(z0289, Date.parse('2026-06-01T11:00:00Z'))).toHaveLength(0);
		expect(rtbaActiveAt(z0289, Date.parse('2026-06-01T14:00:00Z'))).toHaveLength(0);
	});
});

describe('rtbaActiveDuring (range overlap)', () => {
	it('a range spanning 1130-1330 includes every zone', () => {
		const ids = rtbaActiveDuring(
			z0289,
			Date.parse('2026-06-01T11:00:00Z'),
			Date.parse('2026-06-01T14:00:00Z'),
		).map((z) => z.airspaceId);
		expect(ids).toHaveLength(9);
		expect(ids).toContain('LFR45C');
		expect(ids).toContain('LFR45S2');
	});

	it('a range entirely before the windows is empty', () => {
		expect(
			rtbaActiveDuring(
				z0289,
				Date.parse('2026-06-01T09:00:00Z'),
				Date.parse('2026-06-01T11:00:00Z'),
			),
		).toHaveLength(0);
	});

	it('a range opening after 12:30 excludes the 1130-1230 zone', () => {
		const ids = rtbaActiveDuring(
			z0289,
			Date.parse('2026-06-01T12:45:00Z'),
			Date.parse('2026-06-01T13:00:00Z'),
		).map((z) => z.airspaceId);
		expect(ids).not.toContain('LFR45C');
		expect(ids).toHaveLength(8);
	});

	it('matches rtbaActiveAt for the degenerate instant (from === to)', () => {
		const now = Date.parse('2026-06-01T12:45:00Z');
		expect(rtbaActiveDuring(z0289, now, now).map((z) => z.airspaceId)).toEqual(
			rtbaActiveAt(z0289, now).map((z) => z.airspaceId),
		);
	});
});

describe('formatActivationWindow', () => {
	it('formats a same-day window', () => {
		const c = findZone(z0289, 'LFR45C');
		expect(formatActivationWindow(c.start, c.end)).toBe('11:30–12:30Z');
	});
	it('marks an overnight window with (+1)', () => {
		const r69 = findZone(z0078, 'LFR69');
		expect(formatActivationWindow(r69.start, r69.end)).toBe('17:28–00:59Z (+1)');
	});
	it('returns the dash placeholder when an endpoint is missing', () => {
		expect(formatActivationWindow(null, null)).toBe('–');
	});
});

describe('several windows per zone (LFFA-Z0303/26)', () => {
	it('parseRtbaZones emits one entry per window, in body order', () => {
		expect(
			parseRtbaZones(z0303).map(
				(z) => `${z.airspaceId} ${z.startHHMM}-${z.endHHMM}`,
			),
		).toEqual([
			'LFR45A 0800-1000',
			'LFR45A 2013-2259',
			'LFR45NS 0730-1000',
			'LFR45NS 2013-2359',
		]);
	});

	it('anchors both windows of a zone to the start day', () => {
		const a = rtbaZoneActivations(z0303).filter((z) => z.airspaceId === 'LFR45A');
		expect(a.map((z) => iso(z.start))).toEqual([
			'2026-06-09T08:00:00.000Z',
			'2026-06-09T20:13:00.000Z',
		]);
		expect(a.map((z) => iso(z.end))).toEqual([
			'2026-06-09T10:00:00.000Z',
			'2026-06-09T22:59:00.000Z',
		]);
	});

	it('is active during the EVENING window, not only the morning', () => {
		const ids = rtbaActiveAt(z0303, Date.parse('2026-06-09T21:00:00Z')).map(
			(z) => z.airspaceId,
		);
		expect(ids).toContain('LFR45A');
		expect(ids).toContain('LFR45NS');
	});

	it('is inactive in the gap between the morning and evening windows', () => {
		expect(rtbaActiveAt(z0303, Date.parse('2026-06-09T12:00:00Z'))).toHaveLength(0);
	});
});

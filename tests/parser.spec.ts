import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	parseNotams,
	parseQualifierLine,
	parseNotamDates,
	parseSections,
	computePolygonArea,
} from '$lib/notam';
import type { Notam } from '$lib/notam';

function findNotam(notams: Notam[], id: string): Notam | undefined {
	return notams.find((n) => n.id === id);
}

const positionsText = readFileSync(new URL('./fixtures/positions', import.meta.url), 'utf-8');
const areasText = readFileSync(new URL('./fixtures/areas', import.meta.url), 'utf-8');

// Unit tests for qualifier line parser

describe('parseQualifierLine', () => {
	it('should parse all fields with radius', () => {
		const q = parseQualifierLine('LFFF / QWULW / IV / BO / W / 000/014 / 4840N00305E005');
		expect(q).toBeTruthy();
		expect(q!.fir).toBe('LFFF');
		expect(q!.code).toBe('QWULW');
		expect(q!.traffic).toBe('IV');
		expect(q!.purpose).toBe('BO');
		expect(q!.scope).toBe('W');
		expect(q!.lower).toBe(0);
		expect(q!.upper).toBe(14);
		expect(q!.lat).toBeCloseTo(48.6667, 2);
		expect(q!.lon).toBeCloseTo(3.0833, 2);
		expect(q!.radius).toBe(5);
	});

	it('should parse coordinate without radius', () => {
		const q = parseQualifierLine('LFFF / QOBCE / IV / M / E / 000/011 / 4839N00359E');
		expect(q).toBeTruthy();
		expect(q!.fir).toBe('LFFF');
		expect(q!.scope).toBe('E');
		expect(q!.lat).toBeCloseTo(48.65, 2);
		expect(q!.lon).toBeCloseTo(3.9833, 2);
		expect(q!.radius).toBe(null);
	});

	it('should parse western longitude', () => {
		const q = parseQualifierLine('TTZP / QOBCE / IV / M / AE / 000/002 / 1615N06116W001');
		expect(q).toBeTruthy();
		expect(q!.fir).toBe('TTZP');
		expect(q!.scope).toBe('AE');
		expect(q!.lower).toBe(0);
		expect(q!.upper).toBe(2);
		expect(q!.lat).toBeCloseTo(16.25, 2);
		expect(q!.lon).toBeCloseTo(-61.2667, 2);
		expect(q!.radius).toBe(1);
	});

	it('should preserve the raw Q-code', () => {
		const q = parseQualifierLine('LFFF / QWULW / IV / BO / W / 000/014 / 4840N00305E005');
		expect(q).toBeTruthy();
		expect(q!.code).toBe('QWULW');
	});
});

// Unit tests for NOTAM date parser

describe('parseNotamDates', () => {
	it('should parse ICAO B/C dates', () => {
		const content = 'Q) LFFF / QRTCA / IV / BO / W / 000/195 / 4940N00135W007\nA) LFRC\nB) 2026-02-24 00:00 C) 2026-03-11 23:59\nE) TEST';
		const sections = parseSections(content);
		const d = parseNotamDates(sections, content);
		expect(d.start!.getTime()).toBe(Date.UTC(2026, 1, 24, 0, 0));
		expect(d.end!.getTime()).toBe(Date.UTC(2026, 2, 11, 23, 59));
		expect(d.permanent).toBe(false);
		expect(d.estimated).toBe(false);
	});

	it('should parse legacy YYMMDDHHMM B/C dates', () => {
		const content = 'Q) LTAA/QWMLW/IV/BO/W/000/080/3750N03038E002\nA) LTAA B) 2605110500 C) 2605201500\nE) TEST';
		const sections = parseSections(content);
		const d = parseNotamDates(sections, content);
		expect(d.start!.getTime()).toBe(Date.UTC(2026, 4, 11, 5, 0));
		expect(d.end!.getTime()).toBe(Date.UTC(2026, 4, 20, 15, 0));
		expect(d.permanent).toBe(false);
		expect(d.estimated).toBe(false);
	});

	it('should parse SOFIA DU/AU dates', () => {
		const content = 'DU: 20 01 2025 07:32 AU: 30 04 2026 19:02\nA) LFFF\nQ) LFFF / QWULW / IV / BO / W / 000/014 / 4840N00305E005\nE) TEST';
		const sections = parseSections(content);
		const d = parseNotamDates(sections, content);
		expect(d.start!.getTime()).toBe(Date.UTC(2025, 0, 20, 7, 32));
		expect(d.end!.getTime()).toBe(Date.UTC(2026, 3, 30, 19, 2));
		expect(d.permanent).toBe(false);
		expect(d.estimated).toBe(false);
	});

	it('should parse SOFIA AU: PERM', () => {
		const content = 'DU: 23 10 2025 11:46 AU: PERM\nA) LFFF\nQ) LFFF / QOBCE / IV / M / E / 000/011 / 4839N00359E001\nE) TEST';
		const sections = parseSections(content);
		const d = parseNotamDates(sections, content);
		expect(d.start!.getTime()).toBe(Date.UTC(2025, 9, 23, 11, 46));
		expect(d.end).toBe(null);
		expect(d.permanent).toBe(true);
	});

	it('should treat the Y2038 sentinel in C) as PERM', () => {
		// Autorouter (and a few national AIPs) substitute the Y2038
		// INT_MAX date (2038-01-19 03:14 UTC) for the literal PERM
		// keyword. Any C) date >= 2038-01-01 collapses to permanent.
		const content = 'A) LFFF B) 2511190900 C) 3801190314\nE) TEST';
		const sections = parseSections(content);
		const d = parseNotamDates(sections, content);
		expect(d.end).toBe(null);
		expect(d.permanent).toBe(true);
		expect(d.estimated).toBe(false);
	});

	it('should treat the Y2038 sentinel in SOFIA AU as PERM', () => {
		const content = 'DU: 19 11 2025 09:00 AU: 19 01 2038 03:14\nA) LFFF\nQ) LFFF / QOBCE / IV / M / E / 000/011 / 4839N00359E001\nE) TEST';
		const sections = parseSections(content);
		const d = parseNotamDates(sections, content);
		expect(d.end).toBe(null);
		expect(d.permanent).toBe(true);
	});

	it('should parse SOFIA AU with EST suffix', () => {
		const content = 'DU: 29 12 2025 16:06 AU: 30 06 2026 23:59 EST\nA) LPPT\nQ) LPPC / QFAHW / IV / BO / A / 000/999 / 3846N00908W005\nE) TEST';
		const sections = parseSections(content);
		const d = parseNotamDates(sections, content);
		expect(d.start!.getTime()).toBe(Date.UTC(2025, 11, 29, 16, 6));
		expect(d.end!.getTime()).toBe(Date.UTC(2026, 5, 30, 23, 59));
		expect(d.estimated).toBe(true);
	});
});

// Integration tests: positions

describe('parseNotams - positions', () => {
	const notams = parseNotams(positionsText);

	it('should parse all position NOTAMs', () => {
		expect(notams.length).toBe(30);
	});

	it('should not mark any position NOTAM as polygon', () => {
		for (const n of notams) {
			expect(n.isPolygon).toBe(false);
		}
	});

	it('should parse usual PSN coordinate (LFFA-W2942/24)', () => {
		const n = findNotam(notams, 'LFFA-W2942/24');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(1);
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(48.6733, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(3.0781, 2);
	});

	it('should parse decimal seconds PSN coordinates (LFFA-P3613/25)', () => {
		const n = findNotam(notams, 'LFFA-P3613/25');
		expect(n).toBeTruthy();
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(48.6564, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(3.9800, 2);
	});

	it('should parse implicit decimal seconds (LFFA-P4021/25)', () => {
		const n = findNotam(notams, 'LFFA-P4021/25');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(1);
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(49.1424, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(-0.7244, 2);
	});

	it('should parse spaceless PSN coordinate (TTPP-A1652/25)', () => {
		const n = findNotam(notams, 'TTPP-A1652/25');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(1);
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(16.2539, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(-61.2611, 2);
	});

	it('should parse extra leading zero longitude (LEAN-R0341/26)', () => {
		const n = findNotam(notams, 'LEAN-R0341/26');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(1);
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(28.4722, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(-16.2467, 2);
	});

	it('should parse missing leading zero longitude (LOWW-A0089/26)', () => {
		const n = findNotam(notams, 'LOWW-A0089/26');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(1);
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(46.6469, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(14.3392, 2);
	});

	it('should parse circle centres as separate entries (LZIB-A2755/25)', () => {
		const entries = notams.filter((n) => n.id === 'LZIB-A2755/25');
		expect(entries.length).toBe(3);
		for (const n of entries) {
			expect(n.isPolygon).toBe(false);
			expect(n.coordinates.length).toBe(1);
			expect(n.coordinates[0].type).toBe('psn');
		}
		expect(entries[0].coordinates[0].lat).toBeCloseTo(48.4017, 2);
		expect(entries[0].coordinates[0].lon).toBeCloseTo(17.1197, 2);
		expect(entries[1].coordinates[0].lat).toBeCloseTo(48.6372, 2);
		expect(entries[1].coordinates[0].lon).toBeCloseTo(19.1342, 2);
		expect(entries[2].coordinates[0].lat).toBeCloseTo(49.0278, 2);
		expect(entries[2].coordinates[0].lon).toBeCloseTo(21.3031, 2);
	});

	it('should extract radius for circle centres (LZIB-A2755/25)', () => {
		const entries = notams.filter((n) => n.id === 'LZIB-A2755/25');
		expect(entries.length).toBe(3);
		for (const n of entries) {
			expect(n.coordinates[0].radius).toBe(5.6);
			expect(n.coordinates[0].radiusUnit).toBe('KM');
		}
	});

	it('should parse PSN with RADIUS in NM after coordinates (EHAA-A0456/26)', () => {
		const n = findNotam(notams, 'EHAA-A0456/26');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(1);
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(51.7667, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(5.4394, 2);
		expect(n!.coordinates[0].radius).toBe(1);
		expect(n!.coordinates[0].radiusUnit).toBe('NM');
	});

	it('should parse M RADIUS OF PSN before coordinates (LEAN-R0300/26)', () => {
		const n = findNotam(notams, 'LEAN-R0300/26');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(1);
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(40.8864, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(16.035, 2);
		expect(n!.coordinates[0].radius).toBe(500);
		expect(n!.coordinates[0].radiusUnit).toBe('M');
	});

	it('should anchor RDL <bearing>/<distance> ARP <ICAO> to airport coord', () => {
		const sample = 'R0000/26\nQ) LFRR/QOLAS/IV/M/AE/000/004/4715N00135W003\n' +
			'A) LFRS B) 2601010000 C) PERM\nE) BALISAGE D\'EOLIENNES HORS SERVICE\n' +
			'RDL 252/13NM ARP LFRS\nHAUTEUR : 400FT\n\n';
		const lookupAirport = (ident: string) => ident === 'LFRS' ? { lat: 47.1531, lon: -1.6107 } : null;
		const without = parseNotams(sample);
		expect(without[0].coordinates[0].type).toBe('qualifierLine');
		const with_ = parseNotams(sample, { lookupAirport });
		expect(with_[0].coordinates[0].type).toBe('psn');
		// 13 NM at bearing 252° from (47.1531, -1.6107)
		expect(with_[0].coordinates[0].lat).toBeCloseTo(47.086, 2);
		expect(with_[0].coordinates[0].lon).toBeCloseTo(-1.913, 2);
	});

	it('should parse PSN with space between digits and hemisphere (P1484/26)', () => {
		const n = findNotam(notams, 'P1484/26');
		expect(n).toBeTruthy();
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(44.1686, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(4.8642, 2);
	});

	it('should parse PSN with no separator and decimal seconds (P0436/26)', () => {
		const n = findNotam(notams, 'P0436/26');
		expect(n).toBeTruthy();
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(44.5992, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(3.867, 2);
	});

	it('should parse French comma-as-decimal-separator (P1217/26)', () => {
		const n = findNotam(notams, 'P1217/26');
		expect(n).toBeTruthy();
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(48.6546, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(5.4839, 2);
	});

	it('should parse helipad FATO with dash lat/lon and DIAMETRE keyword (H0141/26)', () => {
		const n = findNotam(notams, 'H0141/26');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(1);
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(45.4311, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(6.9933, 2);
		// 15M diameter → 7.5M radius
		expect(n!.coordinates[0].radius).toBe(7.5);
		expect(n!.coordinates[0].radiusUnit).toBe('M');
	});

	it('should parse bare "DANS RAYON X<unit>" before coord (P1757/26)', () => {
		const n = findNotam(notams, 'P1757/26');
		expect(n).toBeTruthy();
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].radius).toBe(50);
		expect(n!.coordinates[0].radiusUnit).toBe('M');
	});

	it('should parse bare "RAYON X<unit>" after coord (W0470/26)', () => {
		const n = findNotam(notams, 'W0470/26');
		expect(n).toBeTruthy();
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].radius).toBe(2000);
		expect(n!.coordinates[0].radiusUnit).toBe('M');
	});

	it('should parse American CENTERED keyword as PSN, not Q-line (D1191/26)', () => {
		const n = findNotam(notams, 'D1191/26');
		expect(n).toBeTruthy();
		expect(n!.isPolygon).toBe(false);
		expect(n!.coordinates.length).toBe(1);
		// Without the CENTER/CENTERED trigger this fell back to the Q-line
		// coord (blue marker); the E) coord makes it a red PSN.
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(48.3547, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(8.0219, 2);
		expect(n!.coordinates[0].radius).toBe(0.5);
		expect(n!.coordinates[0].radiusUnit).toBe('NM');
	});

	it('should parse CENTREE keyword + RAYON D\'EVOLUTION DE elision (W0004/26)', () => {
		const n = findNotam(notams, 'W0004/26');
		expect(n).toBeTruthy();
		expect(n!.isPolygon).toBe(false);
		expect(n!.coordinates.length).toBe(1);
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(45.5139, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(3.2669, 2);
		expect(n!.coordinates[0].radius).toBe(500);
		expect(n!.coordinates[0].radiusUnit).toBe('M');
	});

	it('should parse preamble "DANS UN RAYON DE X AUTOUR DU PSN" (P0389/26)', () => {
		const n = findNotam(notams, 'P0389/26');
		expect(n).toBeTruthy();
		expect(n!.isPolygon).toBe(false);
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(43.6506, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(1.35, 2);
		expect(n!.coordinates[0].radius).toBe(96);
		expect(n!.coordinates[0].radiusUnit).toBe('M');
	});

	it('should parse bullet-list "- RAYON: X" on line below coord (P0994/26)', () => {
		const n = findNotam(notams, 'P0994/26');
		expect(n).toBeTruthy();
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(47.4228, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(-1.184, 2);
		expect(n!.coordinates[0].radius).toBe(5);
		expect(n!.coordinates[0].radiusUnit).toBe('KM');
	});

	it('should parse French DANS UN RAYON DE after PSN (LFFA-W2279/25)', () => {
		const n = findNotam(notams, 'LFFA-W2279/25');
		expect(n).toBeTruthy();
		expect(n!.isPolygon).toBe(false);
		expect(n!.coordinates.length).toBe(1);
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(46.2722, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(6.8367, 2);
		expect(n!.coordinates[0].radius).toBe(5);
		expect(n!.coordinates[0].radiusUnit).toBe('NM');
	});

	it('should parse French CERCLE DE X DE RAYON CENTRE SUR PSN (LFFA-R1463/26)', () => {
		const n = findNotam(notams, 'LFFA-R1463/26');
		expect(n).toBeTruthy();
		expect(n!.isPolygon).toBe(false);
		expect(n!.coordinates.length).toBe(1);
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(48.4686, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(2.6342, 2);
		expect(n!.coordinates[0].radius).toBe(1);
		expect(n!.coordinates[0].radiusUnit).toBe('NM');
	});

	it('should parse high-precision decimal seconds (LFFA-P4304/25)', () => {
		const n = findNotam(notams, 'LFFA-P4304/25');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(1);
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(45.9319, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(6.0776, 2);
	});

	it('should parse 6-digit longitude with decimal seconds (LFFA-P0257/26)', () => {
		const n = findNotam(notams, 'LFFA-P0257/26');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(1);
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(48.1076, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(7.3538, 2);
	});

	it('should parse 6-digit longitude with PSN COORD (WGS-84) (LIIC-M6131/25)', () => {
		const n = findNotam(notams, 'LIIC-M6131/25');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(1);
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(44.6647, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(9.1283, 2);
	});

	it('should parse standard PSN after descriptive text (LFFA-C4783/25)', () => {
		const n = findNotam(notams, 'LFFA-C4783/25');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(1);
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(45.9531, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(6.1261, 2);
	});

	it('should parse WITH <num><unit> RADIUS after COORD (LRBB-C1981/26)', () => {
		const n = findNotam(notams, 'LRBB-C1981/26');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(1);
		expect(n!.coordinates[0].type).toBe('psn');
		expect(n!.coordinates[0].lat).toBeCloseTo(46.5025, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(23.8861, 2);
		expect(n!.coordinates[0].radius).toBe(6);
		expect(n!.coordinates[0].radiusUnit).toBe('NM');
	});

	it('should parse multiple NOTAMs at same position (LEAN-R0225/26, LEAN-R0226/26)', () => {
		const n1 = findNotam(notams, 'LEAN-R0225/26');
		const n2 = findNotam(notams, 'LEAN-R0226/26');
		expect(n1).toBeTruthy();
		expect(n2).toBeTruthy();
		expect(n1!.coordinates[0].type).toBe('qualifierLine');
		expect(n2!.coordinates[0].type).toBe('qualifierLine');
		expect(n1!.coordinates[0].lat).toBeCloseTo(41.6667, 2);
		expect(n1!.coordinates[0].lon).toBeCloseTo(-4.8167, 2);
		expect(n1!.coordinates[0].lat).toBeCloseTo(n2!.coordinates[0].lat, 2);
		expect(n1!.coordinates[0].lon).toBeCloseTo(n2!.coordinates[0].lon, 2);
	});
});

// Integration tests: areas

describe('parseNotams - areas', () => {
	const notams = parseNotams(areasText);

	it('should parse all area NOTAMs', () => {
		expect(notams.length).toBe(34);
	});

	it('should mark area NOTAMs as polygons', () => {
		const polygons = notams.filter((n) => n.isPolygon);
		expect(polygons.length).toBe(25);
	});

	it('should parse LIMITES LATERALES keyword (LFFA-R2339/25)', () => {
		const n = findNotam(notams, 'LFFA-R2339/25');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(4);
		expect(n!.coordinates[0].lat).toBeCloseTo(50.0, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(-1.1183, 2);
	});

	it('should parse LATERAL LIMITS keyword (LFFA-R0311/26)', () => {
		const n = findNotam(notams, 'LFFA-R0311/26');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(4);
		expect(n!.coordinates[0].lat).toBeCloseTo(49.6333, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(-1.4667, 2);
	});

	it('should parse AREA keyword with dash-separated coords (LPPP-A6116/25)', () => {
		const n = findNotam(notams, 'LPPP-A6116/25');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(6);
		expect(n!.coordinates[0].lat).toBeCloseTo(40.5311, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(-7.4997, 2);
	});

	it('should parse WI COORD keyword (LEAN-D0164/26)', () => {
		const n = findNotam(notams, 'LEAN-D0164/26');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(15);
		expect(n!.coordinates[0].lat).toBeCloseTo(40.7783, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(-1.9417, 2);
	});

	it('should detect closed polygon (LGGG-A0134/26)', () => {
		const n = findNotam(notams, 'LGGG-A0134/26');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(4);
		expect(n!.coordinates[0].lat).toBeCloseTo(38.8333, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(19.25, 2);
	});

	it('should detect closing coordinate in parentheses (ENGM-A0737/26)', () => {
		const n = findNotam(notams, 'ENGM-A0737/26');
		expect(n).toBeTruthy();
		expect(n!.coordinates.length).toBe(7);
		expect(n!.coordinates[0].lat).toBeCloseTo(73.0, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(24.0, 2);
	});

	it('should parse overlapping areas (LEAN-R0263/26 smaller, LEAN-R0079/26 larger)', () => {
		const small = findNotam(notams, 'LEAN-R0263/26');
		const large = findNotam(notams, 'LEAN-R0079/26');
		expect(small).toBeTruthy();
		expect(large).toBeTruthy();
		expect(small!.coordinates.length).toBe(4);
		expect(large!.coordinates.length).toBe(4);
		expect(
			computePolygonArea(small!.coordinates) < computePolygonArea(large!.coordinates),
		).toBeTruthy();
	});

	it('should extract only the polygon, not the straight line (LOWW-A3153/25)', () => {
		const entries = notams.filter((n) => n.id === 'LOWW-A3153/25');
		expect(entries.length).toBe(1);
		expect(entries[0].isPolygon).toBe(true);
		expect(entries[0].coordinates.length).toBe(10);
		expect(entries[0].coordinates[0].lat).toBeCloseTo(47.8625, 2);
		expect(entries[0].coordinates[0].lon).toBeCloseTo(14.3078, 2);
	});

	it('should split multiple areas into separate entries (ENGM-A0526/26)', () => {
		const entries = notams.filter((n) => n.id === 'ENGM-A0526/26');
		expect(entries.length).toBe(2);
		expect(entries[0].isPolygon).toBe(true);
		expect(entries[1].isPolygon).toBe(true);

		// First area: Arctic danger zone (4 coordinates)
		expect(entries[0].coordinates.length).toBe(4);
		expect(entries[0].coordinates[0].lat).toBeCloseTo(76.3667, 2);
		expect(entries[0].coordinates[0].lon).toBeCloseTo(21.9167, 2);

		// Second area: Barents Sea impact area (6 coordinates)
		expect(entries[1].coordinates.length).toBe(6);
		expect(entries[1].coordinates[0].lat).toBeCloseTo(70.9333, 2);
		expect(entries[1].coordinates[0].lon).toBeCloseTo(32.0833, 2);
	});

	it('should separate PSN before area keyword from polygon (VABB-A0190/26)', () => {
		const entries = notams.filter((n) => n.id === 'VABB-A0190/26');
		// Only the polygon; parenthesized coordinate without PSN is ignored
		expect(entries.length).toBe(1);
		expect(entries[0].isPolygon).toBe(true);
		expect(entries[0].coordinates.length).toBe(10);
		expect(entries[0].coordinates[0].lat).toBeCloseTo(23.7519, 2);
		expect(entries[0].coordinates[0].lon).toBeCloseTo(79.7553, 2);
	});

	it('should normalize antimeridian-crossing polygon (KZAK-A0546/26)', () => {
		const n = findNotam(notams, 'KZAK-A0546/26');
		expect(n).toBeTruthy();
		expect(n!.isPolygon).toBe(true);
		expect(n!.coordinates.length).toBe(10);
		// First coordinate: ~36.73°N, ~163.07°W
		expect(n!.coordinates[0].lat).toBeCloseTo(36.7333, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(-163.0667, 2);
		// All consecutive longitude differences should be <= 180°
		for (let i = 1; i < n!.coordinates.length; i++) {
			const diff = Math.abs(n!.coordinates[i].lon - n!.coordinates[i - 1].lon);
			expect(diff <= 180).toBeTruthy();
		}
	});

	it('should split polygon and circle centres into separate entries (UUUU-Q1191/26)', () => {
		const entries = notams.filter((n) => n.id === 'UUUU-Q1191/26');
		expect(entries.length).toBe(9);

		// First entry: the polygon area
		expect(entries[0].isPolygon).toBe(true);
		expect(entries[0].coordinates.length).toBe(14);
		expect(entries[0].coordinates[0].lat).toBeCloseTo(64.55, 2);
		expect(entries[0].coordinates[0].lon).toBeCloseTo(55.0831, 2);

		// Remaining 8 entries: individual circle centres with radius
		for (let i = 1; i < 9; i++) {
			expect(entries[i].isPolygon).toBe(false);
			expect(entries[i].coordinates.length).toBe(1);
			expect(entries[i].coordinates[0].radius).toBe(1);
			expect(entries[i].coordinates[0].radiusUnit).toBe('KM');
		}
	});

	it('should rejoin wrapped polygon coords and split into per-PART polygons (F0212/26)', () => {
		const entries = notams.filter((n) => n.id === 'F0212/26');
		expect(entries.length).toBe(5);
		for (const e of entries) expect(e.isPolygon).toBe(true);
		// First polygon (BORDEAUX R1 PART 2): 16 source coords with first == last
		// → 15 unique vertices. First vertex is 470240N 0001500W.
		expect(entries[0].coordinates.length).toBe(15);
		expect(entries[0].coordinates[0].lat).toBeCloseTo(47.0444, 2);
		expect(entries[0].coordinates[0].lon).toBeCloseTo(-0.25, 2);
		// Last polygon (BREST NS PART 1): 16 vertices with first == last → 15.
		expect(entries[4].coordinates.length).toBe(15);
		expect(entries[4].coordinates[0].lat).toBeCloseTo(48.4622, 2);
	});

	it('should parse dash-connected polygon without an area keyword (R3154/25)', () => {
		const n = findNotam(notams, 'R3154/25');
		expect(n).toBeTruthy();
		expect(n!.isPolygon).toBe(true);
		// 34 source coords with first == last; closure pushes the 33 unique.
		expect(n!.coordinates.length).toBe(33);
		expect(n!.coordinates[0].lat).toBeCloseTo(45.9058, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(-1.6636, 2);
	});

	it('should expand ARC HORAIRE arc center into curved sample points (R1129/26)', () => {
		const n = findNotam(notams, 'R1129/26');
		expect(n).toBeTruthy();
		expect(n!.isPolygon).toBe(true);
		// Source: v1, arc-center, v3, v4-closing (== v1). Closure drops v4 and
		// the arc center is expanded into k-1 = 15 sample points.
		expect(n!.coordinates.length).toBe(2 + 15);
		// First and last source vertices are preserved
		expect(n!.coordinates[0].lat).toBeCloseTo(49.1311, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(4.3742, 2);
		expect(n!.coordinates[n!.coordinates.length - 1].lat).toBeCloseTo(49.1361, 2);
		// Sample points sweep clockwise from v1 to v3; going south first
		// (atan2 CCW-positive, HORAIRE = decreasing angle), so the first
		// intermediate sample has lower lat than v1.
		expect(n!.coordinates[1].lat < n!.coordinates[0].lat).toBeTruthy();
	});

	it('should make simple polygon from self-intersecting coords (EBBR-F0162/26)', () => {
		const n = findNotam(notams, 'EBBR-F0162/26');
		expect(n).toBeTruthy();
		expect(n!.isPolygon).toBe(true);
		expect(n!.coordinates.length).toBe(4);
		expect(n!.coordinates[0].lat).toBeCloseTo(49.9914, 2);
		expect(n!.coordinates[0].lon).toBeCloseTo(5.4914, 2);
	});

	it('should ignore parenthesized coordinate without PSN keyword (VABB-A0190/26 variant)', () => {
		const entries = notams.filter((n) => n.id === 'VABB-A0191/26');
		expect(entries.length).toBe(2);

		// First entry: standalone PSN (Chhindwara airport)
		expect(entries[0].isPolygon).toBe(false);
		expect(entries[0].coordinates.length).toBe(1);
		expect(entries[0].coordinates[0].lat).toBeCloseTo(22.0024, 2);
		expect(entries[0].coordinates[0].lon).toBeCloseTo(78.9174, 2);

		// Second entry: polygon area (10 unique vertices)
		expect(entries[1].isPolygon).toBe(true);
		expect(entries[1].coordinates.length).toBe(10);
		expect(entries[1].coordinates[0].lat).toBeCloseTo(23.7519, 2);
		expect(entries[1].coordinates[0].lon).toBeCloseTo(79.7553, 2);
	});

	it('should render an English AXIS/LENGTH aerobatics NOTAM as a corridor (W1031/26)', () => {
		const n = findNotam(notams, 'W1031/26');
		expect(n).toBeTruthy();
		expect(n!.isPolygon).toBe(true);
		expect(n!.obstacleType).toBe('voltige');
		// AXIS 057/237, LENGTH 1000M, no published width: a 4-corner corridor
		// rectangle centred on 484232N 0034546E (the LFFZ Sezanne box).
		expect(n!.coordinates.length).toBe(4);
		expect(n!.coordinates.every((c) => c.original === 'corridor')).toBe(true);
		const cLat = n!.coordinates.reduce((s, c) => s + c.lat, 0) / 4;
		const cLon = n!.coordinates.reduce((s, c) => s + c.lon, 0) / 4;
		expect(cLat).toBeCloseTo(48.7089, 3);
		expect(cLon).toBeCloseTo(3.7628, 3);
	});

	it('should render the French wording (AXE/LONGUEUR) identically (LFFA-W1031/26)', () => {
		const en = findNotam(notams, 'W1031/26');
		const fr = findNotam(notams, 'LFFA-W1031/26');
		expect(fr).toBeTruthy();
		expect(fr!.isPolygon).toBe(true);
		expect(fr!.obstacleType).toBe('voltige');
		expect(fr!.coordinates.length).toBe(4);
		// Same axis, length and centre as the English NOTAM -> same corners.
		for (let i = 0; i < 4; i++) {
			expect(fr!.coordinates[i].lat).toBeCloseTo(en!.coordinates[i].lat, 6);
			expect(fr!.coordinates[i].lon).toBeCloseTo(en!.coordinates[i].lon, 6);
		}
	});
});

// The WMKK A5568/25 shape (World-20260207.txt): a whitespace-only line
// after the E) lead-in, a decimal-second dash-connected polygon, the
// plural 'WI COORDS' cue, and F)/G) items after another whitespace-only
// line. Every clause of it regressed at least once.
const WMKK_SHAPED = `WMKK-A5568/25 NOTAM
Q) WMFC / QWULW / IV / BO / W / 000/004 / 0249N10148E001
A) WMFC
B) 2025-12-22 00:30 C) 2026-03-21 09:30
E) UAV ACT WILL TAKE PLACE WI COORDS:
${'  '}
   025001.90N 1014850.72E - 025016.18N 1014846.90E -
   025021.27N 1014859.22E - 025012.75N 1014908.81E
${'   '}
   (NILAI IMPIAN, NEGERI SEMBILAN)
    RMK: ACT SUBJ TO ATC
F) SFC
G) 400FT AGL
`;

describe('parseNotams - body integrity', () => {
	it('keeps a body split by whitespace-only lines whole (polygon + F/G)', () => {
		const notams = parseNotams(WMKK_SHAPED);
		expect(notams.length).toBe(1);
		const n = notams[0];
		expect(n.isPolygon).toBe(true);
		expect(n.coordinates.length).toBe(4);
		expect(n.coordinates[0].lat).toBeCloseTo(2.8339, 3);
		expect(n.coordinates[0].lon).toBeCloseTo(101.814, 3);
		// The F)/G) items after the second whitespace-only line survive.
		expect(n.fgLower?.sfc).toBe(true);
		expect(n.fgUpper?.ft).toBe(400);
		expect(n.fgUpper?.ref).toBe('AGL');
	});

	it('still truncates trailing junk after an empty line', () => {
		const text = `A1000/26 NOTAMN
Q) LFFF/QWULW/IV/BO/W/000/020/4900N00200E005
A) LFFF B) 2601010000 C) 2601312359
E) SOME ACTIVITY

PAGE FOOTER TEXT THAT IS NOT PART OF THE NOTAM
`;
		const notams = parseNotams(text);
		expect(notams.length).toBe(1);
		expect(notams[0].fullContent).not.toContain('PAGE FOOTER');
	});

	it('does not fragment a body on checklist-row ids, and keeps the genuine NOTAM of a listed id', () => {
		const text = `C0100/26 NOTAMN
Q) LFFF/QKKKK/K/K/K/000/999/4900N00200E999
A) LFFF B) 2601010000 C) 2602010000
E) CHECKLIST
B0104/26
C0055/26

B0104/26 NOTAMN
Q) LFFF/QWULW/IV/BO/W/000/020/4835N00230E002
A) LFFF B) 2601010000 C) 2601312359
E) UAV ACT 2NM RADIUS PSN 483500N 0023000E
`;
		const notams = parseNotams(text);
		const ids = notams.map((n) => n.id);
		// The checklist rows glue back into C0100/26's body instead of
		// becoming bogus entries that poison seenIds.
		expect(ids.filter((id) => id === 'B0104/26').length).toBe(1);
		const real = notams.find((n) => n.id === 'B0104/26');
		expect(real?.qCode).toBe('QWULW');
		expect(real?.coordinates.some((c) => c.type === 'psn')).toBe(true);
		const checklist = notams.find((n) => n.id === 'C0100/26');
		expect(checklist?.fullContent).toContain('C0055/26');
	});
});

// Integration tests: statistics

// The widened obstacle gate (OBST/OBSTACLE(S) + QOB/QOL Q-codes, see
// parseNotams) decodes E)-text positions for 66 more NOTAMs across the
// corpus; the French halves of bilingual obstacle NOTAMs are the main
// beneficiaries (P2092/26: ten turbine positions in both languages).
// The whitespace-only-line fix (a blank line inside a body no longer
// truncates it while later A)-G) sections follow), the plural 'WI COORDS'
// cue, the DDMM-precision branch and the decimal dash-connected pattern
// again grow areas/positions and shrink noPosition (WMKK A5568/25,
// FIMP-A0027/26, the LEAN-D* multi-TSA bodies); the false-header guard
// drops the bogus checklist-row entries (S01/26 in Europe-20260203).
const statisticsTests = [
	// positions/areas moved by one when LFFA-F1557/25's ARC HORAIRE started
	// promoting its group to a polygon (tagged arc centres are area language).
	{ file: 'Europe-20260203.txt', all: 11041, noPosition: 6819, positions: 3042, areas: 1180 },
	{ file: 'LPPT-EPWA-20260207.txt', all: 1035, noPosition: 348, positions: 510, areas: 177 },
	{ file: 'EGPD-LFKC-20260207.txt', all: 676, noPosition: 217, positions: 415, areas: 44 },
	{ file: 'KJFK-KLAX-20260209.txt', all: 449, noPosition: 354, positions: 94, areas: 1 },
	{ file: 'CYQB-CYVR-20260209.txt', all: 366, noPosition: 118, positions: 246, areas: 2 },
	{ file: 'CYTZ-SAWG-20260209.txt', all: 554, noPosition: 350, positions: 183, areas: 21 },
	{ file: 'EGLL-FACT-20260209.txt', all: 791, noPosition: 372, positions: 334, areas: 85 },
	{ file: 'ENGM-YSCB-20260209.txt', all: 521, noPosition: 249, positions: 172, areas: 100 },
	{ file: 'LEMD-UHWW-20260209.txt', all: 1515, noPosition: 542, positions: 707, areas: 266 },
	{ file: 'LSHJ-ZBAA-20260209.txt', all: 1339, noPosition: 445, positions: 780, areas: 114 },
	{ file: 'SBBE-VIDP-20260209.txt', all: 315, noPosition: 254, positions: 36, areas: 25 },
	{ file: 'World-20260207.txt', all: 36874, noPosition: 24768, positions: 8064, areas: 4042 },
	// W0196/26 (AXE : RWY 16R/34L) and W0385/26 (AXE : ORIENTE) gained
	// their voltige corridors when parseAerobaticAxis learned those forms.
	{ file: 'World-20260512.txt', all: 23283, noPosition: 13991, positions: 6671, areas: 2621 },
];

// NOTAMs to be investigated: coordinates far from Q-line due to
// NOTAM data errors, Q-line imprecision, or ambiguous coordinate formats.
const coordinateExclusions = new Set([
	// 6-digit longitude ambiguity (DDMMSS vs truncated DDDMMSS)
	'LGGG-A0292/26',  // 025500E: parsed as 2.9°E, should be 25.8°E
	'LFFA-P4354/25',  // 021600E: parsed as 2.3°E, should be 21.6°E (Réunion)
	'LEAN-A7783/25',  // 035600W: parsed as 3.9°W, should be 35.9°W (Canary Islands)
	// NOTAM coordinate errors (typos in the NOTAM itself)
	'EHAM-A0321/26',  // invalid seconds (070.0), parsed coordinates far off
	'KSLC-A0386/26',  // latitude ~1° off from expected position
	'EPWW-D8111/25',  // extra digit in latitude: 5114050.57N, should be 514050.57N
	'LFFA-P0049/26',  // extra '0' in longitude: 00663101.4E, should be 0063101.4E
	// Q-line data errors (wrong Q-line centre or radius)
	'UUUU-U1184/23',  // Q-line radius too small for route extent
	'OIII-A0289/26',  // Q-line centre wrong, coordinates 241NM away
	'EPWW-D7994/25',  // Q-line centre wrong, coordinates 231NM away
	'EPWW-N7994/25',  // Q-line centre wrong, coordinates 231NM away
	'EHAM-A0324/26',  // Q-line centre wrong, coordinates 56NM away
	'KZLA-A4180/25',  // Q-line centre wrong, coordinates 162NM away
	'LIIC-M0021/25',  // Q-line centre wrong, coordinates 90NM away
	'LIIC-M2022/25',  // Q-line centre wrong, coordinates 134NM away
	'LIIC-M4598/24',  // Q-line centre wrong, coordinates 122NM away
	'LIIC-M4599/24',  // Q-line centre wrong, coordinates 122NM away
	'LIIA-W5239/25',  // Q-line centre wrong, coordinates 119NM away
	'LIIA-W0074/26',  // Q-line centre wrong, coordinates 60NM away
	'VECC-A2279/25',  // Q-line centre ~1° lon off, coordinates 50NM away
	'EDDZ-D0239/26',  // Q-line centre wrong, coordinates 23NM away
	'EDDZ-D0240/26',  // Q-line centre wrong, coordinates 43NM away
	// Arc centre parsed as PSN (parser issue)
	'RJAA-P0490/26',  // arc centre 108NM from Q-centre, Q-radius 61NM
	'RJAA-P0491/26',  // arc centre 75NM from Q-centre, Q-radius 40NM
	'RJAA-P0495/26',  // arc centre 102NM from Q-centre, Q-radius 66NM
	// Base of operations far from survey area
	'VIDP-A0122/26',  // base at Shahpura 35NM from Q-centre, Q-radius 13NM
	// Newly decoded whole (the whitespace-only-line fix keeps the full
	// multi-TSA body): the published areas legitimately extend past the
	// Q-line radius (same class as UUUU-U1184/23)
	'LEAN-D5028/25',  // TSA CACERES arc centre 121NM out, Q-radius 85NM
	'LEAN-D5326/25',  // same multi-TSA body
	'LEAN-D0400/26',  // same multi-TSA body
	'LEAN-D0493/26',  // same multi-TSA body
	// Malformed source coords (DMS minutes/seconds > 60)
	'WMKK-A0016/26',  // E section lists "027437N, 1016897E" (74' minutes invalid)
	'LTAA-D2396/25',  // E section lists "399424.55N 0327544.87E" (94' minutes invalid)
	'M0777/26',       // E section lists "387715N" (77' minutes invalid; Azores antenna)
	// Newly decoded by the widened obstacle gate (OBST/OBSTACLE + QOB/QOL)
	'KZMA-A0098/21',  // Q-line centre wrong, tower 64NM away
	'A0098/21',       // same NOTAM, bare-id form in World-20260512.txt
	'A0409/26',       // ATS-route obstacle NOTAM: windmills 115NM from the ARTCC Q-centre
	// World-20260512.txt uses bare NOTAM IDs (no FIR prefix)
	'A0434/26',       // Q-line centre wrong, coordinates 207NM away
	'A0629/26',       // Q-line centre wrong, coordinates 51NM away
	'A1446/26',       // Q-line centre wrong, coordinates 159NM away
	'D0544/26',       // 94' minutes invalid (same pattern as LTAA-D2396/25)
	'D0780/26',       // extra digit in latitude: 0670033.69N
	'E0806/26',       // Q-line centre wrong, coordinates 78NM away
	'E0893/26',       // Q-line centre wrong, coordinates 46NM away
	'G0424/26',       // invalid coordinate: 000000.0N (lat=0)
	'H3041/26',       // Q-line centre wrong, coordinates 110NM away
	'M0021/25',       // Q-line centre wrong (also as LIIC-/LIIA- variants)
	'M2022/25',       // Q-line centre wrong (also as LIIC- variant)
	'M4598/24',       // Q-line centre wrong (also as LIIC- variant)
	'M4599/24',       // Q-line centre wrong (also as LIIC- variant)
	'M5534/26',       // 94' minutes invalid (same pattern as LTAA-D2396/25)
	'P1629/26',       // Q-line centre wrong, coordinates 64NM away
	'U1184/23',       // Q-line radius too small for route extent (also as UUUU- variant)
]);

function assertCoordinatesNearQualifierLine(notams: Notam[], maxDist: number): void {
	const decoded = notams.filter((n) => !n.isPolygon && n.coordinates.some((c) => c.type === 'psn'));
	for (const n of decoded) {
		if (coordinateExclusions.has(n.id)) continue;
		const sections = parseSections(n.fullContent);
		if (!sections.Q) continue;
		const q = parseQualifierLine(sections.Q);
		// Skip NOTAMs with max Q-line radius (too coarse) or missing radius
		if (!q || q.radius === 999) continue;
		for (const c of n.coordinates) {
			// Skip when Q-line and coordinate are in opposite hemispheres
			// (indicates a Q-line data error, not a parsing bug)
			if ((q.lat < 0) !== (c.lat < 0)) continue;
			const dlat = (c.lat - q.lat) * 60;
			const dlon = (c.lon - q.lon) * 60 * Math.cos(q.lat * Math.PI / 180);
			const dist = Math.sqrt(dlat * dlat + dlon * dlon);
			// A missing Q-radius (null) coerces to 0, matching the original
			// node:assert harness's `q.radius + maxDist` arithmetic.
			const limit = (q.radius ?? 0) + maxDist;
			expect(
				dist,
				`${n.id}: psn ${c.lat.toFixed(4)},${c.lon.toFixed(4)} is ${dist.toFixed(1)}NM from the Q-line centre ${q.lat.toFixed(4)},${q.lon.toFixed(4)} (radius ${q.radius ?? 0} + ${maxDist}NM)`,
			).toBeLessThanOrEqual(limit);
		}
	}
}

for (const t of statisticsTests) {
	describe(`parseNotams - ${t.file} statistics`, () => {
		const text = readFileSync(new URL(`./fixtures/${t.file}`, import.meta.url), 'utf-8');
		const notams = parseNotams(text);
		const areas = notams.filter((n) => n.isPolygon).length;
		const positions = notams.filter((n) => !n.isPolygon && n.coordinates.some((c) => c.type === 'psn')).length;
		const noPosition = notams.filter((n) => !n.isPolygon && n.coordinates.every((c) => c.type === 'qualifierLine')).length;

		it('should count all NOTAMs', () => {
			expect(notams.length).toBe(t.all);
		});

		it('should count NOTAMs with no position', () => {
			expect(noPosition).toBe(t.noPosition);
		});

		it('should count position NOTAMs', () => {
			expect(positions).toBe(t.positions);
		});

		it('should count area NOTAMs', () => {
			expect(areas).toBe(t.areas);
		});

		it('should place all decoded coordinates within 20NM of qualifier line', () => {
			assertCoordinatesNearQualifierLine(notams, 20);
		});
	});
}

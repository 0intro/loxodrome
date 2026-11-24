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

describe('parseSections', () => {
	it('OTNO-A0158/26: an "(AREA F)" inside E) shadows neither F) nor G)', () => {
		const s = parseSections(`Q) OTDF / QWULW / IV / NBO / AW / 000/196 / 2524N05129E001
A) OTHH
B) 2026-01-25 04:00 C) 2026-02-19 11:00
D) 0400-1100
E) REMOTELY PILOTED ACFT SYSTEM (RPAS) ACT WILL TAKE PLACE WI:
252522.34N 0513037.99E - 252450.94N 0513046.26E -
252443.93N 0513007.82E - 252515.29N 0513001.19E -
252522.34N 0513037.99E (AREA F).
FROM SFC TO 984FT AGL.
F) SFC
G) 984FT AGL`);
		expect(s.D).toBe('0400-1100');
		expect(s.E).toMatch(/\(AREA F\)\.\nFROM SFC TO 984FT AGL\.$/);
		expect(s.F).toBe('SFC');
		expect(s.G).toBe('984FT AGL');
	});

	it('LOWW-A3098/25: an enumeration inside E) is no item', () => {
		const s = parseSections(`Q) LOVV / QRTCA / IV / BO / AW / 000/045 / 4817N01417E004
A) LOWL
B) 2026-04-12 05:30 C) 2026-04-12 13:00
E) TEMPORARY RESTRICTED AREA LO R 42 LINZ 2024 ACTIVATED.
EXEMPTIONS FROM THIS RESTRICTION:
A) FLIGHTS ACCORDING PARAGRAPH 145 AVIATION ACT,
C) SEARCH, AMBULANCE AND RESCUE FLIGHTS,
D) FLIGHTS WITH UNMANNED AERIAL VEHICLES ENGAGED FOR POLICE OR
   JUDICIAL PURPOSES,
E) FLIGHTS WITH UNMANNED AERIAL VEHICLES WITH APPROVAL FROM THE
   OPERATOR.
ALL EXEMPTED FLIGHTS ACCORDING 'A' TO 'E' SHALL CONTACT ATC 'LINZ
TOWER' 129.625MHZ PRIOR FLIGHT.
F) GND
G) 4500FT AMSL`);
		expect(s.D).toBeUndefined();
		expect(s.A).toBe('LOWL');
		expect(s.E).toMatch(/129\.625MHZ PRIOR FLIGHT\.$/);
		expect(s.F).toBe('GND');
		// EGGN-A0430/26: a "(CAT D)" in E) is no schedule either.
		const c = parseSections(`Q) EGTT / QPOCH / I  / NBO / A / 000/999 / 5133N00041E005
A) EGMC
B) 2026-02-02 15:07 C) 2038-01-19 03:14
E) AMEND CIRCLING OBSTACLE CLEARANCE HGT (OCH AAL)
AD 2.EGMC-8-2 ILS/DME/NDB(L) RWY 05  (CAT D)
UK AIP EGMC AD 2.24 REFERS.`);
		expect(c.D).toBeUndefined();
		expect(c.E).toMatch(/UK AIP EGMC AD 2\.24 REFERS\.$/);
	});

	it('LEAN-B0768/26 in the SOFIA layout: the FIRs listed in E) stay in E)', () => {
		const s = parseSections(`DU: 30 01 2026 13:29 AU: 16 02 2026 23:59
A) LECM LECB
Q) LEXX / QAFXX / IV / NBO / E / 000/999 / 4220N00345W433
E) UNTIL 16 FEB 2026 2359 UTC, SPANISH CIVIL AIR OPERATORS ARE
RECOMMENDED TO EXERCISE CAUTION AND IMPLEMENT CONTINGENCY
PLANNING WHEN OPERATING AND ROUTING WITHIN:
A) SAN JUAN FIR (TJZS),
B) CURACAO FIR (TNCF),
C) PIARCO FIR (TTZP) WEST OF 0570000W,
DUE TO POTENTIAL SPILLOVER RISKS.`);
		expect(s.B).toBeUndefined();
		expect(s.C).toBeUndefined();
		expect(s.E).toMatch(/CURACAO FIR \(TNCF\),\nC\) PIARCO FIR/);
	});
});

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

	it('should parse a C) date with EST written against it', () => {
		// The ICAO layout of world-fr A0001/26 KZLC: the date-time group
		// "followed by the abbreviation EST" (Item C), with no space.
		const content =
			'Q) KZLC/QCBLS/IV/BO/E/120/150/4023N11809W120\nA) KZLC B) 2601040115 C) 2609142200EST\nE) TEST';
		const d = parseNotamDates(parseSections(content), content);
		expect(d.end!.getTime()).toBe(Date.UTC(2026, 8, 14, 22, 0));
		expect(d.estimated).toBe(true);
		expect(d.permanent).toBe(false);
		// With a space, as autorouter writes it, the same.
		const spaced = parseNotamDates({ B: '2611170600', C: '2611181800 EST' }, '');
		expect(spaced.end!.getTime()).toBe(Date.UTC(2026, 10, 18, 18, 0));
		expect(spaced.estimated).toBe(true);
	});

	it('should read a B) of the last century in the last century', () => {
		// VTSN C0493/98 in the world fixtures, a permanent obstacle since 1998.
		const content =
			'Q) VTBB/QOBCE/IV/M/A/000/999/0828N09958E005\nA) VTSN B) 9802120440 C) PERM\nE) OBST WATER SUPPLY BUILDING HGT 4M';
		const d = parseNotamDates(parseSections(content), content);
		expect(d.start!.getTime()).toBe(Date.UTC(1998, 1, 12, 4, 40));
		expect(d.permanent).toBe(true);
		// The 2038 sentinel stays in this century, and permanent.
		const s = parseNotamDates({ B: '2511190900', C: '3801190314' }, '');
		expect(s.permanent).toBe(true);
		expect(parseNotamDates({ B: '6912312359' }, '').start!.getUTCFullYear()).toBe(2069);
		expect(parseNotamDates({ B: '7001010000' }, '').start!.getUTCFullYear()).toBe(1970);
	});

	it('should keep the end of an activation whose C) carries EST', () => {
		const [n] = parseNotams(`A1234/26 NOTAMN
Q) LFFF/QRTCA/IV/BO/W/000/065/4706N00009E005
A) LFFF B) 2611170600 C) 2611181800EST
E) TEMPORARY RESTRICTED AREA ACTIVATED.`);
		expect(n.endDate!.getTime()).toBe(Date.UTC(2026, 10, 18, 18, 0));
		expect(n.estimated).toBe(true);
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

	it('should read a position from a radius stated beside it', () => {
		// EGGN-A0339/26 (the UK) writes the radius FIRST and marks nothing
		// else; the Q-line would have drawn a 1 NM disc round a rounded
		// centre instead of the crane's own 0.1 NM circle.
		const n = parseNotams(`A0339/26 NOTAMN
Q) EGTT/QOBCE/IV/M/A/000/999/5134N00017W001
A) EGGN B) 2602090700 C) 2602111700
E) CRANES OPR WI 0.1NM RADIUS 513338N 0001633W (WEMBLEY) UP TO 368FT AGL/471FT AMSL.`)[0];
		expect(n.coordinates.length).toBe(1);
		expect(n.coordinates[0].type).toBe('psn');
		expect(n.coordinates[0].lat).toBeCloseTo(51.5606, 3);
		expect(n.coordinates[0].lon).toBeCloseTo(-0.2758, 3);
		expect(n.coordinates[0].radius).toBe(0.1);
		expect(n.coordinates[0].radiusUnit).toBe('NM');
	});

	it('should read a radius stated a few words after the coordinate', () => {
		// F2141/26 (Belgium): one line, no marker, the radius three words on.
		const n = parseNotams(`F2141/26 NOTAMN
Q) EBBU/QWULW/IV/M/W/000/002/5003N00413E001
A) EBBU B) 2609010700 C) 2609011800
E) MACON 500336N 0041313E MODEL ACFT EVENT RADIUS 400M`)[0];
		expect(n.coordinates[0].type).toBe('psn');
		expect(n.coordinates[0].radius).toBe(400);
		expect(n.coordinates[0].radiusUnit).toBe('M');
	});

	it('should parse a slash between the latitude and the longitude', () => {
		// P1801/26 LFLQ (2026-09-18): the SIA separates an obstacle's pair
		// with a slash, and the whole E) reading used to be lost, falling back
		// to the Q-line centre 600 m from the crane the NOTAM is about. The
		// same form carries every Argentinian and Chilean position
		// ("342642S/0674809W").
		const n = parseNotams(`P1801/26 NOTAMN
Q) LFMM/QOBCE/IV/M/AE/000/002/4430N00442E001
A) LFLQ B) 2609010000 C) PERM
E) FIX CRANE OVER CHATEAUNEUF DU RHONE LOCK
PSN : 442958.700N / 0044224.902E
HGT : 171FT`)[0];
		expect(n.coordinates.length).toBe(1);
		expect(n.coordinates[0].type).toBe('psn');
		expect(n.coordinates[0].lat).toBeCloseTo(44.4996, 4);
		expect(n.coordinates[0].lon).toBeCloseTo(4.7069, 4);
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
		// Both read their own stated position now rather than the Q-line's
		// rounded one: "UNMANNED ACFT VEHICLE FLYING WI 1000M RADIUS OF
		// 414056N 0044930W" is a position with a radius, which is the cue.
		// The pin's subject stands: two NOTAMs, one place.
		const n1 = findNotam(notams, 'LEAN-R0225/26');
		const n2 = findNotam(notams, 'LEAN-R0226/26');
		expect(n1).toBeTruthy();
		expect(n2).toBeTruthy();
		expect(n1!.coordinates[0].type).toBe('psn');
		expect(n2!.coordinates[0].type).toBe('psn');
		expect(n1!.coordinates[0].lat).toBeCloseTo(41.6822, 3);
		expect(n1!.coordinates[0].lon).toBeCloseTo(-4.8250, 3);
		expect(n1!.coordinates[0].radius).toBe(1000);
		expect(n1!.coordinates[0].radiusUnit).toBe('M');
		expect(n1!.coordinates[0].lat).toBeCloseTo(n2!.coordinates[0].lat, 3);
		expect(n1!.coordinates[0].lon).toBeCloseTo(n2!.coordinates[0].lon, 3);
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
// The RADIUS-BESIDE-A-COORDINATE cue moves every file, and non-French
// publishers most: a stated radius is what draws the circle, so a text that
// carries one beside a coordinate is stating a position, whichever side it
// writes it on. "MACON 500336N 0041313E MODEL ACFT EVENT RADIUS 400M"
// (Belgium), "CRANES OPR WI 0.1NM RADIUS 513338N 0001633W" (the UK),
// "RADIUS 3NM AROUND 500739N0094213E" (Germany) and "UNMANNED ACFT VEHICLE
// FLYING WI 1000M RADIUS OF 414056N 0044930W" (Spain) all used to fall back
// to the Q-line's own centre and its coarse disc, losing both the position
// and the radius the publisher gave.
// The SLASH pair separator ("342642S/0674809W", the form Argentina and Chile
// write throughout, and the French "442958.700N / 0044224.902E" of P1801/26)
// moves every file that carries it: CYTZ-SAWG gains 62 position and 6 area
// entries, World-20260207 gains 154 and 41, and three World entries appear
// because a body that held one group now states several.
// VIDP-G1211/25 keeps its whole E) since a list inside E) ("B) TOWARDS
// NORTH", "D) FM NORTH-WEST/NORTH") is text, and the route point it repeats
// four times now makes two groups: one entry and one position more in
// LSHJ-ZBAA and SBBE-VIDP.
// The coordinates of eight and nine figures (P3052/26, B1192/26), the
// labelled POSITION of the English texts (D1536/26), the ring that needs
// four points (ORBI-A0870/25's three cranes), and the coordinate refused
// for minutes past 59 or degrees past 180 (the fifth obstacle of
// LFFA-P0049/26, KORF-A0550/26 placed at 8 W) move seven files.
const statisticsTests = [
	// positions/areas moved by one when LFFA-F1557/25's ARC HORAIRE started
	// promoting its group to a polygon (tagged arc centres are area language).
	{ file: 'Europe-20260203.txt', all: 11055, noPosition: 6680, positions: 3195, areas: 1180 },
	{ file: 'LPPT-EPWA-20260207.txt', all: 1034, noPosition: 331, positions: 528, areas: 175 },
	{ file: 'EGPD-LFKC-20260207.txt', all: 675, noPosition: 183, positions: 448, areas: 44 },
	{ file: 'KJFK-KLAX-20260209.txt', all: 449, noPosition: 354, positions: 94, areas: 1 },
	{ file: 'CYQB-CYVR-20260209.txt', all: 366, noPosition: 118, positions: 246, areas: 2 },
	{ file: 'CYTZ-SAWG-20260209.txt', all: 557, noPosition: 277, positions: 253, areas: 27 },
	{ file: 'EGLL-FACT-20260209.txt', all: 791, noPosition: 310, positions: 396, areas: 85 },
	{ file: 'ENGM-YSCB-20260209.txt', all: 521, noPosition: 249, positions: 172, areas: 100 },
	{ file: 'LEMD-UHWW-20260209.txt', all: 1514, noPosition: 533, positions: 715, areas: 266 },
	{ file: 'LSHJ-ZBAA-20260209.txt', all: 1347, noPosition: 437, positions: 796, areas: 114 },
	{ file: 'SBBE-VIDP-20260209.txt', all: 316, noPosition: 253, positions: 38, areas: 25 },
	{ file: 'World-20260207.txt', all: 36912, noPosition: 24180, positions: 8651, areas: 4081 },
	// W0196/26 (AXE : RWY 16R/34L) and W0385/26 (AXE : ORIENTE) gained
	// their voltige corridors when parseAerobaticAxis learned those forms.
	{ file: 'World-20260512.txt', all: 35382, noPosition: 22577, positions: 9274, areas: 3531 },
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
	// Surfaced by the id-collision fix, and left here as one block rather
	// than investigated one by one: every entry is another state's or
	// another aerodrome's NOTAM that the bare-id dedupe used to discard, and
	// every one of them is the SAME two publisher habits the list above
	// already records. A Q-line drawn round the issuing aerodrome or ARTCC
	// rather than round the area (KZBW's ADS-B outage 184 NM from the
	// Boston centre's own reference, KLRD's turbine "15.7NM NW HBV" inside a
	// 5 NM Q radius), and the six-digit longitude ambiguity (SVMC-A0096/26
	// states "074151N/067352W", one digit short of the seven every other
	// vertex of that ring carries).
	'KLRD-A0244/26',
	'KZMP-A0238/26',
	// Newly decoded by the radius-beside-a-coordinate cue: a Tunisian
	// paramotor display listing six circles across the country, whose
	// northernmost site is 220 NM from the Q-line centre the publisher drew
	// round the lot at a 72 NM radius.
	'DTTC-A0453/26',
	'A0098/21', 'A0409/26', 'A0434/26', 'A0629/26',
	'A0756/26', 'A0855/25', 'A1446/26', 'C0005/26',
	'C0010/26', 'C0086/26', 'D0334/26', 'D0544/26',
	'ENGM-A0526/26', 'ETCZ-M2732/25', 'FAJN-A0584/26', 'FAJN-A0609/26',
	'FAJN-A4208/25', 'FALE-A1393/26', 'HECA-W0189/26', 'KIAG-A1084/25',
	'KICT-A1144/26', 'KICZ-A0008/25', 'KICZ-A0014/26', 'KLAN-A2086/26',
	'KLRD-A0245/26', 'KPTK-A1398/26', 'KZAB-A0510/26', 'KZAB-A0821/26',
	'KZAB-A0834/26', 'KZAB-A0907/26', 'KZAB-A1411/26', 'KZAB-A1510/26',
	'KZAK-A0546/26', 'KZAK-A0578/26', 'KZAU-A0255/26', 'KZBW-A0288/26',
	'KZBW-A0323/26', 'KZBW-A0324/26', 'KZFW-A0560/26', 'KZJX-A1444/26',
	'KZKC-A0334/26', 'KZKC-A0496/26', 'KZKC-A0736/26', 'KZLA-A1548/26',
	'KZMA-A0098/21', 'KZME-A0654/26', 'KZMP-A1282/26', 'KZMP-A1389/26',
	'KZOB-A0334/26', 'KZOB-A0408/26', 'KZWY-A0660/26', 'L0226/26',
	'L0448/26', 'L2486/26', 'LEAN-D0446/26', 'LEBZ-D2428/26',
	'LGGG-M0006/26', 'LGLR-M0208/26', 'LIMM-E1128/26', 'LLAD-C0005/26',
	'LLAD-C0010/26', 'LPLA-A2514/26', 'LTAA-D2396/25', 'M0754/26',
	'NZCH-B0585/26', 'OTNO-A0209/26', 'P1629/26', 'PAFA-A2112/26',
	'PAZA-A0074/26', 'PAZA-A0221/26', 'PAZA-A0855/25', 'PAZA-A1323/25',
	'Q6516/26', 'R0463/26', 'SBRJ-O1125/25', 'SGFA-A0131/26',
	'SVMC-A0096/26', 'SVMI-A0624/25', 'U0175/26', 'U0179/26',
	'U0180/26', 'U1184/23', 'VEIM-A0627/26', 'VLVT-A0019/26',
	'WMFC-A1694/26',
	// Newly decoded by the slash pair separator: the source's own DELETE line
	// states the obstacle three degrees of longitude from where the same
	// NOTAM re-states it, which is the digit the amendment exists to correct
	// ("DELETE FAS OBST: 824 AAO 430748N/0755136W. FAS OBST: 824 AAO
	// 430748N/0785136W").
	'KIAG-A1084/25',
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

// A location repeated in A) is one location. The NOTAM panel keys its
// aerodrome chips on the code, where Svelte throws on a repeat in production
// too, and every consumer (ownership, the per-ident index) counted it twice.
describe('parseNotams - A) locations', () => {
	it('lists a location A) repeats once, keeping its first spelling', () => {
		const [n] = parseNotams(`A1234/26 NOTAMN
Q) LFFF/QCACF/IV/BO/A/000/999/4901N00233E005
A) LFPG LFPG lfpg LFPB B) 2601010000 C) PERM
E) FREQ TWR READ 119.255MHZ INSTEAD OF 119.250MHZ`);
		expect(n.icaoCodes).toEqual(['LFPG', 'LFPB']);
	});
});

describe('parseNotams, the positions of the November pairs', () => {
	const shapes = (text: string) =>
		parseNotams(text).map((n) => ({
			polygon: n.isPolygon,
			coords: n.coordinates.map((c) => ({ type: c.type, radius: c.radius })),
		}));

	it('reads a labelled POSITION as the PSN it is (D1536/26)', () => {
		const [n] = parseNotams(
			'D1536/26 NOTAMR D0271/26\nQ) LFMM/QMTCM/IV/NBO/A/000/999/4339N00501E005\n' +
				'A) LFNE B) 2603191217 C) PERM\nE) THR 33R POSITION GEO CORRECTION : 433936.72N 0050049.54E\nREF AD1.3-1',
		);
		expect(n.coordinates[0].type).toBe('psn');
		expect(n.coordinates[0].lat).toBeCloseTo(43.6602, 4);
		expect(n.coordinates[0].lon).toBeCloseTo(5.013761, 4);
	});

	it('keeps a list of POSITION lines a list of points (J4661/26)', () => {
		const got = shapes(
			'J4661/26 NOTAMR J4657/26\nQ) LTAA/QMPCS/IV/M/A/000/999/3847N03432E005\n' +
				'A) LTAZ B) 2610301330 C) 2612311400\nE) 1B,1C AND 1D PRKG POSITIONS INSTALLED\n' +
				' PRKG POSITIONS:            COORD:\n' +
				'-PRKG POSITION 1B(CAT A):   384619.8506N0343131.5444E\n' +
				'-PRKG POSITION 1C(CAT A):   384620.3122N0343131.8468E\n' +
				'-PRKG POSITION 1D(CAT A):   384620.7738N0343132.1492E\n-ADZ TWR INSTRUCTIONS-',
		);
		expect(got).toEqual([0, 1, 2].map(() => ({ polygon: false, coords: [{ type: 'psn', radius: undefined }] })));
	});

	it('closes a ring of four points at least (ORBI-A0870/25)', () => {
		const got = shapes(
			'A0870/25 NOTAMN\nQ) ORBB/QOBCE/IV/M/A/000/999/3200N04423E001\n' +
				'A) ORBI B) 2510010000 C) 2612310000\nE) OBSTACLE CRANES ERECTED WITH HIGHT 70M MSL AT THE FOLLOWING\n' +
				'LOCATIONS 31595528N044223559E 31595583N044223721E\n31595624N044223837E',
		);
		expect(got.some((n) => n.polygon)).toBe(false);
	});

	it('starts the zone at the area before the circle on a PSN (LLLL-C2201/26)', () => {
		const got = shapes(
			'C2201/26 NOTAMN\nQ) LLLL/QWULW/IV/BO/W/000/006/3233N03517E002\n' +
				'A) LLLL B) 2611010001 C) 2611302159\nE) UAS ACT WILL TAKE PLACE AT TAANACHIM AND GADISH.\n' +
				'   AN AREA CLSD FM GND UP TO 100M AGL 560FT AMSL BTN FLW PSN:\n' +
				'   323333N0351719E 323219N0351747E 323221N0351759E\n' +
				'   323207N0351803E 323201N0351722E 323254N0351640E\n' +
				'   323313N0351637E 323317N0351558E 323335N0351558E.\n' +
				'   AN AREA WI 400M RADIUS CENTERED ON PSN 323309N0351447E\n' +
				'   CLSD FM GND UP TO 100M AGL, 560FT AMSL.\nF) GND G) 560FT AMSL',
		);
		expect(got.find((n) => n.polygon)?.coords.length).toBe(9);
		expect(got.some((n) => !n.polygon && n.coords[0]?.radius === 400)).toBe(true);
	});

	it('places the crane of a longitude that lost its leading zero (KEWR-A5571/26)', () => {
		const [n] = parseNotams(
			'A5571/26 NOTAMN\nQ) KZNY/QOBCE/IV/M/A/000/999/4042N07410W005\n' +
				'A) KEWR B) 2611132056 C) 2710312359\nE) OBST CRANE (ASN 2026-AEA-1068-NRA) 40405474N74112408W (1.2NM SW\n' +
				'EWR) 214FT (200FT AGL) FLAGGED AND LGTD',
		);
		expect(n.coordinates[0].type).toBe('psn');
		expect(n.coordinates[0].lon).toBeCloseTo(-74.190022, 4);
	});
});

describe('parseNotams, a NOTAMC', () => {
	it('reads a pasted NOTAMC as nothing, and the NOTAMs beside it as they are', () => {
		const text =
			'A1234/26 NOTAMC A1200/26\nQ) LFFF/QMRXX/IV/NBO/A/000/999/4901N00233E005\n' +
			'A) LFPG B) 2611221200\nE) REF NOTAM CANCELLED\n\n' +
			'A1235/26 NOTAMN\nQ) LFFF/QMRLC/IV/NBO/A/000/999/4901N00233E005\n' +
			'A) LFPG B) 2611230800 C) 2611231700\nE) RWY 09L/27R CLSD.';
		const got = parseNotams(text);
		expect(got.map((n) => n.id)).toEqual(['A1235/26']);
		expect(got[0].endDate?.toISOString()).toBe('2026-11-23T17:00:00.000Z');
		// The prefixed header of SOFIA-Briefing.
		expect(parseNotams('LFFA-A1234/26 NOTAMC A1200/26\nQ) LFFF/QMRXX/IV/NBO/A/000/999/4901N00233E005\nA) LFPG B) 2611221200\nE) REF NOTAM CANCELLED')).toEqual([]);
	});
});

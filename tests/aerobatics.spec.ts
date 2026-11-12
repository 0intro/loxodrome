import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	AEROBATIC_CORRIDOR_WIDTH_M,
	aerobaticCorridorRing,
	parseAerobaticAxis,
	parseNotams,
} from '$lib/notam';
import {
	equirectangularDistanceM,
	initialBearingDeg,
	polygonAreaM2,
} from '$lib/notam/geometry';

// 484232N 0034546E, the Sezanne (LFFZ) aerobatic box centre.
const CENTRE_LAT = 48 + 42 / 60 + 32 / 3600;
const CENTRE_LON = 3 + 45 / 60 + 46 / 3600;

describe('parseAerobaticAxis', () => {
	it('parses the English AXIS / LENGTH form', () => {
		const a = parseAerobaticAxis(
			'AXIS 057/237\nLENGTH : 1000M CENTRED ON PSN: 484232N 0034546E',
		);
		expect(a).toEqual({ bearingDeg: 57, lengthM: 1000 });
	});

	it('parses the French AXE / LONGUEUR form on one line (double space)', () => {
		const a = parseAerobaticAxis(
			'AXE  057/237 LONGUEUR 1000M CENTRE SUR PSN: 484232N 0034546E',
		);
		expect(a).toEqual({ bearingDeg: 57, lengthM: 1000 });
	});

	it('parses a multi-line AXE / LONGUEUR block', () => {
		const a = parseAerobaticAxis('AXE 170/350\nLONGUEUR 2000M');
		expect(a).toEqual({ bearingDeg: 170, lengthM: 2000 });
	});

	it('parses the dashed "AXE : / LONGUEUR :" form', () => {
		const a = parseAerobaticAxis('- AXE : 177/357\n- LONGUEUR : 1000M');
		expect(a).toEqual({ bearingDeg: 177, lengthM: 1000 });
	});

	it('parses ORIENTATION with "LONGUEUR AXE" (and is not fooled by it)', () => {
		const a = parseAerobaticAxis(
			'- ORIENTATION : 081/261\n- LONGUEUR AXE : 2000M',
		);
		expect(a).toEqual({ bearingDeg: 81, lengthM: 2000 });
	});

	it('parses the inline comma form', () => {
		const a = parseAerobaticAxis(
			'-AXE 034/214, LONGUEUR 1000M CENTRE SUR PSN: 481658N 0030930E',
		);
		expect(a).toEqual({ bearingDeg: 34, lengthM: 1000 });
	});

	it('reads a runway-designator axis as tens of degrees', () => {
		const a = parseAerobaticAxis(
			'- AXE PISTE 10/28 CENTRE SUR ARP\n- LONGUEUR : 2000M',
		);
		expect(a).toEqual({ bearingDeg: 100, lengthM: 2000 });
	});

	it('parses the "AXE : ORIENTE" form (the interposed word, W0528/26)', () => {
		const a = parseAerobaticAxis(
			'- AXE : ORIENTE 356/176 CENTRE SUR PSN\n- LONGUEUR: 3200M',
		);
		expect(a).toEqual({ bearingDeg: 356, lengthM: 3200 });
	});

	it('parses "AXIS : ORIENTED" with the LENGHT corpus typo (W1659/26)', () => {
		const a = parseAerobaticAxis(
			'-AXIS : ORIENTED 020/200 CENTRED ON PSN\nLENGHT : 3200M',
		);
		expect(a).toEqual({ bearingDeg: 20, lengthM: 3200 });
	});

	it('parses the AXOS / LLEN corruption (W1750/26)', () => {
		const a = parseAerobaticAxis(
			'AXOS 020/200 LLEN 2000M CENTRED ON ARP: 474414N 0072547E',
		);
		expect(a).toEqual({ bearingDeg: 20, lengthM: 2000 });
	});

	it('reads a colon-separated runway axis with parallel letters (W0196/26)', () => {
		const a = parseAerobaticAxis('- AXE : RWY 16R/34L\n- LONGUEUR : 1000M');
		expect(a).toEqual({ bearingDeg: 160, lengthM: 1000 });
	});

	it('carries a published width, doubled for the each-side idiom', () => {
		expect(
			parseAerobaticAxis(
				"- AXE : RWY 16R/34L\n- LONGUEUR : 1000M\n- LARGEUR : 500M DE PART ET D'AUTRE DE L'AXE",
			),
		).toEqual({ bearingDeg: 160, lengthM: 1000, widthM: 1000 });
		expect(
			parseAerobaticAxis(
				'- AXIS : 010/190\n- LENGTH : 2000M\n- WIDTH : 500M EACH PART OF AXIS',
			),
		).toEqual({ bearingDeg: 10, lengthM: 2000, widthM: 1000 });
		expect(
			parseAerobaticAxis('AXE 010/190 LONGUEUR 2000M LARGEUR 400M'),
		).toEqual({ bearingDeg: 10, lengthM: 2000, widthM: 400 });
	});

	it('returns null when there is no length', () => {
		expect(parseAerobaticAxis('AXE 170/350 CENTRE SUR PSN 481243N 0012936E')).toBeNull();
	});

	it('returns null when there is no axis', () => {
		expect(
			parseAerobaticAxis("ACTIVITE VOLTIGE 'SAINCAIZE' SUPPRIMEE\nPSN : 465600N 0030400E"),
		).toBeNull();
	});
});

describe('aerobaticCorridorRing', () => {
	it('builds a rectangle of the right length, width and centroid', () => {
		const ring = aerobaticCorridorRing(
			{ lat: 0, lon: 0 },
			{ bearingDeg: 0, lengthM: 1000 },
			AEROBATIC_CORRIDOR_WIDTH_M,
		);
		expect(ring).toHaveLength(4);

		const [c0, c1, c2, c3] = ring;
		// Adjacent sides: long sides ~= length, short sides ~= width. Tolerance
		// covers the spherical-vs-planar approximation (~0.1% at this scale).
		const side = (a: (typeof ring)[number], b: (typeof ring)[number]): number =>
			equirectangularDistanceM(a.lat, a.lon, b.lat, b.lon);
		expect(side(c0, c1)).toBeCloseTo(1000, -1);
		expect(side(c2, c3)).toBeCloseTo(1000, -1);
		expect(side(c0, c3)).toBeCloseTo(200, -1);
		expect(side(c1, c2)).toBeCloseTo(200, -1);

		const cLat = ring.reduce((s, c) => s + c.lat, 0) / 4;
		const cLon = ring.reduce((s, c) => s + c.lon, 0) / 4;
		expect(cLat).toBeCloseTo(0, 6);
		expect(cLon).toBeCloseTo(0, 6);

		expect(polygonAreaM2(ring)).toBeCloseTo(1000 * 200, -3);
	});

	it('orients the long axis along the given bearing', () => {
		const ring = aerobaticCorridorRing(
			{ lat: CENTRE_LAT, lon: CENTRE_LON },
			{ bearingDeg: 57, lengthM: 1000 },
			AEROBATIC_CORRIDOR_WIDTH_M,
		);
		// c1 -> c0 runs along the +bearing direction (end2 -> end1).
		const brg = initialBearingDeg(
			ring[1].lat,
			ring[1].lon,
			ring[0].lat,
			ring[0].lon,
		);
		expect(brg).toBeCloseTo(57, 0);
	});
});

// The Sezanne (LFFZ) W1031/26 NOTAM that prompted this feature, in both its
// English and French wording, lives in tests/fixtures/areas and is checked
// end-to-end by the "parseNotams - areas" suite in parser.spec.ts. The cases
// below cover the parsing helpers and the point/area boundary conditions.
describe('parseNotams: aerobatic display corridor', () => {
	it('leaves a SUPPRIMEE voltige notice as a single point', () => {
		const text = `
W1335/25
Q) LFFF/QWBXX/IV/M/W/025/055/4656N00304E005
A) LFFF
E) ACTIVITE VOLTIGE NR6457 'SAINCAIZE' (58) SUPPRIMEE
PSN : 465600N 0030400E
REF ENR5.5
F) 2500FT AGL
G) 4500FT AGL
`;
		const [n] = parseNotams(text);
		expect(n.obstacleType).toBe('voltige');
		expect(n.isPolygon).toBe(false);
		expect(n.coordinates).toHaveLength(1);
	});

	it('leaves a circular (RAYON) voltige as a point with its radius', () => {
		const text = `
W9999/26
Q) LFFF/QWBLW/IV/M/W/000/045/4656N00304E002
A) LFFF
E) VOLTIGE DANS UN RAYON DE 2NM CENTRE SUR PSN 465600N 0030400E
F) SFC
G) 4500FT AMSL
`;
		const [n] = parseNotams(text);
		expect(n.isPolygon).toBe(false);
		expect(n.coordinates).toHaveLength(1);
		expect(n.coordinates[0].radius).toBe(2);
	});

	it('fires on the real EGLL-FACT briefing voltige NOTAMs', () => {
		// The five French voltige axis+length NOTAMs in this fixture (PRE SAINT
		// MARTIN, LE BROUILH-MONBERT, CLERMONT-FERRAND, VILLEMANOCHE, CHATEAUDUN)
		// become corridor polygons; this is the +5 area / -5 position shift the
		// statistics test in parser.spec.ts also tracks.
		const text = readFileSync(
			new URL('./fixtures/EGLL-FACT-20260209.txt', import.meta.url),
			'utf-8',
		);
		const corridors = parseNotams(text).filter(
			(n) => n.isPolygon && n.coordinates.every((c) => c.original === 'corridor'),
		);
		expect(corridors).toHaveLength(5);
		for (const n of corridors) {
			expect(n.obstacleType).toBe('voltige');
			expect(n.coordinates).toHaveLength(4);
		}
	});

	it('does not turn a non-voltige AXIS/LENGTH NOTAM into a corridor', () => {
		const text = `
A1234/26
Q) LFFF/QMRLC/IV/NBO/A/000/999/4843N00346E005
A) LFFZ
E) RWY 10/28 AXIS 100/280 LENGTH : 1000M CENTRED ON PSN: 484232N 0034546E
F) SFC
G) UNL
`;
		const [n] = parseNotams(text);
		expect(n.obstacleType).toBe('');
		expect(n.isPolygon).toBe(false);
		expect(n.coordinates).toHaveLength(1);
	});
});

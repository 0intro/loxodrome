import { describe, it, expect } from 'vitest';
import { extractAirportAnchor, extractRadiusFromText, radiusToNM } from '$lib/notam';

// Unit tests for radius extraction

describe('extractRadiusFromText', () => {
	it('should extract RADIUS after coordinates', () => {
		const text = 'PSN 514600N 0052622E RADIUS 1NM BTN GND/500FT';
		// "514600N 0052622E" starts at 4, length 16
		const r = extractRadiusFromText(text, 4, 20);
		expect(r).toBeTruthy();
		expect(r!.radius).toBe(1);
		expect(r!.radiusUnit).toBe('NM');
	});

	it('should extract decimal RADIUS after coordinates', () => {
		const text = 'PSN 513613N 0055239E RADIUS 1.5NM BTN GND';
		const r = extractRadiusFromText(text, 4, 20);
		expect(r).toBeTruthy();
		expect(r!.radius).toBe(1.5);
		expect(r!.radiusUnit).toBe('NM');
	});

	it('should extract RADIUS with comma decimal (KM) before coordinates', () => {
		const text = 'CIRCLE RADIUS 5,6KM CENTRED ON 482406N 0170711E';
		// "482406N 0170711E" starts at 31, length 16
		const r = extractRadiusFromText(text, 31, 47);
		expect(r).toBeTruthy();
		expect(r!.radius).toBe(5.6);
		expect(r!.radiusUnit).toBe('KM');
	});

	it('should extract M RADIUS OF before coordinates', () => {
		const text = 'UNMANNED ACFT VEHICLE FLYING WI 1000M RADIUS OF 414056N 0044930W';
		// "414056N 0044930W" starts at 49, length 16
		const r = extractRadiusFromText(text, 49, 65);
		expect(r).toBeTruthy();
		expect(r!.radius).toBe(1000);
		expect(r!.radiusUnit).toBe('M');
	});

	it('should return null when no radius present', () => {
		const text = 'PSN 484024N 0030441E RDL 031/5.4NM ARP LFAI';
		const r = extractRadiusFromText(text, 4, 20);
		expect(r).toBe(null);
	});

	it('should extract French DE RAYON before coordinates', () => {
		const text = 'CERCLE DE 1NM DE RAYON CENTRE SUR PSN 482807N 0023803E';
		// "482807N 0023803E" starts at 38, length 16
		const r = extractRadiusFromText(text, 38, 54);
		expect(r).toBeTruthy();
		expect(r!.radius).toBe(1);
		expect(r!.radiusUnit).toBe('NM');
	});

	it('should extract French decimal DE RAYON before coordinates', () => {
		const text = 'CERCLE DE 0.2NM DE RAYON CENTRE SUR PSN : 434524N 0065513E';
		// "434524N 0065513E" starts at 42, length 16
		const r = extractRadiusFromText(text, 42, 58);
		expect(r).toBeTruthy();
		expect(r!.radius).toBe(0.2);
		expect(r!.radiusUnit).toBe('NM');
	});

	it('should extract French RAYON : after coordinates', () => {
		const text = 'PSN : 461043N 0064212E\nRAYON : 5NM\nRDL091/18NM LFLI';
		// "461043N 0064212E" starts at 6, length 16
		const r = extractRadiusFromText(text, 6, 22);
		expect(r).toBeTruthy();
		expect(r!.radius).toBe(5);
		expect(r!.radiusUnit).toBe('NM');
	});

	it('should extract French DANS UN RAYON DE after coordinates', () => {
		const text = 'PSN : 461620N 0065012E DANS UN RAYON DE 5NM\nRDL046/18NM';
		// "461620N 0065012E" starts at 6, length 16
		const r = extractRadiusFromText(text, 6, 22);
		expect(r).toBeTruthy();
		expect(r!.radius).toBe(5);
		expect(r!.radiusUnit).toBe('NM');
	});

	it('should not match RAYON without a separator (e.g. RAYON LASER)', () => {
		const text = 'EMISSION RAYON LASER 3M PSN 482807N 0023803E';
		// "482807N 0023803E" starts at 28, length 16
		const r = extractRadiusFromText(text, 28, 44);
		expect(r).toBe(null);
	});
});

describe('extractAirportAnchor', () => {
	it('parses the plain RDL form', () => {
		expect(extractAirportAnchor('RDL 031/5.4NM ARP LFAI')).toEqual({
			bearing: 31,
			distance: 5.4,
			distanceUnit: 'NM',
			ident: 'LFAI',
		});
	});

	it('parses the label-colon form', () => {
		expect(extractAirportAnchor('RDL : 268DEG/1.24NM ARP LFDB MONTAUBAN')).toEqual({
			bearing: 268,
			distance: 1.24,
			distanceUnit: 'NM',
			ident: 'LFDB',
		});
	});

	it('parses the truncated-DEG form', () => {
		expect(extractAirportAnchor('RDL220DE/0.22NM ARP LFBJ')).toEqual({
			bearing: 220,
			distance: 0.22,
			distanceUnit: 'NM',
			ident: 'LFBJ',
		});
	});

	it('returns null without the ARP ident', () => {
		expect(extractAirportAnchor('RDL046/18NM')).toBe(null);
	});
});

describe('extractRadiusFromText France corpus forms', () => {
	it('parses "RADIUS : <n>" with a colon (W0701/26)', () => {
		const text = 'PSN : 451912N 0032141E\nRADIUS : 1NM';
		expect(extractRadiusFromText(text, 6, 22)).toEqual({
			radius: 1,
			radiusUnit: 'NM',
		});
	});

	it('parses "WITHIN <n> RADIUS" after the coordinate (P3953/25)', () => {
		const text = 'PSN MOY : 480345N 0014301W WITHIN 330M RADIUS';
		expect(extractRadiusFromText(text, 10, 26)).toEqual({
			radius: 330,
			radiusUnit: 'M',
		});
	});

	it('parses "CIRCLE OF <n> RADIUS" after the coordinate (W0227/26)', () => {
		const text =
			"PSN : 461043N 0064212E \nCIRCLE OF 3NM RADIUS RDL091/18NM FM 'ANNEMASSE' AD";
		expect(extractRadiusFromText(text, 6, 22)).toEqual({
			radius: 3,
			radiusUnit: 'NM',
		});
	});

	it('applies the radius-around-name preamble to the PSN (W1654/26)', () => {
		const text =
			"GATHERING OF 50 GLIDERS WITHIN A 5NM RADIUS AROUND 'CHALONS' AD :\n-PSN : 485420N 0042110E";
		const start = text.indexOf('485420N');
		expect(extractRadiusFromText(text, start, start + 16)).toEqual({
			radius: 5,
			radiusUnit: 'NM',
		});
	});

	it('parses "CERCLE DE <n> CENTRE SUR" without DE RAYON (R1651/26)', () => {
		const text = 'CERCLE DE 2NM CENTRE SUR 462131N 0063859E';
		const start = text.indexOf('462131N');
		expect(extractRadiusFromText(text, start, start + 16)).toEqual({
			radius: 2,
			radiusUnit: 'NM',
		});
	});

	it('halves the English DIAMETER like the French DIAMETRE (H0343/26)', () => {
		const text = 'PSN : 451111N 0054539E\n- SAFETY AREA : DIAMETER 28 M';
		expect(extractRadiusFromText(text, 6, 22)).toEqual({
			radius: 14,
			radiusUnit: 'M',
		});
	});

	it("never leaks an earlier coordinate's radius across it (R1129/26)", () => {
		const text =
			'ARC HORAIRE DE 0.8NM DE RAYON CENTRE SUR 490801N 0042112E,\n490810N 0042000E,';
		const start = text.indexOf('490810N');
		expect(extractRadiusFromText(text, start, start + 16)).toBeNull();
	});
});

describe('radiusToNM', () => {
	it('should return NM as-is', () => {
		expect(radiusToNM(5, 'NM')).toBe(5);
	});

	it('should convert KM to NM', () => {
		expect(radiusToNM(1.852, 'KM')).toBeCloseTo(1.0, 2);
	});

	it('should convert M to NM', () => {
		expect(radiusToNM(1852, 'M')).toBeCloseTo(1.0, 2);
	});
});

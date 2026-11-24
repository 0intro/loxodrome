import { describe, it, expect } from 'vitest';
import { parseDMSCoordinate } from '$lib/notam';

// Unit tests for PSN coordinate parser

describe('parseDMSCoordinate', () => {
	it('should parse standard coordinates with space', () => {
		const c = parseDMSCoordinate('484024N 0030441E');
		expect(c).toBeTruthy();
		expect(c!.lat).toBeCloseTo(48.6733, 2);
		expect(c!.lon).toBeCloseTo(3.0781, 2);
	});

	it('should parse coordinates without space', () => {
		const c = parseDMSCoordinate('161514N0611540W');
		expect(c).toBeTruthy();
		expect(c!.lat).toBeCloseTo(16.2539, 2);
		expect(c!.lon).toBeCloseTo(-61.2611, 2);
	});

	it('should parse 7-digit latitude (implicit decimal seconds)', () => {
		const c = parseDMSCoordinate('4908325N 0004328W');
		expect(c).toBeTruthy();
		expect(c!.lat).toBeCloseTo(49.1424, 2);
		expect(c!.lon).toBeCloseTo(-0.7244, 2);
	});

	it('should parse 7-digit longitude missing leading zero', () => {
		const c = parseDMSCoordinate('4638487N 1420211E');
		expect(c).toBeTruthy();
		expect(c!.lat).toBeCloseTo(46.6469, 2);
		expect(c!.lon).toBeCloseTo(14.3392, 2);
	});

	it('should parse 7-digit longitude as DDDMMSS with 6-digit latitude', () => {
		const c = parseDMSCoordinate('504940N 1211510W');
		expect(c).toBeTruthy();
		expect(c!.lat).toBeCloseTo(50.8278, 2);
		expect(c!.lon).toBeCloseTo(-121.2528, 2);
	});

	it('should parse decimal seconds', () => {
		const c = parseDMSCoordinate('483923.17N 0035848.18E');
		expect(c).toBeTruthy();
		expect(c!.lat).toBeCloseTo(48.6564, 2);
		expect(c!.lon).toBeCloseTo(3.9800, 2);
	});

	it('should parse DDMM precision (4-digit lat + 5-digit lon)', () => {
		const c = parseDMSCoordinate('4900N 11000W');
		expect(c).toBeTruthy();
		expect(c!.lat).toBeCloseTo(49.0, 4);
		expect(c!.lon).toBeCloseTo(-110.0, 4);
	});

	it('should parse DDMM PSN form (mobile rigs)', () => {
		const c = parseDMSCoordinate('5338N 00304E');
		expect(c).toBeTruthy();
		expect(c!.lat).toBeCloseTo(53.6333, 3);
		expect(c!.lon).toBeCloseTo(3.0667, 3);
	});

	it('should parse DDMM decimal minutes', () => {
		const c = parseDMSCoordinate('4900.5N 11030.25W');
		expect(c).toBeTruthy();
		expect(c!.lat).toBeCloseTo(49.00833, 4);
		expect(c!.lon).toBeCloseTo(-110.50417, 4);
	});

	it('should reject a 5-digit latitude group (ambiguous)', () => {
		expect(parseDMSCoordinate('49005N 001234E')).toBeNull();
	});
});

describe('parseDMSCoordinate, digits read and refused', () => {
	it('reads fractions of a second with no decimal point', () => {
		// P3052/26 and B1192/26.
		const p = parseDMSCoordinate('43302737N 004593549E');
		expect(p!.lat).toBeCloseTo(43.507603, 5);
		expect(p!.lon).toBeCloseTo(4.993192, 5);
		expect(parseDMSCoordinate('210233068N 0865410.67W')!.lat).toBeCloseTo(21.042519, 5);
	});

	it('restores the leading zero of a longitude whose degrees pass 180', () => {
		// KEWR-A5571/26, 1.2 NM southwest of Newark, and HKJK-A0265/26.
		const p = parseDMSCoordinate('40405474N 74112408W');
		expect(p!.lat).toBeCloseTo(40.681872, 5);
		expect(p!.lon).toBeCloseTo(-74.190022, 5);
		const q = parseDMSCoordinate('01194115S 36552950E');
		expect(q!.lat).toBeCloseTo(-1.328097, 5);
		expect(q!.lon).toBeCloseTo(36.924861, 5);
	});

	it('refuses minutes past 59', () => {
		// LPLA-A2514/26, LTAA-D2396/25, and KORF-A0550/26, whose 6-digit
		// longitude reads as 007 60 91.01.
		expect(parseDMSCoordinate('387715N 0270904W')).toBeNull();
		expect(parseDMSCoordinate('399424.55N 0327544.87E')).toBeNull();
		expect(parseDMSCoordinate('373655.00N 076091.01W')).toBeNull();
	});
});

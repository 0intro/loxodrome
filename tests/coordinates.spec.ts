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

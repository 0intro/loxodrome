import { describe, expect, it } from 'vitest';
import { normalizeClock24 } from '$lib/format/datetime';

describe('normalizeClock24', () => {
	it('passes canonical HH:MM through', () => {
		expect(normalizeClock24('06:00')).toBe('06:00');
		expect(normalizeClock24('18:30')).toBe('18:30');
		expect(normalizeClock24('00:00')).toBe('00:00');
		expect(normalizeClock24('23:59')).toBe('23:59');
	});

	it('zero-pads short colon forms', () => {
		expect(normalizeClock24('6:00')).toBe('06:00');
		expect(normalizeClock24('6:5')).toBe('06:05');
		expect(normalizeClock24('9:9')).toBe('09:09');
	});

	it('accepts separator-less HHMM / HMM', () => {
		expect(normalizeClock24('1830')).toBe('18:30');
		expect(normalizeClock24('0600')).toBe('06:00');
		expect(normalizeClock24('600')).toBe('06:00');
		expect(normalizeClock24('0000')).toBe('00:00');
		expect(normalizeClock24('2359')).toBe('23:59');
	});

	it('accepts a bare hour', () => {
		expect(normalizeClock24('18')).toBe('18:00');
		expect(normalizeClock24('6')).toBe('06:00');
		expect(normalizeClock24('0')).toBe('00:00');
		expect(normalizeClock24('23')).toBe('23:00');
	});

	it('trims surrounding whitespace', () => {
		expect(normalizeClock24('  18:30  ')).toBe('18:30');
	});

	it('rejects out-of-range values', () => {
		expect(normalizeClock24('24:00')).toBeNull();
		expect(normalizeClock24('25:00')).toBeNull();
		expect(normalizeClock24('18:60')).toBeNull();
		expect(normalizeClock24('2400')).toBeNull();
		expect(normalizeClock24('1861')).toBeNull();
	});

	it('rejects unparseable text', () => {
		expect(normalizeClock24('')).toBeNull();
		expect(normalizeClock24('abc')).toBeNull();
		expect(normalizeClock24('6:00 PM')).toBeNull();
		expect(normalizeClock24('12345')).toBeNull();
		expect(normalizeClock24('1:2:3')).toBeNull();
	});
});

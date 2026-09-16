import { describe, it, expect } from 'vitest';
import { formatDMS, formatDMSAxis } from '$lib/notam/format';

describe('formatDMSAxis', () => {
	it('formats a latitude axis with two-digit degrees', () => {
		expect(formatDMSAxis(46.6468611, 'N', 'S', 2)).toBe('46°38\'48.70"N');
	});

	it('zero-pads degrees to three digits and minutes to two', () => {
		expect(formatDMSAxis(14, 'E', 'W', 3)).toBe('014°00\'00.00"E');
	});

	it('pads a single-digit degree and selects the negative hemisphere', () => {
		expect(formatDMSAxis(-5.5, 'N', 'S', 2)).toBe('05°30\'00.00"S');
	});

	it('carries seconds rounding over a minute boundary (never 60.00")', () => {
		expect(formatDMSAxis(45.99999999, 'N', 'S', 2)).toBe('46°00\'00.00"N');
		// Just below a minute boundary inside a degree: 45°59'59.9999…"
		expect(formatDMSAxis(45.9999999, 'N', 'S', 2)).toBe('46°00\'00.00"N');
	});
});

describe('formatDMS', () => {
	it('formats the combined lat / lon pair', () => {
		expect(formatDMS(46.6468611, 14.3392)).toBe('46°38\'48.70"N / 014°20\'21.12"E');
	});

	it('carries seconds rounding into minutes and degrees (never 60.00")', () => {
		expect(formatDMS(46.99999999, 2.0)).toBe('47°00\'00.00"N / 002°00\'00.00"E');
	});
});

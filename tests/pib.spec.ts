import { describe, it, expect } from 'vitest';
import { pibDateTime, pibValidity, pibQLine } from '$lib/notam/pib';

describe('pibDateTime', () => {
	it('formats a UTC date as SOFIA does (DD MM YYYY HH:MM)', () => {
		expect(pibDateTime(new Date(Date.UTC(2026, 6, 9, 10, 0)))).toBe('09 07 2026 10:00');
		expect(pibDateTime(new Date(Date.UTC(2026, 0, 5, 5, 54)))).toBe('05 01 2026 05:54');
	});
});

describe('pibValidity', () => {
	it('mirrors the DU:/AU: line of the reference PIB', () => {
		const v = pibValidity(
			new Date(Date.UTC(2026, 6, 9, 10, 0)),
			new Date(Date.UTC(2026, 6, 14, 15, 0)),
			false,
			false,
		);
		expect(v).toEqual({ from: '09 07 2026 10:00', to: '14 07 2026 15:00', permanent: false, estimated: false });
	});

	it('permanent NOTAMs carry no end date (printed PERM)', () => {
		const v = pibValidity(new Date(Date.UTC(2026, 2, 19, 15, 43)), null, true, false);
		expect(v.to).toBeNull();
		expect(v.permanent).toBe(true);
	});

	it('flags estimated end dates', () => {
		const v = pibValidity(
			new Date(Date.UTC(2026, 4, 7, 8, 0)),
			new Date(Date.UTC(2026, 7, 5, 23, 59)),
			false,
			true,
		);
		expect(v).toEqual({ from: '07 05 2026 08:00', to: '05 08 2026 23:59', permanent: false, estimated: true });
	});
});

describe('pibQLine', () => {
	it('re-spaces a compact Q-line the SOFIA way', () => {
		expect(pibQLine('LFFF/QFATT/IV/BO/A/000/999/4849N00237E005')).toBe(
			'LFFF / QFATT / IV / BO / A / 000/999 / 4849N00237E005',
		);
	});

	it('is idempotent on an already-spaced Q-line', () => {
		const spaced = 'LFFF / QRTCA / IV / BO / W / 000/195 / 4940N00135W007';
		expect(pibQLine(spaced)).toBe(spaced);
	});

	it('keeps the lower/upper band joined by a bare slash', () => {
		expect(pibQLine('LFMM/QMRLB/IV/NBO/A/000/080/4547N00310E005')).toBe(
			'LFMM / QMRLB / IV / NBO / A / 000/080 / 4547N00310E005',
		);
	});

	it('returns empty for a missing Q-line', () => {
		expect(pibQLine('')).toBe('');
		expect(pibQLine(null)).toBe('');
		expect(pibQLine(undefined)).toBe('');
	});
});

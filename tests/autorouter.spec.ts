import { describe, it, expect } from 'vitest';
import { rowToIcaoText } from '$lib/autorouter/client';
import { parseNotams } from '$lib/notam/parser';

// autorouter encodes lat/lon as Garmin int32 (×90 / 2^30). The tests build
// rows in the same format so the reconstruction is exercised end-to-end.
const degToGarmin = (d: number): number => Math.round((d * 0x40000000) / 90);

describe('rowToIcaoText', () => {
	it('reconstructs an ICAO-format NOTAM block from a typical row', () => {
		const text = rowToIcaoText({
			series: 'A',
			number: 234,
			year: 2026,
			code23: 'OB',
			code45: 'CE',
			fir: 'LFFF',
			traffic: 'IV',
			purpose: 'M ',  // trailing space in autorouter's actual shape
			scope: 'AE',
			lower: 0,
			upper: 50,
			lat: degToGarmin(49.5),
			lon: degToGarmin(2.5),
			radius: 5,
			itema: ['LFPG'],
			itemd: 'DAILY 0800-1700',
			iteme: 'CRANE ERECTED',
			itemf: 'GND',
			itemg: '500FT AGL',
			startvalidity: 1779456000,
			endvalidity: 1782048000,
		});
		// id on its own line, then Q) line with the leading Q prepended,
		// then A) / B) / C) / D) / E) / F) / G) in order.
		expect(text.split('\n')[0]).toBe('A0234/26');
		expect(text).toMatch(/^A0234\/26\nQ\) LFFF\/QOBCE\/IV\/M\/AE\/000\/050\/4930N00230E005/);
		expect(text).toContain('A) LFPG');
		expect(text).toContain('D) DAILY 0800-1700');
		expect(text).toContain('E) CRANE ERECTED');
		expect(text).toContain('F) GND');
		expect(text).toContain('G) 500FT AGL');
	});

	it('round-trips through parseNotams into a complete Notam', () => {
		const text = rowToIcaoText({
			series: 'A',
			number: 234,
			year: 2026,
			code23: 'OB',
			code45: 'CE',
			fir: 'LFFF',
			traffic: 'IV',
			purpose: 'M',
			scope: 'AE',
			lower: 0,
			upper: 50,
			lat: degToGarmin(49.5),
			lon: degToGarmin(2.5),
			radius: 5,
			itema: ['LFPG'],
			iteme: 'CRANE ERECTED NEAR THE FIELD',
			startvalidity: 1779456000,
			endvalidity: 1782048000,
		});
		const [n] = parseNotams(text);
		expect(n.id).toBe('A0234/26');
		expect(n.qCode).toBe('QOBCE');
		expect(n.qualifier?.fir).toBe('LFFF');
		expect(n.qualifier?.traffic).toBe('IV');
		expect(n.qualifier?.scope).toBe('AE');
		expect(n.qualifier?.lower).toBe(0);
		expect(n.qualifier?.upper).toBe(50);
		expect(n.qualifier?.lat).toBeCloseTo(49.5, 1);
		expect(n.qualifier?.lon).toBeCloseTo(2.5, 1);
		expect(n.qualifier?.radius).toBe(5);
		expect(n.icaoCodes).toEqual(['LFPG']);
		expect(n.startDate?.toISOString()).toBe('2026-05-22T13:20:00.000Z');
		expect(n.obstacleType).toBe('crane');
	});

	it('accepts itema and fir as arrays (the real autorouter shape)', () => {
		const text = rowToIcaoText({
			itema: ['LFPG', 'LFPB'],
			fir: ['LFFF'],
			code23: 'OB',
			code45: 'CE',
			scope: 'A',
			lat: degToGarmin(49.0),
			lon: degToGarmin(2.5),
			radius: 5,
			iteme: 'CRANE',
		});
		expect(text).toContain('A) LFPG LFPB');
		expect(text).toMatch(/Q\) LFFF\//);
	});

	it('formats a permanent NOTAM with C) PERM', () => {
		const text = rowToIcaoText({
			series: 'C',
			number: 1,
			year: 26,
			code23: 'OB',
			code45: 'CE',
			fir: 'LFFF',
			lat: degToGarmin(48),
			lon: degToGarmin(2),
			startvalidity: 1779456000,
			permanent: true,
			iteme: 'PERMANENT CLOSURE',
		});
		expect(text).toContain('C) PERM');
	});

	it('returns the empty string for a row without enough data to form a Q-line', () => {
		// No coordinates, no FIR; nothing the parser can do with this row.
		expect(rowToIcaoText({})).toBe('');
	});

	it('matches the wiki example coordinates (Stuttgart EDDS, Garmin format)', () => {
		const text = rowToIcaoText({
			itema: ['EDDS'],
			fir: 'EDGG',
			code23: 'FA',
			code45: 'LT',
			lat: 580814790,
			lon: 109959116,
			radius: 5,
			iteme: 'MIL SIDE NO TRANSIENT ALERT AVBL',
		});
		// EDDS sits at ~(48.69, 9.22); Q-line reconstruction should reflect.
		expect(text).toMatch(/Q\) EDGG\/QFALT\/.*4841N00913E005/);
	});

	it('uses the Q-line for an en-route NOTAM with no E-section coordinates (blue marker)', () => {
		// Real-world: F0710/26; Le Mans trigger NOTAM. The E section has no
		// parseable PSN, so the parser falls back to the Q-line position and
		// tags it qualifierLine (blue).
		const text = rowToIcaoText({
			series: 'F',
			number: 710,
			year: 26,
			itema: ['LFFF', 'LFRR'],
			fir: 'LFXX',
			code23: 'AT',
			code45: 'TT',
			scope: 'E',
			traffic: 'IV',
			purpose: 'BO',
			lower: 0,
			upper: 115,
			lat: degToGarmin(47.93),
			lon: degToGarmin(-0.20),
			radius: 39,
			iteme: 'TRIGGER NOTAM - AIRAC AIP SUP 072/26.',
		});
		const [n] = parseNotams(text);
		expect(n.coordinates).toHaveLength(1);
		expect(n.coordinates[0].type).toBe('qualifierLine');
	});

	it('promotes a NOTAM to a PSN marker when the E section has parseable coordinates', () => {
		// Simulates an obstacle NOTAM that includes a DMS coordinate in
		// the comment. parseNotams should pick that as the authoritative
		// position and tag the coord 'psn' (red).
		const text = rowToIcaoText({
			series: 'B',
			number: 100,
			year: 26,
			itema: ['LFPG'],
			fir: 'LFFF',
			code23: 'OB',
			code45: 'CE',
			scope: 'A',
			lat: degToGarmin(49.0),
			lon: degToGarmin(2.5),
			radius: 5,
			iteme: 'CRANE ERECTED PSN 490230N 0023045E HEIGHT 50M',
		});
		const [n] = parseNotams(text);
		expect(n.coordinates.length).toBeGreaterThanOrEqual(1);
		expect(n.coordinates[0].type).toBe('psn');
	});
});

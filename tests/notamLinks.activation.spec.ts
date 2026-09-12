import { describe, it, expect } from 'vitest';
import { parseNotams } from '$lib/notam';
import { isActivationQCode } from '$lib/notam/qcode';
import {
	extractAirspaceIds,
	isActiveDuring,
	isActiveNow,
} from '$lib/state/notamLinks.svelte';

// A trimmed activation NOTAM borrowed from
// tests/fixtures/EGPD-LFKC-20260207.txt. Quoting it inline keeps this spec
// independent of the large fixture and self-explanatory.
const ACTIVATION_NOTAM = `LFFA-R2112/25
DU: 13 09 2025 00:00 AU: 15 04 2026 23:59
A) LFFE
Q) LFFF / QRRCA / IV / BO / AW / 000/015 / 4904N00220E003
E) ZONE REGLEMENTEE LF-R262 'ENGHIEN' MODIFIEE :
- HORAIRES MODIFIES : H24
- REF AIP FRANCE ENR 5.1
F) SFC
G) 1500FT AMSL
`;

// A non-activation NOTAM (obstacle-light, QOBCE); should not be flagged as
// activation and should not yield any airspace ids even though the body
// happens to mention numbers.
const OBSTACLE_NOTAM = `LFFA-Z9999/25
DU: 01 01 2026 00:00 AU: 31 12 2026 23:59
A) LFPG
Q) LFFF / QOBCE / IV / M / A / 000/005 / 4900N00210E001
E) CRANE 45 M AGL ERECTED NEAR LFPG.
F) SFC
G) 150FT AGL
`;

describe('isActivationQCode', () => {
	it('flags the activation qCodes the parser sees in real NOTAMs', () => {
		expect(isActivationQCode('QRRCA')).toBe(true);
		expect(isActivationQCode('QRDCA')).toBe(true);
		expect(isActivationQCode('QRPCA')).toBe(true);
		expect(isActivationQCode('QRMCA')).toBe(true);
		expect(isActivationQCode('QRTCA')).toBe(true);
		expect(isActivationQCode('QRACA')).toBe(true);
		expect(isActivationQCode('QRRLW')).toBe(true);
		expect(isActivationQCode('QRDGA')).toBe(true);
	});

	it('rejects deactivation, obstacle, and malformed inputs', () => {
		expect(isActivationQCode('QRRCD')).toBe(false); // deactivated
		expect(isActivationQCode('QRRCN')).toBe(false); // cancelled
		expect(isActivationQCode('QOBCE')).toBe(false); // obstacle erected
		expect(isActivationQCode('')).toBe(false);
		expect(isActivationQCode('QRRC')).toBe(false);
		expect(isActivationQCode('XRRCA')).toBe(false);
	});
});

describe('extractAirspaceIds', () => {
	it('normalises the hyphenated NOTAM form to the airspaces.json codeId', () => {
		expect(extractAirspaceIds("ZONE REGLEMENTEE LF-R262 'ENGHIEN'"))
			.toEqual(['LFR262']);
	});

	it('handles all special-use letters and overseas prefixes', () => {
		const text = 'See LF-R45A, LF-D75, LF-P226L, NT-R102, TF-D9.';
		expect(extractAirspaceIds(text)).toEqual([
			'LFR45A', 'LFD75', 'LFP226L', 'NTR102', 'TFD9',
		]);
	});

	it('deduplicates repeated mentions, preserving first-mention order', () => {
		const text = 'LF-R45A active; see also LFR45A and LF-D75.';
		expect(extractAirspaceIds(text)).toEqual(['LFR45A', 'LFD75']);
	});

	it('returns nothing for text without special-use codes', () => {
		expect(extractAirspaceIds('CRANE 45 M AGL ERECTED NEAR LFPG.')).toEqual([]);
		expect(extractAirspaceIds('')).toEqual([]);
	});
});

describe('isActiveNow', () => {
	const start = new Date('2026-01-01T00:00:00Z');
	const end = new Date('2026-12-31T23:59:00Z');
	const window = (s: Date | null, e: Date | null, permanent = false) => ({
		startDate: s, endDate: e, permanent,
	}) as unknown as Parameters<typeof isActiveNow>[0];

	it('returns true when now is inside the window', () => {
		const now = new Date('2026-06-01T12:00:00Z').getTime();
		expect(isActiveNow(window(start, end), now)).toBe(true);
	});

	it('returns false when now is outside the window', () => {
		const before = new Date('2025-12-01T00:00:00Z').getTime();
		const after = new Date('2027-01-01T00:00:00Z').getTime();
		expect(isActiveNow(window(start, end), before)).toBe(false);
		expect(isActiveNow(window(start, end), after)).toBe(false);
	});

	it('treats permanent NOTAMs as always active', () => {
		expect(isActiveNow(window(start, null, true), Date.now())).toBe(true);
	});

	it('rejects NOTAMs without a window', () => {
		expect(isActiveNow(window(null, null), Date.now())).toBe(false);
	});
});

describe('isActiveDuring', () => {
	// A NOTAM valid 2026-06-10 .. 2026-06-20.
	const start = new Date('2026-06-10T00:00:00Z');
	const end = new Date('2026-06-20T00:00:00Z');
	const window = (s: Date | null, e: Date | null, permanent = false) => ({
		startDate: s, endDate: e, permanent,
	}) as unknown as Parameters<typeof isActiveDuring>[0];
	const ms = (s: string) => Date.parse(s);

	it('true when the validity window is fully inside the range', () => {
		expect(
			isActiveDuring(window(start, end), ms('2026-06-01T00:00:00Z'), ms('2026-06-30T00:00:00Z')),
		).toBe(true);
	});

	it('true when the range is fully inside the validity window', () => {
		expect(
			isActiveDuring(window(start, end), ms('2026-06-13T00:00:00Z'), ms('2026-06-14T00:00:00Z')),
		).toBe(true);
	});

	it('true on either partial overlap', () => {
		// range starts before, ends inside the window
		expect(
			isActiveDuring(window(start, end), ms('2026-06-05T00:00:00Z'), ms('2026-06-12T00:00:00Z')),
		).toBe(true);
		// range starts inside, ends after the window
		expect(
			isActiveDuring(window(start, end), ms('2026-06-18T00:00:00Z'), ms('2026-06-25T00:00:00Z')),
		).toBe(true);
	});

	it('false when the range is entirely before or after the window', () => {
		expect(
			isActiveDuring(window(start, end), ms('2026-06-01T00:00:00Z'), ms('2026-06-05T00:00:00Z')),
		).toBe(false);
		expect(
			isActiveDuring(window(start, end), ms('2026-06-25T00:00:00Z'), ms('2026-06-30T00:00:00Z')),
		).toBe(false);
	});

	it('treats permanent NOTAMs as always active', () => {
		expect(
			isActiveDuring(window(start, null, true), ms('2030-01-01T00:00:00Z'), ms('2030-01-02T00:00:00Z')),
		).toBe(true);
	});

	it('rejects NOTAMs without a window', () => {
		expect(
			isActiveDuring(window(null, null), ms('2026-06-13T00:00:00Z'), ms('2026-06-14T00:00:00Z')),
		).toBe(false);
	});

	it('matches isActiveNow for the degenerate instant (from === to)', () => {
		const inside = ms('2026-06-15T00:00:00Z');
		const outside = ms('2026-07-01T00:00:00Z');
		expect(isActiveDuring(window(start, end), inside, inside)).toBe(true);
		expect(isActiveDuring(window(start, end), outside, outside)).toBe(false);
	});
});

describe('parse → activation pipeline', () => {
	it('parses LFFA-R2112/25 with QRRCA and finds LFR262 in its body', () => {
		const notams = parseNotams(ACTIVATION_NOTAM);
		expect(notams).toHaveLength(1);
		const n = notams[0];
		expect(n.id).toBe('LFFA-R2112/25');
		expect(n.qCode).toBe('QRRCA');
		expect(isActivationQCode(n.qCode)).toBe(true);
		expect(extractAirspaceIds(n.fullContent)).toEqual(['LFR262']);
	});

	it('does not flag the obstacle NOTAM as activation', () => {
		const notams = parseNotams(OBSTACLE_NOTAM);
		expect(notams).toHaveLength(1);
		const n = notams[0];
		expect(n.qCode).toBe('QOBCE');
		expect(isActivationQCode(n.qCode)).toBe(false);
		expect(extractAirspaceIds(n.fullContent)).toEqual([]);
	});
});

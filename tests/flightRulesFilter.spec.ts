import { describe, it, expect, beforeEach } from 'vitest';
import { parseNotams } from '$lib/notam';
import { notamState, visibleNotams } from '$lib/state/notam.svelte';
import { filter } from '$lib/state/filter.svelte';

// Captured at import time, before any beforeEach mutates the singleton, so the
// default-mode assertion is independent of test order.
const initialTrafficMode = filter.trafficMode;

// One NOTAM per traffic class, all at the same spot so geometry never filters.
// QPICH = instrument approach (IFR-only), QPKCH = VFR approach (VFR-only),
// QOBCE = obstacle (both); the last carries no Q) line at all (unclassified).
const IFR_ONLY = `A0001/26
Q) LFFF / QPICH / I / NBO / A / 000/999 / 4500N00300E005
A) LFPG
B) 2605010000 C) 2606010000
E) IAP RWY 27 NOT AVBL.
`;
const VFR_ONLY = `A0002/26
Q) LFFF / QPKCH / V / NBO / A / 000/999 / 4500N00300E005
A) LFPG
B) 2605010000 C) 2606010000
E) VFR APCH PROC AMENDED.
`;
const BOTH = `A0003/26
Q) LFFF / QOBCE / IV / M / A / 000/005 / 4500N00300E005
A) LFPG
B) 2605010000 C) 2606010000
E) NEW CRANE PSN 450000N 0030000E.
`;
const NO_QLINE = `A0004/26
A) LFPG
B) 2605010000 C) 2606010000
E) UNSPECIFIED ACT PSN 450000N 0030000E.
`;

function load(): void {
	notamState.notams = parseNotams([IFR_ONLY, VFR_ONLY, BOTH, NO_QLINE].join('\n\n'));
	notamState.fetchBbox = null;
}

function visibleIds(): string[] {
	return visibleNotams()
		.map((v) => v.notam.id)
		.sort();
}

describe('flight-rules (traffic) filter', () => {
	beforeEach(() => {
		// Reset the shared filter singleton to a permissive baseline so only the
		// traffic dimension under test is active; each test sets trafficMode.
		filter.query = '';
		filter.kind.area = filter.kind.position = filter.kind.qualifierLine = true;
		// The fixtures are dated 2605010000 to 2606010000; a window inside that
		// validity keeps the traffic dimension the only one under test, whatever
		// the wall clock says when the suite runs.
		filter.window.mode = 'custom';
		filter.window.fromDate = '2026-05-15';
		filter.window.fromTime = '00:00';
		filter.window.toDate = '2026-05-16';
		filter.window.toTime = '00:00';
		filter.altitude.enabled = false;
		filter.trafficMode = 'all';
		load();
	});

	it('parses one NOTAM per traffic class', () => {
		// Sanity: the four classes really did parse, with the traffic we expect.
		const byId = new Map(notamState.notams.map((n) => [n.id, n]));
		expect(byId.get('A0001/26')?.qualifier?.traffic).toBe('I');
		expect(byId.get('A0002/26')?.qualifier?.traffic).toBe('V');
		expect(byId.get('A0003/26')?.qualifier?.traffic).toBe('IV');
		expect(byId.get('A0004/26')?.qualifier).toBeNull();
	});

	it('defaults to "vfr" (hides IFR-only out of the box)', () => {
		expect(initialTrafficMode).toBe('vfr');
	});

	it('"all" shows every class', () => {
		filter.trafficMode = 'all';
		expect(visibleIds()).toEqual(['A0001/26', 'A0002/26', 'A0003/26', 'A0004/26']);
	});

	it('"vfr" hides IFR-only, keeps VFR-only / both / unclassified', () => {
		filter.trafficMode = 'vfr';
		expect(visibleIds()).toEqual(['A0002/26', 'A0003/26', 'A0004/26']);
	});

	it('"ifr" hides VFR-only, keeps IFR-only / both / unclassified', () => {
		filter.trafficMode = 'ifr';
		expect(visibleIds()).toEqual(['A0001/26', 'A0003/26', 'A0004/26']);
	});

	it('never hides "IV" or unclassified NOTAMs in any mode', () => {
		for (const mode of ['all', 'vfr', 'ifr'] as const) {
			filter.trafficMode = mode;
			const ids = visibleIds();
			expect(ids).toContain('A0003/26'); // IV
			expect(ids).toContain('A0004/26'); // no Q-line
		}
	});
});

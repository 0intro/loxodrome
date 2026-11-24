/* The trace profile's zoom window across a change of trace
 * (components/profileWindow.svelte.ts fitNewTrace, called by
 * NavProfileModal on the trace's identity, its first fix). A new recording
 * or an import with the surface still docked drew the new trace inside the
 * old trace's touched windows, an empty chart on desktop, until Fit. A
 * recording that grows keeps its identity, and with it the pilot's own
 * zoom. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createProfileWindow } from '$lib/components/profileWindow.svelte';

function makeWindow(total: { nm: number; ceilFt: number }): ReturnType<typeof createProfileWindow> {
	return createProfileWindow({
		totalNM: () => total.nm,
		dataCeilingFt: () => 20_000,
		fitCeilingFt: () => total.ceilFt,
		enough: () => true,
		fmtAltBubble: (v: number) => `${v} ft`,
	});
}

const windows = (w: ReturnType<typeof createProfileWindow>): number[] => [
	w.viewFromNM,
	w.viewToNM,
	w.viewFloorFt,
	w.viewCeilingFt,
];

describe('fitNewTrace', () => {
	it('fits a new trace whatever the last one was zoomed to', () => {
		const total = { nm: 200, ceilFt: 9000 };
		const w = makeWindow(total);
		w.fitNewTrace(1000);
		w.onDistWindow(150, 180);
		w.onAltWindow(5000, 8000);
		total.nm = 40;
		total.ceilFt = 4000;
		w.fitNewTrace(2000);
		expect([w.distTouched, w.altTouched]).toEqual([false, false]);
		expect(windows(w)).toEqual([0, 40, 0, 4000]);
	});

	it('keeps the window of a trace that grows', () => {
		const total = { nm: 200, ceilFt: 9000 };
		const w = makeWindow(total);
		w.fitNewTrace(1000);
		w.onDistWindow(150, 180);
		w.onAltWindow(5000, 8000);
		total.nm = 260;
		w.fitNewTrace(1000);
		expect([w.distTouched, w.altTouched]).toEqual([true, true]);
		expect(windows(w)).toEqual([150, 180, 5000, 8000]);
	});

	it('fits a new recording made after the trace was cleared', () => {
		const total = { nm: 200, ceilFt: 9000 };
		const w = makeWindow(total);
		w.fitNewTrace(1000);
		w.onDistWindow(150, 180);
		w.fitNewTrace(null);
		total.nm = 3;
		w.fitNewTrace(3000);
		expect(w.distTouched).toBe(false);
		expect(windows(w)).toEqual([0, 3, 0, 9000]);
	});

	it('is what the trace profile calls on its trace identity', () => {
		const modal = readFileSync('src/lib/components/NavProfileModal.svelte', 'utf8');
		expect(modal).toContain('const traceIdentity = $derived(nav.points[0]?.timeMs ?? null);');
		expect(modal).toContain('win.fitNewTrace(id);');
	});
});

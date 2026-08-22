/* THE evaluation window (state/notam.svelte activeEvalWindow), the period
 * every dated surface is judged against: the NOTAM list and map layer, SUP AIP
 * zones, SIGMETs, the airspace activation hatch, the navaid / obstacle cue
 * rings and the profile overlays. Three sources in precedence order, a valid
 * custom range, the planned flight's span, else now plus the look-ahead, and
 * the safety rule that binds them: whatever falls through lands on the default,
 * never on a window that would hide everything. */

import { describe, it, expect, afterEach } from 'vitest';
import { activeEvalWindow } from '$lib/state/notam.svelte';
import { filter, setWindowMode, DEFAULT_HORIZON_H } from '$lib/state/filter.svelte';

const HOUR_MS = 3600_000;

function reset(): void {
	filter.window.mode = 'now';
	filter.window.horizonH = DEFAULT_HORIZON_H;
	filter.window.fromDate = '';
	filter.window.fromTime = '';
	filter.window.toDate = '';
	filter.window.toTime = '';
}

afterEach(reset);

describe('activeEvalWindow', () => {
	it('defaults to now onwards, unbounded ahead', () => {
		reset();
		const before = Date.now();
		const w = activeEvalWindow();
		const after = Date.now();
		// from is "now" floored to the minute, so every caller in one render
		// pass reads the same instant. Never ahead of now (that would hide
		// something early) and never more than a minute behind it.
		expect(w.from).toBeLessThanOrEqual(after);
		expect(w.from).toBeGreaterThan(before - 60_000);
		expect(w.from % 60_000).toBe(0);
		// Unbounded by default: an activation scheduled for later, however much
		// later, is shown rather than withheld. Narrowing is the pilot's call.
		expect(DEFAULT_HORIZON_H).toBeNull();
		expect(w.to).toBe(Infinity);
	});

	it('hands every caller in one pass the same instant', () => {
		reset();
		// The memo contract downstream: a `from` that moved between selectors
		// would miss on every call.
		expect(activeEvalWindow().from).toBe(activeEvalWindow().from);
	});

	it('narrows to the look-ahead once one is chosen', () => {
		reset();
		filter.window.horizonH = 24;
		const w = activeEvalWindow();
		expect(w.to).toBe(w.from + 24 * HOUR_MS);
	});

	it('returns the typed range verbatim in custom mode', () => {
		setWindowMode('custom');
		filter.window.fromDate = '2026-06-09';
		filter.window.fromTime = '00:00';
		filter.window.toDate = '2026-06-10';
		filter.window.toTime = '00:00';
		expect(activeEvalWindow()).toEqual({
			from: Date.parse('2026-06-09T00:00:00Z'),
			to: Date.parse('2026-06-10T00:00:00Z'),
		});
	});

	it('falls back to the default for an invalid (from > to) range', () => {
		setWindowMode('custom');
		filter.window.fromDate = '2026-06-10';
		filter.window.fromTime = '00:00';
		filter.window.toDate = '2026-06-09';
		filter.window.toTime = '00:00';
		expect(activeEvalWindow().to).toBe(Infinity);
	});

	it('pre-fills the custom fields on arrival so they are never blank', () => {
		setWindowMode('custom');
		expect(filter.window.fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(filter.window.toDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(activeEvalWindow().to).toBeGreaterThan(activeEvalWindow().from);
	});

	it('falls back to the default in flight mode with no route planned', () => {
		// The safety rule: an underivable flight window must never resolve to
		// an empty or point window, which would hide every dated surface.
		setWindowMode('flight');
		const w = activeEvalWindow();
		expect(w.to).toBe(Infinity);
		expect(w.to).toBeGreaterThan(w.from);
	});
});

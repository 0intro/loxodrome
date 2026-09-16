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
import { flightPrep } from '$lib/state/flightPrep.svelte';
import { routes, type Route, type Waypoint } from '$lib/state/route.svelte';

const HOUR_MS = 3600_000;

function reset(): void {
	filter.window.mode = 'now';
	filter.window.horizonH = DEFAULT_HORIZON_H;
	filter.window.fromDate = '';
	filter.window.fromTime = '';
	filter.window.toDate = '';
	filter.window.toTime = '';
	routes.list = [];
	flightPrep.dossier.flightDate = null;
	flightPrep.dossier.departureTime = null;
}

/** The least a route needs to be a trip the flight window can derive from:
 *  two waypoints carrying real positions. */
function flyableRoute(): Route {
	const wp = (id: string, lat: number, lon: number): Waypoint => ({
		id,
		lat,
		lon,
		kind: 'free',
		alt: 3000,
		altAuto: true,
	});
	return {
		id: 'route-1',
		name: null,
		waypoints: [wp('a', 48.82, 2.62), wp('b', 47.97, 2.68)],
		selectedWaypointId: null,
	};
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

	// The reported case (2026-09-06): a flight dated but never timed. The
	// window used to be built around an INVENTED ETD, the next whole hour, so
	// it opened an hour back, in a past no briefing service will cover, and it
	// named today outright for a flight dated later. A pilot who gave the date
	// and not the hour has said the flight is somewhere in that day.
	it('gives a flight with no departure time its whole day', () => {
		reset();
		routes.list = [flyableRoute()];
		flightPrep.dossier.flightDate = '2026-09-20';
		setWindowMode('flight');
		const w = activeEvalWindow();
		expect(new Date(w.from).toISOString()).toBe('2026-09-20T00:00:00.000Z');
		expect(new Date(w.to).toISOString()).toBe('2026-09-21T00:00:00.000Z');
	});

	it('keeps the ramp hour before a departure time the pilot did state', () => {
		reset();
		routes.list = [flyableRoute()];
		flightPrep.dossier.flightDate = '2026-09-20';
		flightPrep.dossier.departureTime = '09:30';
		setWindowMode('flight');
		const w = activeEvalWindow();
		// The tail rides the nav log, so only the start is pinned here.
		expect(new Date(w.from).toISOString()).toBe('2026-09-20T08:30:00.000Z');
		expect(w.to).toBeGreaterThan(w.from);
	});
});

/* The pilot's leg pins as the live state holds them (state/navRoute): one
 * correction per press, scoped to the route AND to the trace it was made on.
 * A pin is an INSTANT, so an instant from another flight would re-anchor the
 * new one from its very first fix; the trace's own first stamp is what tells
 * the two apart. Contract: docs/nav-live.md. */

import { describe, it, expect, beforeEach } from 'vitest';
import { nav } from '$lib/state/navRecording.svelte';
import {
	legPinsFor,
	navRoute,
	setNavLegPin,
	undoNavLegPin,
} from '$lib/state/navRoute.svelte';
import type { TrackPoint } from '$lib/nav/trace';

function trace(startMs: number, n = 3): TrackPoint[] {
	return Array.from({ length: n }, (_, i) => ({
		lat: 0,
		lon: i / 100,
		altFt: null,
		timeMs: startMs + i * 60_000,
	}));
}

/** Load a trace and park the playhead on its last fix, the recording case. */
function load(startMs: number, n = 3): void {
	nav.points = trace(startMs, n);
	nav.playheadMs = nav.points[nav.points.length - 1].timeMs;
}

beforeEach(() => {
	navRoute.legs = null;
	nav.points = [];
	nav.playheadMs = 0;
});

describe('leg pins', () => {
	it('records one correction at the displayed instant, per route', () => {
		load(1_000_000);
		setNavLegPin('r1', 2);
		expect(legPinsFor('r1')).toEqual([{ legIdx: 2, sinceMs: 1_120_000 }]);
		expect(legPinsFor('r2')).toEqual([]);
	});

	it('keeps every correction, the last press at one instant replacing it', () => {
		load(0);
		setNavLegPin('r1', 2);
		nav.playheadMs += 60_000;
		setNavLegPin('r1', 0);
		setNavLegPin('r1', 1); // same instant: one correction, the later one
		expect(legPinsFor('r1')).toEqual([
			{ legIdx: 2, sinceMs: 120_000 },
			{ legIdx: 1, sinceMs: 180_000 },
		]);
	});

	it('undoes the most recent only, since each earlier one is a fact of the flight', () => {
		load(0);
		setNavLegPin('r1', 2);
		nav.playheadMs += 60_000;
		setNavLegPin('r1', 1);
		undoNavLegPin('r1');
		expect(legPinsFor('r1')).toEqual([{ legIdx: 2, sinceMs: 120_000 }]);
		undoNavLegPin('r1');
		expect(legPinsFor('r1')).toEqual([]);
		undoNavLegPin('r1'); // nothing left to undo
		expect(legPinsFor('r1')).toEqual([]);
	});

	it('goes stale with the trace it was made on', () => {
		load(1_000_000);
		setNavLegPin('r1', 2);
		expect(legPinsFor('r1')).toHaveLength(1);
		// A cleared trace, and then another flight: an instant from the first
		// would floor the second from its very first fix.
		nav.points = [];
		expect(legPinsFor('r1')).toEqual([]);
		load(9_000_000);
		expect(legPinsFor('r1')).toEqual([]);
		// The same trace still carries it (a stop and continue is one outing).
		load(1_000_000, 5);
		expect(legPinsFor('r1')).toEqual([{ legIdx: 2, sinceMs: 1_120_000 }]);
	});

	it('has nothing to correct without a trace', () => {
		setNavLegPin('r1', 1);
		expect(navRoute.legs).toBeNull();
		expect(legPinsFor('r1')).toEqual([]);
	});
});

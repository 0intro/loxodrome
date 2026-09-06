/* The flights surface's requested-view semantics (state/flightsModal.svelte):
 * the toggleFlightPrep contract, pinned because three kinds of entry point
 * ride it and each depends on a different clause. The launchers toggle, so a
 * same-view (or view-less) press puts the surface away; the route-actions
 * menu deep-links to Plans, so a DIFFERENT view switches instead of
 * dismissing; and the file importer's no-arg open must land wherever the
 * user last was, since the component is mounted for the whole session and
 * its view has always survived close/reopen. A refused eviction must leave
 * the view exactly as it was: a request that never happened must not leave
 * its parameter behind. */

import { afterEach, describe, expect, it } from 'vitest';
import { SURFACE_IDS } from '$lib/surfaces';
import {
	closeSurface,
	isOpen,
	openSurface,
	registerSurfaceClose,
	setStageSize,
} from '$lib/state/workspace.svelte';
import {
	closeFlights,
	flightsModal,
	openFlights,
	toggleFlights,
} from '$lib/state/flightsModal.svelte';

function reset(): void {
	for (const id of SURFACE_IDS) {
		closeSurface(id);
	}
	flightsModal.view = 'flights';
	try {
		localStorage.clear();
	} catch {
		/* no storage under the node environment; readItem degrades to null */
	}
}

afterEach(reset);

describe('the flights surface view requests', () => {
	it('opens on the requested view', () => {
		setStageSize(1200, 800);
		openFlights('plans');
		expect(isOpen('flights')).toBe(true);
		expect(flightsModal.view).toBe('plans');
	});

	it('a no-arg open leaves the view where it was', () => {
		setStageSize(1200, 800);
		openFlights('plans');
		closeFlights();
		openFlights();
		expect(isOpen('flights')).toBe(true);
		expect(flightsModal.view).toBe('plans');
	});

	it('a different view switches the open surface instead of dismissing it', () => {
		setStageSize(1200, 800);
		openFlights();
		expect(flightsModal.view).toBe('flights');
		toggleFlights('plans');
		expect(isOpen('flights')).toBe(true);
		expect(flightsModal.view).toBe('plans');
	});

	it('a matching (or view-less) toggle puts the surface away', () => {
		setStageSize(1200, 800);
		openFlights('plans');
		toggleFlights('plans');
		expect(isOpen('flights')).toBe(false);

		openFlights('plans');
		toggleFlights();
		expect(isOpen('flights')).toBe(false);
	});

	it('a refused eviction leaves the view untouched', () => {
		setStageSize(1200, 800);
		// Both surfaces are pages, so flights must evict the editor to open;
		// a closer that declines (the unsaved-edits confirm's shape) keeps it.
		openSurface('aircraftEditor');
		const unregister = registerSurfaceClose('aircraftEditor', () => {});
		try {
			openFlights('plans');
			expect(isOpen('flights')).toBe(false);
			expect(flightsModal.view).toBe('flights');
		} finally {
			unregister();
		}
	});
});

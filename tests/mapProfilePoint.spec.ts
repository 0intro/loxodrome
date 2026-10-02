/* The map altitude profile's point (state/mapProfileModal.svelte).
 *
 * The invariant worth a spec: the point reads null exactly while the surface is
 * closed, because that is what takes the draggable marker off the map. Several
 * close paths never run closeMapProfile at all (an eviction landing before
 * SurfaceShell registered its handler, and reflowSurfaces closing a surface
 * itself on a viewport flip), so the clear is a gate on the getter rather than
 * something each closer remembers. That is also what makes it testable here: the
 * repo runs pure Vitest, with no component effects.
 *
 * The second one: the drag's writer must not go through openSurface, which
 * re-runs the eviction protocol and re-derives the dock size on every event. */

import { afterEach, describe, expect, it } from 'vitest';
import { SURFACE_IDS } from '$lib/surfaces';
import {
	mapProfileModal,
	openMapProfile,
	closeMapProfile,
	setMapProfilePoint,
} from '$lib/state/mapProfileModal.svelte';
import { ui } from '$lib/state/ui.svelte';
import {
	closeSurface,
	commitDockPx,
	isOpen,
	openSurface,
	placementOf,
	reflowSurfaces,
	setPlacement,
	setStageSize,
	workspace,
} from '$lib/state/workspace.svelte';

afterEach(() => {
	for (const id of SURFACE_IDS) {
		closeSurface(id);
	}
	ui.isMobile = false;
});

describe('the map profile point', () => {
	it('opens at the point it was given', () => {
		setStageSize(1200, 800);
		openMapProfile(48.7, 2.4);
		expect(mapProfileModal.open).toBe(true);
		expect(mapProfileModal.point).toEqual({ lat: 48.7, lng: 2.4 });
	});

	it('reads null once the surface is closed', () => {
		setStageSize(1200, 800);
		openMapProfile(48.7, 2.4);
		closeMapProfile();
		expect(mapProfileModal.point).toBeNull();
	});

	it('reads null when another dock-bottom surface evicts it', () => {
		// The eviction path: place() asks the incumbent to close, which falls back
		// to a plain closeSurface when no shell has registered a handler.
		setStageSize(1200, 800);
		openMapProfile(48.7, 2.4);
		openSurface('navProfile');
		expect(isOpen('mapProfile')).toBe(false);
		expect(mapProfileModal.point).toBeNull();
	});

	it('reads null when a viewport flip closes it', () => {
		// reflowSurfaces never evicts: a surface whose target slot is taken closes
		// ITSELF, through closeSurface, so no closer of ours runs.
		setStageSize(1200, 800);
		openMapProfile(48.7, 2.4);
		setPlacement('mapProfile', 'dock-right');
		// routeProfile, which defaults to the bottom, so the two do not compete
		// for a slot before the flip.
		openSurface('routeProfile');
		// Both up, in different slots: so the close below is the reflow's, not an
		// eviction that already happened.
		expect(isOpen('mapProfile')).toBe(true);
		expect(workspace.dockRight).toBe('mapProfile');
		expect(workspace.dockBottom).toBe('routeProfile');

		// A phone has one dock, so mapProfile's dock-right collapses onto the
		// bottom, which routeProfile holds.
		ui.isMobile = true;
		reflowSurfaces();
		expect(isOpen('mapProfile')).toBe(false);
		expect(mapProfileModal.point).toBeNull();
	});

	it('keeps the point through a placement change', () => {
		setStageSize(1200, 800);
		openMapProfile(48.7, 2.4);
		for (const placement of ['dock-right', 'page', 'full', 'dock-bottom'] as const) {
			setPlacement('mapProfile', placement);
			expect(mapProfileModal.point).toEqual({ lat: 48.7, lng: 2.4 });
		}
	});

	it('moves the point while open', () => {
		setStageSize(1200, 800);
		openMapProfile(48.7, 2.4);
		setMapProfilePoint(48.8, 2.5);
		expect(mapProfileModal.point).toEqual({ lat: 48.8, lng: 2.5 });
	});

	it('ignores a point written while closed', () => {
		// A late dragend after the surface went must not leave a phantom point for
		// the next open to render, which writes its own point first.
		setStageSize(1200, 800);
		setMapProfilePoint(10, 10);
		expect(mapProfileModal.point).toBeNull();
		openMapProfile(48.7, 2.4);
		expect(mapProfileModal.point).toEqual({ lat: 48.7, lng: 2.4 });
	});

	it('leaves the slot, the placement and the dock size alone when it moves', () => {
		setStageSize(1200, 800);
		openMapProfile(48.7, 2.4);
		// A size no default would produce (0.4 of an 800px stage is 320), so the
		// assertion fails if the write goes through openSurface and re-derives it.
		commitDockPx('bottom', 500);

		setMapProfilePoint(48.8, 2.5);
		expect(workspace.dockPx.bottom).toBe(500);
		expect(workspace.dockBottom).toBe('mapProfile');
		expect(placementOf('mapProfile')).toBe('dock-bottom');
	});
});

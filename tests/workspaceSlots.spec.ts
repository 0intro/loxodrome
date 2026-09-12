/* The workspace slot invariants (state/workspace.svelte), exercised against
 * the real state machine rather than the pure rules in surfaces.ts.
 *
 * The one that matters most: `open` and `placement` must agree. They are two
 * fields on purpose - an effect that only cares whether a surface is up must
 * not also wake when it is docked, paged or maximised - and keeping them in
 * step is what makes that safe. Drift there silently wiped the aircraft
 * editor's unsaved draft on every placement change. */

import { afterEach, describe, expect, it } from 'vitest';
import { SURFACE_IDS, type SurfaceId } from '$lib/surfaces';
import {
	closeSurface,
	isOpen,
	openSurface,
	placementOf,
	setPlacement,
	setStageSize,
	workspace,
} from '$lib/state/workspace.svelte';

/** Every invariant the slots must hold, checked after each mutation. */
function expectConsistent(): void {
	for (const id of SURFACE_IDS) {
		expect(isOpen(id)).toBe(placementOf(id) !== null);
	}
	const slots = [
		['dockBottom', workspace.dockBottom],
		['dockRight', workspace.dockRight],
		['overlay', workspace.overlay],
	] as const;
	const held = slots.flatMap(([, id]) => (id === null ? [] : [id]));
	// No surface in two slots, and every slot occupant is open.
	expect(new Set(held).size).toBe(held.length);
	for (const id of held) {
		expect(isOpen(id)).toBe(true);
	}
	// Every open surface holds exactly one slot.
	for (const id of SURFACE_IDS) {
		expect(held.includes(id)).toBe(isOpen(id));
	}
	// A dock size only exists while its slot does.
	expect(workspace.dockPx.bottom > 0).toBe(workspace.dockBottom !== null);
	expect(workspace.dockPx.right > 0).toBe(workspace.dockRight !== null);
}

function reset(): void {
	for (const id of SURFACE_IDS) {
		closeSurface(id);
	}
	try {
		localStorage.clear();
	} catch {
		/* no storage under the node environment; readItem degrades to null */
	}
}

afterEach(reset);

describe('slot invariants', () => {
	it('holds through open, move, evict and close', () => {
		setStageSize(1200, 800);
		expectConsistent();

		openSurface('routeProfile');
		expect(placementOf('routeProfile')).toBe('dock-bottom');
		expectConsistent();

		// Same slot: the incumbent must be evicted, not doubled up. Both
		// profiles default to the bottom, where the nav log defaults right.
		openSurface('navProfile');
		expect(isOpen('routeProfile')).toBe(false);
		expect(workspace.dockBottom).toBe('navProfile');
		expectConsistent();

		// A move vacates the old slot before claiming the new one.
		setPlacement('navProfile', 'dock-right');
		expect(workspace.dockBottom).toBeNull();
		expect(workspace.dockRight).toBe('navProfile');
		expectConsistent();

		// Three slots, three surfaces, no interference. The overlay is About
		// (a dialog) rather than a page, since a page takes the whole stage
		// and so evicts the docks; that rule has its own case.
		openSurface('routeProfile');
		openSurface('about');
		expect(workspace.dockRight).toBe('navProfile');
		expect(workspace.dockBottom).toBe('routeProfile');
		expect(workspace.overlay).toBe('about');
		expectConsistent();

		closeSurface('navProfile');
		expectConsistent();
		closeSurface('routeProfile');
		closeSurface('about');
		expectConsistent();
	});

	it('leaves open-ness alone when only the placement changes', () => {
		// The whole point of the second field: docking, paging and maximising
		// must not look like a close-and-reopen to anything watching isOpen.
		setStageSize(1200, 800);
		openSurface('routeProfile');
		for (const placement of ['dock-right', 'page', 'full', 'dock-bottom'] as const) {
			setPlacement('routeProfile', placement);
			expect(isOpen('routeProfile')).toBe(true);
			expect(placementOf('routeProfile')).toBe(placement);
			expectConsistent();
		}
	});

	it('re-opening an already-open surface is not a close', () => {
		setStageSize(1200, 800);
		openSurface('flightPrep');
		const before = placementOf('flightPrep');
		openSurface('flightPrep');
		expect(isOpen('flightPrep')).toBe(true);
		expect(placementOf('flightPrep')).toBe(before);
		expectConsistent();
	});

	it('closes cleanly from every placement', () => {
		setStageSize(1200, 800);
		for (const placement of ['dock-bottom', 'dock-right', 'page', 'full'] as const) {
			openSurface('routeProfile');
			setPlacement('routeProfile', placement);
			closeSurface('routeProfile');
			expect(isOpen('routeProfile')).toBe(false);
			expect(placementOf('routeProfile')).toBeNull();
			expectConsistent();
		}
	});

	it('gives a page the whole stage, evicting every dock', () => {
		// A page takes the stage, so a dock cannot be open beside one: a dock
		// exists to split with the MAP, and a page is what replaces the map.
		// Sharing also shrank the page to the leftover box, which is how a
		// maximised profile ended up at 258px, under the 420px floor every
		// dock is clamped to.
		setStageSize(1200, 800);

		openSurface('navlog');
		setPlacement('navlog', 'dock-right');
		openSurface('routeProfile');
		expect(placementOf('routeProfile')).toBe('dock-bottom');
		expectConsistent();

		setPlacement('routeProfile', 'page');
		expect(isOpen('navlog')).toBe(false);
		expect(workspace.dockRight).toBeNull();
		expectConsistent();

		// The other direction is the same conflict: a dock displaces a page.
		openSurface('navlog');
		setPlacement('navlog', 'dock-right');
		expect(isOpen('routeProfile')).toBe(false);
		expectConsistent();
	});

	it('clears both docks at once for a page', () => {
		setStageSize(1200, 800);
		// navlog to the right FIRST: it defaults to the bottom, so opening it
		// second would evict navProfile before the page ever ran.
		openSurface('navlog');
		setPlacement('navlog', 'dock-right');
		openSurface('navProfile');
		expect(workspace.dockBottom).toBe('navProfile');
		expect(workspace.dockRight).toBe('navlog');
		expectConsistent();

		openSurface('flightPrep');
		expect(placementOf('flightPrep')).toBe('page');
		expect(workspace.dockBottom).toBeNull();
		expect(workspace.dockRight).toBeNull();
		expectConsistent();
	});

	it('leaves the docks alone for full screen', () => {
		// Full screen covers the stage rather than competing for it, so
		// dismissing it brings the layout back.
		setStageSize(1200, 800);
		openSurface('flightPrep');
		setPlacement('flightPrep', 'full');
		openSurface('routeProfile');
		expect(workspace.dockBottom).toBe('routeProfile');
		expect(isOpen('flightPrep')).toBe(true);
		expectConsistent();
	});

	it('survives closing a surface that was never opened', () => {
		const ids: SurfaceId[] = ['about', 'navProfile', 'aircraftEditor'];
		for (const id of ids) {
			closeSurface(id);
			expect(isOpen(id)).toBe(false);
		}
		expectConsistent();
	});
});

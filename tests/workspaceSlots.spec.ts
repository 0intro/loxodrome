/* The workspace slot invariants (state/workspace.svelte), exercised against
 * the real state machine rather than the pure rules in surfaces.ts.
 *
 * The one that matters most: `open` and `placement` must agree. They are two
 * fields on purpose - an effect that only cares whether a surface is up must
 * not also wake when it is docked, paged or maximised - and keeping them in
 * step is what makes that safe. Drift there silently wiped the aircraft
 * editor's unsaved draft on every placement change. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SURFACE_IDS, type SurfaceId } from '$lib/surfaces';
import {
	closeSurface,
	frontmostSurface,
	isOpen,
	movePlacement,
	openSurface,
	placementOf,
	reflowSurfaces,
	registerSurfaceClose,
	releaseOrphanedSurface,
	setPaneCapHook,
	setPlacement,
	setStageSize,
	surfaceKeepsMapVisible,
	surfaceSurvivesDetail,
	workspace,
} from '$lib/state/workspace.svelte';
import { ui } from '$lib/state/ui.svelte';

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

describe('a shell that goes', () => {
	it('releases its surface, unless a new shell has registered for it', () => {
		ui.isMobile = false;
		setStageSize(1400, 900);
		openSurface('navlog');
		const unregister = registerSurfaceClose('navlog', () => closeSurface('navlog'));
		// A remount: the new shell's closer is in before the old one's
		// release runs, and the surface stays.
		releaseOrphanedSurface('navlog');
		expect(isOpen('navlog')).toBe(true);
		// The shell is gone for good: its closer went with its teardown.
		unregister();
		releaseOrphanedSurface('navlog');
		expect(isOpen('navlog')).toBe(false);
		expect(workspace.dockPx.right + workspace.dockPx.bottom).toBe(0);
		expectConsistent();
	});
});

describe('the phone pane', () => {
	const uiState = ui as { isMobile: boolean; isLandscapePhone: boolean; detail: unknown };

	afterEach(() => {
		uiState.isMobile = false;
		uiState.isLandscapePhone = false;
		uiState.detail = null;
		setPaneCapHook(() => false);
	});

	it('opens a map-coupled surface at the half detent on a phone, whatever was stored', () => {
		uiState.isMobile = true;
		setStageSize(392, 640);
		try {
			localStorage.setItem('loxodrome:surface:routeProfile:placement', 'page');
		} catch {
			/* no storage under node */
		}
		openSurface('routeProfile');
		expect(placementOf('routeProfile')).toBe('dock-bottom');
		expect(workspace.dockPx.bottom).toBe(Math.round(640 * 0.45));
		expectConsistent();
	});

	it('cycles to the page detent and back without remembering either', () => {
		uiState.isMobile = true;
		setStageSize(392, 640);
		openSurface('navlog');
		expect(movePlacement('navlog', 'page')).toBe(true);
		expect(placementOf('navlog')).toBe('page');
		expect(movePlacement('navlog', 'dock-bottom')).toBe(true);
		expect(workspace.dockPx.bottom).toBe(Math.round(640 * 0.45));
		closeSurface('navlog');
		openSurface('navlog');
		expect(placementOf('navlog')).toBe('dock-bottom');
		expectConsistent();
	});

	it('opens the pane at half while capped (a recording runs)', () => {
		uiState.isMobile = true;
		setStageSize(392, 640);
		setPaneCapHook(() => true);
		openSurface('routeProfile');
		expect(placementOf('routeProfile')).toBe('dock-bottom');
		// A second surface opening in flight is capped too: nothing takes
		// the map on its own while the pilot is flying.
		openSurface('navlog');
		expect(placementOf('navlog')).toBe('dock-bottom');
		expectConsistent();
	});

	it('obeys the pilot own move in flight: a drag or tap to full is not capped', () => {
		uiState.isMobile = true;
		setStageSize(392, 640);
		setPaneCapHook(() => true);
		openSurface('routeProfile');
		expect(placementOf('routeProfile')).toBe('dock-bottom');
		expect(movePlacement('routeProfile', 'page')).toBe(true);
		expect(placementOf('routeProfile')).toBe('page');
		// And back down the same way.
		expect(movePlacement('routeProfile', 'dock-bottom')).toBe(true);
		expect(placementOf('routeProfile')).toBe('dock-bottom');
		expectConsistent();
	});

	it('keeps that choice across a reflow, so a rotation does not undo it', () => {
		uiState.isMobile = true;
		setStageSize(392, 640);
		setPaneCapHook(() => true);
		openSurface('routeProfile');
		expect(movePlacement('routeProfile', 'page')).toBe(true);
		reflowSurfaces();
		expect(placementOf('routeProfile')).toBe('page');
		expectConsistent();
	});

	it('docks the pane on the right in landscape, at the narrow width', () => {
		uiState.isMobile = true;
		uiState.isLandscapePhone = true;
		setStageSize(730, 340);
		openSurface('navlog');
		expect(placementOf('navlog')).toBe('dock-right');
		expect(workspace.dockPx.right).toBe(Math.round(730 * 0.4));
		expectConsistent();
	});

	it('pages the detail without closing the selection it is showing', () => {
		uiState.isMobile = true;
		uiState.detail = { kind: 'airport', id: 'LFPL' };
		setStageSize(392, 640);
		openSurface('detail');
		expect(movePlacement('detail', 'page')).toBe(true);
		expect(uiState.detail).not.toBeNull();
		// Another surface paging DOES put the detail away, through its slot.
		expect(frontmostSurface()).toBeNull();
		expectConsistent();
	});

	it('never offers the detail as the surface a bare print takes', () => {
		uiState.isMobile = true;
		setStageSize(392, 640);
		openSurface('detail');
		expect(frontmostSurface()).toBeNull();
		openSurface('navlog');
		expect(frontmostSurface()).toBe('navlog');
		expectConsistent();
	});

	it('does not let a docked profile think it survives the detail', () => {
		/* On desktop the detail is an overlay panel that insets for the docks,
		 * so a docked profile keeps the map and stays: no breadcrumb needed.
		 * On a phone the detail is the pane's THIRD OCCUPANT and takes that
		 * very dock, so the profile is evicted whatever its placement says.
		 * Reading keepsMapVisible alone there left the pilot in a detail with
		 * no way back to the chart they had followed a link out of. */
		setStageSize(1500, 900);
		openSurface('routeProfile');
		expect(placementOf('routeProfile')).toBe('dock-bottom');
		expect(surfaceSurvivesDetail('routeProfile')).toBe(true);

		uiState.isMobile = true;
		setStageSize(392, 640);
		openSurface('routeProfile');
		expect(placementOf('routeProfile')).toBe('dock-bottom');
		expect(surfaceKeepsMapVisible('routeProfile')).toBe(true);
		expect(surfaceSurvivesDetail('routeProfile')).toBe(false);
		// And it is indeed the detail that takes the slot.
		openSurface('detail');
		expect(isOpen('routeProfile')).toBe(false);
		expectConsistent();
	});

	it('is what both profiles ask before skipping the breadcrumb', () => {
		// The rule is only worth anything where it is read: each modal's
		// leaveForDetail returns early on it, and neither may go back to the
		// placement test that cannot see the phone's shared slot.
		for (const f of [
			'src/lib/components/RouteProfileModal.svelte',
			'src/lib/components/NavProfileModal.svelte',
		]) {
			const src = readFileSync(join(process.cwd(), f), 'utf8');
			const fn = src.slice(src.indexOf('function leaveForDetail('));
			const body = fn.slice(0, fn.indexOf('\n\t}'));
			expect(body).toContain('surfaceSurvivesDetail(');
			expect(body).not.toContain('surfaceKeepsMapVisible(');
			// The breadcrumb the panel's back arrow reads. Each modal supplies
			// its own label and its own reopen, so the panel needs to know
			// nothing about profiles (state/ui.svelte.ts DetailReturn).
			expect(body).toContain('markDetailReturn(');
		}
	});
});

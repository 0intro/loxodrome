/* Pins the workspace placement rules in $lib/surfaces.ts: which placement a
 * surface opens in, how a stored choice and a phone viewport change that,
 * which slot each placement claims, and the dock-size clamp. The reactive
 * slots (state/workspace.svelte.ts) build on exactly these. */
import { describe, expect, it } from 'vitest';
import {
	type Placement,
	SURFACE_IDS,
	clampDockPx,
	defaultPlacement,
	dockCeilingPx,
	dockEdgeOf,
	dockRelease,
	isModalPlacement,
	keepsMapVisible,
	minDockPx,
	mobilePlacement,
	pageRelease,
	resolvePlacement,
	slotFor,
	surfaceDef,
} from '$lib/surfaces';

describe('defaultPlacement', () => {
	it('docks the map-coupled surfaces on the edge their shape wants', () => {
		// The profiles read across a wide, short chart; the nav log reads down
		// a table that grows a row per leg.
		for (const id of ['routeProfile', 'navProfile', 'mapProfile', 'airspaceProfile'] as const) {
			const def = surfaceDef(id);
			expect(def.mapCoupled).toBe(true);
			expect(defaultPlacement(def)).toBe('dock-bottom');
		}
		const navlog = surfaceDef('navlog');
		expect(navlog.mapCoupled).toBe(true);
		expect(defaultPlacement(navlog)).toBe('dock-right');
	});

	it('opens the workbooks as a page, never full screen', () => {
		for (const id of ['flightPrep', 'aircraftEditor'] as const) {
			expect(defaultPlacement(surfaceDef(id))).toBe('page');
		}
	});

	it('leaves About a dialog', () => {
		expect(defaultPlacement(surfaceDef('about'))).toBe('dialog');
	});

	it('never defaults any surface to full screen', () => {
		for (const id of SURFACE_IDS) {
			expect(defaultPlacement(surfaceDef(id))).not.toBe('full');
		}
	});

	it('offers only placements a surface allows', () => {
		for (const id of SURFACE_IDS) {
			const def = surfaceDef(id);
			expect(def.placements).toContain(defaultPlacement(def));
		}
	});

	it('opens a dock at 40% of the stage, and the workbooks at half', () => {
		for (const id of ['routeProfile', 'navProfile', 'mapProfile', 'airspaceProfile', 'navlog'] as const) {
			expect(surfaceDef(id).defaultDockFrac).toBe(0.4);
		}
		for (const id of ['flightPrep', 'aircraftEditor'] as const) {
			expect(surfaceDef(id).defaultDockFrac).toBe(0.5);
		}
	});

	it('leaves the opening share intact at every usable stage height', () => {
		// The content floor must not quietly inflate the 40% share: on any
		// stage tall enough to matter, 40% is what a dock opens at.
		for (const stage of [600, 700, 800, 900, 1000, 1200]) {
			const def = surfaceDef('routeProfile');
			const opening = Math.round(stage * def.defaultDockFrac);
			expect(clampDockPx(def, 'bottom', stage, opening)).toBe(opening);
		}
	});
});

describe('resolvePlacement', () => {
	const route = surfaceDef('routeProfile');

	it('honours a stored choice', () => {
		expect(resolvePlacement(route, 'full', false)).toBe('full');
		expect(resolvePlacement(route, 'dock-right', false)).toBe('dock-right');
	});

	it('falls back to the default for an absent or stale stored value', () => {
		expect(resolvePlacement(route, null, false)).toBe('dock-bottom');
		expect(resolvePlacement(route, 'dialog', false)).toBe('dock-bottom');
		expect(resolvePlacement(route, 'nonsense', false)).toBe('dock-bottom');
	});

	it('collapses for phones: no side dock, no page, no dialog', () => {
		expect(resolvePlacement(route, 'dock-right', true)).toBe('dock-bottom');
		expect(resolvePlacement(surfaceDef('flightPrep'), 'page', true)).toBe('full');
		expect(resolvePlacement(surfaceDef('about'), 'dialog', true)).toBe('full');
	});

	it('keeps a bottom dock and full screen as they are on phones', () => {
		expect(resolvePlacement(route, 'dock-bottom', true)).toBe('dock-bottom');
		expect(resolvePlacement(route, 'full', true)).toBe('full');
	});

	it('resolves a collapse the surface does not allow to its own default', () => {
		// flightPrep may dock right but not bottom, so the phone collapse of
		// dock-right cannot land there; it takes the collapsed default instead.
		const prep = surfaceDef('flightPrep');
		expect(prep.placements).not.toContain('dock-bottom');
		expect(resolvePlacement(prep, 'dock-right', true)).toBe('full');
	});

	it('sends a side dock to the bottom on a stage that cannot seat it', () => {
		// The nav log defaults right, but its 812px floor plus a map worth the
		// name does not fit a narrow stage: at 818 (a 1280px window) the dock
		// would take everything and still clip its own grid, and even at 1038
		// (1500px) the strip left is under the 350px minimum.
		const navlog = surfaceDef('navlog');
		expect(resolvePlacement(navlog, null, false, 818)).toBe('dock-bottom');
		expect(resolvePlacement(navlog, 'dock-right', false, 818)).toBe('dock-bottom');
		expect(resolvePlacement(navlog, null, false, 1038)).toBe('dock-bottom');
		expect(resolvePlacement(navlog, null, false, 1458)).toBe('dock-right');

		// The stored choice is untouched, so a wider window comes back to it,
		// and an unmeasured stage narrows nothing.
		expect(resolvePlacement(navlog, 'dock-right', false, 0)).toBe('dock-right');
		expect(resolvePlacement(navlog, 'dock-right', false)).toBe('dock-right');
	});

	it('gives a phone full screen rather than a keyhole dock', () => {
		// Both placements are the phone's full width, so a dock only pays
		// while the surface can show its content in it. The nav log's 812px
		// grid against a 414px phone cannot; a profile's 420px floor can, and
		// the strip of map above it is the point of docking at all.
		const navlog = surfaceDef('navlog');
		expect(resolvePlacement(navlog, null, true, 414)).toBe('full');
		expect(resolvePlacement(navlog, 'dock-bottom', true, 414)).toBe('full');
		expect(resolvePlacement(navlog, 'dock-right', true, 414)).toBe('full');
		expect(resolvePlacement(route, null, true, 414)).toBe('dock-bottom');
		expect(resolvePlacement(surfaceDef('mapProfile'), null, true, 414)).toBe('dock-bottom');

		// A phone wide enough for the log to read keeps the dock, the stored
		// choice is untouched either way, and an interactive move (no stage
		// measurement) is never overridden.
		expect(resolvePlacement(navlog, null, true, 600)).toBe('dock-bottom');
		expect(resolvePlacement(navlog, 'dock-bottom', true, 0)).toBe('dock-bottom');
		expect(resolvePlacement(navlog, 'dock-bottom', true)).toBe('dock-bottom');
	});

	it('narrows only the side dock, and only where a bottom one is allowed', () => {
		const navlog = surfaceDef('navlog');
		for (const p of ['page', 'full', 'dock-bottom'] as const) {
			expect(resolvePlacement(navlog, p, false, 300)).toBe(p);
		}
		// flightPrep may dock right but not bottom: it has nowhere to narrow
		// to, and the size clamp holds it to the stage instead.
		expect(resolvePlacement(surfaceDef('flightPrep'), 'dock-right', false, 300)).toBe('dock-right');
	});

	it('always resolves to something renderable', () => {
		const stored: (string | null)[] = [null, 'dialog', 'page', 'full', 'dock-bottom', 'dock-right'];
		for (const id of SURFACE_IDS) {
			const def = surfaceDef(id);
			for (const s of stored) {
				for (const mobile of [false, true]) {
					const p = resolvePlacement(def, s, mobile);
					expect(mobile ? mobilePlacement(p) : p).toBe(p);
					expect(slotFor(p)).toBeTruthy();
				}
			}
		}
	});
});

describe('slots and modality', () => {
	const cases: [Placement, string][] = [
		['dock-bottom', 'dockBottom'],
		['dock-right', 'dockRight'],
		['page', 'overlay'],
		['full', 'overlay'],
		['dialog', 'overlay'],
	];

	it('maps each placement to its slot', () => {
		for (const [placement, slot] of cases) {
			expect(slotFor(placement)).toBe(slot);
		}
	});

	it('treats only full screen and the dialog as modal', () => {
		expect(isModalPlacement('full')).toBe(true);
		expect(isModalPlacement('dialog')).toBe(true);
		// The page keeps the side panels on screen, so they must stay reachable.
		expect(isModalPlacement('page')).toBe(false);
		expect(isModalPlacement('dock-bottom')).toBe(false);
		expect(isModalPlacement('dock-right')).toBe(false);
	});

	it('leaves the map on screen only for the docks', () => {
		// What decides whether a profile has to get out of the way when the
		// user follows one of its links to a detail panel.
		expect(keepsMapVisible('dock-bottom')).toBe(true);
		expect(keepsMapVisible('dock-right')).toBe(true);
		expect(keepsMapVisible('page')).toBe(false);
		expect(keepsMapVisible('full')).toBe(false);
		expect(keepsMapVisible('dialog')).toBe(false);
	});

	it('names the edge of the dock placements only', () => {
		expect(dockEdgeOf('dock-bottom')).toBe('bottom');
		expect(dockEdgeOf('dock-right')).toBe('right');
		expect(dockEdgeOf('page')).toBeNull();
		expect(dockEdgeOf('full')).toBeNull();
		expect(dockEdgeOf('dialog')).toBeNull();
	});
});

describe('minimum width', () => {
	it('carries each surface content floor', () => {
		// The width below which the content stops reflowing and has to scroll:
		// the nav-log grid is min-width 760 plus its padding, scrollbar and
		// border; the editor's POH grids and CG envelope column are the widest
		// thing in the fleet.
		expect(surfaceDef('navlog').minWidthPx).toBe(812);
		expect(surfaceDef('aircraftEditor').minWidthPx).toBe(560);
		expect(surfaceDef('flightPrep').minWidthPx).toBe(460);
	});

	it('floors a side dock at the width, a bottom dock at the height', () => {
		const navlog = surfaceDef('navlog');
		expect(minDockPx(navlog, 'right')).toBe(navlog.minWidthPx);
		expect(minDockPx(navlog, 'bottom')).toBe(navlog.minDockHeightPx);
	});

	it('never lets a surface dock narrower than its content', () => {
		for (const id of SURFACE_IDS) {
			const def = surfaceDef(id);
			if (!def.placements.includes('dock-right')) {
				continue;
			}
			expect(clampDockPx(def, 'right', 2000, 10)).toBe(def.minWidthPx);
		}
	});
});

describe('clampDockPx', () => {
	const navlog = surfaceDef('navlog');

	it('holds a dock to the surface content floor', () => {
		expect(clampDockPx(navlog, 'bottom', 900, 40)).toBe(navlog.minDockHeightPx);
		expect(clampDockPx(navlog, 'right', 1400, 100)).toBe(navlog.minWidthPx);
	});

	it('always leaves the map a strip', () => {
		expect(clampDockPx(navlog, 'bottom', 900, 5000)).toBe(810);
	});

	it('keeps a size that fits', () => {
		expect(clampDockPx(navlog, 'bottom', 900, 360)).toBe(360);
	});

	it('yields to the ceiling when the stage cannot hold the floor', () => {
		// A very short stage: the 90% ceiling wins, so the value stays inside
		// the stage rather than overflowing it to honour the minimum.
		expect(clampDockPx(navlog, 'bottom', 100, 400)).toBe(90);
	});
});

describe('dockRelease', () => {
	const navlog = surfaceDef('navlog');

	it('keeps a size released inside the resting range', () => {
		expect(dockRelease(navlog, 'bottom', 900, 400)).toEqual({ kind: 'size', px: 400 });
	});

	it('maximises when dragged past the ceiling', () => {
		expect(dockCeilingPx(900)).toBe(810);
		expect(dockRelease(navlog, 'bottom', 900, 811)).toEqual({ kind: 'page' });
		expect(dockRelease(navlog, 'bottom', 900, 900)).toEqual({ kind: 'page' });
	});

	it('holds at the ceiling exactly, so the gesture has to pass it', () => {
		expect(dockRelease(navlog, 'bottom', 900, 810)).toEqual({ kind: 'size', px: 810 });
	});

	it('applies to the side dock too', () => {
		expect(dockRelease(navlog, 'right', 1400, 1400)).toEqual({ kind: 'page' });
		expect(dockRelease(navlog, 'right', 1400, 900)).toEqual({ kind: 'size', px: 900 });
	});

	it('stops at the ceiling for a surface with no page placement', () => {
		const about = surfaceDef('about');
		expect(about.placements).not.toContain('page');
		expect(dockRelease(about, 'bottom', 900, 900)).toEqual({ kind: 'size', px: 810 });
	});

	it('holds a release below the floor up to it', () => {
		expect(dockRelease(navlog, 'bottom', 900, 10)).toEqual({
			kind: 'size',
			px: navlog.minDockHeightPx,
		});
	});
});

describe('pageRelease', () => {
	const navlog = surfaceDef('navlog');

	it('docks a page dragged back down', () => {
		expect(pageRelease(navlog, 900, 400)).toEqual({ kind: 'size', px: 400 });
	});

	it('stays a page while the drag is still near the top', () => {
		expect(pageRelease(navlog, 900, 811)).toEqual({ kind: 'page' });
	});

	it('stays a page for a surface that cannot dock at the bottom', () => {
		const prep = surfaceDef('flightPrep');
		expect(prep.placements).not.toContain('dock-bottom');
		expect(pageRelease(prep, 900, 300)).toEqual({ kind: 'page' });
	});

	it('is the inverse of dockRelease over the whole travel', () => {
		for (const px of [0, 100, 300, 810, 811, 900]) {
			const down = pageRelease(navlog, 900, px);
			const up = dockRelease(navlog, 'bottom', 900, px);
			expect(down.kind).toBe(up.kind);
		}
	});
});

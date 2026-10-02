/* The remembered layout (docs/preferences.md): the two side panels' widths
 * and each surface's placement and dock sizes are stored only away from
 * their defaults, and Restore default settings forgets them IN PLACE, with
 * nothing moved, closed or evicted, so no confirm can appear out of nowhere
 * and no open surface is lost. The widths were component state, which
 * nothing outside the component could put back. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage, type MemoryStorage } from './helpers/storage';
import { SURFACE_IDS } from '$lib/surfaces';
import {
	closeSurface,
	commitDockPx,
	forgetSurfaceLayout,
	openSurface,
	placementOf,
	setPlacement,
	setStageSize,
	workspace,
} from '$lib/state/workspace.svelte';

let ls: MemoryStorage;

beforeEach(() => {
	ls = memoryStorage();
	vi.stubGlobal('localStorage', ls);
});

afterEach(() => {
	for (const id of SURFACE_IDS) {
		closeSurface(id);
	}
	vi.unstubAllGlobals();
});

describe('a surface placement', () => {
	it('is remembered only away from the default', () => {
		setStageSize(1800, 900);
		openSurface('routeProfile');
		expect(placementOf('routeProfile')).toBe('dock-bottom');
		setPlacement('routeProfile', 'dock-right');
		expect(ls.getItem('loxodrome:surface:routeProfile:placement')).toBe('dock-right');
		setPlacement('routeProfile', 'dock-bottom');
		expect(ls.getItem('loxodrome:surface:routeProfile:placement')).toBeNull();
	});

	it('opens again at the dock size committed last', () => {
		setStageSize(1800, 900);
		openSurface('routeProfile');
		const share = workspace.dockPx.bottom;
		commitDockPx('bottom', share + 120);
		expect(ls.getItem('loxodrome:surface:routeProfile:size-bottom')).toBe(String(share + 120));
		closeSurface('routeProfile');
		openSurface('routeProfile');
		expect(workspace.dockPx.bottom).toBe(share + 120);
	});
});

describe('forgetSurfaceLayout', () => {
	it('forgets every remembered layout and moves nothing', () => {
		setStageSize(1800, 900);
		openSurface('routeProfile');
		setPlacement('routeProfile', 'dock-right');
		const share = workspace.dockPx.right;
		commitDockPx('right', share + 150);
		expect(ls.getItem('loxodrome:surface:routeProfile:size-right')).toBe(String(share + 150));
		// A surface that no longer exists left a key behind.
		ls.setItem('loxodrome:surface:retired:placement', 'page');
		forgetSurfaceLayout();
		expect(ls.dump()).toEqual({});
		// Where it is, at its default share, until it is next opened...
		expect(placementOf('routeProfile')).toBe('dock-right');
		expect(workspace.dockPx.right).toBe(share);
		// ...which lands on its default placement.
		closeSurface('routeProfile');
		openSurface('routeProfile');
		expect(placementOf('routeProfile')).toBe('dock-bottom');
	});

	it('forgets only the surfaces it is given, every key of theirs', () => {
		setStageSize(1800, 900);
		openSurface('navlog');
		setPlacement('navlog', 'dock-bottom');
		openSurface('about');
		for (const id of ['routeProfile', 'navlog']) {
			ls.setItem(`loxodrome:surface:${id}:size-bottom`, '300');
			ls.setItem(`loxodrome:surface:${id}:size-right`, '500');
		}
		ls.setItem('loxodrome:surface:routeProfile:placement', 'dock-right');
		forgetSurfaceLayout(['about', 'routeProfile']);
		expect(ls.dump()).toEqual({
			'loxodrome:surface:navlog:placement': 'dock-bottom',
			'loxodrome:surface:navlog:size-bottom': '300',
			'loxodrome:surface:navlog:size-right': '500',
		});
	});
});

describe('the panel widths', () => {
	it('are remembered away from the default and restored in place', async () => {
		vi.resetModules();
		const w = await import('$lib/state/panelWidths.svelte');
		expect(w.panelWidths).toEqual({ sidebar: 400, detail: 480 });
		w.setPanelWidth('sidebar', 520);
		expect(ls.dump()).toEqual({});
		w.commitPanelWidth('sidebar', 520.4);
		w.commitPanelWidth('detail', 600);
		expect(ls.dump()).toEqual({
			'loxodrome:sidebar-width': '520',
			'loxodrome:detail-width': '600',
		});
		vi.resetModules();
		const again = await import('$lib/state/panelWidths.svelte');
		expect(again.panelWidths).toEqual({ sidebar: 520, detail: 600 });
		again.restorePanelWidths(['detail']);
		expect(again.panelWidths.detail).toBe(480);
		expect(ls.dump()).toEqual({ 'loxodrome:sidebar-width': '520' });
		again.commitPanelWidth('sidebar', 400);
		expect(ls.dump()).toEqual({});
	});
});

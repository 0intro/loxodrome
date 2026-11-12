/* How a phone makes room for the replay on its map (state/phoneNav.svelte.ts
 * revealReplay / showReplayOnMap; docs/nav-live.md "The replay strip"): a
 * trace opened, a flight loaded from the library. The strip is up on any
 * loaded trace already (state/replayStrip.svelte.ts); what covers the map
 * goes (a full-screen surface, unless it refuses, then the page), a pane
 * maximised over it steps down to a dock, and follow comes back to the
 * aircraft: re-armed only after a trace swap, whose pose the map has not
 * drawn yet, else recentred. The Flight page carries no Replay launcher: the
 * Map destination is the way back to a replay. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackPoint } from '$lib/nav/trace';

const calls = vi.hoisted(() => ({ rearm: 0, recenter: 0 }));
vi.mock('$lib/map/navLayer', () => ({
	rearmFollow: () => {
		calls.rearm += 1;
	},
	recenterNav: () => {
		calls.recenter += 1;
	},
}));
vi.mock('$lib/map/notamLayer', () => ({ fitToNotams: () => {} }));
vi.mock('$lib/components/tabs/route/fitRoute', () => ({ fitRoute: () => {} }));

const { nav, clearTrace, importTrace } = await import('$lib/state/navRecording.svelte');
const { ui, openPage } = await import('$lib/state/ui.svelte');
const { mapState } = await import('$lib/state/map.svelte');
const ws = await import('$lib/state/workspace.svelte');
const phone = await import('$lib/state/phoneNav.svelte');
const strip = await import('$lib/state/replayStrip.svelte');

const T0 = Date.UTC(2026, 8, 30, 9, 15, 27);
const trace = (): TrackPoint[] =>
	Array.from({ length: 5 }, (_, i) => ({ lat: 48.8, lon: 2.6 + i / 100, altFt: 1000, timeMs: T0 + i * 60_000 }));

const sectionIds = (): string[] => phone.offeredSections('flight').map((s) => s.id);

beforeEach(() => {
	ui.isMobile = true;
	ui.page = null;
	nav.follow = true;
	nav.recording = false;
	clearTrace();
	strip.unfoldReplayStrip();
	mapState.map = {} as never;
	calls.rearm = 0;
	calls.recenter = 0;
});

afterEach(() => {
	for (const id of ['navProfile', 'flights'] as const) {
		if (ws.isOpen(id)) {
			ws.closeSurface(id);
		}
	}
	strip.unfoldReplayStrip();
	mapState.map = null;
	ui.isMobile = false;
	ui.page = null;
	nav.recording = false;
});

describe('the Flight page', () => {
	it('offers no Replay launcher, a replay riding the map whenever a trace is loaded', () => {
		expect(sectionIds()).toEqual(['flight', 'alerts', 'trace']);
		importTrace(trace(), 'msl');
		expect(sectionIds()).toEqual(['flight', 'alerts', 'trace']);
		expect(strip.replayStripShown()).toBe(true);
	});

	it('opens on its first section', () => {
		expect(phone.pageSection('flight')).toBe('flight');
	});
});

describe('revealReplay', () => {
	it('puts the page aside and the strip up, recentring on the aircraft drawn', () => {
		importTrace(trace(), 'msl');
		openPage('flight', 'trace');
		phone.revealReplay(false);
		expect(ui.page).toBeNull();
		expect(strip.replayStripShown()).toBe(true);
		expect(calls).toEqual({ rearm: 0, recenter: 1 });
	});

	it('only re-arms follow after a trace swap, the map not having drawn its pose', () => {
		importTrace(trace(), 'msl');
		phone.revealReplay(true);
		expect(strip.replayStripShown()).toBe(true);
		expect(calls).toEqual({ rearm: 1, recenter: 0 });
	});

	it('leaves the map alone with follow off', () => {
		importTrace(trace(), 'msl');
		nav.follow = false;
		phone.revealReplay(false);
		expect(strip.replayStripShown()).toBe(true);
		expect(calls).toEqual({ rearm: 0, recenter: 0 });
	});

	it('does nothing on the desktop, or with nothing to replay', () => {
		importTrace(trace(), 'msl');
		ui.isMobile = false;
		openPage('flight');
		phone.revealReplay(false);
		expect(ui.page).toBe('flight');
		ui.isMobile = true;
		nav.recording = true;
		phone.revealReplay(false);
		expect(ui.page).toBe('flight');
		nav.recording = false;
		expect(calls).toEqual({ rearm: 0, recenter: 0 });
	});

	it('steps a pane maximised over the map down to a dock', () => {
		importTrace(trace(), 'msl');
		ws.openSurface('navProfile');
		ws.movePlacement('navProfile', 'page');
		expect(ws.placementOf('navProfile')).toBe('page');
		phone.revealReplay(false);
		expect(ws.placementOf('navProfile')).toBe('dock-bottom');
		expect(strip.replayStripShown()).toBe(true);
	});

	it('closes a full-screen surface first, and stops at one that refuses', () => {
		importTrace(trace(), 'msl');
		ws.openSurface('flights');
		expect(ws.placementOf('flights')).toBe('full');
		phone.revealReplay(true);
		expect(ws.isOpen('flights')).toBe(false);
		expect(strip.replayStripShown()).toBe(true);

		ws.openSurface('flights');
		openPage('flight');
		const release = ws.registerSurfaceClose('flights', () => {});
		calls.recenter = 0;
		calls.rearm = 0;
		phone.revealReplay(true);
		release();
		// It stops there: the surface and the page stay, follow untouched.
		expect(ws.isOpen('flights')).toBe(true);
		expect(ui.page).toBe('flight');
		expect(calls).toEqual({ rearm: 0, recenter: 0 });
	});

	it('shows the replay under a surface that has something to say', () => {
		importTrace(trace(), 'msl');
		ws.openSurface('flights');
		phone.showReplayOnMap(true);
		expect(ws.isOpen('flights')).toBe(true);
		expect(strip.replayStripShown()).toBe(true);
	});
});

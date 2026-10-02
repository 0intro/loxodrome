/* Follow while the phone's replay scrubber is held (map/navLayer.ts
 * syncNavAircraft's `scrub`, state/replayStrip.svelte.ts). A dragged
 * scrubber moves the aircraft across the map in a second, and following it
 * pan by pan was a moveend per step, which repaints every canvas layer: 131
 * moveends for a 61-step sweep on the phone emulation, 17 with the hold. The
 * hold lets the aircraft stray to a quarter of the map's short side, jumps
 * (unanimated, one moveend) past that, and centres exactly on the release.
 * Real Leaflet over the Node shim, the routeDragSnap harness. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fix } from '$lib/nav/trace';
import { installLeafletNode } from './helpers/leafletNode';

const env = installLeafletNode();
const L = (await import('leaflet')).default;
const { FOLLOW_DEADBAND_PX, clearNavLayer, scrubDeadbandPx, syncNavAircraft } = await import(
	'$lib/map/navLayer'
);

const W = 400;
const H = 600;
let map: L.Map;
let moves = 0;

/** Run the queued frames with time passing: a pan animates by the wall
 *  clock (Leaflet's PosAnimation reads Date), which the shim's frames alone
 *  never move. */
function settle(): void {
	for (let i = 0; i < 200 && env.pendingFrames() > 0; i += 1) {
		vi.advanceTimersByTime(40);
		env.runFrame();
	}
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	map = L.map(env.container(W, H) as unknown as HTMLElement, {
		zoomControl: false,
		attributionControl: false,
		zoomAnimation: false,
		fadeAnimation: false,
		markerZoomAnimation: false,
		trackResize: false,
		preferCanvas: true,
	}).setView([48.82, 2.62], 12);
	moves = 0;
	map.on('moveend', () => {
		moves += 1;
	});
});

afterEach(() => {
	clearNavLayer(map);
	// The trace's removal asks the canvas for a redraw: run it while the map
	// still has one, or it lands on the next case's frame queue.
	settle();
	map.remove();
	vi.useRealTimers();
});

/** The pose `dx`, `dy` container px off the map's current centre. */
function poseOff(dx: number, dy: number): Fix {
	const at = map.containerPointToLatLng([W / 2 + dx, H / 2 + dy]);
	return { lat: at.lat, lon: at.lng, altFt: 1500, trackDeg: 90, speedKt: 90 };
}

/** How far the aircraft sits off the container centre, px. */
function offCentre(f: Fix): number {
	const p = map.latLngToContainerPoint([f.lat, f.lon]);
	return Math.max(Math.abs(p.x - W / 2), Math.abs(p.y - H / 2));
}

function sync(f: Fix, scrub: boolean): void {
	syncNavAircraft(map, f, 'plane', true, 'good', 'Recentre', scrub);
	settle();
}

describe('the held scrubber', () => {
	it('lets the aircraft stray to a quarter of the short side, never less than the deadband', () => {
		expect(scrubDeadbandPx({ x: W, y: H })).toBe(100);
		expect(scrubDeadbandPx({ x: 30, y: 20 })).toBe(FOLLOW_DEADBAND_PX);
	});

	it('pans only past the wide deadband, in one jump, and centres on the release', () => {
		sync(poseOff(0, 0), false); // arming centres exactly
		moves = 0;
		const near = poseOff(80, -60);
		sync(near, true);
		expect(moves).toBe(0);
		expect(offCentre(near)).toBeGreaterThan(FOLLOW_DEADBAND_PX);

		const far = poseOff(150, 40);
		sync(far, true);
		expect(moves).toBe(1);
		expect(offCentre(far)).toBeLessThan(1);

		const there = poseOff(70, 30);
		sync(there, true);
		expect(moves).toBe(1);
		// The finger lets go, the pose unchanged: centred exactly, once.
		sync(there, false);
		expect(moves).toBe(2);
		expect(offCentre(there)).toBeLessThan(1);
	});

	it('follows by the usual deadband once released', () => {
		sync(poseOff(0, 0), false);
		moves = 0;
		const drift = poseOff(20, 0);
		sync(drift, false);
		expect(moves).toBe(1);
		expect(offCentre(drift)).toBeLessThan(1);
	});

	it('leaves a pan suspension as it was', () => {
		sync(poseOff(0, 0), false);
		map.fire('dragstart');
		moves = 0;
		const far = poseOff(160, 0);
		sync(far, true);
		sync(far, false);
		expect(moves).toBe(0);
		expect(offCentre(far)).toBeGreaterThan(100);
	});
});

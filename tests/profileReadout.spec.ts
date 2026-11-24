/* The profiles' readouts say the ground under the pointer, or an em-dash.
 * Offline the route terrain settles with every sample null, and the route
 * readout printed "Ground 0 ft" with an AGL equal to the planned level over
 * any relief, and across a gap the nearest READ sample, possibly a valley
 * miles away, overstating the AGL. terrainFtNear answers the sample nearest
 * the pointer or null. The trace readout's altitude is on MSL, the datum its
 * line is drawn on. The readouts are pinned by their source, the modals
 * needing a DOM and a route to render (the closureInstantSurfaces idiom). */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { terrainFtNear, type TerrainSample } from '$lib/route/routeProfile';
import { sampleCeilingFt } from '$lib/map/terrain';

const route = readFileSync('src/lib/components/RouteProfileModal.svelte', 'utf8');
const trace = readFileSync('src/lib/components/NavProfileModal.svelte', 'utf8');

describe('terrainFtNear', () => {
	const at = (pairs: [number, number | null][]): TerrainSample[] =>
		pairs.map(([distNM, elevFt]) => ({ distNM, elevFt }));

	it('is null without samples, or where every sample is unread', () => {
		expect(terrainFtNear([], 3)).toBeNull();
		expect(terrainFtNear(at([[0, null], [1, null], [2, null]]), 1.2)).toBeNull();
	});

	it('never reaches past an unread sample for a far one', () => {
		const gap = at([[0, 300], [1, null], [2, null], [3, 2400]]);
		expect(terrainFtNear(gap, 1.4)).toBeNull();
		expect(terrainFtNear(gap, 2.6)).toBe(2400);
		expect(terrainFtNear(gap, 0.4)).toBe(300);
	});

	it('takes the reading asked for', () => {
		const banded: TerrainSample[] = [{ distNM: 0, elevFt: 1000, minFt: 800, maxFt: 1500 }];
		expect(terrainFtNear(banded, 0)).toBe(1000);
		expect(terrainFtNear(banded, 0, sampleCeilingFt)).toBe(1500);
	});
});

describe('the readouts', () => {
	it('read the route readout and its menu clouds through terrainFtNear', () => {
		expect(route).toContain('const groundFt = terrainFtNear(terrain, inspectNM);');
		expect(route).toContain('const groundFt = terrainFtNear(terrain, ctxMenu.distNM);');
	});

	it('read the trace readout through terrainFtNear', () => {
		expect(trace).toContain('const groundFt = terrainFtNear(terrain, c.distNM);');
	});

	// A recorded fix is on the device's datum (the WGS84 ellipsoid on
	// Android, some 150 ft above MSL over France) and the line is drawn on
	// MSL: Altitude and AGL rows read off the raw fix would stand that far
	// above the line they label, the AGL on the unsafe side.
	it('read the trace readout altitude on the datum of its line', () => {
		expect(trace).toContain('thinTrace(nav.points, 600, poseAltMslFt)');
		expect(trace).toContain('altFt: fix ? poseAltMslFt(fix) : null,');
	});
});

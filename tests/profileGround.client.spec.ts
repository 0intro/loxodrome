/* A column profile's ground belongs to its point. Moved from one place to
 * another (the detail panel's next subject, the map's "Altitude profile"
 * picked elsewhere), the profile kept the previous point's ground until the
 * new read landed: every AGL limit of the new stack and its "free below"
 * figure rested on it for as long as an uncached tile took. A DRAG of the
 * map's marker keeps the last ground through its reads, so it never
 * flickers through nothing. The effects really run (tests/env/webnode.ts),
 * and the terrain read is a deferred promise per point. */

import { flushSync } from 'svelte';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => new Map<string, (ft: number | null) => void>());
vi.mock('$lib/map/terrain', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/map/terrain')>()),
	elevationFtAt: (lat: number, lon: number): Promise<number | null> =>
		new Promise((resolve) => reads.set(`${lat},${lon}`, resolve)),
}));

import { mountMapGround, mountPanelModel } from './helpers/profileGroundHost.svelte';
import { closeMapProfile, openMapProfile, setMapProfilePoint } from '$lib/state/mapProfileModal.svelte';
import { setStageSize } from '$lib/state/workspace.svelte';

/** Answer the read for a point, then let its settle land. */
async function land(lat: number, lon: number, ft: number): Promise<void> {
	const resolve = reads.get(`${lat},${lon}`);
	expect(resolve, `a read for ${lat},${lon}`).toBeDefined();
	resolve?.(ft);
	for (let i = 0; i < 4; i++) {
		await Promise.resolve();
	}
	flushSync();
}

afterEach(() => {
	reads.clear();
	closeMapProfile();
});

describe('a panel profile', () => {
	it('reads no ground for its new point until that point is read', async () => {
		const h = mountPanelModel({ lat: 45.2, lon: 5.7 });
		flushSync();
		await land(45.2, 5.7, 200);
		expect(h.ground()).toBe(200);
		h.s.lat = 45.9;
		h.s.lon = 6.9;
		flushSync();
		expect(h.ground()).toBeNull();
		await land(45.9, 6.9, 3000);
		expect(h.ground()).toBe(3000);
		h.stop();
	});
});

describe('an aerodrome panel profile', () => {
	it('keeps the published elevation, and reads the terrain without one', async () => {
		const h = mountPanelModel({ lat: 45.2, lon: 5.7, groundFt: 450 });
		flushSync();
		expect(h.ground()).toBe(450);
		expect(reads.size).toBe(0);
		h.s.groundFt = null;
		flushSync();
		await land(45.2, 5.7, 610);
		expect(h.ground()).toBe(610);
		h.stop();
	});
});

describe('the map profile', () => {
	it('drops the ground at a jump and keeps it through a drag', async () => {
		setStageSize(1200, 800);
		const h = mountMapGround();
		openMapProfile(45.2, 5.7);
		flushSync();
		await land(45.2, 5.7, 300);
		expect(h.ground()).toBe(300);
		// The marker dragged: the last ground holds until the next lands.
		setMapProfilePoint(45.21, 5.71);
		flushSync();
		expect(h.ground()).toBe(300);
		await land(45.21, 5.71, 320);
		expect(h.ground()).toBe(320);
		// Picked elsewhere: nothing until that point is read.
		openMapProfile(45.9, 6.9);
		flushSync();
		expect(h.ground()).toBeNull();
		await land(45.9, 6.9, 1500);
		expect(h.ground()).toBe(1500);
		h.stop();
	});

	it('is the read MapProfileModal makes', () => {
		const src = readFileSync('src/lib/components/MapProfileModal.svelte', 'utf8');
		expect(src).toContain('useProfileGround(');
		expect(src).toContain('key: mapProfileModal.opened');
	});
});

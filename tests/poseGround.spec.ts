/* Pins the shared ground-under-the-pose sample (state/poseGround.svelte.ts):
 * refreshed only once the aircraft moved a mile, answering only within two,
 * one fetch in flight, and the mosaic's synchronous answer taken free of a
 * fetch. The alert engine and the band read one sample. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function tileOf(lat: number, lon: number): string {
	return `${Math.round(lat * 10)}/${Math.round(lon * 10)}`;
}
function groundFt(lat: number, lon: number): number {
	return Math.round((lat + lon) * 1000);
}

const asked: string[] = [];
const decoded = new Set<string>();
const voids = new Set<string>();
let hold: Promise<void> | null = null;

vi.mock('$lib/map/terrain', () => ({
	elevationFtAt: async (lat: number, lon: number): Promise<number | null> => {
		const tile = tileOf(lat, lon);
		asked.push(tile);
		if (hold) {
			await hold;
		}
		decoded.add(tile);
		return voids.has(tile) ? null : groundFt(lat, lon);
	},
	peekElevationFtAt: (lat: number, lon: number): number | null | undefined => {
		const tile = tileOf(lat, lon);
		if (!decoded.has(tile)) {
			return undefined;
		}
		return voids.has(tile) ? null : groundFt(lat, lon);
	},
}));

import {
	GROUND_REFRESH_M,
	GROUND_VALID_M,
	ensurePoseGround,
	poseGround,
	poseGroundFt,
	resetPoseGround,
} from '$lib/state/poseGround.svelte';
import { M_PER_DEG } from '$lib/notam/geometry';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** Degrees of latitude for a distance in metres. */
const degFor = (m: number): number => m / M_PER_DEG;

beforeEach(() => {
	asked.length = 0;
	decoded.clear();
	voids.clear();
	hold = null;
	resetPoseGround();
});
afterEach(() => {
	resetPoseGround();
});

describe('poseGround', () => {
	it('fetches once and then answers for the mile around the sample', async () => {
		ensurePoseGround(48.0, 2.0);
		expect(asked).toHaveLength(1);
		expect(poseGround(48.0, 2.0)).toBeNull();
		await settle();
		expect(poseGroundFt(48.0, 2.0)).toBe(groundFt(48.0, 2.0));
		ensurePoseGround(48.0 + degFor(GROUND_REFRESH_M * 0.5), 2.0);
		expect(asked).toHaveLength(1);
	});

	it('refreshes past a mile of movement and stops answering past two', async () => {
		// Starts near a tile edge so the mile of movement crosses into a tile
		// the mosaic has not decoded, which is what makes the refresh a fetch.
		ensurePoseGround(48.04, 2.0);
		await settle();
		const farLat = 48.04 + degFor(GROUND_VALID_M * 1.2);
		expect(poseGround(farLat, 2.0)).toBeNull();
		const nearLat = 48.04 + degFor(GROUND_REFRESH_M * 1.5);
		expect(tileOf(nearLat, 2.0)).not.toBe(tileOf(48.04, 2.0));
		ensurePoseGround(nearLat, 2.0);
		expect(asked).toHaveLength(2);
	});

	it('holds one fetch in flight and never queues a second', async () => {
		let release!: () => void;
		hold = new Promise((r) => (release = r));
		ensurePoseGround(48.0, 2.0);
		ensurePoseGround(48.5, 2.5);
		ensurePoseGround(49.0, 3.0);
		expect(asked).toHaveLength(1);
		release();
		await settle();
		expect(poseGroundFt(48.0, 2.0)).toBe(groundFt(48.0, 2.0));
	});

	it('takes the mosaic answer without a fetch once the tile is decoded', async () => {
		ensurePoseGround(48.0, 2.0);
		await settle();
		// Two miles on in the same tile: the peek answers, no fetch.
		const lat = 48.0 + degFor(GROUND_REFRESH_M * 2.2);
		expect(tileOf(lat, 2.0)).toBe(tileOf(48.0, 2.0));
		ensurePoseGround(lat, 2.0);
		expect(asked).toHaveLength(1);
		await settle();
		expect(poseGroundFt(lat, 2.0)).toBe(groundFt(lat, 2.0));
	});

	it('reports a terrain void as known and empty', async () => {
		voids.add(tileOf(48.0, 2.0));
		ensurePoseGround(48.0, 2.0);
		await settle();
		expect(poseGround(48.0, 2.0)?.ft).toBeNull();
		expect(poseGround(48.0, 2.0)).not.toBeNull();
		expect(poseGroundFt(48.0, 2.0)).toBeNull();
	});
});

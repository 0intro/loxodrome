/* The elevation tile reader against a fixture the GO writer produced
 * (internal/terrain, `go test ./internal/terrain -run TestFixture -update`).
 *
 * Reading a fixture the other language wrote is the point: a reader pinned
 * against its own writer proves only that it is self-consistent, and the two
 * halves of this format live in different languages. The fixture is the real
 * Alpine grid tests/terrainCorridor.spec.ts already reads (the ridge between
 * Albertville and Bourg-Saint-Maurice, 1212 to 3550 m), with the extremes of
 * each pixel's 3x3 neighbourhood as the pooled bands and a 4x4 void at
 * (10,10). */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
	decodeTerrainTile,
	TERRAIN_HEADER_SIZE,
	TERRAIN_MAGIC,
	TERRAIN_NODATA,
	TERRAIN_PIXELS,
	TERRAIN_TILE_SIZE,
} from '$lib/map/terrainTile';

const fixture = readFileSync('tests/fixtures/terrain-12-2125-1464.tile');
/** The same grid before the Go writer packed it, so the two fixtures can be
 *  compared value by value. */
const source = new Int16Array(
	gunzipSync(readFileSync('tests/fixtures/alpine-12-2125-1464.i16.gz')).buffer,
);

const at = (a: Int16Array, x: number, y: number): number => a[y * TERRAIN_TILE_SIZE + x];

describe('decodeTerrainTile', () => {
	it('reads the address the writer stamped', async () => {
		const t = await decodeTerrainTile(fixture);
		expect(t).not.toBeNull();
		expect(t!.z).toBe(12);
		expect(t!.x).toBe(2125);
		expect(t!.y).toBe(1464);
	});

	it('recovers the grid the Go side encoded, pixel for pixel', async () => {
		const t = await decodeTerrainTile(fixture);
		expect(t!.mean).toHaveLength(TERRAIN_PIXELS);
		let compared = 0;
		for (let i = 0; i < TERRAIN_PIXELS; i++) {
			if (t!.mean[i] === TERRAIN_NODATA) {
				continue; // the injected void, checked below
			}
			expect(t!.mean[i]).toBe(source[i]);
			compared++;
		}
		// The void is 16 pixels; everything else must have been compared, or
		// the row-delta decode quietly dropped a run.
		expect(compared).toBe(TERRAIN_PIXELS - 16);
	});

	it('brackets every mean with its own extremes', async () => {
		const t = await decodeTerrainTile(fixture);
		for (let i = 0; i < TERRAIN_PIXELS; i++) {
			const m = t!.mean[i];
			if (m === TERRAIN_NODATA) {
				continue;
			}
			expect(t!.min![i]).toBeLessThanOrEqual(m);
			expect(t!.max![i]).toBeGreaterThanOrEqual(m);
		}
	});

	it('carries the pooled extremes the writer put there', async () => {
		const t = await decodeTerrainTile(fixture);
		// The fixture's bands are the 3x3 neighbourhood extremes, so they are
		// reproducible here from the source grid alone.
		for (const [x, y] of [
			[100, 100],
			[7, 200],
			[255, 255],
			[0, 0],
		]) {
			let hi = -Infinity;
			let lo = Infinity;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const cx = Math.min(TERRAIN_TILE_SIZE - 1, Math.max(0, x + dx));
					const cy = Math.min(TERRAIN_TILE_SIZE - 1, Math.max(0, y + dy));
					hi = Math.max(hi, at(source, cx, cy));
					lo = Math.min(lo, at(source, cx, cy));
				}
			}
			expect(at(t!.max!, x, y)).toBe(hi);
			expect(at(t!.min!, x, y)).toBe(lo);
		}
	});

	it('reads a void as the sentinel on every band, and its neighbour as ground', async () => {
		const t = await decodeTerrainTile(fixture);
		for (let y = 10; y < 14; y++) {
			for (let x = 10; x < 14; x++) {
				expect(at(t!.mean, x, y)).toBe(TERRAIN_NODATA);
				expect(at(t!.max!, x, y)).toBe(TERRAIN_NODATA);
				expect(at(t!.min!, x, y)).toBe(TERRAIN_NODATA);
			}
		}
		// The delta crosses the sentinel and comes back: the pixel after the
		// void is ordinary ground, not a wrapped value.
		expect(at(t!.mean, 14, 10)).toBe(at(source, 14, 10));
		expect(at(t!.mean, 9, 10)).toBe(at(source, 9, 10));
	});

	it('reads a half-written or wrong object as no tile, never as terrain', async () => {
		const truncated = fixture.subarray(0, Math.floor(fixture.length / 2));
		const wrongMagic = Buffer.from(fixture);
		wrongMagic[0] = 0x58; // not gzip any more either
		expect(await decodeTerrainTile(new Uint8Array())).toBeNull();
		expect(await decodeTerrainTile(truncated)).toBeNull();
		expect(await decodeTerrainTile(wrongMagic)).toBeNull();
		expect(await decodeTerrainTile(Buffer.from(TERRAIN_MAGIC + ' and then some'))).toBeNull();
	});

	it('keeps the compressed form far smaller than the grid it carries', () => {
		// What the pin stores and the service worker caches is this, not the
		// 384 KiB the three bands occupy once decoded.
		expect(fixture.length).toBeLessThan(3 * TERRAIN_PIXELS * 2);
		expect(TERRAIN_HEADER_SIZE).toBe(20);
	});
});

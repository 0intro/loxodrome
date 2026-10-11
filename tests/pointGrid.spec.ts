/* The bucket index behind the NOTAM proximity matches (data/pointGrid):
 * rowsInBox must return exactly what the linear prefilter it replaced
 * returned, in dataset order, wherever the box falls: cell edges, the
 * antimeridian (no wrap, like the scan), the poles (the scan itself), and it
 * rebuilds for a new array while reusing the index for the same one. */

import { describe, it, expect } from 'vitest';
import { rowsInBox, type LatLon } from '$lib/data/pointGrid';

/** The linear scan rowsInBox replaces. */
function scan<T extends LatLon>(rows: readonly T[], lat: number, lon: number, dLat: number, dLon: number): T[] {
	return rows.filter((p) => !(Math.abs(p.lat - lat) > dLat) && !(Math.abs(p.lon - lon) > dLon));
}

/** A deterministic generator (mulberry32), so a failure is reproducible. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Row extends LatLon {
	id: number;
}

function cloud(seed: number, n: number, lat0: number, lon0: number, spread: number): Row[] {
	const r = rng(seed);
	const out: Row[] = [];
	for (let i = 0; i < n; i++) {
		out.push({ id: i, lat: lat0 + (r() - 0.5) * spread, lon: lon0 + (r() - 0.5) * spread });
	}
	return out;
}

describe('rowsInBox', () => {
	it('equals the linear scan, in dataset order, over random boxes', () => {
		const rows = cloud(1, 20000, 47, 2, 6);
		const r = rng(2);
		for (let k = 0; k < 400; k++) {
			const lat = 47 + (r() - 0.5) * 6.4;
			const lon = 2 + (r() - 0.5) * 6.4;
			const dLat = 0.0005 + r() * 0.2;
			const dLon = 0.0005 + r() * 0.3;
			expect(rowsInBox(rows, lat, lon, dLat, dLon).map((p) => p.id)).toEqual(
				scan(rows, lat, lon, dLat, dLon).map((p) => p.id),
			);
		}
	});

	it('finds rows sitting exactly on cell edges and on the box edge', () => {
		const rows: Row[] = [];
		let id = 0;
		for (let lat = 44.9; lat <= 45.1 + 1e-9; lat += 0.05) {
			for (let lon = 4.9; lon <= 5.1 + 1e-9; lon += 0.05) {
				rows.push({ id: id++, lat, lon });
			}
		}
		for (const [lat, lon, d] of [
			[45, 5, 0.05],
			[45.05, 5.05, 0.05],
			[44.95, 4.95, 0.0001],
			[45, 5, 0],
		] as [number, number, number][]) {
			expect(rowsInBox(rows, lat, lon, d, d).map((p) => p.id)).toEqual(scan(rows, lat, lon, d, d).map((p) => p.id));
		}
	});

	it('does not wrap across the antimeridian, like the scan', () => {
		const rows: Row[] = [
			{ id: 0, lat: 0, lon: 179.999 },
			{ id: 1, lat: 0, lon: -179.999 },
			{ id: 2, lat: 0, lon: 180 },
			{ id: 3, lat: 0, lon: -180 },
		];
		for (const lon of [179.998, -179.998, 180, -180]) {
			expect(rowsInBox(rows, 0, lon, 0.01, 0.01).map((p) => p.id)).toEqual(scan(rows, 0, lon, 0.01, 0.01).map((p) => p.id));
		}
	});

	it('near a pole, where the longitude box spans the globe, falls back to the scan', () => {
		const rows = cloud(3, 2000, 89.5, 0, 1).map((p, i) => ({ ...p, lon: -180 + (i * 360) / 2000 }));
		expect(rowsInBox(rows, 89.9, 10, 0.1, 120).map((p) => p.id)).toEqual(scan(rows, 89.9, 10, 0.1, 120).map((p) => p.id));
	});

	it('answers nothing for a NaN coordinate', () => {
		const rows = cloud(4, 100, 45, 5, 1);
		expect(rowsInBox(rows, NaN, 5, 0.01, 0.01)).toEqual([]);
	});

	it('indexes per array identity: a new array is indexed afresh', () => {
		const a = cloud(5, 1000, 45, 5, 1);
		const hit = rowsInBox(a, a[10].lat, a[10].lon, 1e-6, 1e-6);
		expect(hit.map((p) => p.id)).toEqual([10]);
		// Same rows moved, new array: the old index must not answer.
		const b = a.map((p) => ({ ...p, lat: p.lat + 0.5 }));
		expect(rowsInBox(b, a[10].lat, a[10].lon, 1e-6, 1e-6)).toEqual(scan(b, a[10].lat, a[10].lon, 1e-6, 1e-6));
		expect(rowsInBox(b, b[10].lat, b[10].lon, 1e-6, 1e-6).map((p) => p.id)).toEqual([10]);
	});
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Archive, zxyToTileId } from '../src/pmtiles.ts';
import { checkDescriptor, chooseLevel, decodeSegment, nearest, SEGMENTS, seriesAt, tileOf, varKey } from '../src/archive.ts';
import { MODELS } from '../src/models.ts';
import { FIXTURES } from './helpers.ts';

interface FixturePoint {
	lat: number;
	lon: number;
	i: number;
	j: number;
	series: Record<string, (number | null)[]>;
	absent?: boolean;
}

async function openFile(path: string): Promise<Archive> {
	const data = new Uint8Array(readFileSync(path));
	return Archive.open(data.subarray(0, 64 * 1024), (off, len) => Promise.resolve(data.subarray(off, off + len)));
}

void test('tile ids follow the PMTiles spec', () => {
	// The spec's table: z0, then z1's Hilbert order.
	assert.equal(zxyToTileId(0, 0, 0), 0);
	assert.equal(zxyToTileId(1, 0, 0), 1);
	assert.equal(zxyToTileId(1, 0, 1), 2);
	assert.equal(zxyToTileId(1, 1, 1), 3);
	assert.equal(zxyToTileId(1, 1, 0), 4);
	assert.equal(zxyToTileId(2, 0, 0), 5);
	assert.equal(zxyToTileId(7, 70, 44), zxyToTileId(7, 70, 44));
});

void test('the TypeScript reader decodes what the Go reader decoded', async () => {
	const archive = await openFile(join(FIXTURES, 'mini-nwp.pmtiles'));
	const desc = checkDescriptor(archive.metadata);
	const expected = JSON.parse(readFileSync(join(FIXTURES, 'mini-nwp.json'), 'utf8')) as { points: FixturePoint[] };
	assert.equal(desc.model, 'mini');
	let compared = 0;
	for (const p of expected.points) {
		const ij = nearest(desc.grid, p.lat, p.lon);
		assert.deepEqual(ij, { i: p.i, j: p.j }, `nearest ${p.lat},${p.lon}`);
		const native = desc.levels[0];
		const t = tileOf(native, desc.tile, p.i, p.j);
		const at = await archive.locate(native.z, t.x, t.y);
		if (p.absent && Object.keys(p.series).length === 0) {
			assert.equal(at, null);
			continue;
		}
		assert.ok(at, `tile for ${p.i},${p.j}`);
		const payload = new Uint8Array(readFileSync(join(FIXTURES, 'mini-nwp.pmtiles'))).subarray(at.offset, at.offset + at.length);
		for (let s = 0; s < SEGMENTS.length; s++) {
			const seg = desc.segments[s];
			const data = await decodeSegment(payload, s);
			seg.vars.forEach((v, vi) => {
				const want = p.series[varKey(v)];
				if (!want) {
					return;
				}
				assert.deepEqual(seriesAt(seg, data, vi, t.at, desc.tile), want, `${varKey(v)} at ${p.i},${p.j}`);
				compared++;
			});
		}
	}
	assert.ok(compared > 50, `compared ${compared} series`);
});

void test('a coarse level holds its lattice points with the native values', async () => {
	const path = join(FIXTURES, 'mini-nwp.pmtiles');
	const data = new Uint8Array(readFileSync(path));
	const archive = await openFile(path);
	const desc = checkDescriptor(archive.metadata);
	const coarse = desc.levels[1];
	assert.equal(coarse.factor, 5);
	// Native point (8, 7) is the x5 level's (1, 1): the anchor (3, 2) plus 5.
	const level = chooseLevel(desc.levels, [{ i: 8, j: 7 }, { i: 13, j: 12 }]);
	assert.equal(level.z, coarse.z);
	assert.equal(chooseLevel(desc.levels, [{ i: 8, j: 7 }, { i: 9, j: 7 }]).z, desc.levels[0].z);
	const read = async (z: number, i: number, j: number, lvl: typeof coarse): Promise<(number | null)[]> => {
		const t = tileOf(lvl, desc.tile, i, j);
		const at = await archive.locate(z, t.x, t.y);
		assert.ok(at);
		const seg = desc.segments[1];
		const d = await decodeSegment(data.subarray(at.offset, at.offset + at.length), 1);
		return seriesAt(seg, d, 0, t.at, desc.tile);
	};
	assert.deepEqual(await read(coarse.z, 8, 7, coarse), await read(desc.levels[0].z, 8, 7, desc.levels[0]));
});

void test('nearest rounds half up in microdegrees and wraps a global grid', () => {
	const arpege = MODELS.arpege01.grid;
	assert.deepEqual(nearest(arpege, 72, -32), { i: 0, j: 0 });
	assert.deepEqual(nearest(arpege, 71.95, -31.95), { i: 1, j: 1 });
	assert.deepEqual(nearest(arpege, 71.96, -31.96), { i: 0, j: 0 });
	assert.deepEqual(nearest(arpege, 20, 42), { i: 740, j: 520 });
	assert.equal(nearest(arpege, 19.9, 42), null);
	const ifs = MODELS.ifs025.grid;
	for (const [lon, i] of [[-180, 0], [179.75, 1439], [179.9, 0], [180, 0], [0, 720], [-0.1, 720]] as const) {
		assert.equal(nearest(ifs, 0, lon)?.i, i, `lon ${lon}`);
	}
});

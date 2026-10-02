/* The Plan IGN offline pack across the language boundary: the app's own
 * reader (pmtiles.js through offline/filePmtiles.ts) opens an archive
 * written by cmd/planign's assembly and internal/pmtiles' writer
 * (tests/fixtures/planign-mini.pmtiles, rebuilt with `go test ./cmd/planign
 * -run TestFixtureIsCurrent -update`). The fixture holds the real build's
 * zooms and metadata, leaf directories (forced on a small pyramid), a run of
 * identical tiles and a tile stored once for two positions, so every path
 * the reader takes through a 1.3 GB archive is taken here. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TileType, Compression } from 'pmtiles';
import { archiveInfo, pmtilesFromFile } from '../src/lib/offline/filePmtiles';
import { basemapPackDef } from '../src/lib/offline/basemapPacks';

const buf = readFileSync(fileURLToPath(new URL('./fixtures/planign-mini.pmtiles', import.meta.url)));
const file = new File([buf], 'planign.pmtiles');

/** Paris's tile at zoom z, as cmd/planign's fixture places it. */
function paris(z: number): [number, number] {
	const n = 2 ** z;
	const lat = (48.8534 * Math.PI) / 180;
	return [
		Math.floor(((2.3488 + 180) / 360) * n),
		Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n),
	];
}

const bytes = (t: { data: ArrayBuffer } | undefined): Uint8Array => new Uint8Array(t?.data ?? new ArrayBuffer(0));
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

describe('the Plan IGN pack, as the app reads it', () => {
	it('carries the header the base layer is built from', async () => {
		const h = await pmtilesFromFile(file, 'fixture').getHeader();
		expect(h.specVersion).toBe(3);
		expect(h.tileType).toBe(TileType.Webp);
		expect(h.tileCompression).toBe(Compression.None);
		expect(h.internalCompression).toBe(Compression.Gzip);
		expect(h.clustered).toBe(true);
		expect(h.minZoom).toBe(0);
		// The Go build's last zoom IS the registry's: the map draws the pack to
		// it and the live layer only above it.
		expect(h.maxZoom).toBe(basemapPackDef('planign')?.maxNativeZoom);
		expect(h.leafDirectoryLength).toBeGreaterThan(0);
		expect(h.numAddressedTiles).toBe(17);
		expect(h.numTileContents).toBe(4);
	});

	it('states its edition and its licence in the metadata', async () => {
		const meta = (await pmtilesFromFile(file, 'fixture').getMetadata()) as Record<string, unknown>;
		expect(meta.version).toBe('2026-10-01');
		expect(meta.attribution).toContain('Licence Ouverte');
		expect(String(meta['loxodrome:digest'])).toMatch(/^[0-9a-f]{64}$/);
		const info = await archiveInfo(file, 'fixture');
		expect(info).toEqual({ minZoom: 0, maxZoom: basemapPackDef('planign')?.maxNativeZoom, edition: '2026-10-01' });
	});

	it('finds every tile through the leaf directories, and nothing where there is none', async () => {
		const pm = pmtilesFromFile(file, 'fixture');
		const [x13, y13] = paris(13);
		const deep = bytes(await pm.getZxy(13, x13, y13));
		expect(new TextDecoder().decode(deep.slice(0, 4))).toBe('RIFF');
		expect(new TextDecoder().decode(deep.slice(8, 12))).toBe('WEBP');
		for (let z = 2; z <= 13; z++) {
			const [x, y] = paris(z);
			expect(bytes(await pm.getZxy(z, x, y)).length, `z${z}`).toBeGreaterThan(0);
		}
		// Paris's eastern neighbour was absent in the harvest; zoom 14 is past
		// the archive, where the live layer takes over.
		expect(await pm.getZxy(13, x13 + 1, y13)).toBeUndefined();
		const [x14, y14] = paris(14);
		expect(await pm.getZxy(14, x14, y14)).toBeUndefined();
	});

	it('reads a run of identical tiles, and one tile stored once for two places', async () => {
		const pm = pmtilesFromFile(file, 'fixture');
		const sea = [await pm.getZxy(1, 0, 0), await pm.getZxy(1, 0, 1), await pm.getZxy(1, 1, 1)].map(bytes);
		expect(sea[0].length).toBeGreaterThan(0);
		expect(same(sea[0], sea[1]) && same(sea[1], sea[2])).toBe(true);
		const land0 = bytes(await pm.getZxy(0, 0, 0));
		const land1 = bytes(await pm.getZxy(1, 1, 0));
		expect(same(land0, land1)).toBe(true);
		expect(same(land0, sea[0])).toBe(false);
	});
});

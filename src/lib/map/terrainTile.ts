/* The elevation tile's reader: the other half of internal/terrain (Go), which
 * writes it. The format, and why it is shaped this way, are that package's
 * doc comment; this file is only the reader, and it is pinned against a
 * fixture the Go writer produced (tests/terrainTile.spec.ts), because a
 * reader pinned against its own writer proves only that it is
 * self-consistent.
 *
 *	0  : magic "LOXTERR1"        8 bytes
 *	8  : zoom, uint8             1 byte
 *	9  : bands, uint8            1 byte   1 = mean only, 3 = mean, max, min
 *	10 : reserved                2 bytes
 *	12 : x, uint32 LE            4 bytes
 *	16 : y, uint32 LE            4 bytes
 *	20 : mean plane              256*256 int16 LE, row-delta coded
 *	   : max - mean, mean - min  (bands == 3)
 *
 * Every failure reads as null rather than throwing: this runs on the boot
 * path of a corridor fetch, and a half-written or misrouted object must
 * degrade to a failed read the callers already handle (map/terrain.ts asks
 * it again later), never to terrain in the wrong place or an exception in an
 * effect.
 *
 * Pure: no DOM, no canvas, no Svelte. The bytes arrive gzipped and are
 * decompressed here rather than by the browser's Content-Encoding, so what
 * the offline pin stores and the service worker caches stays the compressed
 * 20 KB and not the 128 KiB grid. */

/** Opens every tile; tells a truncated or misrouted download from a real one
 *  before any plane is trusted. */
export const TERRAIN_MAGIC = 'LOXTERR1';

/** Tile edge in pixels, the slippy convention (map/terrain.ts TILE_SIZE). */
export const TERRAIN_TILE_SIZE = 256;

/** Pixels in one band. */
export const TERRAIN_PIXELS = TERRAIN_TILE_SIZE * TERRAIN_TILE_SIZE;

/** The magic, the zoom, the band count, the padding and the two coordinates. */
export const TERRAIN_HEADER_SIZE = 20;

/** A pixel no source covered. A SENTINEL, not a low value: a void that reads
 *  as an elevation is a void that reads as ground, and one in the Alps
 *  reading 0 m AMSL under a live aircraft would report the whole altitude as
 *  height above ground. Consumers treat it as unknown. */
export const TERRAIN_NODATA = -32768;

/** Bounds the compressed body the reader takes. What it inflates is bounded
 *  by MAX_RAW_BYTES. */
const MAX_COMPRESSED_BYTES = 4 << 20;

/** The largest tile there is, three bands: 384 KiB and the header. gunzip
 *  stops one byte past it, as internal/terrain's LimitReader does, so a
 *  body that inflates without end cannot make the reader allocate wildly. */
const MAX_RAW_BYTES = TERRAIN_HEADER_SIZE + 3 * TERRAIN_PIXELS * 2;

/** One addressed grid. `mean` is the value at the pixel, `max` / `min` the
 *  extremes of everything the pixel covers; a tile whose source has one value
 *  per pixel carries `mean` alone and reads back with the extremes null. */
export interface TerrainTile {
	z: number;
	x: number;
	y: number;
	mean: Int16Array;
	max: Int16Array | null;
	min: Int16Array | null;
}

async function gunzip(body: BufferSource): Promise<Uint8Array | null> {
	try {
		const reader = new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
		const chunks: Uint8Array[] = [];
		let n = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			n += value.byteLength;
			if (n > MAX_RAW_BYTES) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
		const raw = new Uint8Array(n);
		let at = 0;
		for (const c of chunks) {
			raw.set(c, at);
			at += c.byteLength;
		}
		return raw;
	} catch {
		return null;
	}
}

/** Undo the row delta in place: each row is its first value and the
 *  differences that follow. Int16Array assignment truncates to 16 bits, which
 *  is the wrapping the writer coded in, so a row crossing the NoData sentinel
 *  comes back like any other. */
function rowUndelta(p: Int16Array): void {
	for (let r = 0; r < TERRAIN_TILE_SIZE; r++) {
		const base = r * TERRAIN_TILE_SIZE;
		for (let i = 1; i < TERRAIN_TILE_SIZE; i++) {
			p[base + i] = p[base + i] + p[base + i - 1];
		}
	}
}

/** Read one tile, or null for anything the reader cannot fully account for.
 *  Int16Array over the buffer assumes a little-endian host, which every
 *  platform this app runs on is. */
export async function decodeTerrainTile(body: BufferSource): Promise<TerrainTile | null> {
	if (body.byteLength === 0 || body.byteLength > MAX_COMPRESSED_BYTES) {
		return null;
	}
	const raw = await gunzip(body);
	if (!raw || raw.byteLength < TERRAIN_HEADER_SIZE) {
		return null;
	}
	for (let i = 0; i < TERRAIN_MAGIC.length; i++) {
		if (raw[i] !== TERRAIN_MAGIC.charCodeAt(i)) {
			return null;
		}
	}
	const bands = raw[9];
	if (bands !== 1 && bands !== 3) {
		return null;
	}
	if (raw.byteLength !== TERRAIN_HEADER_SIZE + bands * TERRAIN_PIXELS * 2) {
		return null;
	}
	const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	const plane = (i: number): Int16Array => {
		const p = new Int16Array(
			raw.buffer.slice(
				raw.byteOffset + TERRAIN_HEADER_SIZE + i * TERRAIN_PIXELS * 2,
				raw.byteOffset + TERRAIN_HEADER_SIZE + (i + 1) * TERRAIN_PIXELS * 2,
			),
		);
		rowUndelta(p);
		return p;
	};

	const mean = plane(0);
	const tile: TerrainTile = {
		z: raw[8],
		x: view.getUint32(12, true),
		y: view.getUint32(16, true),
		mean,
		max: null,
		min: null,
	};
	if (bands === 3) {
		// The upper bands are stored as distances from the mean, and a pixel
		// with no data has no extremes: the sentinel is carried once.
		const hi = plane(1);
		const lo = plane(2);
		const max = new Int16Array(TERRAIN_PIXELS);
		const min = new Int16Array(TERRAIN_PIXELS);
		for (let i = 0; i < TERRAIN_PIXELS; i++) {
			const m = mean[i];
			if (m === TERRAIN_NODATA) {
				max[i] = TERRAIN_NODATA;
				min[i] = TERRAIN_NODATA;
				continue;
			}
			max[i] = m + hi[i];
			min[i] = m - lo[i];
		}
		tile.max = max;
		tile.min = min;
	}
	return tile;
}

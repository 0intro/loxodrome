/* The tiled-TIFF head reader over a synthetic file built here and over the
 * real head of a live OPERA frame (tests/fixtures/opera-head.bin, the first
 * 8 192 bytes of OPERA@20260920T0810@0@DBZH.tiff, EUMETNET, CC BY 4.0), plus
 * one real tile of it (opera-tile-42.bin, the tile holding Paris) decoded
 * against the values GDAL reads at the same cells. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inflateZlib } from '$lib/files/deflate';
import { isOperaLayout, parseTiledTiffHead, tileByteRange, tileIndex } from '$lib/files/tiff';
import { OPERA_GRID, OPERA_GRID_2KM } from '$lib/weather/laea';
import { decodeDbzTile } from '$lib/weather/radarDecode';
import { NODATA, UNDETECT } from '$lib/weather/opera';

const fixture = (name: string): Uint8Array =>
	new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
	const s = new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
	return new Uint8Array(await new Response(s).arrayBuffer());
}

interface Build {
	width: number;
	height: number;
	tileW: number;
	tileH: number;
	spp: number;
	tiles: Uint8Array[];
	littleEndian?: boolean;
	magic?: number;
	strips?: boolean;
	tiepoint?: [number, number];
	pixelScale?: [number, number];
	/** Point the tile-offsets array past the end of the file. */
	danglingArray?: boolean;
	/** The field type of the tile tables (324 / 325), LONG by default. */
	tableType?: number;
}

/** A classic TIFF: header, one IFD at 8, out-of-line values, tile data. */
function buildTiff(b: Build): Uint8Array {
	const le = b.littleEndian ?? true;
	const entries: { tag: number; type: number; values: number[] }[] = [];
	const push = (tag: number, type: number, values: number[]): void => {
		entries.push({ tag, type, values });
	};
	push(256, 4, [b.width]);
	push(257, 4, [b.height]);
	push(258, 3, Array<number>(b.spp).fill(32));
	push(259, 3, [8]);
	push(277, 3, [b.spp]);
	push(317, 3, [1]);
	push(339, 3, Array<number>(b.spp).fill(3));
	push(33550, 12, [b.pixelScale?.[0] ?? 1000, b.pixelScale?.[1] ?? 1000, 0]);
	push(33922, 12, [0, 0, 0, b.tiepoint?.[0] ?? 0, b.tiepoint?.[1] ?? 0, 0]);
	const n = b.tiles.length;
	const SIZE: Record<number, number> = { 3: 2, 4: 4, 12: 8 };
	// Layout: IFD (2 + 12 n + 4) then the out-of-line values, then the tiles.
	const nEntries = entries.length + 4;
	const ifdBytes = 2 + nEntries * 12 + 4;
	let valuesAt = 8 + ifdBytes;
	const sized = (values: number[], type: number): number => values.length * SIZE[type];
	let extra = 0;
	for (const e of entries) {
		if (sized(e.values, e.type) > 4) {
			extra += sized(e.values, e.type);
		}
	}
	extra += n > 1 ? 2 * 4 * n : 0;
	const dataAt = valuesAt + extra;
	const offsets: number[] = [];
	const counts: number[] = [];
	let at = dataAt;
	for (const t of b.tiles) {
		offsets.push(b.danglingArray ? at + 1_000_000 : at);
		counts.push(t.length);
		at += t.length;
	}
	if (b.strips) {
		push(273, 4, offsets);
		push(278, 4, [b.tileH]);
		push(279, 4, counts);
		push(284, 3, [1]);
	} else {
		push(322, 4, [b.tileW]);
		push(323, 4, [b.tileH]);
		push(324, b.tableType ?? 4, offsets);
		push(325, b.tableType ?? 4, counts);
	}
	entries.sort((x, y) => x.tag - y.tag);
	const total = at;
	const buf = new Uint8Array(total);
	const dv = new DataView(buf.buffer);
	buf[0] = le ? 0x49 : 0x4d;
	buf[1] = buf[0];
	dv.setUint16(2, b.magic ?? 42, le);
	dv.setUint32(4, 8, le);
	dv.setUint16(8, entries.length, le);
	let e = 10;
	for (const ent of entries) {
		dv.setUint16(e, ent.tag, le);
		dv.setUint16(e + 2, ent.type, le);
		dv.setUint32(e + 4, ent.values.length, le);
		const size = sized(ent.values, ent.type);
		let p: number;
		if (size <= 4) {
			p = e + 8;
		} else {
			p = valuesAt;
			dv.setUint32(e + 8, b.danglingArray && ent.tag === 324 ? total + 100 : valuesAt, le);
			valuesAt += size;
		}
		if (!(b.danglingArray && ent.tag === 324)) {
			for (let k = 0; k < ent.values.length; k++) {
				const q = p + k * SIZE[ent.type];
				if (ent.type === 3) dv.setUint16(q, ent.values[k], le);
				else if (ent.type === 4) dv.setUint32(q, ent.values[k], le);
				else dv.setFloat64(q, ent.values[k], le);
			}
		}
		e += 12;
	}
	dv.setUint32(e, 0, le);
	let d = dataAt;
	for (const t of b.tiles) {
		buf.set(t, d);
		d += t.length;
	}
	return buf;
}

/** A 32 x 32 two-sample tile whose first pixels carry the cases decode
 *  must tell apart. */
function tilePixels(): Float32Array {
	const f = new Float32Array(32 * 32 * 2).fill(NaN);
	for (let i = 0; i < 32 * 32; i++) {
		f[i * 2 + 1] = 1;
	}
	f[0] = NaN;
	f[2] = -9999000;
	f[4] = 34.6;
	f[6] = 65.5;
	f[8] = -32;
	f[10] = 150;
	return f;
}

describe('parseTiledTiffHead', () => {
	it('reads a synthetic tiled deflate file and decodes its tiles', async () => {
		const raw0 = new Uint8Array(tilePixels().buffer);
		const raw1 = new Uint8Array(new Float32Array(32 * 32 * 2).fill(12.25).buffer);
		const file = buildTiff({
			width: 64,
			height: 32,
			tileW: 32,
			tileH: 32,
			spp: 2,
			tiles: [await deflate(raw0), await deflate(raw1)],
			tiepoint: [-500, 500],
		});
		const l = parseTiledTiffHead(file)!;
		expect(l).not.toBeNull();
		expect(l.littleEndian).toBe(true);
		expect([l.width, l.height, l.tileWidth, l.tileHeight]).toEqual([64, 32, 32, 32]);
		expect([l.samplesPerPixel, l.bitsPerSample, l.sampleFormat, l.compression, l.predictor]).toEqual([2, 32, 3, 8, 1]);
		expect(l.tileOffsets).toHaveLength(2);
		expect(l.tiepoint).toEqual([-500, 500]);
		expect(l.pixelScale).toEqual([1000, 1000]);
		expect(tileIndex(l, 1, 0)).toBe(1);
		const r0 = tileByteRange(l, 0);
		const inflated = await inflateZlib(file.subarray(r0.start, r0.end), 1 << 20);
		expect(inflated.length).toBe(32 * 32 * 2 * 4);
		const dbz = decodeDbzTile(inflated);
		expect([...dbz.subarray(0, 6)]).toEqual([UNDETECT, NODATA, 35, 66, -32, 100]);
		const r1 = tileByteRange(l, 1);
		const second = decodeDbzTile(await inflateZlib(file.subarray(r1.start, r1.end), 1 << 20));
		expect(second[5]).toBe(12);
	});

	it('reads the head of a live OPERA frame and recognises the layout', () => {
		const l = parseTiledTiffHead(fixture('opera-head.bin'))!;
		expect(l).not.toBeNull();
		expect([l.width, l.height, l.tileWidth, l.tileHeight]).toEqual([3800, 4400, 512, 512]);
		expect(l.tileOffsets).toHaveLength(72);
		expect(l.tiepoint![0]).toBeCloseTo(-500, 3);
		expect(l.tiepoint![1]).toBeCloseTo(500, 3);
		expect(l.pixelScale).toEqual([1000, 1000]);
		expect(tileByteRange(l, 42)).toEqual({ start: 3227004, end: 3227004 + 43707 });
		expect(tileByteRange(l, 0)).toEqual({ start: 1622526, end: 1622526 + 8925 });
		expect(isOperaLayout(l, OPERA_GRID)).toBe(true);
		expect(isOperaLayout(l, OPERA_GRID_2KM)).toBe(false);
	});

	it('decodes a live tile to the values GDAL reads', async () => {
		const inflated = await inflateZlib(fixture('opera-tile-42.bin'), 4 << 20);
		expect(inflated.length).toBe(512 * 512 * 2 * 4);
		const dbz = decodeDbzTile(inflated);
		// Grid (row 2738, col 1405) is Paris CDG, dry at 08:10Z; the two
		// others are light echoes north-west of it. Local = (row - 2560,
		// col - 1024).
		expect(dbz[(2738 - 2560) * 512 + (1405 - 1024)]).toBe(UNDETECT);
		expect(dbz[(2650 - 2560) * 512 + (1200 - 1024)]).toBe(-2);
		expect(dbz[(2660 - 2560) * 512 + (1224 - 1024)]).toBe(-1);
		let nodata = 0;
		let undetect = 0;
		let echo = 0;
		for (const v of dbz) {
			if (v === NODATA) nodata++;
			else if (v === UNDETECT) undetect++;
			else echo++;
		}
		expect([nodata, undetect, echo]).toEqual([0, 226684, 35460]);
	});

	it('refuses what it does not speak', async () => {
		const tile = await deflate(new Uint8Array(32 * 32 * 2 * 4));
		const base: Build = { width: 32, height: 32, tileW: 32, tileH: 32, spp: 2, tiles: [tile] };
		expect(parseTiledTiffHead(buildTiff({ ...base, magic: 43 }))).toBeNull();
		expect(parseTiledTiffHead(buildTiff({ ...base, strips: true }))).toBeNull();
		// Two tiles, so the offsets array is out of line and can dangle.
		expect(
			parseTiledTiffHead(buildTiff({ ...base, width: 64, tiles: [tile, tile], danglingArray: true })),
		).toBeNull();
		// Tile tables are byte offsets and counts, SHORT or LONG: a float one
		// passed every range test as NaN (the relay refuses it the same way).
		expect(parseTiledTiffHead(buildTiff({ ...base, width: 64, tiles: [tile, tile], tableType: 12 }))).toBeNull();
		expect(parseTiledTiffHead(new Uint8Array([0x49, 0x49, 42, 0]))).toBeNull();
		expect(parseTiledTiffHead(new Uint8Array(0))).toBeNull();
		const big = parseTiledTiffHead(buildTiff({ ...base, littleEndian: false }))!;
		expect(big.littleEndian).toBe(false);
		expect(big.width).toBe(32);
		// A truncated head whose offset arrays lie beyond it.
		const real = fixture('opera-head.bin');
		expect(parseTiledTiffHead(real.subarray(0, 300))).toBeNull();
	});

	it('accepts only the OPERA CIRRUS layout under the 1 km grid', () => {
		const l = parseTiledTiffHead(fixture('opera-head.bin'))!;
		expect(isOperaLayout({ ...l, width: 3801 }, OPERA_GRID)).toBe(false);
		expect(isOperaLayout({ ...l, samplesPerPixel: 1 }, OPERA_GRID)).toBe(false);
		expect(isOperaLayout({ ...l, compression: 1 }, OPERA_GRID)).toBe(false);
		expect(isOperaLayout({ ...l, tiepoint: [12, 34] }, OPERA_GRID)).toBe(false);
		expect(isOperaLayout({ ...l, tiepoint: [0, 0] }, OPERA_GRID)).toBe(true);
		expect(isOperaLayout({ ...l, tiepoint: null }, OPERA_GRID)).toBe(true);
		expect(isOperaLayout({ ...l, pixelScale: [2000, 2000] }, OPERA_GRID)).toBe(false);
		expect(isOperaLayout({ ...l, littleEndian: false }, OPERA_GRID)).toBe(false);
		// The tile tables list exactly the grid's tiles, as the relay's guard
		// requires field for field: one short, and a view's last tile would
		// be sliced at an undefined byte count.
		expect(l.tileOffsets).toHaveLength(OPERA_GRID.tileCount);
		expect(isOperaLayout({ ...l, tileOffsets: l.tileOffsets.slice(0, -1) }, OPERA_GRID)).toBe(false);
		const longer = new Uint32Array(l.tileOffsets.length + 1);
		longer.set(l.tileOffsets);
		expect(isOperaLayout({ ...l, tileOffsets: longer }, OPERA_GRID)).toBe(false);
		expect(isOperaLayout({ ...l, height: l.height + 1 }, OPERA_GRID)).toBe(false);
	});

	it('skips an optional field whose value lies past the head, refuses a needed one', () => {
		// The live head with one entry's value pointer moved past 8 KB: the
		// GDAL_NODATA (42113) reads as absent; the tile offsets (324) refuse.
		const head = fixture('opera-head.bin');
		const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
		const ifd = dv.getUint32(4, true);
		const n = dv.getUint16(ifd, true);
		const moved = (tag: number): Uint8Array => {
			const copy = head.slice();
			const cv = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
			for (let i = 0; i < n; i++) {
				const e = ifd + 2 + i * 12;
				if (cv.getUint16(e, true) === tag) {
					cv.setUint32(e + 8, 9000, true);
				}
			}
			return copy;
		};
		const optional = parseTiledTiffHead(moved(42113));
		expect(optional).not.toBeNull();
		expect(optional!.nodata).toBeNull();
		expect(optional!.tileOffsets.length).toBe(72);
		expect(parseTiledTiffHead(moved(324))).toBeNull();
	});

	it('reads the producer\'s own GDAL_NODATA off both live heads', () => {
		// -9999000 today for both products; the decoder takes it from the
		// head rather than trusting a built-in the producer could move.
		expect(parseTiledTiffHead(fixture('opera-head.bin'))!.nodata).toBe(-9999000);
		expect(parseTiledTiffHead(fixture('opera-rate-head.bin'))!.nodata).toBe(-9999000);
	});

	it('reads the head of a live RATE frame and recognises the 2 km layout', () => {
		// The first 8 192 bytes of OPERA@20260920T1900@0@RATE.tiff (EUMETNET,
		// CC BY 4.0): 1900 x 2200 in 20 tiles, the tie point at the converter's
		// half-pixel slip of the 2 km cell.
		const l = parseTiledTiffHead(fixture('opera-rate-head.bin'))!;
		expect(l).not.toBeNull();
		expect([l.width, l.height, l.tileWidth, l.tileHeight]).toEqual([1900, 2200, 512, 512]);
		expect(l.tileOffsets).toHaveLength(20);
		expect(l.samplesPerPixel).toBe(2);
		expect(l.tiepoint![0]).toBeCloseTo(-1000, 3);
		expect(l.tiepoint![1]).toBeCloseTo(1000, 3);
		expect(l.pixelScale).toEqual([2000, 2000]);
		expect(isOperaLayout(l, OPERA_GRID_2KM)).toBe(true);
		expect(isOperaLayout(l, OPERA_GRID)).toBe(false);
	});

	it('accepts the RATE layout under the 2 km grid and refuses it under the 1 km one', async () => {
		// The NIMBUS shape: 1900 x 2200 in 20 tiles of 512, the tie point at
		// the converter's half-pixel slip of the 2 km cell.
		const tile = await deflate(new Uint8Array(32 * 32 * 2 * 4));
		const rate: Build = {
			width: 1900,
			height: 2200,
			tileW: 512,
			tileH: 512,
			spp: 2,
			tiles: Array.from({ length: 20 }, () => tile),
			tiepoint: [-1000, 1000],
			pixelScale: [2000, 2000],
		};
		const l = parseTiledTiffHead(buildTiff(rate))!;
		expect(l).not.toBeNull();
		expect(l.tileOffsets).toHaveLength(20);
		expect(isOperaLayout(l, OPERA_GRID_2KM)).toBe(true);
		expect(isOperaLayout(l, OPERA_GRID)).toBe(false);
		expect(isOperaLayout({ ...l, tiepoint: [0, 0] }, OPERA_GRID_2KM)).toBe(true);
		expect(isOperaLayout({ ...l, tiepoint: [-500, 500] }, OPERA_GRID_2KM)).toBe(false);
		expect(isOperaLayout({ ...l, pixelScale: [1000, 1000] }, OPERA_GRID_2KM)).toBe(false);
		expect(isOperaLayout({ ...l, width: 1901 }, OPERA_GRID_2KM)).toBe(false);
	});
});

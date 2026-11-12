/* tiff.ts: the directory of a TILED classic TIFF, read off the head of the
 * file alone. What the OPERA composite is (docs/precipitation-radar.md): a
 * cloud-optimized GeoTIFF whose five directories, tile offset and bytecount
 * arrays included, sit inside the first 6 KB, so one small read of the head
 * names every tile's byte range and a viewport never pulls the 3.5 MB
 * whole. Only what that file needs is read (IFD0, the tags below); anything
 * else, BigTIFF, a strip layout, a directory reaching past the bytes held,
 * answers null rather than a guess, since every offset in a TIFF is a claim
 * the bytes must be checked against (the XCSoar lesson). Pure. */

export interface TiffLayout {
	littleEndian: boolean;
	width: number;
	height: number;
	tileWidth: number;
	tileHeight: number;
	samplesPerPixel: number;
	/** The first sample's bit depth (the OPERA layout has equal samples). */
	bitsPerSample: number;
	/** TIFF SampleFormat: 1 unsigned, 2 signed, 3 IEEE float. */
	sampleFormat: number;
	/** TIFF Compression: 1 none, 8 Deflate (zlib streams). */
	compression: number;
	predictor: number;
	/** Byte offset of each tile, row-major over the tile grid. */
	tileOffsets: Uint32Array;
	tileByteCounts: Uint32Array;
	/** ModelTiepoint's model (x, y) for raster (0, 0); null when absent. */
	tiepoint: [number, number] | null;
	/** ModelPixelScale (sx, sy); null when absent. */
	pixelScale: [number, number] | null;
	/** GDAL_NODATA (tag 42113), the value the producer writes for no
	 *  coverage; null when absent or unreadable. */
	nodata: number | null;
}

const TAG_WIDTH = 256;
const TAG_HEIGHT = 257;
const TAG_BITS = 258;
const TAG_COMPRESSION = 259;
const TAG_STRIP_OFFSETS = 273;
const TAG_SAMPLES = 277;
const TAG_PREDICTOR = 317;
const TAG_TILE_WIDTH = 322;
const TAG_TILE_HEIGHT = 323;
const TAG_TILE_OFFSETS = 324;
const TAG_TILE_COUNTS = 325;
const TAG_SAMPLE_FORMAT = 339;
const TAG_PIXEL_SCALE = 33550;
const TAG_TIEPOINT = 33922;
const TAG_GDAL_NODATA = 42113;

/** Bytes per element of the TIFF field types read here. */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8 };
/** The most entries an IFD is allowed to claim (a real file has a few dozen). */
const MAX_ENTRIES = 512;
/** The fields the layout NEEDS, which must lie inside the head; any other
 *  field whose value lies past it (a GDAL_METADATA block the producer
 *  lengthened, a GeoASCIIParams) is skipped rather than refusing the frame:
 *  the relay bounds only these to the head, and a frame it relays must be
 *  one the client reads. */
const NEEDED_TAGS = new Set([
	TAG_WIDTH,
	TAG_HEIGHT,
	TAG_BITS,
	TAG_COMPRESSION,
	TAG_STRIP_OFFSETS,
	TAG_SAMPLES,
	TAG_PREDICTOR,
	TAG_TILE_WIDTH,
	TAG_TILE_HEIGHT,
	TAG_TILE_OFFSETS,
	TAG_TILE_COUNTS,
	TAG_SAMPLE_FORMAT,
]);

/** Parse the first directory of a tiled classic TIFF from its head bytes.
 *  Null for anything that is not that, or whose directory or needed fields
 *  reach past `head`. */
export function parseTiledTiffHead(head: Uint8Array): TiffLayout | null {
	if (head.length < 8) {
		return null;
	}
	const le = head[0] === 0x49 && head[1] === 0x49;
	const be = head[0] === 0x4d && head[1] === 0x4d;
	if (!le && !be) {
		return null;
	}
	const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
	// 42 is a classic TIFF; 43 is BigTIFF, whose 8-byte offsets this reader
	// does not speak.
	if (dv.getUint16(2, le) !== 42) {
		return null;
	}
	const ifd = dv.getUint32(4, le);
	if (ifd < 8 || ifd + 2 > head.length) {
		return null;
	}
	const n = dv.getUint16(ifd, le);
	if (n === 0 || n > MAX_ENTRIES || ifd + 2 + n * 12 > head.length) {
		return null;
	}
	const fields = new Map<number, number[]>();
	for (let i = 0; i < n; i++) {
		const e = ifd + 2 + i * 12;
		const tag = dv.getUint16(e, le);
		const type = dv.getUint16(e + 2, le);
		const count = dv.getUint32(e + 4, le);
		const size = TYPE_SIZE[type];
		if (size === undefined) {
			// An unknown field type is skipped, never guessed at.
			continue;
		}
		if ((tag === TAG_TILE_OFFSETS || tag === TAG_TILE_COUNTS) && type !== 3 && type !== 4) {
			// Byte offsets and counts are SHORT or LONG: a float table passed
			// every range test as NaN (the relay refuses it the same way).
			return null;
		}
		const total = size * count;
		const at = total <= 4 ? e + 8 : dv.getUint32(e + 8, le);
		if (at + total > head.length) {
			if (NEEDED_TAGS.has(tag)) {
				return null;
			}
			// An optional field past the head reads as absent.
			continue;
		}
		const vals: number[] = [];
		for (let k = 0; k < count; k++) {
			const p = at + k * size;
			switch (type) {
				case 1:
				case 2:
					vals.push(dv.getUint8(p));
					break;
				case 3:
					vals.push(dv.getUint16(p, le));
					break;
				case 4:
					vals.push(dv.getUint32(p, le));
					break;
				case 5:
					vals.push(dv.getUint32(p, le) / (dv.getUint32(p + 4, le) || 1));
					break;
				case 11:
					vals.push(dv.getFloat32(p, le));
					break;
				case 12:
					vals.push(dv.getFloat64(p, le));
					break;
			}
		}
		fields.set(tag, vals);
	}
	const one = (tag: number, fallback: number | null): number | null => {
		const v = fields.get(tag);
		return v && v.length > 0 ? v[0] : fallback;
	};
	const width = one(TAG_WIDTH, null);
	const height = one(TAG_HEIGHT, null);
	const tileWidth = one(TAG_TILE_WIDTH, null);
	const tileHeight = one(TAG_TILE_HEIGHT, null);
	const offsets = fields.get(TAG_TILE_OFFSETS);
	const counts = fields.get(TAG_TILE_COUNTS);
	if (
		width == null ||
		height == null ||
		tileWidth == null ||
		tileHeight == null ||
		!offsets ||
		!counts ||
		fields.has(TAG_STRIP_OFFSETS)
	) {
		return null;
	}
	if (width <= 0 || height <= 0 || tileWidth <= 0 || tileHeight <= 0) {
		return null;
	}
	const tiles = Math.ceil(width / tileWidth) * Math.ceil(height / tileHeight);
	if (offsets.length !== tiles || counts.length !== tiles) {
		return null;
	}
	const scale = fields.get(TAG_PIXEL_SCALE);
	const tie = fields.get(TAG_TIEPOINT);
	// An ASCII field arrives as its byte values, NUL-terminated.
	const nodataText = fields.get(TAG_GDAL_NODATA);
	const nodata = nodataText ? Number(String.fromCharCode(...nodataText).replace(/\0+$/, '').trim()) : NaN;
	return {
		littleEndian: le,
		width,
		height,
		tileWidth,
		tileHeight,
		samplesPerPixel: one(TAG_SAMPLES, 1) ?? 1,
		bitsPerSample: one(TAG_BITS, 1) ?? 1,
		sampleFormat: one(TAG_SAMPLE_FORMAT, 1) ?? 1,
		compression: one(TAG_COMPRESSION, 1) ?? 1,
		predictor: one(TAG_PREDICTOR, 1) ?? 1,
		tileOffsets: Uint32Array.from(offsets),
		tileByteCounts: Uint32Array.from(counts),
		tiepoint: tie && tie.length >= 5 ? [tie[3], tie[4]] : null,
		pixelScale: scale && scale.length >= 2 ? [scale[0], scale[1]] : null,
		nodata: Number.isFinite(nodata) ? nodata : null,
	};
}

/** Row-major tile index of tile column / row. */
export function tileIndex(layout: TiffLayout, tx: number, ty: number): number {
	return ty * Math.ceil(layout.width / layout.tileWidth) + tx;
}

/** Byte range [start, end) of one tile in the file. */
export function tileByteRange(layout: TiffLayout, idx: number): { start: number; end: number } {
	const start = layout.tileOffsets[idx];
	return { start, end: start + layout.tileByteCounts[idx] };
}

/** What a composite grid looks like in a GeoTIFF directory: the cell count,
 *  the tile count and the cell size. weather/laea.ts's OperaGrid satisfies
 *  it structurally (this module imports nothing of the weather's). */
export interface OperaLayoutExpectation {
	readonly cols: number;
	readonly rows: number;
	readonly tileCount: number;
	readonly cellM: number;
}

/** An OPERA composite layout, exactly: the expected grid in 512 px tiles,
 *  two Float32 samples a pixel (the value + quality), zlib tiles with no
 *  predictor, little-endian, and a tie point at the ODIM corner or the
 *  converter's half-pixel shift of it (-cellM/2, +cellM/2). Anything else
 *  is another product or another grid, and the app refuses it rather than
 *  drawing it where this grid says. */
export function isOperaLayout(l: TiffLayout, exp: OperaLayoutExpectation): boolean {
	const half = exp.cellM / 2;
	const tieOk =
		l.tiepoint == null ||
		(Math.abs(l.tiepoint[0]) < 1 && Math.abs(l.tiepoint[1]) < 1) ||
		(Math.abs(l.tiepoint[0] + half) < 1 && Math.abs(l.tiepoint[1] - half) < 1);
	const scaleOk =
		l.pixelScale == null ||
		(Math.abs(l.pixelScale[0] - exp.cellM) < 1e-6 && Math.abs(l.pixelScale[1] - exp.cellM) < 1e-6);
	return (
		l.littleEndian &&
		l.width === exp.cols &&
		l.height === exp.rows &&
		l.tileWidth === 512 &&
		l.tileHeight === 512 &&
		l.samplesPerPixel === 2 &&
		l.bitsPerSample === 32 &&
		l.sampleFormat === 3 &&
		l.compression === 8 &&
		l.predictor === 1 &&
		l.tileOffsets.length === exp.tileCount &&
		tieOk &&
		scaleOk
	);
}

/* A PMTiles v3 reader over ranged reads, just enough for the block archives
 * internal/nwp writes (internal/pmtiles is the writer): the header and root
 * directory in one read, leaf directories and tiles by range, gzip-compressed
 * directories and metadata, uncompressed tiles. Pure: the caller supplies the
 * range reads and decides what to cache. */

export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

export interface Header {
	rootOffset: number;
	rootLength: number;
	metadataOffset: number;
	metadataLength: number;
	leafOffset: number;
	leafLength: number;
	dataOffset: number;
	dataLength: number;
	internalCompression: number;
	tileCompression: number;
	minZoom: number;
	maxZoom: number;
}

export interface Entry {
	tileId: number;
	offset: number;
	length: number;
	runLength: number;
}

/** A directory's four columns in typed arrays, 24 bytes an entry: a JS
 *  object per entry cost about 80, and an isolate keeping 150 opened
 *  archives of IFS's 4 500 entries held 52 MB of its 128 in them. */
export interface Directory {
	tileId: Float64Array;
	offset: Float64Array;
	length: Uint32Array;
	runLength: Uint32Array;
}

export const HEADER_LEN = 127;
/** The writer keeps the header and the root directory inside 16 KiB. */
export const ROOT_LIMIT = 16384;

function u64(view: DataView, at: number): number {
	const lo = view.getUint32(at, true);
	const hi = view.getUint32(at + 4, true);
	return hi * 2 ** 32 + lo;
}

export function parseHeader(b: Uint8Array): Header {
	if (b.length < HEADER_LEN) {
		throw new Error('pmtiles: short header');
	}
	const magic = String.fromCharCode(...b.subarray(0, 7));
	if (magic !== 'PMTiles' || b[7] !== 3) {
		throw new Error('pmtiles: not a v3 archive');
	}
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	return {
		rootOffset: u64(v, 8),
		rootLength: u64(v, 16),
		metadataOffset: u64(v, 24),
		metadataLength: u64(v, 32),
		leafOffset: u64(v, 40),
		leafLength: u64(v, 48),
		dataOffset: u64(v, 56),
		dataLength: u64(v, 64),
		internalCompression: b[97],
		tileCompression: b[98],
		minZoom: b[100],
		maxZoom: b[101],
	};
}

export async function gunzip(b: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([b.slice()]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflateRaw(b: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([b.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decodes an uncompressed directory: the varint columns of the spec. */
export function decodeEntries(b: Uint8Array): Entry[] {
	const d = decodeDirectory(b);
	return Array.from(d.tileId, (tileId, i) => ({ tileId, offset: d.offset[i], length: d.length[i], runLength: d.runLength[i] }));
}

/** Decodes an uncompressed directory into its typed columns. */
export function decodeDirectory(b: Uint8Array): Directory {
	let pos = 0;
	const varint = (): number => {
		let result = 0;
		let shift = 1;
		for (;;) {
			if (pos >= b.length) {
				throw new Error('pmtiles: truncated directory');
			}
			const byte = b[pos++];
			result += (byte & 0x7f) * shift;
			if (byte < 0x80) {
				return result;
			}
			shift *= 128;
		}
	};
	const n = varint();
	const d: Directory = {
		tileId: new Float64Array(n),
		offset: new Float64Array(n),
		length: new Uint32Array(n),
		runLength: new Uint32Array(n),
	};
	let last = 0;
	for (let i = 0; i < n; i++) {
		last += varint();
		d.tileId[i] = last;
	}
	for (let i = 0; i < n; i++) {
		d.runLength[i] = varint();
	}
	for (let i = 0; i < n; i++) {
		d.length[i] = varint();
	}
	for (let i = 0; i < n; i++) {
		const v = varint();
		d.offset[i] = v === 0 && i > 0 ? d.offset[i - 1] + d.length[i - 1] : v - 1;
	}
	return d;
}

function rotate(n: number, x: number, y: number, rx: number, ry: number): [number, number] {
	if (ry === 0) {
		if (rx !== 0) {
			x = n - 1 - x;
			y = n - 1 - y;
		}
		return [y, x];
	}
	return [x, y];
}

/** The TileID of z/x/y: every lower zoom's tiles, then the Hilbert curve. */
export function zxyToTileId(z: number, x: number, y: number): number {
	let acc = (4 ** z - 1) / 3;
	if (z === 0) {
		return acc;
	}
	let n = z - 1;
	for (let s = 1 << n; s > 0; s >>= 1) {
		const rx = s & x ? 1 : 0;
		const ry = s & y ? 1 : 0;
		acc += ((3 * rx) ^ ry) * 2 ** (2 * n);
		[x, y] = rotate(s, x, y, rx, ry);
		n--;
	}
	return acc;
}

/** The entry holding id: its index, or -1. */
function find(d: Directory, id: number): number {
	let lo = 0;
	let hi = d.tileId.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const c = d.tileId[mid] - id;
		if (c < 0) {
			lo = mid + 1;
		} else if (c > 0) {
			hi = mid - 1;
		} else {
			return mid;
		}
	}
	// The last entry before id: a run, or a leaf covering id.
	if (hi >= 0 && (d.runLength[hi] === 0 || id - d.tileId[hi] < d.runLength[hi])) {
		return hi;
	}
	return -1;
}

/** One opened archive: its header, root directory and metadata. */
export class Archive {
	readonly header: Header;
	readonly metadata: unknown;
	private readonly root: Directory;
	private readonly read: ReadRange;
	private readonly leaves = new Map<number, Promise<Directory>>();

	private constructor(header: Header, root: Directory, metadata: unknown, read: ReadRange) {
		this.header = header;
		this.root = root;
		this.metadata = metadata;
		this.read = read;
	}

	/** Opens an archive from its first bytes (at least the header and the
	 *  root; the metadata too when they reach it, which saves a read). */
	static async open(head: Uint8Array, read: ReadRange): Promise<Archive> {
		const h = parseHeader(head);
		if (h.internalCompression !== 2) {
			throw new Error(`pmtiles: internal compression ${h.internalCompression}`);
		}
		const slice = async (off: number, len: number): Promise<Uint8Array> =>
			off + len <= head.length ? head.subarray(off, off + len) : read(off, len);
		const root = decodeDirectory(await gunzip(await slice(h.rootOffset, h.rootLength)));
		const meta: unknown = JSON.parse(new TextDecoder().decode(await gunzip(await slice(h.metadataOffset, h.metadataLength))));
		return new Archive(h, root, meta, read);
	}

	/** Where tile z/x/y lies in the file, or null when the archive does
	 *  not hold it. A leaf directory is read through `read`, the asking
	 *  request's (the archive outlives the request that opened it), and
	 *  kept for every later one. */
	async locate(
		z: number,
		x: number,
		y: number,
		read: ReadRange = this.read,
	): Promise<{ offset: number; length: number } | null> {
		const id = zxyToTileId(z, x, y);
		let dir = this.root;
		for (let depth = 0; depth < 3; depth++) {
			const i = find(dir, id);
			if (i < 0) {
				return null;
			}
			const offset = dir.offset[i];
			const length = dir.length[i];
			if (dir.runLength[i] > 0) {
				return { offset: this.header.dataOffset + offset, length };
			}
			let leaf = this.leaves.get(offset);
			if (!leaf) {
				leaf = read(this.header.leafOffset + offset, length).then(async (b) => decodeDirectory(await gunzip(b)));
				this.leaves.set(offset, leaf);
				leaf.catch(() => this.leaves.delete(offset));
			}
			dir = await leaf;
		}
		throw new Error('pmtiles: directories nested too deep');
	}
}

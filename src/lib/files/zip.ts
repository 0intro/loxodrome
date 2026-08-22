/* Minimal ZIP writer: the flights library's export-all bundles (traces in
 * their own formats, plans and aircraft as YAML, the logbook CSV) need one
 * downloadable archive, not a dependency.
 *
 * Two builders over one assembler. `buildZip` is STORE only (method 0) and
 * SYNCHRONOUS, which is all the small archives need. `buildZipDeflated` is
 * the one the whole-library bundle uses: a trace is text and deflates about
 * ten to one, which is the difference between a bundle a phone can carry and
 * one it cannot. Deflate goes through the platform's own
 * CompressionStream('deflate-raw'), the twin of the DecompressionStream the
 * container reader already uses (files/kmz.ts), so no dependency is added and
 * the builder is testable under node.
 *
 * UTF-8 names (general-purpose flag bit 11), per-entry DOS timestamps from
 * the caller's mtimeMs read as UTC (deterministic output for the pins; the
 * DOS format has no zone anyway), no zip64 (fine below 4 GB and 65535
 * entries, orders of magnitude above a flight library). Layout per
 * APPNOTE.TXT: local file headers + data, then the central directory, then
 * the end-of-central-directory record. Pure (no Svelte, no I/O;
 * tests/zip.spec.ts). */

import { deflateRaw } from './deflate';

export interface ZipEntry {
	/** Archive path, UTF-8. */
	name: string;
	/** File content; a string is UTF-8 encoded. */
	data: string | Uint8Array;
	/** Modification instant; absent or before the DOS epoch reads 1980. */
	mtimeMs?: number;
}

/** A name no other entry in the archive has yet, suffixed -2, -3, ... before
 *  the extension. Case-insensitive, because the archives are unpacked on
 *  systems that do not distinguish; extension-agnostic, unlike the plan
 *  catalog's yaml-only nextPlanName, since a bundle's traces arrive under
 *  whatever their own files were called and two of them may well be
 *  "track.gpx". */
export function uniqueEntryName(name: string, taken: Iterable<string>): string {
	const used = new Set<string>();
	for (const t of taken) {
		used.add(t.toLowerCase());
	}
	if (!used.has(name.toLowerCase())) {
		return name;
	}
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : '';
	for (let n = 2; ; n++) {
		const candidate = `${stem}-${n}${ext}`;
		if (!used.has(candidate.toLowerCase())) {
			return candidate;
		}
	}
}

/** Method 0: the bytes are stored as they are. */
const STORE = 0;
/** Method 8: deflate, raw (no zlib wrapper), which is what ZIP carries. */
const DEFLATE = 8;

/** One entry resolved to exactly what its headers will state. The CRC and
 *  `rawLength` are always the UNCOMPRESSED data's, whatever the method. */
interface Prepared {
	name: Uint8Array;
	/** What lands in the archive: the raw bytes, or the deflated ones. */
	data: Uint8Array;
	rawLength: number;
	crc: number;
	method: number;
	time: number;
	date: number;
}

const CRC_TABLE = ((): Uint32Array => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		t[n] = c >>> 0;
	}
	return t;
})();

/** Standard CRC-32 (the ZIP polynomial); crc32 of "123456789" is
 *  0xcbf43926, the format's own check value. */
export function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

/** DOS date+time words from an epoch instant, UTC, clamped to the DOS
 *  epoch (1980-01-01). */
function dosStamp(ms: number | undefined): { time: number; date: number } {
	const d = new Date(Math.max(ms ?? 0, Date.UTC(1980, 0, 1)));
	return {
		time:
			(d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
		date:
			((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
	};
}

/** The raw bytes, name and stamp of one entry, before a method is chosen. */
function rawOf(e: ZipEntry, enc: TextEncoder): Omit<Prepared, 'data' | 'method'> {
	const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
	const { time, date } = dosStamp(e.mtimeMs);
	return { name: enc.encode(e.name), rawLength: data.length, crc: crc32(data), time, date };
}

/** Write the headers around already-prepared entries. Entries keep the given
 *  order. The ArrayBuffer backing is part of the type so the result feeds
 *  Blob directly. */
function assemble(prepared: readonly Prepared[]): Uint8Array<ArrayBuffer> {
	const parts: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const p of prepared) {
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		local.setUint16(4, 20, true); // version needed (2.0 covers deflate)
		local.setUint16(6, 0x0800, true); // UTF-8 names
		local.setUint16(8, p.method, true);
		local.setUint16(10, p.time, true);
		local.setUint16(12, p.date, true);
		local.setUint32(14, p.crc, true);
		local.setUint32(18, p.data.length, true); // compressed size
		local.setUint32(22, p.rawLength, true); // uncompressed size
		local.setUint16(26, p.name.length, true);
		local.setUint16(28, 0, true);
		parts.push(new Uint8Array(local.buffer), p.name, p.data);
		const cen = new DataView(new ArrayBuffer(46));
		cen.setUint32(0, 0x02014b50, true);
		cen.setUint16(4, 20, true); // version made by
		cen.setUint16(6, 20, true); // version needed
		cen.setUint16(8, 0x0800, true);
		cen.setUint16(10, p.method, true);
		cen.setUint16(12, p.time, true);
		cen.setUint16(14, p.date, true);
		cen.setUint32(16, p.crc, true);
		cen.setUint32(20, p.data.length, true);
		cen.setUint32(24, p.rawLength, true);
		cen.setUint16(28, p.name.length, true);
		// extra, comment, disk, internal attrs, external attrs: zero
		cen.setUint32(42, offset, true); // local header offset
		central.push(new Uint8Array(cen.buffer), p.name);
		offset += 30 + p.name.length + p.data.length;
	}
	const cdSize = central.reduce((sum, p) => sum + p.length, 0);
	const eocd = new DataView(new ArrayBuffer(22));
	eocd.setUint32(0, 0x06054b50, true);
	eocd.setUint16(8, prepared.length, true);
	eocd.setUint16(10, prepared.length, true);
	eocd.setUint32(12, cdSize, true);
	eocd.setUint32(16, offset, true);
	const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
	const out = new Uint8Array(all.reduce((sum, p) => sum + p.length, 0));
	let at = 0;
	for (const p of all) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** Build a STORE-only archive, synchronously. */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
	const enc = new TextEncoder();
	return assemble(
		entries.map((e) => {
			const raw = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
			return { ...rawOf(e, enc), data: raw, method: STORE };
		}),
	);
}

/** Build a DEFLATED archive. Each member falls back to STORE when deflate
 *  does not actually shrink it (already-compressed bytes grow by the deflate
 *  block overhead, and a reader must never be handed a "compressed" member
 *  larger than its original). Members are deflated one at a time on purpose:
 *  a whole-library bundle is a hundred multi-hundred-KB traces, and running
 *  every stream at once would hold all of them in memory for no wall-clock
 *  gain on a single-threaded compressor. */
export async function buildZipDeflated(
	entries: readonly ZipEntry[],
): Promise<Uint8Array<ArrayBuffer>> {
	const enc = new TextEncoder();
	const prepared: Prepared[] = [];
	for (const e of entries) {
		const raw = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
		const head = rawOf(e, enc);
		const packed = await deflateRaw(raw);
		prepared.push(
			packed.length < raw.length
				? { ...head, data: packed, method: DEFLATE }
				: { ...head, data: raw, method: STORE },
		);
	}
	return assemble(prepared);
}

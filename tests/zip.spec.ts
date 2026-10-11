/* Pins for the ZIP writer (files/zip): the CRC check value, and the archive
 * structure read back by a tiny independent parser (local headers, central
 * directory, EOCD), so a writer bug cannot pin itself. A real-unzip
 * cross-check ran at authoring time (python3 zipfile + unzip -t both accept
 * the output).
 *
 * The deflating builder is pinned against node:zlib rather than against our
 * own reader, the kmz.spec discipline: a codec verified by its own twin
 * verifies nothing. */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { buildZip, buildZipDeflated, crc32, uniqueEntryName } from '$lib/files/zip';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('crc32', () => {
	it('matches the format check value', () => {
		expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
		expect(crc32(new Uint8Array(0))).toBe(0);
	});
});

describe('buildZip', () => {
	it('writes a structurally valid store archive', () => {
		const zip = buildZip([
			{ name: 'a.txt', data: 'hello', mtimeMs: Date.UTC(2026, 7, 11, 12, 34, 56) },
			{ name: 'dir/é.yaml', data: enc.encode('version: 1\n') },
		]);
		const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		// EOCD at the tail (no comment).
		const eocd = zip.length - 22;
		expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
		expect(dv.getUint16(eocd + 10, true)).toBe(2);
		const cdSize = dv.getUint32(eocd + 12, true);
		const cdOff = dv.getUint32(eocd + 16, true);
		expect(cdOff + cdSize).toBe(eocd);
		// Walk the central directory; verify each entry against its local
		// header and data.
		let at = cdOff;
		const names: string[] = [];
		for (let i = 0; i < 2; i++) {
			expect(dv.getUint32(at, true)).toBe(0x02014b50);
			expect(dv.getUint16(at + 10, true)).toBe(0); // store
			const crc = dv.getUint32(at + 16, true);
			const size = dv.getUint32(at + 20, true);
			const nameLen = dv.getUint16(at + 28, true);
			const local = dv.getUint32(at + 42, true);
			const name = dec.decode(zip.subarray(at + 46, at + 46 + nameLen));
			names.push(name);
			expect(dv.getUint32(local, true)).toBe(0x04034b50);
			expect(dv.getUint16(local + 6, true)).toBe(0x0800); // UTF-8 flag
			const localNameLen = dv.getUint16(local + 26, true);
			expect(dec.decode(zip.subarray(local + 30, local + 30 + localNameLen))).toBe(name);
			const data = zip.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size);
			expect(crc32(data)).toBe(crc);
			at += 46 + nameLen;
		}
		expect(names).toEqual(['a.txt', 'dir/é.yaml']);
		// The first entry's content round-trips.
		const firstData = zip.subarray(30 + enc.encode('a.txt').length, 30 + 5 + 5);
		expect(dec.decode(firstData)).toBe('hello');
		// DOS stamp of the first entry: 2026-08-11 12:34:56 UTC.
		expect(dv.getUint16(4 + 6, true)).toBe(
			(12 << 11) | (34 << 5) | (56 >> 1),
		);
		expect(dv.getUint16(4 + 8, true)).toBe(((2026 - 1980) << 9) | (8 << 5) | 11);
	});

	it('clamps a pre-DOS-epoch mtime and accepts an empty list', () => {
		const zip = buildZip([{ name: 'x', data: 'y', mtimeMs: 0 }]);
		const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		expect(dv.getUint16(12, true)).toBe((0 << 9) | (1 << 5) | 1); // 1980-01-01
		const empty = buildZip([]);
		expect(empty.length).toBe(22);
		expect(new DataView(empty.buffer).getUint32(0, true)).toBe(0x06054b50);
	});
});

/** Read one member back the way an independent tool would: central directory
 *  for the method and sizes, local header for the data offset, node:zlib for
 *  the inflate. */
function readEntries(zip: Uint8Array): { name: string; method: number; text: string }[] {
	const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	const eocd = zip.length - 22;
	const count = dv.getUint16(eocd + 10, true);
	const out: { name: string; method: number; text: string }[] = [];
	let at = dv.getUint32(eocd + 16, true);
	for (let i = 0; i < count; i++) {
		expect(dv.getUint32(at, true)).toBe(0x02014b50);
		const method = dv.getUint16(at + 10, true);
		const crc = dv.getUint32(at + 16, true);
		const packed = dv.getUint32(at + 20, true);
		const raw = dv.getUint32(at + 24, true);
		const nameLen = dv.getUint16(at + 28, true);
		const local = dv.getUint32(at + 42, true);
		const name = dec.decode(zip.subarray(at + 46, at + 46 + nameLen));
		const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
		const body = zip.subarray(start, start + packed);
		const bytes = method === 8 ? new Uint8Array(inflateRawSync(body)) : body;
		expect(bytes.length).toBe(raw);
		expect(crc32(bytes)).toBe(crc);
		out.push({ name, method, text: dec.decode(bytes) });
		at += 46 + nameLen;
	}
	return out;
}

describe('buildZipDeflated', () => {
	it('deflates compressible members, node:zlib reading them back', async () => {
		const body = 'GPX '.repeat(400);
		const zip = await buildZipDeflated([
			{ name: 'a.gpx', data: body, mtimeMs: Date.UTC(2026, 7, 11) },
			{ name: 'dir/é.yaml', data: enc.encode('version: 1\n') },
		]);
		const entries = readEntries(zip);
		expect(entries.map((e) => e.name)).toEqual(['a.gpx', 'dir/é.yaml']);
		expect(entries[0].method).toBe(8);
		expect(entries[0].text).toBe(body);
		expect(entries[1].text).toBe('version: 1\n');
		// The point of the exercise: it is much smaller than STORE.
		expect(zip.length).toBeLessThan(buildZip([{ name: 'a.gpx', data: body }]).length / 4);
	});

	it('falls back to STORE when deflate does not shrink the member', async () => {
		// Incompressible bytes: a deflate block would be LARGER, and a member
		// whose "compressed" size exceeds its original is a reader hazard.
		// A SHA-256 keystream is high-entropy AND deterministic, which
		// randomBytes would not be.
		const noise = new Uint8Array(2048);
		let block = createHash('sha256').update('loxodrome').digest();
		for (let at = 0; at < noise.length; at += 32) {
			noise.set(block.subarray(0, Math.min(32, noise.length - at)), at);
			block = createHash('sha256').update(block).digest();
		}
		const entries = readEntries(await buildZipDeflated([{ name: 'n.bin', data: noise }]));
		expect(entries[0].method).toBe(0);
	});

	it('accepts an empty list', async () => {
		expect((await buildZipDeflated([])).length).toBe(22);
	});
});

/* Two imported traces really can both be called "track.gpx": they are
 * different flights, and an archive that silently kept one of them would lose
 * the other on the way back in. */
describe('uniqueEntryName', () => {
	it('suffixes before the extension, case-insensitively', () => {
		const taken: string[] = [];
		for (const want of ['track.gpx', 'track-2.gpx', 'track-3.gpx']) {
			const got = uniqueEntryName('track.gpx', taken);
			expect(got).toBe(want);
			taken.push(got);
		}
		expect(uniqueEntryName('TRACK.GPX', taken)).toBe('TRACK-4.GPX');
	});

	it('handles a name with no extension and one with several dots', () => {
		expect(uniqueEntryName('logbook', ['logbook'])).toBe('logbook-2');
		expect(uniqueEntryName('2026-05-12.lfpl.igc', ['2026-05-12.lfpl.igc'])).toBe(
			'2026-05-12.lfpl-2.igc',
		);
	});
});

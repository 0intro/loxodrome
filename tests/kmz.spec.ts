/* Unit tests for the KMZ container reader (docs/trace-files.md). The
 * archives are built HERE with node:zlib rather than by the app's own writer
 * (which is STORE-only and could not exercise deflate at all), the zip.spec
 * discipline: a reader must be pinned against something it did not produce. */

import { describe, it, expect, vi } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { isZipBytes, kmzToKml, textOfBytes, zipEntries } from '$lib/files/kmz';

/** Every inflation the reader starts, counted through the real one. */
const inflations = vi.hoisted(() => ({ n: 0 }));
vi.mock('$lib/files/deflate', async (orig) => {
	const real = await orig<typeof import('$lib/files/deflate')>();
	return {
		...real,
		inflateRaw: (data: Uint8Array, maxBytes: number) => {
			inflations.n++;
			return real.inflateRaw(data, maxBytes);
		},
	};
});

const enc = new TextEncoder();

interface Member {
	name: string;
	/** Bytes for a member that is not text (a KMZ's images). */
	body: string | Uint8Array;
	/** 8 = deflate, 0 = stored. */
	method: number;
	/** Lie about the uncompressed size (the cap test). */
	declared?: number;
}

/** A minimal ZIP, written by hand so the reader has something foreign to
 *  read: local headers, then the central directory, then the EOCD with an
 *  optional trailing comment. */
function buildArchive(members: Member[], comment = ''): Uint8Array {
	const locals: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const m of members) {
		const raw = typeof m.body === 'string' ? enc.encode(m.body) : m.body;
		const data = m.method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
		const name = enc.encode(m.name);
		const local = new Uint8Array(30 + name.length + data.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(8, m.method, true);
		lv.setUint32(18, data.length, true);
		lv.setUint32(22, m.declared ?? raw.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);
		local.set(data, 30 + name.length);
		locals.push(local);

		const cd = new Uint8Array(46 + name.length);
		const cv = new DataView(cd.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(10, m.method, true);
		cv.setUint32(20, data.length, true);
		cv.setUint32(24, m.declared ?? raw.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		cd.set(name, 46);
		central.push(cd);
		offset += local.length;
	}
	const cdSize = central.reduce((n, c) => n + c.length, 0);
	const tail = enc.encode(comment);
	const eocd = new Uint8Array(22 + tail.length);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, members.length, true);
	ev.setUint16(10, members.length, true);
	ev.setUint32(12, cdSize, true);
	ev.setUint32(16, offset, true);
	ev.setUint16(20, tail.length, true);
	eocd.set(tail, 22);

	const total = offset + cdSize + eocd.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of [...locals, ...central, eocd]) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

const KML = '<?xml version="1.0"?><kml><Document><name>Essai</name></Document></kml>';

describe('isZipBytes', () => {
	it('knows the local-header magic', () => {
		expect(isZipBytes(buildArchive([{ name: 'doc.kml', body: KML, method: 8 }]))).toBe(true);
	});

	it('says no to text and to nothing', () => {
		expect(isZipBytes(enc.encode(KML))).toBe(false);
		expect(isZipBytes(new Uint8Array())).toBe(false);
		expect(isZipBytes(enc.encode('PK'))).toBe(false);
	});
});

describe('kmzToKml', () => {
	it('inflates a deflated member', async () => {
		const kmz = buildArchive([{ name: 'doc.kml', body: KML, method: 8 }]);
		expect(await kmzToKml(kmz)).toBe(KML);
	});

	it('reads a stored member too', async () => {
		const kmz = buildArchive([{ name: 'doc.kml', body: KML, method: 0 }]);
		expect(await kmzToKml(kmz)).toBe(KML);
	});

	it('skips what comes before the KML', async () => {
		const kmz = buildArchive([
			{ name: 'images/logo.png', body: 'not a kml', method: 8 },
			{ name: 'files/track.KML', body: KML, method: 8 },
		]);
		expect(await kmzToKml(kmz)).toBe(KML);
	});

	it('finds the directory behind a ZIP comment', async () => {
		const kmz = buildArchive([{ name: 'doc.kml', body: KML, method: 8 }], 'written by a tool');
		expect(await kmzToKml(kmz)).toBe(KML);
	});

	it('refuses an archive with no KML inside', async () => {
		const kmz = buildArchive([{ name: 'notes.txt', body: 'hello', method: 8 }]);
		await expect(kmzToKml(kmz)).rejects.toThrow(/no \.kml/i);
	});

	it('refuses a member that claims to be enormous, before inflating it', async () => {
		const kmz = buildArchive([
			{ name: 'doc.kml', body: KML, method: 8, declared: 1024 * 1024 * 1024 },
		]);
		await expect(kmzToKml(kmz)).rejects.toThrow(/too large/i);
	});

	it('refuses a compression method it cannot read', async () => {
		const kmz = buildArchive([{ name: 'doc.kml', body: KML, method: 12 }]);
		await expect(kmzToKml(kmz)).rejects.toThrow(/compression method/i);
	});

	it('refuses a file that is not an archive at all', async () => {
		await expect(kmzToKml(enc.encode('PK and then rubbish'))).rejects.toThrow(
			/ZIP directory/i,
		);
	});
});

describe('textOfBytes', () => {
	it('unwraps a container and passes text through', async () => {
		expect(await textOfBytes(buildArchive([{ name: 'doc.kml', body: KML, method: 8 }]))).toBe(KML);
		expect(await textOfBytes(enc.encode(KML))).toBe(KML);
	});

	it('decodes UTF-8 accents', async () => {
		expect(await textOfBytes(enc.encode('Étampes'))).toBe('Étampes');
	});
});

describe('zipEntries', () => {
	it('hands back every text member, in directory order', async () => {
		const bundle = buildArchive([
			{ name: 'a.gpx', body: '<gpx/>', method: 8 },
			{ name: 'logbook.csv', body: 'date,departure_place', method: 0 },
			{ name: 'plans/x.yaml', body: 'routes:\n', method: 8 },
		]);
		expect((await zipEntries(bundle)).map((m) => [m.name, m.text])).toEqual([
			['a.gpx', '<gpx/>'],
			['logbook.csv', 'date,departure_place'],
			['plans/x.yaml', 'routes:\n'],
		]);
	});

	/* The discrimination rule the importer rests on: a KMZ yields ONE member
	 * the app recognises, a bundle yields several. Its images must not be
	 * decoded into strings on the way, whether stored or deflated. */
	it('skips a KMZ\'s binary members, stored or deflated', async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
		const kmz = buildArchive([
			{ name: 'images/logo.png', body: png, method: 0 },
			{ name: 'images/mark.png', body: png, method: 8 },
			{ name: 'doc.kml', body: KML, method: 8 },
		]);
		expect((await zipEntries(kmz)).map((m) => [m.name, m.text])).toEqual([['doc.kml', KML]]);
	});

	it('skips directory entries and empty members', async () => {
		const bundle = buildArchive([
			{ name: 'plans/', body: '', method: 0 },
			{ name: 'empty.txt', body: '', method: 0 },
			{ name: 'a.igc', body: 'AXLOX', method: 0 },
		]);
		expect((await zipEntries(bundle)).map((m) => [m.name, m.text])).toEqual([['a.igc', 'AXLOX']]);
	});

	/* One bad member must not cost the caller the archive: the bundle is a
	 * whole flight library, and losing it all to one unreadable entry is the
	 * failure this rule exists to prevent. */
	it('skips an oversized or unreadable member and keeps the rest', async () => {
		const bundle = buildArchive([
			{ name: 'huge.gpx', body: '<gpx/>', method: 8, declared: 1024 * 1024 * 1024 },
			{ name: 'odd.gpx', body: '<gpx/>', method: 12 },
			{ name: 'good.gpx', body: '<gpx/>', method: 8 },
		]);
		expect((await zipEntries(bundle)).map((m) => [m.name, m.text])).toEqual([['good.gpx', '<gpx/>']]);
	});

	it('refuses a file that is not an archive at all', async () => {
		await expect(zipEntries(enc.encode('PK and then rubbish'))).rejects.toThrow(
			/ZIP directory/i,
		);
	});
});

/* An archive whose members all claim one byte and inflate past the member
 * cap: the cap held each one, but a member it stopped was skipped without
 * being charged to the archive's budget, so every one was tried. 4096 entries
 * sharing one 65 KB stream make a 278 KB file that drives 256 GiB of
 * inflation, the denial of service the budget exists to stop. */
describe('zipEntries under a hostile archive', () => {
	// 64 MiB and one more 64 KiB block of zeros deflate to about 65 KB.
	const bomb = new Uint8Array(deflateRawSync(new Uint8Array(64 * 1024 * 1024 + 65536)));

	/** Local headers at the given offsets of `locals` distinct copies of
	 *  the stream, and a central directory of `entries` members pointing at
	 *  them in turn, every one declaring one byte. */
	function hostile(locals: number, entries: number): Uint8Array {
		const name = enc.encode('a.gpx');
		const local = new Uint8Array(30 + name.length + bomb.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(8, 8, true);
		lv.setUint32(18, bomb.length, true);
		lv.setUint32(22, 1, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);
		local.set(bomb, 30 + name.length);
		const cd = new Uint8Array(entries * (46 + name.length));
		for (let i = 0; i < entries; i++) {
			const at = i * (46 + name.length);
			const cv = new DataView(cd.buffer, at);
			cv.setUint32(0, 0x02014b50, true);
			cv.setUint16(10, 8, true);
			cv.setUint32(20, bomb.length, true);
			cv.setUint32(24, 1, true);
			cv.setUint16(28, name.length, true);
			cv.setUint32(42, (i % locals) * local.length, true);
			cd.set(name, at + 46);
		}
		const eocd = new Uint8Array(22);
		const ev = new DataView(eocd.buffer);
		ev.setUint32(0, 0x06054b50, true);
		ev.setUint16(8, entries, true);
		ev.setUint16(10, entries, true);
		ev.setUint32(12, cd.length, true);
		ev.setUint32(16, locals * local.length, true);
		const out = new Uint8Array(locals * local.length + cd.length + eocd.length);
		for (let i = 0; i < locals; i++) {
			out.set(local, i * local.length);
		}
		out.set(cd, locals * local.length);
		out.set(eocd, locals * local.length + cd.length);
		return out;
	}

	it('charges a member stopped at its cap, so the budget ends the walk', async () => {
		// Ten members of their own: eight caps of 64 MiB are the 512 MiB.
		inflations.n = 0;
		expect(await zipEntries(hostile(10, 10))).toEqual([]);
		expect(inflations.n).toBe(8);
	});

	it('reads one member once, however many entries point at it', async () => {
		inflations.n = 0;
		expect(await zipEntries(hostile(1, 12))).toEqual([]);
		expect(inflations.n).toBe(1);
	});
});

/* zipEntries hands back the member's BYTES, which is what lets an imported
 * trace be stored and re-exported unchanged. A decoded string would already
 * have lost the BOM below. */
describe('zipEntries bytes', () => {
	it('returns the member bytes verbatim, and its stored timestamp', async () => {
		const raw = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('<gpx/>')]);
		const bundle = buildArchive([
			{ name: 'a.gpx', body: raw, method: 8 },
			{ name: 'b.gpx', body: '<gpx/>', method: 8 },
		]);
		const [a] = await zipEntries(bundle);
		expect(a.bytes).toEqual(raw);
		expect(a.text).not.toContain('\ufeff'.repeat(2));
		expect(typeof a.mtimeMs).toBe('number');
	});
});

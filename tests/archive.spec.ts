/* The container classifier (files/archive.ts): is this ZIP one document or a
 * whole flights library?
 *
 * This is the rule that lets the bundle carry no manifest and no format
 * version of its own, so it is the rule worth pinning hardest. The archives
 * are built HERE with node:zlib, the kmz.spec discipline: a reader pinned
 * against its own writer pins nothing.
 */

import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { itemsOf, readArchive, readIncoming } from '$lib/files/archive';

const enc = new TextEncoder();

const GPX = '<?xml version="1.0"?><gpx version="1.1"><trk><trkseg/></trk></gpx>';
const KML = '<?xml version="1.0"?><kml><Document><name>Vol</name></Document></kml>';
const IGC = 'AXLOX001\r\nHFDTEDATE:120526,01\r\nB1003004845000N00226000EA0012300145\r\n';
const ROUTES = 'version: 1\nroutes:\n  - name: LFPL-LFQB\n';
const AIRCRAFT = 'version: 1\naircraft:\n  registration: F-GJQK\n';
const CSV = 'date,departure_place,departure_time,arrival_place\n2026-05-12,LFPL,10:03,LFQB\n';

interface Member {
	name: string;
	body: string | Uint8Array;
}

/** A deflated ZIP, written by hand so the reader has something foreign. */
function archive(members: Member[]): Uint8Array {
	const locals: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const m of members) {
		const raw = typeof m.body === 'string' ? enc.encode(m.body) : m.body;
		const data = new Uint8Array(deflateRawSync(raw));
		const name = enc.encode(m.name);
		const local = new Uint8Array(30 + name.length + data.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(8, 8, true); // deflate
		lv.setUint32(18, data.length, true);
		lv.setUint32(22, raw.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);
		local.set(data, 30 + name.length);
		locals.push(local);

		const cd = new Uint8Array(46 + name.length);
		const cv = new DataView(cd.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(10, 8, true);
		cv.setUint32(20, data.length, true);
		cv.setUint32(24, raw.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		cd.set(name, 46);
		central.push(cd);
		offset += local.length;
	}
	const cdSize = central.reduce((n, c) => n + c.length, 0);
	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, members.length, true);
	ev.setUint16(10, members.length, true);
	ev.setUint32(12, cdSize, true);
	ev.setUint32(16, offset, true);
	const out = new Uint8Array(offset + cdSize + 22);
	let at = 0;
	for (const part of [...locals, ...central, eocd]) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

describe('readArchive', () => {
	it('reads every kind the application hands out', async () => {
		const members = await readArchive(
			archive([
				{ name: 'a.gpx', body: GPX },
				{ name: 'b.igc', body: IGC },
				{ name: 'c.kml', body: KML },
				{ name: 'logbook.csv', body: CSV },
				{ name: 'plans/lfpl-lfqb.yaml', body: ROUTES },
				{ name: 'aircraft/f-gjqk.yaml', body: AIRCRAFT },
			]),
		);
		expect(members.map((m) => [m.name, m.kind])).toEqual([
			['a.gpx', 'gpx'],
			['b.igc', 'igc'],
			['c.kml', 'kml'],
			['logbook.csv', 'logbook'],
			['plans/lfpl-lfqb.yaml', 'routes'],
			['aircraft/f-gjqk.yaml', 'aircraft'],
		]);
	});

	it('drops what it does not recognise without a word', async () => {
		const members = await readArchive(
			archive([
				{ name: 'images/logo.png', body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]) },
				{ name: 'readme.txt', body: 'nothing aeronautical here' },
				{ name: 'doc.kml', body: KML },
			]),
		);
		expect(members.map((m) => m.name)).toEqual(['doc.kml']);
	});
});

describe('readIncoming', () => {
	it('passes plain bytes through as one file', async () => {
		const got = await readIncoming('t.gpx', enc.encode(GPX));
		expect(got.kind === 'single' && [got.name, got.text]).toEqual(['t.gpx', GPX]);
		expect(got.kind === 'single' && got.bytes).toEqual(enc.encode(GPX));
	});

	/* A KMZ is packaging around ONE document; its images do not make it a
	 * library. The OUTER name wins: Google Earth always writes `doc.kml`, so three
	 * tours would otherwise all be filed and reported under that one name. */
	it('reads a KMZ as a single document, under the file\'s own name', async () => {
		const got = await readIncoming(
			'Vol_LFPL-LFQB.kmz',
			archive([
				{ name: 'images/logo.png', body: new Uint8Array([0x89, 0x50, 0, 1]) },
				{ name: 'doc.kml', body: KML },
			]),
		);
		expect(got.kind === 'single' && [got.name, got.text]).toEqual(['Vol_LFPL-LFQB.kmz', KML]);
	});

	it('reads a bundle as its members', async () => {
		const incoming = await readIncoming(
			'flights-20260817.zip',
			archive([
				{ name: 'a.gpx', body: GPX },
				{ name: 'logbook.csv', body: CSV },
				{ name: 'plans/x.yaml', body: ROUTES },
			]),
		);
		expect(incoming.kind).toBe('bundle');
		expect(incoming.kind === 'bundle' && incoming.members.map((m) => m.kind)).toEqual([
			'gpx',
			'logbook',
			'routes',
		]);
	});

	/* THE case a "does it contain a .kml?" test would get wrong. With the
	 * trace format set to KML, a bundle is an archive of .kml files, and
	 * reading it as one Google Earth document would import the first flight
	 * and silently drop the rest. */
	it('reads a bundle of KML traces as a bundle, not as a KMZ', async () => {
		const incoming = await readIncoming(
			'flights.zip',
			archive([
				{ name: 'Loxodrome 20260512-1003.kml', body: KML },
				{ name: 'Loxodrome 20260519-0912.kml', body: KML },
				{ name: 'logbook.csv', body: CSV },
			]),
		);
		expect(incoming.kind).toBe('bundle');
		expect(incoming.kind === 'bundle' && incoming.members.length).toBe(3);
	});

	/* A single-trace archive is a single trace: it belongs in the Navigation
	 * tab, not in a batch import. */
	it('reads a one-trace archive as that trace', async () => {
		const got = await readIncoming('one.zip', archive([{ name: 'a.gpx', body: GPX }]));
		expect(got.kind === 'single' && got.text).toBe(GPX);
	});

	/* But an archive holding ONE PLAN is a library with one plan in it, never
	 * a loose route file: reading it as `single` sent it to the dispatcher,
	 * which loads a route straight into the workspace and replaces what the
	 * pilot is flying. Only a TRACE can be what an archive is packaging. */
	it('reads a one-plan archive as a bundle, not as a route file', async () => {
		const got = await readIncoming('one.zip', archive([{ name: 'plans/x.yaml', body: ROUTES }]));
		expect(got.kind).toBe('bundle');
	});

	it('reports an archive holding nothing readable', async () => {
		expect(
			await readIncoming('photos.zip', archive([{ name: 'readme.txt', body: 'hello' }])),
		).toEqual({ kind: 'empty' });
	});
});

/* The doors must agree. The dispatcher built its own item list and carried
 * only {name, text}, so a bundle arriving by "Open with" filed every trace
 * from a re-encoding of its decoded text; the same bundle picked in the
 * surface kept its bytes. Measured on a Latin-1 IGC: identical off the
 * desktop picker, corrupt off the phone's intent. */
describe('itemsOf', () => {
	it('carries every member\'s own bytes and stamp', async () => {
		// A real IGC (the sniffer wants a B record) whose pilot header is
		// ISO-8859-1, which is what loggers actually write.
		const raw = new Uint8Array([
			...enc.encode('AXXX9ZZ\r\nHFDTE150326\r\nHFPLTPILOTINCHARGE:H'),
			0xe9,
			...enc.encode('lio\r\n' + IGC.split('\r\n')[2] + '\r\n'),
		]);
		const incoming = await readIncoming(
			'flights.zip',
			archive([
				{ name: 'a.igc', body: raw },
				{ name: 'plans/x.yaml', body: ROUTES },
			]),
		);
		const items = itemsOf('flights.zip', incoming);
		expect(items.map((i) => i.name)).toEqual(['a.igc', 'plans/x.yaml']);
		// The bytes, not a re-encoding of the text: 0xE9 survives, U+FFFD never appears.
		expect(items[0].bytes).toEqual(raw);
		expect(new TextEncoder().encode(items[0].text)).not.toEqual(raw);
		expect(typeof items[1].mtimeMs).toBe('number');
	});

	it('carries a plain file\'s bytes too', async () => {
		const raw = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(GPX)]);
		const items = itemsOf('t.gpx', await readIncoming('t.gpx', raw));
		expect(items[0].bytes).toEqual(raw);
	});
});

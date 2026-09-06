/* The incoming-file sniffer (files/detect.ts). A file arriving from outside
 * (an Android VIEW / SEND intent, the ?file= boot parameter) states no kind:
 * route and aircraft files share the .yaml extension and Android display names
 * are often opaque, so the content has to decide. Pinned against the real
 * artefacts: a document from the saved-route writer, a sheet from the
 * committed fleet, this app's own GPX export, and briefing fixtures. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { detectFileKind } from '$lib/files/detect';
import { buildRoutesDoc, stringifyRoutesDoc } from '$lib/route/yaml';
import { buildGpx } from '$lib/nav/gpx';
import { buildIgc } from '$lib/nav/igc';
import { buildKml } from '$lib/nav/kml';
import { buildLogbookCsv } from '$lib/nav/logbook';

function fixture(file: string): string {
	return readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf-8');
}

const routesYaml = stringifyRoutesDoc(
	buildRoutesDoc([
		{
			name: 'LFPL-LFPU',
			waypoints: [
				{ kind: 'airport', ident: 'LFPL', lat: 48.6, lon: 2.68, alt: 2500, altAuto: true },
				{ kind: 'airport', ident: 'LFPU', lat: 49.1, lon: 2.6, alt: 2500, altAuto: true },
			],
		},
	]),
);

const aircraftYaml = readFileSync(
	new URL('../public/data/aircraft/f-gorq.yaml', import.meta.url),
	'utf-8',
);

const tracePoints = [
	{ timeMs: 1_770_000_000_000, lat: 48.6, lon: 2.68, altFt: 1200 },
	{ timeMs: 1_770_000_060_000, lat: 48.7, lon: 2.7, altFt: 2400 },
];

const gpx = buildGpx(tracePoints);

describe('detectFileKind', () => {
	it('reads a saved route workspace', () => {
		expect(detectFileKind('LFPL-LFPU.yaml', routesYaml)).toBe('routes');
		// The name is only a hint: the same document under any name.
		expect(detectFileKind('', routesYaml)).toBe('routes');
		expect(detectFileKind('document', routesYaml)).toBe('routes');
	});

	it('reads an aircraft data sheet', () => {
		expect(detectFileKind('f-gorq.yaml', aircraftYaml)).toBe('aircraft');
		expect(detectFileKind('', aircraftYaml)).toBe('aircraft');
	});

	it("reads the app's own logbook CSV, with or without a BOM", () => {
		const csv = buildLogbookCsv([]);
		expect(detectFileKind('logbook.csv', csv)).toBe('logbook');
		expect(detectFileKind('', '\uFEFF' + csv)).toBe('logbook');
	});

	it('reads a plan in each of the four interchange formats', () => {
		// SDVFR's own exports, trimmed: the files this app has to take from the
		// application beside it (docs/route-files.md).
		for (const ext of ['gpx', 'kml', 'fpl', 'pln']) {
			const text = fixture(`sdvfr/route.${ext}`);
			expect(detectFileKind(`route.${ext}`, text)).toBe('plan');
			expect(detectFileKind('', text)).toBe('plan');
		}
	});

	it('tells a route GPX or KML from a trace in the same format', () => {
		// The pair this change exists for: one extension, two kinds of file.
		expect(detectFileKind('x.gpx', fixture('sdvfr/route.gpx'))).toBe('plan');
		expect(detectFileKind('x.gpx', gpx)).toBe('gpx');
		expect(detectFileKind('x.kml', fixture('sdvfr/route.kml'))).toBe('plan');
		expect(detectFileKind('x.kml', buildKml(tracePoints, { name: 'x' }))).toBe('kml');
	});

	it('looks past the head for the route a long FPL states after its table', () => {
		// An FPL writes its waypoint table first, so the route sits behind it:
		// this app's own 22-point plan puts the first route-point at character
		// 4048, and one plan longer would be refused by a head-sized look.
		const fpl = fixture('sdvfr/route.fpl');
		const padded = fpl.replace(
			'</waypoint-table>',
			'<waypoint><identifier>PAD</identifier><type>USER WAYPOINT</type><country-code/>' +
				'<lat>48.5</lat><lon>2.5</lon>' +
				`<comment/><waypoint-description>${'PADDING '.repeat(600)}</waypoint-description></waypoint>` +
				'</waypoint-table>',
		);
		expect(padded.indexOf('<route-point>')).toBeGreaterThan(4096);
		expect(detectFileKind('', padded)).toBe('plan');
	});

	it('looks past the head for the route evidence a KML buries', () => {
		// SDVFR writes kilobytes of <Style> before its first placemark, so the
		// 4096 characters the cheap probes read hold no evidence at all.
		expect(fixture('sdvfr/route.kml').indexOf('<Point>')).toBeGreaterThan(4096);
		expect(detectFileKind('', fixture('sdvfr/route.kml'))).toBe('plan');
	});

	it('reads a GPX trace, named or not', () => {
		expect(detectFileKind('trace-20260806.gpx', gpx)).toBe('gpx');
		expect(detectFileKind('', gpx)).toBe('gpx');
	});

	it('reads an IGC trace, named or not', () => {
		const igc = buildIgc(tracePoints, { softwareVersion: '2.0.0' });
		expect(detectFileKind('2026-07-07.igc', igc)).toBe('igc');
		expect(detectFileKind('', igc)).toBe('igc');
	});

	it('reads a trace exported under the old name', () => {
		// Every trace this app wrote before the rename carries the word NOTAM:
		// the IGC A record opened "AXNV001NOTAM Viewer" and the KML named
		// itself "NOTAM Viewer <stamp>". Those files are on disks now, and the
		// regression this pins is that the word must not make one a briefing.
		const legacyIgc = buildIgc(tracePoints, { softwareVersion: '2.0.0' }).replace(
			'AXLX001Loxodrome',
			'AXNV001NOTAM Viewer',
		);
		expect(legacyIgc).toMatch(/^AXNV001NOTAM Viewer/);
		expect(detectFileKind('2026-07-07.igc', legacyIgc)).toBe('igc');
		expect(detectFileKind('', legacyIgc)).toBe('igc');

		const legacyKml = buildKml(tracePoints, { name: 'NOTAM Viewer 20260707-1432' });
		expect(detectFileKind('trace.kml', legacyKml)).toBe('kml');
		expect(detectFileKind('', legacyKml)).toBe('kml');
	});

	it('reads a KML trace, named or not', () => {
		const kml = buildKml(tracePoints, { name: 'Loxodrome 20260707-1432' });
		expect(detectFileKind('trace.kml', kml)).toBe('kml');
		expect(detectFileKind('', kml)).toBe('kml');
	});

	it('does not mistake a briefing for a trace', () => {
		// A briefing's own lines open with "B)" and its prose says AMSL: the
		// IGC probe wants a real fix record, not a letter.
		const pib = 'A0031/26 NOTAMN\nB) 2601010600 C) 2601312359\nE) OBST ERECTED AMSL 520FT';
		expect(detectFileKind('pib.txt', pib)).toBe('notams');
	});

	it('reads a NOTAM briefing in either language', () => {
		expect(detectFileKind('world.txt', fixture('world-en-20260610.txt'))).toBe('notams');
		// The French SOFIA PIB: no NOTAM word in its first lines, Q) items throughout.
		expect(detectFileKind('', fixture('EGPD-LFKC-20260207.txt'))).toBe('notams');
		expect(detectFileKind('Europe.txt', fixture('Europe-20260203.txt'))).toBe('notams');
	});

	it('refuses what it cannot read', () => {
		expect(detectFileKind('notes.txt', 'shopping list\nmilk\nbread\n')).toBeNull();
		expect(detectFileKind('map.png', 'PNG\r\n\n\0\0\0\rIHDR')).toBeNull();
		expect(detectFileKind('empty.txt', '')).toBeNull();
	});

	it('refuses a YAML document of ours that names no kind, briefing words and all', () => {
		// A corrupt route file must not be mistaken for a briefing and dumped
		// into the parser.
		const headerOnly = routesYaml.slice(0, routesYaml.indexOf('routes:'));
		expect(detectFileKind('LFPL-LFPU.yaml', headerOnly)).toBeNull();
		expect(detectFileKind('sheet.yaml', 'version: 1\nsomething: else\n')).toBeNull();
		// The same file saved under the old name says "NOTAM Viewer" in its
		// header comment, which is what put the YAML test above the briefing
		// markers in the first place. That order still has to hold.
		const legacyHeader = headerOnly.replace(
			'Saved by Loxodrome (loxodrome.fr)',
			'Saved by NOTAM Viewer (notam-viewer.net)',
		);
		expect(legacyHeader).toMatch(/NOTAM Viewer/);
		expect(detectFileKind('LFPL-LFPU.yaml', legacyHeader)).toBeNull();
	});
});

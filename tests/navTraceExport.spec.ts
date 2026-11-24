/* Unit tests for the trace export chokepoint (docs/trace-files.md): the
 * file name, the MIME, the format guard, the IGC downgrade, and the one
 * datum becoming two opposite altitude references. */

import { describe, it, expect } from 'vitest';
import {
	buildTraceExport,
	flightOfDay,
	isTraceFormat,
	resolveTraceFormat,
	TRACE_FORMATS,
	TRACE_FORMAT_LABEL,
} from '$lib/nav/traceExport';
import type { TrackPoint } from '$lib/nav/trace';

const T0 = Date.UTC(2026, 6, 7, 14, 32, 0);

const points: TrackPoint[] = [
	{ lat: 48.6747, lon: 2.1071, altFt: 1000, timeMs: T0 },
	{ lat: 48.72, lon: 2.2, altFt: 1500, timeMs: T0 + 60_000 },
];

/** A GPX imported without <time>: parseGpx synthesises a 1 Hz clock from 0. */
const timeless: TrackPoint[] = points.map((p, i) => ({ ...p, timeMs: i * 1000 }));

describe('isTraceFormat', () => {
	it('accepts the three formats and nothing else', () => {
		for (const f of TRACE_FORMATS) {
			expect(isTraceFormat(f)).toBe(true);
		}
		for (const junk of ['GPX', 'csv', '', null, undefined, 7]) {
			expect(isTraceFormat(junk)).toBe(false);
		}
	});
});

describe('resolveTraceFormat', () => {
	it('leaves a dated trace alone', () => {
		for (const f of TRACE_FORMATS) {
			expect(resolveTraceFormat(f, points)).toBe(f);
		}
	});

	it('degrades IGC to GPX when the trace has no UTC date to state', () => {
		expect(resolveTraceFormat('igc', timeless)).toBe('gpx');
		expect(resolveTraceFormat('kml', timeless)).toBe('kml');
	});
});

describe('buildTraceExport', () => {
	it('names, types and writes each format', () => {
		const at = { datum: 'msl', atMs: T0, subject: 'LFPN-LFOZ' } as const;
		const gpx = buildTraceExport(points, { format: 'gpx', ...at });
		expect(gpx.filename).toBe('LFPN-LFOZ_20260707T1432Z.gpx');
		expect(gpx.mime).toBe('application/gpx+xml');
		expect(gpx.text).toContain('<gpx version="1.1"');

		const igc = buildTraceExport(points, { format: 'igc', ...at });
		expect(igc.filename).toBe('LFPN-LFOZ_20260707T1432Z.igc');
		expect(igc.mime).toBe('text/plain');
		expect(igc.text).toMatch(/^AX/);

		const kml = buildTraceExport(points, { format: 'kml', ...at });
		expect(kml.filename).toBe('LFPN-LFOZ_20260707T1432Z.kml');
		expect(kml.mime).toBe('application/vnd.google-earth.kml+xml');
		expect(kml.text).toContain('<gx:Track>');
	});

	/* The subject is the flown aerodrome chain, and it is a FIELD: with none
	 * resolved it falls away rather than leaving a separator behind. */
	it('drops the subject field when the trace touched nothing known', () => {
		const f = buildTraceExport(points, { format: 'gpx', datum: 'msl', atMs: T0 });
		expect(f.filename).toBe('20260707T1432Z.gpx');
	});

	/* A file and the track inside it must not be called different things:
	 * Google Earth shows the second, the folder shows the first. */
	it('names the track inside the file after the file', () => {
		const gpx = buildTraceExport(points, {
			format: 'gpx',
			datum: 'msl',
			atMs: T0,
			subject: 'LFPN-LFOZ',
		});
		expect(gpx.text).toContain('<name>LFPN-LFOZ_20260707T1432Z</name>');
		// Provenance stays in the creator attribute, not in the track's name.
		expect(gpx.text).toContain('creator="Loxodrome"');
	});

	it('reports the format it actually wrote', () => {
		const f = buildTraceExport(timeless, { format: 'igc', datum: 'msl', atMs: T0 });
		expect(f.format).toBe('gpx');
		expect(f.filename.endsWith('.gpx')).toBe(true);
	});

	it('sends one datum to two opposite references', () => {
		const igc = buildTraceExport(points, { format: 'igc', datum: 'msl', atMs: T0 });
		const kml = buildTraceExport(points, { format: 'kml', datum: 'msl', atMs: T0 });
		const gnssM = Number(igc.text.split('\r\n')[13]?.slice(30, 35));
		const kmlM = Number(/<gx:coord>\S+ \S+ (\S+)<\/gx:coord>/.exec(kml.text)?.[1]);
		expect(gnssM).toBeGreaterThan(kmlM); // ellipsoid over MSL, France
	});

	it('carries the IGC header fields it is given', () => {
		const igc = buildTraceExport(points, {
			format: 'igc',
			datum: 'ellipsoid',
			atMs: T0,
			pilot: 'Bloggs Bill',
			aircraftType: 'DR400/120',
			aircraftId: 'F-GORQ',
			flightOfDay: 2,
			softwareVersion: '2.4.0',
		});
		expect(igc.text).toContain('HFDTEDATE:070726,02');
		expect(igc.text).toContain('HFPLTPILOTINCHARGE:Bloggs Bill');
		expect(igc.text).toContain('HFGIDGLIDERID:F-GORQ');
	});

	it('labels the formats with their invariant codes', () => {
		expect(TRACE_FORMAT_LABEL.igc).toBe('IGC');
	});
});

describe('flightOfDay', () => {
	const day1 = Date.UTC(2026, 6, 7, 9, 0, 0);
	const day1b = Date.UTC(2026, 6, 7, 15, 0, 0);
	const day2 = Date.UTC(2026, 6, 8, 9, 0, 0);

	it('ranks a trace among the same UTC day, oldest first', () => {
		const all = [day1b, day2, day1];
		expect(flightOfDay(day1, all)).toBe(1);
		expect(flightOfDay(day1b, all)).toBe(2);
		expect(flightOfDay(day2, all)).toBe(1);
	});

	it('answers 1 for an instant that is not in the list', () => {
		expect(flightOfDay(day1, [])).toBe(1);
	});
});

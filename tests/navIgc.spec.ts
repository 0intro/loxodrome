/* Unit tests for the IGC writer (docs/trace-files.md). The format is
 * COLUMN-POSITIONAL, so the B-record assertions go through a tiny reader
 * written here from the specification's own byte table (A4.1.3), the
 * zip.spec.ts discipline: a writer bug must not be able to pin itself. */

import { describe, it, expect } from 'vitest';
import { buildIgc, looksLikeIgc, parseIgc } from '$lib/nav/igc';
import { buildGpx } from '$lib/nav/gpx';
import { ellipsoidAltFt, mslAltFt } from '$lib/nav/altitudeDatum';
import { geoidHeightFt } from '$lib/nav/geoid';
import { hasAbsoluteTime, type TrackPoint } from '$lib/nav/trace';

const M_PER_FT = 0.3048;

/** 2026-07-07 14:32:00Z, over Étampes. */
const T0 = Date.UTC(2026, 6, 7, 14, 32, 0);

const points: TrackPoint[] = [
	{ lat: 48.6747, lon: 2.1071, altFt: 1000, timeMs: T0, accuracyM: 8 },
	{ lat: 48.72, lon: 2.2, altFt: 1500, timeMs: T0 + 60_000 },
	{ lat: 48.84, lon: -2.68, altFt: null, timeMs: T0 + 120_000, accuracyM: 12 },
];

function lines(igc: string): string[] {
	return igc.split('\r\n').filter((l) => l !== '');
}

function bRecords(igc: string): string[] {
	return lines(igc).filter((l) => l.startsWith('B'));
}

/** Decode one B record back through the specification's byte offsets. */
function readB(b: string): {
	timeUtc: string;
	lat: number;
	lon: number;
	valid: string;
	pressM: number;
	gnssM: number;
	fxa: number | null;
} {
	const num = (s: string): number => Number(s);
	const lat =
		(num(b.slice(7, 9)) + num(b.slice(9, 11)) / 60 + num(b.slice(11, 14)) / 60_000) *
		(b[14] === 'S' ? -1 : 1);
	const lon =
		(num(b.slice(15, 18)) + num(b.slice(18, 20)) / 60 + num(b.slice(20, 23)) / 60_000) *
		(b[23] === 'W' ? -1 : 1);
	return {
		timeUtc: b.slice(1, 7),
		lat,
		lon,
		valid: b[24] ?? '',
		pressM: num(b.slice(25, 30)),
		gnssM: num(b.slice(30, 35)),
		fxa: b.length > 35 ? num(b.slice(35, 38)) : null,
	};
}

describe('buildIgc header', () => {
	const igc = buildIgc(points, {
		pilot: 'Dupré Éric',
		aircraftType: 'DR400/120',
		aircraftId: 'F-GORQ',
		softwareVersion: '2.4.0',
	});

	it('declares a NON-approved recorder in the A record', () => {
		expect(lines(igc)[0]).toMatch(/^AX/);
	});

	it('writes every required H record once, with the UTC date of the first fix', () => {
		for (const rec of [
			'HFDTEDATE:070726,01',
			'HFPLTPILOTINCHARGE:',
			'HFGTYGLIDERTYPE:DR400/120',
			'HFGIDGLIDERID:F-GORQ',
			'HFDTMGPSDATUM:WGS84',
			'HFRHWHARDWAREVERSION:',
			'HFFTYFRTYPE:',
			'HFGPSRECEIVER:',
			'HFPRSPRESSALTSENSOR:NONE',
		]) {
			expect(lines(igc).filter((l) => l.startsWith(rec))).toHaveLength(1);
		}
	});

	it('states the ellipsoidal GNSS altitude datum in the firmware line', () => {
		expect(igc).toContain('with WGS84 Ellipsoid GPS altitude datum');
	});

	it('folds accents out of the header text', () => {
		expect(igc).toContain('HFPLTPILOTINCHARGE:Dupre Eric');
	});

	it('carries no security record: this is not an approved recorder', () => {
		expect(lines(igc).some((l) => l.startsWith('G'))).toBe(false);
	});

	it('terminates every line with CRLF and stays ASCII', () => {
		expect(igc.endsWith('\r\n')).toBe(true);
		expect(igc.split('\n').every((l) => l === '' || l.endsWith('\r'))).toBe(true);
		expect(/^[\x20-\x7e\r\n]*$/.test(igc)).toBe(true);
	});
});

describe('buildIgc B records', () => {
	it('writes fixed-width records the byte table decodes back', () => {
		const bs = bRecords(buildIgc(points));
		expect(bs).toHaveLength(3);
		expect(bs.every((b) => b.length === 38)).toBe(true); // 35 + FXA
		const first = readB(bs[0]);
		expect(first.timeUtc).toBe('143200');
		expect(first.lat).toBeCloseTo(48.6747, 4);
		expect(first.lon).toBeCloseTo(2.1071, 4);
		expect(first.valid).toBe('A');
		expect(first.pressM).toBe(0);
		expect(first.gnssM).toBe(Math.round(1000 * M_PER_FT));
	});

	it('signs the western hemisphere', () => {
		const third = readB(bRecords(buildIgc(points))[2]);
		expect(third.lon).toBeCloseTo(-2.68, 4);
	});

	it('marks a fix without altitude 2D and zeroes its GNSS column', () => {
		const third = readB(bRecords(buildIgc(points))[2]);
		expect(third.valid).toBe('V');
		expect(third.gnssM).toBe(0);
	});

	it('never invents a pressure altitude', () => {
		for (const b of bRecords(buildIgc(points))) {
			expect(b.slice(25, 30)).toBe('00000');
		}
	});

	it('writes the accuracy when known and the worst value when not', () => {
		const bs = bRecords(buildIgc(points));
		expect(readB(bs[0]).fxa).toBe(8);
		expect(readB(bs[1]).fxa).toBe(999);
	});

	it('omits the FXA column entirely when no fix carries an accuracy', () => {
		const bare = points.map(({ accuracyM: _drop, ...p }) => p);
		const igc = buildIgc(bare);
		expect(igc).not.toContain('I013638FXA');
		expect(bRecords(igc).every((b) => b.length === 35)).toBe(true);
	});

	it('keeps one record per UTC second, the first of each', () => {
		const dense: TrackPoint[] = [
			{ lat: 48.6, lon: 2.6, altFt: 500, timeMs: T0 },
			{ lat: 48.7, lon: 2.7, altFt: 900, timeMs: T0 + 200 },
			{ lat: 48.8, lon: 2.8, altFt: 1300, timeMs: T0 + 1000 },
		];
		const bs = bRecords(buildIgc(dense));
		expect(bs).toHaveLength(2);
		expect(readB(bs[0]).gnssM).toBe(Math.round(500 * M_PER_FT));
	});

	it('carries the minute rounding instead of printing 60000', () => {
		const edge = buildIgc([{ lat: 48.99999999, lon: 2, altFt: 0, timeMs: T0 }]);
		const b = bRecords(edge)[0];
		expect(b.slice(7, 15)).toBe('4900000N');
	});

	it('writes a negative altitude with its sign in place of the leading zero', () => {
		const below = buildIgc([{ lat: 48.6, lon: 2.6, altFt: -40, timeMs: T0 }]);
		expect(bRecords(below)[0].slice(30, 35)).toBe('-0012');
	});

	it('keeps ONE date across UTC midnight and lets the clock wrap', () => {
		const night: TrackPoint[] = [
			{ lat: 48.6, lon: 2.6, altFt: 500, timeMs: Date.UTC(2026, 6, 7, 23, 59, 30) },
			{ lat: 48.7, lon: 2.7, altFt: 500, timeMs: Date.UTC(2026, 6, 8, 0, 0, 30) },
		];
		const igc = buildIgc(night);
		expect(lines(igc).filter((l) => l.startsWith('HFDTEDATE:'))).toHaveLength(1);
		expect(igc).toContain('HFDTEDATE:070726,01');
		const bs = bRecords(igc);
		expect(readB(bs[0]).timeUtc).toBe('235930');
		expect(readB(bs[1]).timeUtc).toBe('000030');
	});

	it('stays a valid header-only file on an empty trace', () => {
		const igc = buildIgc([]);
		expect(lines(igc)[0]).toMatch(/^AX/);
		expect(bRecords(igc)).toHaveLength(0);
	});
});

describe('the IGC altitude datum', () => {
	const p = points[0];

	it('writes the ELLIPSOIDAL height, above the MSL metres GPX writes', () => {
		const igc = buildIgc(points, {
			altEllipsoidFt: (q) => ellipsoidAltFt(q.altFt, q.lat, q.lon, 'msl'),
		});
		const gpx = buildGpx(points, { altMslFt: (q) => mslAltFt(q.altFt, q.lat, q.lon, 'msl') });
		const gnssM = readB(bRecords(igc)[0]).gnssM;
		const eleM = Number(/<ele>([-\d.]+)<\/ele>/.exec(gpx)?.[1]);
		expect(gnssM).toBe(Math.round(ellipsoidAltFt(p.altFt, p.lat, p.lon, 'msl')! * M_PER_FT));
		// The separation over France is tens of metres, and it has ONE sign.
		expect(gnssM).toBeGreaterThan(eleM);
		expect(gnssM - eleM).toBeCloseTo(geoidHeightFt(p.lat, p.lon) * M_PER_FT, 0);
	});

	it('agrees with GPX when the device already reports the ellipsoid', () => {
		const igc = buildIgc(points, {
			altEllipsoidFt: (q) => ellipsoidAltFt(q.altFt, q.lat, q.lon, 'ellipsoid'),
		});
		expect(readB(bRecords(igc)[0]).gnssM).toBe(Math.round(p.altFt! * M_PER_FT));
	});
});

describe('parseIgc', () => {
	it('round-trips the app\'s own file, datum and all', () => {
		const igc = buildIgc(points, {
			altEllipsoidFt: (q) => ellipsoidAltFt(q.altFt, q.lat, q.lon, 'ellipsoid'),
			softwareVersion: '2.0.0',
		});
		const read = parseIgc(igc);
		// The file STATES its datum (the specification's firmware wording),
		// so nothing has to be asked.
		expect(read.datum).toBe('ellipsoid');
		expect(read.points).toHaveLength(3);
		expect(read.points[0].lat).toBeCloseTo(points[0].lat, 4);
		expect(read.points[0].lon).toBeCloseTo(points[0].lon, 4);
		expect(read.points[0].timeMs).toBe(points[0].timeMs);
		// The column holds whole METRES, so a foot value returns within one
		// metre of itself; that is the format's resolution, not a defect.
		expect(Math.abs(read.points[0].altFt! - 1000)).toBeLessThan(1 / M_PER_FT);
		// The 2D fix comes back with no altitude, as it went in.
		expect(read.points[2].altFt).toBeNull();
		// FXA is not read back: the parser keeps to the fixed 35-byte table.
		expect(read.points[0].accuracyM).toBeUndefined();
	});

	it('leaves the datum unanswered when the file does not state it', () => {
		const foreign = buildIgc(points).replace(/^HFRFW.*$/m, 'HFRFWFIRMWAREVERSION:6.4');
		expect(parseIgc(foreign).datum).toBeNull();
	});

	it('asks nothing about a file whose fixes carry no altitude', () => {
		const flat = points.map((p) => ({ ...p, altFt: null }));
		const igc = buildIgc(flat).replace(/^HFRFW.*$/m, 'HFRFWFIRMWAREVERSION:6.4');
		expect(parseIgc(igc).datum).toBe('ellipsoid');
	});

	it('reads the legacy date header and either line ending', () => {
		const body = [
			'AXXX001',
			'HFDTE070726',
			'B1402004836270N00236432EA0000000152',
			'B1402104836510N00236792EA0000000229',
		];
		for (const eol of ['\r\n', '\n', '\r']) {
			const read = parseIgc(body.join(eol) + eol);
			expect(read.points).toHaveLength(2);
			expect(read.points[0].timeMs).toBe(Date.UTC(2026, 6, 7, 14, 2, 0));
		}
	});

	it('windows the two-digit year on a fixed rule, not on today', () => {
		const of = (yy: string): number =>
			parseIgc(`HFDTE0101${yy}\r\nB1402004836270N00236432EA0000000152\r\n`).points[0].timeMs;
		expect(new Date(of('95')).getUTCFullYear()).toBe(1995);
		expect(new Date(of('26')).getUTCFullYear()).toBe(2026);
	});

	it('reads a file with no date header as a trace with no wall clock', () => {
		const read = parseIgc('B1402004836270N00236432EA0000000152\r\n');
		expect(hasAbsoluteTime(read.points)).toBe(false);
		expect(read.points[0].timeMs).toBe(14 * 3600_000 + 2 * 60_000);
	});

	it('ignores I-record extensions past the fixed table', () => {
		const igc =
			'HFDTE070726\r\nI023638FXA3940SIU\r\n' +
			'B1402004836270N00236432EA0000000152006' + '12' + '\r\n';
		const read = parseIgc(igc);
		expect(read.points).toHaveLength(1);
		expect(read.points[0].altFt).toBeCloseTo(152 / 0.3048, 0);
	});

	it('rolls the date forward past midnight, and only there', () => {
		const igc =
			'HFDTE070726\r\n' +
			'B2359304836270N00236432EA0000000152\r\n' +
			'B0000304836510N00236792EA0000000229\r\n';
		const read = parseIgc(igc);
		expect(read.points[1].timeMs - read.points[0].timeMs).toBe(60_000);

		// A backwards jitter of a few seconds is not a new day, and the fix
		// it stamps is DROPPED (the GPX / KML rule): pushed out of order it
		// would survive the importers' sort as an equal adjacent stamp.
		const jitter =
			'HFDTE070726\r\n' +
			'B1402104836270N00236432EA0000000152\r\n' +
			'B1402054836510N00236792EA0000000229\r\n' +
			'B1402114836750N00237152EA0000000305\r\n';
		const read2 = parseIgc(jitter);
		expect(read2.points).toHaveLength(2);
		expect(read2.points[1].timeMs - read2.points[0].timeMs).toBe(1000);
	});

	it('keeps the first fix of each second and skips a short line', () => {
		const igc =
			'HFDTE070726\r\n' +
			'B1402004836270N00236432EA0000000152\r\n' +
			'B1402004836510N00236792EA0000000229\r\n' +
			'B14020548362\r\n' +
			'B1402104836750N00237152EA0000000305\r\n';
		const read = parseIgc(igc);
		expect(read.points).toHaveLength(2);
		expect(read.points[0].lat).toBeCloseTo(48.6045, 4);
	});

	it('never reads the pressure column, and never calls zero an altitude', () => {
		const igc =
			'HFDTE070726\r\n' +
			'B1402004836270N00236432EA0150000000\r\n' +
			'B1402104836510N00236792EV0150000000\r\n';
		const read = parseIgc(igc);
		expect(read.points.every((p) => p.altFt === null)).toBe(true);
	});

	it('throws on a document with no fixes', () => {
		expect(() => parseIgc('AXXX001\r\nHFDTE070726\r\n')).toThrow(/no fix records/i);
	});
});

describe('looksLikeIgc', () => {
	it('knows a fix line from prose', () => {
		expect(looksLikeIgc(buildIgc(points))).toBe(true);
		expect(looksLikeIgc('AMSL and other words\nB) 2601010600 C) 2601312359')).toBe(false);
	});
});

/* Unit tests for the hand-rolled GPX writer / parser: the round-trip and the
 * tolerance cases (attribute order, missing ele/time, namespace prefixes,
 * self-closing tags) plus the empty-document throw. */

import { describe, it, expect } from 'vitest';
import { buildGpx, parseGpx } from '$lib/nav/gpx';
import type { TrackPoint } from '$lib/nav/trace';

const points: TrackPoint[] = [
	{ lat: 48.6747, lon: 2.1071, altFt: 1000, timeMs: 1_720_000_000_000 },
	{ lat: 48.72, lon: 2.2, altFt: 1500, timeMs: 1_720_000_060_000 },
	{ lat: 48.84, lon: 2.68, altFt: null, timeMs: 1_720_000_120_000 },
];

describe('buildGpx', () => {
	it('emits a GPX 1.1 document with a track and a name', () => {
		const gpx = buildGpx(points, { name: 'Test flight' });
		expect(gpx).toContain('<gpx version="1.1"');
		expect(gpx).toContain('http://www.topografix.com/GPX/1/1');
		expect(gpx).toContain('<name>Test flight</name>');
		expect(gpx).toContain('<trkpt lat="48.6747" lon="2.1071">');
		// Elevation written in metres, omitted for the null-altitude fix.
		expect(gpx).toContain('<ele>304.8</ele>');
		expect((gpx.match(/<ele>/g) ?? [])).toHaveLength(2);
	});
});

describe('round-trip', () => {
	it('preserves lat/lon, altitude and time', () => {
		const parsed = parseGpx(buildGpx(points));
		expect(parsed).toHaveLength(3);
		expect(parsed[0].lat).toBeCloseTo(48.6747, 6);
		expect(parsed[0].lon).toBeCloseTo(2.1071, 6);
		expect(parsed[0].altFt).toBeCloseTo(1000, 1);
		expect(parsed[0].timeMs).toBe(1_720_000_000_000);
		expect(parsed[2].altFt).toBeNull();
	});
});

describe('the elevation datum', () => {
	it('writes the MSL value the resolver hands back, not the stored one', () => {
		// <ele> is MSL by convention, so an ellipsoidal recording is corrected
		// on the way out; the state owns the datum, the writer just asks.
		const gpx = buildGpx(points, { altMslFt: (p) => (p.altFt == null ? null : p.altFt - 148) });
		expect(gpx).toContain('<ele>259.7</ele>');
		expect(gpx).not.toContain('<ele>304.8</ele>');
	});

	it('still omits the tag for a fix with no altitude at all', () => {
		const gpx = buildGpx(points, { altMslFt: (p) => (p.altFt == null ? null : p.altFt) });
		expect((gpx.match(/<ele>/g) ?? [])).toHaveLength(2);
	});
});

describe('parse tolerance', () => {
	it('accepts reversed attribute order and single quotes', () => {
		const pts = parseGpx(
			"<gpx><trk><trkseg><trkpt lon='2.5' lat='48.5'><time>2024-01-01T00:00:00Z</time></trkpt></trkseg></trk></gpx>",
		);
		expect(pts[0]).toMatchObject({ lat: 48.5, lon: 2.5 });
	});

	it('accepts self-closing trkpt and namespace prefixes', () => {
		const pts = parseGpx(
			'<gpx:gpx><gpx:trkpt lat="1" lon="2"/><gpx:trkpt lat="3" lon="4"><gpx:ele>100</gpx:ele></gpx:trkpt></gpx:gpx>',
		);
		expect(pts).toHaveLength(2);
		expect(pts[1].altFt).toBeCloseTo(100 / 0.3048, 3);
	});

	it('synthesises a monotonic clock when time is missing', () => {
		const pts = parseGpx('<gpx><trkpt lat="1" lon="2"/><trkpt lat="1.1" lon="2"/></gpx>');
		expect(pts.map((p) => p.timeMs)).toEqual([0, 1000]);
	});

	it('throws when there are no track points', () => {
		expect(() => parseGpx('<gpx></gpx>')).toThrow(/no track points/i);
	});
});

describe('the stated clock', () => {
	const pt = (sec: string, extra = ''): string =>
		`<trkpt lat="48.8" lon="2.6"><time>2026-07-07T10:00:${sec}Z</time>${extra}</trkpt>`;

	it('drops a backward stamp instead of re-stamping the tail', () => {
		// A sub-second recorder whose clock steps back once: the old +1 s fill
		// overtook the real 4 Hz clock here and rewrote every later fix.
		const pts = parseGpx(
			`<gpx>${pt('00.25')}${pt('00.75')}${pt('00.50')}${pt('01.25')}${pt('01.75')}</gpx>`,
		);
		expect(pts.map((p) => p.timeMs % 60000)).toEqual([250, 750, 1250, 1750]);
	});

	it('keeps the first fix of a duplicated stamp', () => {
		const pts = parseGpx(`<gpx>${pt('00', '<ele>100</ele>')}${pt('00')}${pt('01')}</gpx>`);
		expect(pts).toHaveLength(2);
		expect(pts[0].altFt).not.toBeNull();
	});

	it('drops a re-emitted overlap whole (the segment-boundary glitch)', () => {
		// The EMU recorder re-opens a segment a second or two back and repeats
		// the stamps; the overlap is dropped, the resumed real clock kept.
		const pts = parseGpx(
			`<gpx>${pt('05')}${pt('06')}${pt('07')}${pt('05.50')}${pt('06.50')}${pt('07.50')}${pt('08')}</gpx>`,
		);
		expect(pts.map((p) => p.timeMs % 60000)).toEqual([5000, 6000, 7000, 7500, 8000]);
	});

	it('drops a time-less fix amid real times, leading ones included', () => {
		// A leading time-less fix used to take epoch 0 and flip the whole
		// trace to "no wall clock"; a mid-trace one used to fabricate +1 s.
		const pts = parseGpx(
			`<gpx><trkpt lat="1" lon="2"/>${pt('10')}<trkpt lat="1.1" lon="2"/>${pt('11')}</gpx>`,
		);
		expect(pts).toHaveLength(2);
		expect(pts[0].timeMs).toBeGreaterThan(946684800000);
	});

	it('always returns a strictly ascending timeline', () => {
		const pts = parseGpx(
			`<gpx>${pt('03')}${pt('01')}${pt('02')}${pt('04')}${pt('04')}${pt('05')}</gpx>`,
		);
		for (let i = 1; i < pts.length; i++) {
			expect(pts[i].timeMs).toBeGreaterThan(pts[i - 1].timeMs);
		}
	});

	it('falls back to the synthetic clock when the stated times form no timeline', () => {
		// A route-tool export stamping every point with the one <time> it
		// knows: the rule would keep a single fix, and a one-fix trace that
		// imports "successfully" replays nothing. No clock is the honest
		// answer, exactly as for a document stating no time at all.
		const pts = parseGpx(`<gpx>${pt('00')}${pt('00')}${pt('00')}</gpx>`);
		expect(pts).toHaveLength(3);
		expect(pts.map((p) => p.timeMs)).toEqual([0, 1000, 2000]);
	});
});

describe('the zero speed channel', () => {
	const pt = (sec: string, speed: string): string =>
		`<trkpt lat="48.8" lon="${2.6 + Number(sec) * 0.001}"><time>2026-07-07T10:00:${sec}Z</time><speed>${speed}</speed></trkpt>`;

	it('drops a speed channel that reads 0 on every fix, so the hops speak', () => {
		// Some writers emit <speed>0</speed> whatever the receiver measured;
		// a stated 0 outranks the hop in every fold and the trace would
		// never take off.
		const pts = parseGpx(`<gpx>${pt('00', '0')}${pt('01', '0')}${pt('02', '0.0')}</gpx>`);
		expect(pts.every((p) => p.speedKt === undefined)).toBe(true);
	});

	it('keeps a channel that states a real speed anywhere, zeros included', () => {
		const pts = parseGpx(`<gpx>${pt('00', '0')}${pt('01', '30.5')}${pt('02', '0')}</gpx>`);
		expect(pts[0].speedKt).toBe(0);
		expect(pts[1].speedKt).toBeCloseTo(30.5 / 0.514444, 1);
	});
});

describe('stated speed and course', () => {
	it('reads the TrackPointExtension pair, m/s and degrees', () => {
		const pts = parseGpx(
			'<gpx><trkpt lat="1" lon="2"><time>2026-07-07T10:00:00Z</time><extensions>' +
				'<gpxtpx:TrackPointExtension><gpxtpx:speed>51.44</gpxtpx:speed>' +
				'<gpxtpx:course>90.00</gpxtpx:course></gpxtpx:TrackPointExtension>' +
				'</extensions></trkpt></gpx>',
		);
		expect(pts[0].speedKt).toBeCloseTo(100, 1);
		expect(pts[0].trackDeg).toBeCloseTo(90, 5);
	});

	it('reads GPX 1.0 bare children the same way', () => {
		const pts = parseGpx(
			'<gpx version="1.0"><trkpt lat="1" lon="2"><speed>10.29</speed><course>180</course></trkpt></gpx>',
		);
		expect(pts[0].speedKt).toBeCloseTo(20, 1);
		expect(pts[0].trackDeg).toBe(180);
	});

	it('normalises a due-north 360.00 course to 0', () => {
		const pts = parseGpx('<gpx><trkpt lat="1" lon="2"><course>360.00</course></trkpt></gpx>');
		expect(pts[0].trackDeg).toBe(0);
	});

	it('keeps each channel independently optional', () => {
		const pts = parseGpx(
			'<gpx><trkpt lat="1" lon="2"><gpxtpx:speed>5</gpxtpx:speed></trkpt>' +
				'<trkpt lat="1.1" lon="2"><gpxtpx:course>45</gpxtpx:course></trkpt></gpx>',
		);
		expect(pts[0].speedKt).toBeCloseTo(5 / (1852 / 3600), 3);
		expect(pts[0].trackDeg).toBeUndefined();
		expect(pts[1].speedKt).toBeUndefined();
		expect(pts[1].trackDeg).toBe(45);
	});

	it('ignores garbage values', () => {
		const pts = parseGpx(
			'<gpx><trkpt lat="1" lon="2"><speed>fast</speed><course>NaN</course></trkpt></gpx>',
		);
		expect(pts[0].speedKt).toBeUndefined();
		expect(pts[0].trackDeg).toBeUndefined();
	});
});

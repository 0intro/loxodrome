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

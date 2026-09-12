/* Unit tests for the KML writer (docs/trace-files.md): the gx:Track shape,
 * the altitude mode, and the timeless-track fallback. */

import { describe, it, expect } from 'vitest';
import { buildKml, looksLikeKml, parseKml } from '$lib/nav/kml';
import type { TrackPoint } from '$lib/nav/trace';

const T0 = Date.UTC(2026, 6, 7, 14, 32, 0);

const points: TrackPoint[] = [
	{ lat: 48.6747, lon: 2.1071, altFt: 1000, timeMs: T0 },
	{ lat: 48.72, lon: 2.2, altFt: 1500, timeMs: T0 + 60_000 },
	{ lat: 48.84, lon: 2.68, altFt: null, timeMs: T0 + 120_000 },
];

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

describe('buildKml', () => {
	const kml = buildKml(points, { name: 'Sortie & retour' });

	it('declares the KML 2.2 and gx namespaces', () => {
		expect(kml).toContain('xmlns="http://www.opengis.net/kml/2.2"');
		expect(kml).toContain('xmlns:gx="http://www.google.com/kml/ext/2.2"');
	});

	it('writes one gx:Track with paired times and coordinates', () => {
		expect(kml).toContain('<gx:Track>');
		expect(count(kml, /<when>/g)).toBe(points.length);
		expect(count(kml, /<gx:coord>/g)).toBe(points.length);
	});

	it('writes lon lat alt in metres above sea level', () => {
		expect(kml).toContain('<altitudeMode>absolute</altitudeMode>');
		expect(kml).toContain('<gx:coord>2.1071 48.6747 304.8</gx:coord>');
		expect(kml).toContain(`<when>${new Date(T0).toISOString()}</when>`);
	});

	it('styles the line with the trace ink', () => {
		expect(kml).toContain('<color>ff0c59e8</color>');
		expect(kml).toContain('<styleUrl>#trace</styleUrl>');
	});

	it('escapes the name', () => {
		expect(kml).toContain('Sortie &amp; retour');
	});

	it('honours the altitude callback', () => {
		const corrected = buildKml(points, {
			altMslFt: (p) => (p.altFt == null ? null : p.altFt - 148),
		});
		expect(corrected).toContain('<gx:coord>2.1071 48.6747 259.7</gx:coord>');
	});

	it('writes no height at all for a fix that has none', () => {
		// The grammar's altitude is optional; a zero would assert sea level.
		expect(kml).toContain('<gx:coord>2.68 48.84</gx:coord>');
	});
});

describe('buildKml degradations', () => {
	it('clamps to the ground when NO fix has an altitude', () => {
		const flat = points.map((p) => ({ ...p, altFt: null }));
		const kml = buildKml(flat);
		expect(kml).toContain('<altitudeMode>clampToGround</altitudeMode>');
		expect(kml).not.toContain('absolute');
	});

	it('falls back to a static LineString when the trace has no real clock', () => {
		// parseGpx synthesises a 1 Hz clock from zero for a GPX with no <time>.
		const timeless = points.map((p, i) => ({ ...p, timeMs: i * 1000 }));
		const kml = buildKml(timeless);
		expect(kml).toContain('<LineString>');
		expect(kml).not.toContain('<gx:Track>');
		expect(count(kml, /<when>/g)).toBe(0);
		expect(kml).toContain('2.1071,48.6747,304.8');
	});

	it('stays well formed on an empty trace', () => {
		const kml = buildKml([]);
		expect(kml).toContain('<kml ');
		expect(kml.trimEnd().endsWith('</kml>')).toBe(true);
	});
});

describe('parseKml', () => {
	it('round-trips a timed track', () => {
		const read = parseKml(buildKml(points, { name: 'Essai' }));
		expect(read).toHaveLength(3);
		expect(read[0].lat).toBeCloseTo(points[0].lat, 6);
		expect(read[0].lon).toBeCloseTo(points[0].lon, 6);
		expect(read[0].timeMs).toBe(points[0].timeMs);
		expect(read[0].altFt).toBeCloseTo(1000, 0);
		expect(read[2].altFt).toBeNull(); // written as 0, and 0 is not a height
	});

	it('round-trips a clockless line, whose mode our own writer states', () => {
		const timeless = points.map((p, i) => ({ ...p, timeMs: i * 1000 }));
		const read = parseKml(buildKml(timeless));
		expect(read).toHaveLength(3);
		// Our LineString says absolute, so its heights ARE altitudes; only a
		// foreign line that states no mode drops them (below).
		expect(read[0].altFt).toBeCloseTo(1000, 0);
		expect(read[1].timeMs - read[0].timeMs).toBe(1000);
	});

	it('honours the altitude mode over the geometry', () => {
		const track = (mode: string | null): string => `
			<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
			<Placemark><gx:Track>
				${mode == null ? '' : `<altitudeMode>${mode}</altitudeMode>`}
				<when>2026-07-07T14:32:00Z</when><gx:coord>2.1071 48.6747 304.8</gx:coord>
			</gx:Track></Placemark></kml>`;
		expect(parseKml(track('absolute'))[0].altFt).toBeCloseTo(1000, 0);
		expect(parseKml(track('clampToGround'))[0].altFt).toBeNull();
		expect(parseKml(track('relativeToGround'))[0].altFt).toBeNull();
		expect(parseKml(track(null))[0].altFt).toBeCloseTo(1000, 0); // a recording states its own

		const line = (mode: string | null): string => `
			<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><LineString>
				${mode == null ? '' : `<altitudeMode>${mode}</altitudeMode>`}
				<coordinates>2.1071,48.6747,304.8 2.2,48.72,457.2</coordinates>
			</LineString></Placemark></kml>`;
		expect(parseKml(line('absolute'))[0].altFt).toBeCloseTo(1000, 0);
		expect(parseKml(line(null))[0].altFt).toBeNull(); // a drawn line: terrain
	});

	it('reads the gx altitude mode too', () => {
		const kml = `<kml><Placemark><LineString>
			<gx:altitudeMode>relativeToSeaFloor</gx:altitudeMode>
			<coordinates>2.1,48.6,300</coordinates></LineString></Placemark></kml>`;
		expect(parseKml(kml)[0].altFt).toBeNull();
	});

	it('tolerates spaces, newlines and two-component tuples', () => {
		const kml = `<kml><Placemark><LineString><coordinates>
			2.655268, 48.813424, 143.29
			2.869445,48.791606
		</coordinates></LineString></Placemark></kml>`;
		const read = parseKml(kml);
		expect(read).toHaveLength(2);
		expect(read[0].lon).toBeCloseTo(2.655268, 6);
		expect(read[1].altFt).toBeNull();
	});

	it('reads any namespace prefix, and a MultiTrack whole', () => {
		const kml = `<k:kml xmlns:k="http://www.opengis.net/kml/2.2" xmlns:g="http://www.google.com/kml/ext/2.2">
			<k:Placemark><g:MultiTrack>
				<g:Track><k:altitudeMode>absolute</k:altitudeMode>
					<k:when>2026-07-07T14:32:00Z</k:when><g:coord>2.1 48.6 300</g:coord></g:Track>
				<g:Track><k:altitudeMode>absolute</k:altitudeMode>
					<k:when>2026-07-07T14:33:00Z</k:when><g:coord>2.2 48.7 400</g:coord></g:Track>
			</g:MultiTrack></k:Placemark></k:kml>`;
		const read = parseKml(kml);
		expect(read).toHaveLength(2);
		expect(read[1].timeMs - read[0].timeMs).toBe(60_000);
	});

	it('pairs times and positions by index, not by adjacency', () => {
		const kml = `<kml><Placemark><gx:Track>
			<when>2026-07-07T14:32:00Z</when><when>2026-07-07T14:33:00Z</when>
			<gx:coord>2.1 48.6 300</gx:coord><gx:coord>2.2 48.7 400</gx:coord>
		</gx:Track></Placemark></kml>`;
		const read = parseKml(kml);
		expect(read).toHaveLength(2);
		expect(read[1].timeMs - read[0].timeMs).toBe(60_000);
	});

	it('takes the tracks when a document holds both, and the longest line otherwise', () => {
		const both = `<kml><Placemark><gx:Track>
				<when>2026-07-07T14:32:00Z</when><gx:coord>2.1 48.6 300</gx:coord>
			</gx:Track></Placemark>
			<Placemark><LineString><coordinates>1,1 2,2 3,3</coordinates></LineString></Placemark></kml>`;
		expect(parseKml(both)).toHaveLength(1);

		const lines = `<kml>
			<Placemark><LineString><coordinates>1,1 2,2</coordinates></LineString></Placemark>
			<Placemark><LineString><coordinates>3,3 4,4 5,5</coordinates></LineString></Placemark></kml>`;
		expect(parseKml(lines)).toHaveLength(3);
	});

	it('drops a <when> that does not advance the clock (the GPX rule)', () => {
		const track = `<kml><Placemark><gx:Track>
				<when>2026-07-07T14:32:00Z</when><gx:coord>2.10 48.60 300</gx:coord>
				<when>2026-07-07T14:32:01Z</when><gx:coord>2.11 48.61 310</gx:coord>
				<when>2026-07-07T14:32:00Z</when><gx:coord>2.12 48.62 320</gx:coord>
				<when>2026-07-07T14:32:01Z</when><gx:coord>2.13 48.63 330</gx:coord>
				<when>2026-07-07T14:32:02Z</when><gx:coord>2.14 48.64 340</gx:coord>
			</gx:Track></Placemark></kml>`;
		const read = parseKml(track);
		expect(read.map((p) => p.lon)).toEqual([2.1, 2.11, 2.14]);
		for (let i = 1; i < read.length; i++) {
			expect(read[i].timeMs).toBeGreaterThan(read[i - 1].timeMs);
		}
	});

	it('drops a fix whose <when> is missing amid real ones', () => {
		const track = `<kml><Placemark><gx:Track>
				<when></when><gx:coord>2.10 48.60</gx:coord>
				<when>2026-07-07T14:32:00Z</when><gx:coord>2.11 48.61</gx:coord>
			</gx:Track></Placemark></kml>`;
		const read = parseKml(track);
		expect(read).toHaveLength(1);
		expect(read[0].lon).toBe(2.11);
	});

	it('refuses a document that holds no track: points and rings are not one', () => {
		const points =
			'<kml><Placemark><Point><coordinates>2.1,48.6,0</coordinates></Point></Placemark></kml>';
		expect(() => parseKml(points)).toThrow(/no track or line/i);
		const ring = `<kml><Placemark><Polygon><outerBoundaryIs><LinearRing>
			<coordinates>1,1 2,2 3,3 1,1</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
		expect(() => parseKml(ring)).toThrow(/no track or line/i);
	});
});

describe('looksLikeKml', () => {
	it('knows a KML document from a GPX one', () => {
		expect(looksLikeKml(buildKml(points))).toBe(true);
		expect(looksLikeKml('<?xml version="1.0"?><gpx version="1.1"></gpx>')).toBe(false);
	});
});

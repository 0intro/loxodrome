/* Unit tests for the shareable map-view URL hash
 * (#map=z/lat/lon[&layer=][&charts=a,b]): build/parse round-trip, the
 * default-osm layer omission, the ORDERED chart stack (order in `charts=` is
 * the stacking order), legacy boolean-flag parsing (oaci/oaci_250/oaci_ch),
 * zoom clamping, the malformed-input rejection, and the base-layer id guard.
 * writeViewHash is not exercised here: it touches location/history, absent
 * in the node test env. */

import { describe, it, expect } from 'vitest';
import { buildViewHash, parseViewHash, isBaseLayerId } from '$lib/map/viewHash';

// Empty chart stack (the common case); charts is a required arg.
const OFF: [] = [];

describe('buildViewHash', () => {
	it('omits the layer when it is the default osm', () => {
		expect(buildViewHash(6, 48.8566, 2.3522, 'osm', OFF)).toBe('#map=6/48.85660/2.35220');
	});

	it('appends &layer= for a non-default base layer', () => {
		expect(buildViewHash(13, 48.8584, 2.2945, 'ign', OFF)).toBe(
			'#map=13/48.85840/2.29450&layer=ign',
		);
	});

	it('rounds the zoom to an integer and fixes coords to 5 dp', () => {
		expect(buildViewHash(13.7, 1, 2, 'osm', OFF)).toBe('#map=14/1.00000/2.00000');
	});

	it('emits the chart stack in order', () => {
		expect(buildViewHash(8, 45, 5, 'osm', ['fr500'])).toBe(
			'#map=8/45.00000/5.00000&charts=fr500',
		);
		expect(buildViewHash(8, 45, 5, 'ign', ['us500', 'fr500'])).toBe(
			'#map=8/45.00000/5.00000&layer=ign&charts=us500,fr500',
		);
		expect(buildViewHash(8, 45, 5, 'osm', ['fr500', 'fr250', 'swissIcao'])).toBe(
			'#map=8/45.00000/5.00000&charts=fr500,fr250,swissIcao',
		);
	});

	it('omits charts= when the stack is empty', () => {
		expect(buildViewHash(8, 45, 5, 'osm', OFF)).toBe('#map=8/45.00000/5.00000');
	});
});

describe('parseViewHash', () => {
	it('reads center, zoom and no layer', () => {
		expect(parseViewHash('#map=13/48.8584/2.2945')).toEqual({
			center: [48.8584, 2.2945],
			zoom: 13,
			layer: undefined,
			charts: [],
		});
	});

	it('reads a base layer', () => {
		expect(parseViewHash('#map=8/45/5&layer=topo')).toEqual({
			center: [45, 5],
			zoom: 8,
			layer: 'topo',
			charts: [],
		});
	});

	it('tolerates a missing leading #', () => {
		expect(parseViewHash('map=8/45/5')).toEqual({
			center: [45, 5],
			zoom: 8,
			layer: undefined,
			charts: [],
		});
	});

	it('reads the ordered chart stack', () => {
		expect(parseViewHash('#map=8/45/5&charts=fr500')?.charts).toEqual(['fr500']);
		expect(parseViewHash('#map=8/45/5&charts=us500,fr500')?.charts).toEqual([
			'us500',
			'fr500',
		]);
		expect(parseViewHash('#map=8/45/5&charts=es500,us250,fr250')?.charts).toEqual([
			'es500',
			'us250',
			'fr250',
		]);
	});

	it('drops unknown ids and duplicates from charts=', () => {
		expect(parseViewHash('#map=8/45/5&charts=bogus,fr500,fr500,swissIcao')?.charts).toEqual([
			'fr500',
			'swissIcao',
		]);
		expect(parseViewHash('#map=8/45/5&charts=')?.charts).toEqual([]);
	});

	it('parses legacy boolean flags into the stack (legacy order)', () => {
		expect(parseViewHash('#map=8/45/5&oaci=1')?.charts).toEqual(['fr500']);
		expect(parseViewHash('#map=8/45/5&oaci_ch=1')?.charts).toEqual(['swissIcao']);
		expect(parseViewHash('#map=8/45/5&oaci=1&oaci_250=1&oaci_ch=1')?.charts).toEqual([
			'fr500',
			'fr250',
			'swissIcao',
		]);
		expect(parseViewHash('#map=8/45/5&oaci=0')?.charts).toEqual([]);
		// charts= wins over legacy flags when both are present
		expect(parseViewHash('#map=8/45/5&charts=us500&oaci=1')?.charts).toEqual(['us500']);
	});

	it('round-trips a built hash including the stack order', () => {
		const built = buildViewHash(10, 43.6047, 1.4442, 'ign', ['fr250', 'fr500']);
		const view = parseViewHash(built);
		expect(view).not.toBeNull();
		expect(view?.zoom).toBe(10);
		expect(view?.layer).toBe('ign');
		expect(view?.charts).toEqual(['fr250', 'fr500']);
		expect(view?.center[0]).toBeCloseTo(43.6047, 4);
		expect(view?.center[1]).toBeCloseTo(1.4442, 4);
	});

	it('clamps the zoom to 0..20', () => {
		expect(parseViewHash('#map=99/1/2')?.zoom).toBe(20);
		expect(parseViewHash('#map=-3/1/2')?.zoom).toBe(0);
	});

	it('drops an unknown base layer', () => {
		expect(parseViewHash('#map=8/45/5&layer=bogus')?.layer).toBeUndefined();
	});

	it('rejects malformed or out-of-range hashes', () => {
		for (const bad of [
			'',
			'#',
			'#foo=bar', // no map param
			'#map=abc', // 1 field
			'#map=13/48', // 2 fields
			'#map=13/48/2/9', // 4 fields
			'#map=13//2', // empty field
			'#map=5/NaN/2', // non-numeric
			'#map=5/91/0', // lat out of range
			'#map=5/-91/0',
			'#map=5/0/181', // lon out of range
			'#map=5/0/-181',
		]) {
			expect(parseViewHash(bad)).toBeNull();
		}
	});
});

describe('isBaseLayerId', () => {
	it('accepts the five known ids and rejects the rest', () => {
		for (const id of ['osm', 'topo', 'ign', 'google', 'bing']) {
			expect(isBaseLayerId(id)).toBe(true);
		}
		expect(isBaseLayerId('bogus')).toBe(false);
		expect(isBaseLayerId(null)).toBe(false);
	});
});

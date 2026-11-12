/* The label ink for a chip filled in a colour the app draws
 * (src/lib/ui/labelInk.ts). What a type checker cannot see: that every fill
 * actually handed to it comes out legible. The fixed palettes are the map's
 * own (the flight categories, the SIGMET hazards, a NOTAM band's orange), so
 * their fills cannot move to suit a label; the airspace category inks are
 * theme tokens, mapped to the label tokens theme.css pairs with them, which
 * tests/contrast.spec.ts holds to AA in both themes. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { labelInkOn, relativeLuminance } from '$lib/ui/labelInk';
import { HAZARD_STYLES } from '$lib/weather/sigmet';
import { NOTAM_PROFILE_COLOR } from '$lib/route/notamProfile';

import { installLeafletNode } from './helpers/leafletNode';

// The flight-category palette lives with the map layer, which imports Leaflet.
installLeafletNode();
const { STATION_CAT_COLORS, STATION_NO_CAT_COLOR } = await import('$lib/map/metarLayer');

const ratio = (a: string, b: string): number => {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const HEXINK = (ink: string): string => (ink === '#000' ? '#000000' : '#ffffff');

describe('labelInkOn', () => {
	it('labels an airspace category ink with the token theme.css pairs with it', () => {
		expect(labelInkOn('var(--airspace-restricted)')).toBe('var(--on-airspace-restricted)');
		expect(labelInkOn(' var(--airspace-transit) ')).toBe('var(--on-airspace-transit)');
		const theme = readFileSync('src/styles/theme.css', 'utf8');
		for (const cat of ['controlled', 'restricted', 'activity', 'trafficmgmt', 'transit', 'siv', 'fir']) {
			expect(theme, cat).toContain(`--on-airspace-${cat}:`);
		}
	});

	it('takes black or white, whichever measures higher, on a fixed colour', () => {
		expect(labelInkOn('#ffffff')).toBe('#000');
		expect(labelInkOn('#000')).toBe('#fff');
		// Around the crossover, where the two are equal (L about 0.179).
		expect(labelInkOn('#757575')).toBe('#fff');
		expect(labelInkOn('#7a7a7a')).toBe('#000');
	});

	it('makes every map palette chip legible, which white alone did not', () => {
		const fills: [string, string][] = [
			...Object.entries(STATION_CAT_COLORS),
			['no category', STATION_NO_CAT_COLOR],
			...Object.entries(HAZARD_STYLES).map(([k, v]): [string, string] => [k, v.color]),
			['NOTAM band', NOTAM_PROFILE_COLOR],
		];
		const failedWhite: string[] = [];
		for (const [name, fill] of fills) {
			const ink = labelInkOn(fill);
			expect(['#000', '#fff'], name).toContain(ink);
			expect(ratio(HEXINK(ink), fill), `${name} ${fill} under ${ink}`).toBeGreaterThanOrEqual(4.5);
			if (ratio('#ffffff', fill) < 4.5) {
				failedWhite.push(name);
			}
		}
		// The chips these fixed: white measured under 4.5:1 on each.
		expect(failedWhite.sort()).toEqual(['NOTAM band', 'TURB', 'VFR', 'no category']);
	});

	it('keeps white on any other colour, which the callers never hand it', () => {
		expect(labelInkOn('var(--supaip)')).toBe('#fff');
		const theme = readFileSync('src/styles/theme.css', 'utf8');
		const supaip = theme.match(/--supaip:\s*(#[0-9a-f]{6})/i)![1];
		expect(ratio('#ffffff', supaip)).toBeGreaterThanOrEqual(4.5);
	});

	it('is handed a crossing\'s band colour, always one of its two forms', () => {
		// The crossings strip labels a NO-GO chip with labelInkOn(c.color): a
		// band's colour is an airspace category token, or a NOTAM band's hex.
		const profile = readFileSync('src/lib/route/routeProfile.ts', 'utf8');
		expect(profile.match(/\bcolor: [^,\n]+/g)?.filter((c) => !/color: (string|band\.color)/.test(c))).toEqual([
			'color: `var(--airspace-${b.category})`',
		]);
		expect(readFileSync('src/lib/route/notamProfile.ts', 'utf8')).toMatch(/\bcolor: NOTAM_PROFILE_COLOR,/);
		expect(NOTAM_PROFILE_COLOR).toMatch(/^#[0-9a-f]{6}$/i);
	});
});

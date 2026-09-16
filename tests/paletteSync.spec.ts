/* The CSS mirrors of the chart palette cannot import
 * src/lib/map/palette.ts (they are CSS text), so this spec locks them to
 * it by parsing: theme.css day + night --airspace-* / --obstacle-* tokens,
 * the shared .print-palette pins in app.css (every print flow's palette),
 * and MapView's SVG hatch defs. Comparison is case-insensitive (CSS
 * lowercases, palette keeps the Legende2026 sampling case). readFileSync
 * per the aircraftData.spec.ts precedent. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	AIRSPACE_CHIP_DAY,
	AIRSPACE_CHIP_NIGHT,
	OBSTACLE_INK,
	SIA,
} from '$lib/map/palette';

const read = (p: string): string =>
	readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const CATEGORIES = [
	'controlled', 'restricted', 'activity', 'trafficmgmt', 'transit', 'siv', 'fir',
] as const;

function airspaceTokens(css: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of css.matchAll(/--airspace-(\w+):\s*(#[0-9a-fA-F]{6})/g)) {
		out[m[1]] = m[2].toLowerCase();
	}
	return out;
}

const lower = (set: Record<string, string>): Record<string, string> =>
	Object.fromEntries(Object.entries(set).map(([k, v]) => [k, v.toLowerCase()]));

describe('theme.css mirrors the palette', () => {
	const css = read('src/styles/theme.css');
	const nightAt = css.indexOf(':root[data-theme=\'night\']');
	const night2 = css.indexOf(':root[data-theme="night"]');
	const split = nightAt >= 0 ? nightAt : night2;
	it('has a night block to split at', () => {
		expect(split).toBeGreaterThan(0);
	});
	const day = airspaceTokens(css.slice(0, split));
	const night = airspaceTokens(css.slice(split));

	it('day --airspace-* equals AIRSPACE_CHIP_DAY, all seven', () => {
		expect(day).toEqual(lower(AIRSPACE_CHIP_DAY));
		expect(Object.keys(day).sort()).toEqual([...CATEGORIES].sort());
	});

	it('night --airspace-* equals AIRSPACE_CHIP_NIGHT, all seven', () => {
		expect(night).toEqual(lower(AIRSPACE_CHIP_NIGHT));
		expect(Object.keys(night).sort()).toEqual([...CATEGORIES].sort());
	});

	it('--obstacle-* tokens equal OBSTACLE_INK', () => {
		const obst = [...css.matchAll(/--obstacle-\w+:\s*(#[0-9a-fA-F]{6})/g)].map((m) => m[1].toLowerCase());
		expect(obst.length).toBeGreaterThanOrEqual(2);
		for (const v of obst) {
			expect(v).toBe(OBSTACLE_INK.toLowerCase());
		}
	});

	it('--supaip keeps its distinct identity, never a chart ink', () => {
		const m = css.match(/--supaip:\s*(#[0-9a-fA-F]{6})/);
		expect(m?.[1].toLowerCase()).toBe('#c2185b');
		const inks = new Set(Object.values(SIA).map((v) => v.toLowerCase()));
		expect(inks.has('#c2185b')).toBe(false);
	});
});

describe('print pins mirror the day palette', () => {
	it('app.css .print-palette pins its six categories to day values', () => {
		const pins = airspaceTokens(read('src/app.css'));
		expect(Object.keys(pins).length).toBeGreaterThanOrEqual(6);
		for (const [cat, hex] of Object.entries(pins)) {
			expect(hex, `--airspace-${cat}`).toBe(
				AIRSPACE_CHIP_DAY[cat as keyof typeof AIRSPACE_CHIP_DAY].toLowerCase());
		}
	});

	it('the print flows carry no per-component airspace pins of their own', () => {
		for (const p of [
			'src/lib/components/NavLogModal.svelte',
			'src/lib/components/flightprep/PrintDoc.svelte',
			'src/lib/components/FlightPrepModal.svelte',
			'src/lib/components/RouteProfileModal.svelte',
		]) {
			expect(Object.keys(airspaceTokens(read(p))), p).toEqual([]);
		}
	});
});

describe('MapView hatch defs', () => {
	it('keeps the SUP AIP hatch literal at #c2185b', () => {
		const svelte = read('src/lib/components/MapView.svelte');
		const m = svelte.match(/id="hatch-supaip"[\s\S]{0,200}?fill="(#[0-9a-fA-F]{6})"/);
		expect(m?.[1].toLowerCase()).toBe('#c2185b');
	});
});

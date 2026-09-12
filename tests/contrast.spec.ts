/* WCAG contrast pins for the theme inks that carry small TEXT.
 *
 * theme.css documents a measured ratio beside --workbook-orange,
 * --no-live-data and --nav-orange, each darkened (day) or brightened
 * (night) until it passed. Prose alone did not hold: --nav-orange shipped
 * as the map's saturated line colour #e8590c reused as 12px banner text,
 * at 3.09:1 on its own tint, and nothing failed. This spec recomputes the
 * ratios from theme.css itself, so moving one of these values is a
 * decision that has to pass, not an edit that quietly regresses the one
 * band a pilot reads in flight.
 *
 * AA for normal text is 4.5:1 (WCAG 2.2 SC 1.4.3); the alert banner is
 * 12px / weight 600, which is normal text, not large. readFileSync per the
 * paletteSync.spec.ts precedent. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const AA_NORMAL = 4.5;

const css = readFileSync(new URL('../src/styles/theme.css', import.meta.url), 'utf8');

function tokens(block: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)) {
		out[m[1]] = m[2].toLowerCase();
	}
	return out;
}

const nightAt = Math.max(
	css.indexOf(":root[data-theme='night']"),
	css.indexOf(':root[data-theme="night"]'),
);
const day = tokens(css.slice(0, nightAt));
const nightOnly = tokens(css.slice(nightAt));
// The night block overrides a subset; everything else falls through.
const night = { ...day, ...nightOnly };

function channels(hex: string): [number, number, number] {
	let h = hex.replace('#', '');
	if (h.length === 3) {
		h = h
			.split('')
			.map((c) => c + c)
			.join('');
	}
	return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
	const lin = (v: number): number => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	};
	const [r, g, b] = channels(hex);
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: string, b: string): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg` composited over `bg` at `alpha`, the color-mix() the tints use. */
function over(fg: string, bg: string, alpha: number): string {
	const f = channels(fg);
	const b = channels(bg);
	return (
		'#' +
		[0, 1, 2]
			.map((i) =>
				Math.round(f[i] * alpha + b[i] * (1 - alpha))
					.toString(16)
					.padStart(2, '0'),
			)
			.join('')
	);
}

describe('the theme inks that carry text pass WCAG AA', () => {
	const themes: [string, Record<string, string>][] = [
		['day', day],
		['night', night],
	];

	/* The three alert tiers of NavStrip's banner. Each is read three ways:
	 * as text on its own 12% tint (the hardest), as text on the surface the
	 * strip sits on, and as the solid "inside the volume" fill under
	 * --surface text. */
	const TIERS = ['danger', 'workbook-orange', 'nav-orange'];

	for (const [name, t] of themes) {
		it(`${name}: every alert tier ink is legible on all three of its backdrops`, () => {
			for (const tier of TIERS) {
				const ink = t[tier];
				expect(ink, `--${tier} missing in ${name}`).toBeTruthy();
				const tint = over(ink, t.surface, 0.12);
				expect(ratio(ink, tint), `--${tier} text on its own tint (${name})`).toBeGreaterThanOrEqual(
					AA_NORMAL,
				);
				expect(ratio(ink, t.surface), `--${tier} text on --surface (${name})`).toBeGreaterThanOrEqual(
					AA_NORMAL,
				);
				expect(
					ratio(t.surface, ink),
					`--surface text on the solid --${tier} fill (${name})`,
				).toBeGreaterThanOrEqual(AA_NORMAL);
			}
		});

		it(`${name}: --nav-orange is also legible on the app background`, () => {
			// The off-route number and the Navigation tab's alert rows sit on
			// --bg rather than on a strip surface.
			expect(ratio(t['nav-orange'], t.bg)).toBeGreaterThanOrEqual(AA_NORMAL);
		});

		it(`${name}: body and muted text pass on both surfaces`, () => {
			for (const on of ['bg', 'surface', 'surface-2']) {
				expect(ratio(t.text, t[on]), `--text on --${on} (${name})`).toBeGreaterThanOrEqual(
					AA_NORMAL,
				);
				expect(
					ratio(t['text-muted'], t[on]),
					`--text-muted on --${on} (${name})`,
				).toBeGreaterThanOrEqual(AA_NORMAL);
			}
		});

		it(`${name}: the accent is legible as a link and under its own text colour`, () => {
			expect(ratio(t.accent, t.surface)).toBeGreaterThanOrEqual(AA_NORMAL);
			expect(ratio(t['accent-text'], t.accent)).toBeGreaterThanOrEqual(AA_NORMAL);
		});

		it(`${name}: the filled danger button's label is legible on it`, () => {
			// .btn.danger labels with --surface rather than white, because the
			// night --danger is a light red: white on it measures 2.78:1.
			expect(ratio(t.surface, t.danger)).toBeGreaterThanOrEqual(AA_NORMAL);
		});
	}

	it('the map keeps its own saturated line orange, distinct from the UI ink', () => {
		// The split is the point: navLayer's stroke over terrain is not a
		// text-contrast case, and reusing it as text is what failed.
		const layer = readFileSync(new URL('../src/lib/map/navLayer.ts', import.meta.url), 'utf8');
		expect(layer).toContain("const TRACE_COLOR = '#e8590c'");
		expect(day['nav-orange']).not.toBe('#e8590c');
	});
});

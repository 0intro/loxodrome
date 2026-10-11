/* The label ink for a chip filled in a colour the app draws, so its text
 * reads at WCAG AA (4.5:1) on every fill, day and night.
 *
 * An airspace category ink is a theme token whose fill changes between the
 * day and night themes, so its label is the token theme.css pairs with it
 * (`--on-airspace-<category>`, pinned by tests/contrast.spec.ts). A fixed
 * palette colour (a NOTAM band's orange, a flight category, a SIGMET hazard,
 * each shared with the map, so its fill never changes) takes black or white,
 * whichever measures higher against it: never under 4.58:1, the point where
 * the two are equal. Pure and locale-free. */

const AIRSPACE_TOKEN = /^var\(--airspace-([a-z]+)\)$/;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** WCAG 2.2 relative luminance of a `#rgb` / `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
	let h = hex.slice(1);
	if (h.length === 3) {
		h = [...h].map((c) => c + c).join('');
	}
	const lin = (v: number): number => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	};
	const [r, g, b] = [0, 2, 4].map((i) => lin(parseInt(h.slice(i, i + 2), 16)));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The ink to label `fill` with: its paired token for an airspace category,
 *  black or white for a fixed colour. Anything else keeps the white the chips
 *  were drawn with; every palette handed here is one of the two forms
 *  (tests/labelInk.spec.ts). */
export function labelInkOn(fill: string): string {
	const f = fill.trim();
	const token = AIRSPACE_TOKEN.exec(f);
	if (token) {
		return `var(--on-airspace-${token[1]})`;
	}
	if (!HEX.test(f)) {
		return '#fff';
	}
	const l = relativeLuminance(f);
	// Black wins once (L + 0.05) / 0.05 exceeds 1.05 / (L + 0.05).
	return (l + 0.05) * (l + 0.05) > 1.05 * 0.05 ? '#000' : '#fff';
}

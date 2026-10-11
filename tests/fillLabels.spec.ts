/* Every label the components set on a solid colour fill reads at WCAG AA,
 * in the day theme and the night one (src/styles/theme.css). A chip labelled
 * white on a theme fill read fine by day and failed at night, where the fills
 * turn light: the U/S badges on the night red at 2.78:1, the airspace panel's
 * category badges at 2.40 to 3.63:1, the crossings strip's NO-GO chips. The
 * rule (visual-language): a fill that turns light at night labels with
 * --surface, an airspace category fill with its --on-airspace-* token, a
 * fixed palette colour with ui/labelInk.ts.
 *
 * This reads every stylesheet: a rule filling with a theme token or a hex,
 * its text colour from the same rule or, for a modifier, from the rule it
 * modifies (`.tag--cap` takes `.tag`'s), both resolved in each theme. A label
 * set at run time (an inline style, a var() the theme does not declare) is
 * tests/labelInk.spec.ts's; a translucent or gradient fill is left out. */

import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { cssRulesOf } from './helpers/cssRules';

const AA = 4.5;

const theme = readFileSync('src/styles/theme.css', 'utf8');
const split = theme.search(/:root\[data-theme=["']night["']\]/);
function tokens(block: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)) {
		out[m[1]] = m[2].toLowerCase();
	}
	return out;
}
const day = tokens(theme.slice(0, split));
const night = { ...day, ...tokens(theme.slice(split)) };

function resolve(value: string, t: Record<string, string>): string | null {
	const v = value.trim();
	const m = /^var\(--([\w-]+)(?:,\s*(.+))?\)$/.exec(v);
	if (m) {
		return t[m[1]] ?? (m[2] ? resolve(m[2], t) : null);
	}
	if (v === 'white' || v === '#fff') {
		return '#ffffff';
	}
	return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v) ? v.toLowerCase() : null;
}

function luminance(hex: string): number {
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
const ratio = (a: string, b: string): number => {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** The fills a label never sits on as a chip: the surfaces themselves (their
 *  text is the body text, pinned by contrast.spec.ts), translucent and
 *  gradient fills, images. */
const SKIP_FILL = /transparent|none|inherit|currentcolor|color-mix|gradient|url\(|rgb\(|var\(--(surface|surface-2|surface-3|bg|border|border-strong)\)/i;

interface Pair {
	where: string;
	fill: string;
	label: string;
}

function pairs(): Pair[] {
	const out: Pair[] = [];
	const files = [...globSync('src/**/*.svelte'), ...globSync('src/**/*.css')];
	for (const file of files) {
		const src = readFileSync(file, 'utf8');
		if (file.endsWith('.svelte') && !/<style/.test(src)) {
			continue;
		}
		const rules = cssRulesOf(file);
		const colorOf = new Map<string, string>();
		for (const r of rules) {
			const c = r.decls.get('color');
			if (c) {
				for (const sel of r.selectors) {
					colorOf.set(sel, c);
				}
			}
		}
		for (const r of rules) {
			const fill = r.decls.get('background') ?? r.decls.get('background-color');
			if (!fill || SKIP_FILL.test(fill)) {
				continue;
			}
			let label = r.decls.get('color');
			if (!label) {
				const first = r.selectors[0];
				const base = first.replace(/(--[\w-]+|:[\w-]+(\([^)]*\))?)$/, '');
				const compound = first.replace(/(?<=\S)\.[\w-]+$/, '');
				label = colorOf.get(base) ?? colorOf.get(compound);
			}
			if (label) {
				out.push({ where: `${file} ${r.selectors.join(', ')}`, fill, label });
			}
		}
	}
	return out;
}

describe('a label on a colour fill', () => {
	const all = pairs();

	it('reads at AA in both themes, wherever both resolve', () => {
		const failing: string[] = [];
		let checked = 0;
		for (const p of all) {
			for (const [name, t] of [['day', day], ['night', night]] as const) {
				const f = resolve(p.fill, t);
				const l = resolve(p.label, t);
				if (!f || !l) {
					continue;
				}
				checked++;
				const r = ratio(f, l);
				if (r < AA) {
					failing.push(`${p.where} (${name}) ${r.toFixed(2)}:1`);
				}
			}
		}
		expect(failing).toEqual([]);
		// The scan resolves the chips it was written for, so a parser that read
		// nothing cannot pass for one that found nothing wrong.
		expect(checked).toBeGreaterThan(80);
	});

	it('covers the chips that failed', () => {
		const where = all.map((p) => p.where).join('\n');
		for (const chip of [
			'ContextMenu.svelte .notam-count',
			'ContextMenu.svelte .us-badge',
			'AirspaceDetail.svelte .badge--transit',
			'NavLogSchedule.svelte .chip--transit',
			'StatusHeader.svelte .status-active',
			'AirportDetail.svelte .tag--cap',
			'AirportDetail.svelte .tag--vfr',
			'NavaidDetail.svelte .tag--unserviceable',
			'CrossingsStrip.svelte .cx-sum-warn',
		]) {
			expect(where, chip).toContain(chip);
		}
	});
});

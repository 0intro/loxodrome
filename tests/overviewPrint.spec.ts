/* The printed Overview, the dossier's front sheet, holds ONE A4 landscape
 * sheet whatever prints it, and no table of the fuel plan widens the page.
 *
 * Measured in Chromium and Firefox (2026-09-28). The Overview's lines were as
 * tall as the platform's system-ui face asked: Adwaita Sans 1.21 em on a GNOME
 * desktop, Segoe UI 1.33 em on Windows, 29 px more on a sheet with 16 to
 * spare. Firefox then moved the two-column grid row that could not finish on
 * the page to the next sheet whole, printing box A alone on the first. And
 * the fuel tables never wrapped a label: the refuelling strategies outgrew
 * their column from four trips and, with six, the page itself, where every
 * engine shrank the whole dossier to fit (to 70% in French).
 *
 * None of that shows without a browser, so the rules that prevent it are
 * pinned from the sources, the radarPaper.spec precedent. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flightprep as en } from '$lib/i18n/en/flightprep';
import { flightprep as fr } from '$lib/i18n/fr/flightprep';

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

const styleOf = (src: string): string =>
	src.slice(src.indexOf('<style>') + '<style>'.length, src.indexOf('</style>'));

/** The body of the `{ ... }` block whose opening brace is at `open`. */
function blockAt(css: string, open: number): string {
	let depth = 0;
	for (let i = open; i < css.length; i++) {
		if (css[i] === '{') {
			depth++;
		} else if (css[i] === '}' && --depth === 0) {
			return css.slice(open + 1, i);
		}
	}
	throw new Error('unbalanced braces');
}

/** The body of the style's `@media print` block. */
function printBlock(css: string): string {
	const at = css.indexOf('@media print {');
	expect(at).toBeGreaterThan(0);
	return blockAt(css, css.indexOf('{', at));
}

interface Rule {
	sel: string[];
	body: string;
}

/** The innermost rules of a stylesheet: selector list and declarations. An
 *  at-rule's own header never matches, its body holding braces. */
function rules(css: string): Rule[] {
	const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
	return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
		sel: m[1].split(',').map((s) => s.trim()),
		body: m[2],
	}));
}

/** The rule whose selector list is exactly `selector`. */
const only = (list: Rule[], selector: string): Rule | undefined =>
	list.find((r) => r.sel.length === 1 && r.sel[0] === selector);

describe('the printed Overview', () => {
	const style = styleOf(read('src/lib/components/flightprep/DossierPage.svelte'));
	const print = rules(printBlock(style));

	it('pins its line box, unitless, so no platform face moves the sheet', () => {
		// Unitless so each size scales its own (the 13 px route line, the
		// 9 px local times); a length would hand every line one height.
		expect(only(print, '.page')?.body).toMatch(/line-height:\s*1(\.\d+)?;/);
	});

	it('prints its two columns as a flex row, so Firefox breaks a column and not the row', () => {
		expect(only(print, '.two-col')?.body).toMatch(/display:\s*flex;/);
		expect(only(print, '.two-col > .col')?.body).toMatch(/flex:\s*1 1 0;/);
		expect(
			print.some((r) => r.sel.includes('.two-col') && /grid-template-columns/.test(r.body)),
		).toBe(false);
	});

	it('keeps the screen grid, whose @container collapse is written for one', () => {
		const screen = rules(style.slice(0, style.indexOf('@media print')));
		expect(only(screen, '.two-col')?.body).toMatch(/display:\s*grid;/);
	});

	it('wraps the take-off procedure where every other cell clips', () => {
		// Six trips leave a column about 58 px wide on paper, where the
		// procedure printed "Aucu…" for "Aucune ne convient": a no-go must
		// read whole, on screen and on paper alike.
		const screen = rules(style.slice(0, style.indexOf('@media print')));
		const cell = screen.find((r) => r.sel.includes('.fp-table.grid tr.procedure td'));
		expect(cell?.body).toMatch(/white-space:\s*normal;/);
		expect(cell?.body).toMatch(/text-overflow:\s*clip;/);
		const reclipped = rules(printBlock(style)).filter(
			(r) => r.sel.some((s) => s.includes('tr.procedure')) && /white-space:\s*nowrap/.test(r.body),
		);
		expect(reclipped).toEqual([]);
	});
});

describe('the fuel plan’s tables', () => {
	const src = read('src/lib/components/flightprep/FuelPlanPage.svelte');
	const all = rules(styleOf(src));

	it('let their heads and row labels wrap, and never the figures', () => {
		// Scoped (0,3,1), above the shared workbook nowrap (0,2,1).
		expect(only(all, '.page .fp-table th')?.body).toMatch(/white-space:\s*normal;/);
		expect(
			all.some((r) => r.sel.some((s) => /\btd\b/.test(s)) && /white-space:\s*normal/.test(r.body)),
		).toBe(false);
	});

	it('head the stops’ columns once, each by its aerodrome alone', () => {
		expect(src).toContain('<th class="group" colspan={fuel.inputs.length - 1}>');
		expect(src).toContain('{t.flightprep.refuelGroup} (L)');
		expect(src).toMatch(/<th[^>]*>\{stopLabel\(j\)\}<\/th>/);
		expect(src).not.toContain('t.flightprep.refuelAt(stopLabel(i - 1))} (L)');
		expect(en.refuelGroup).toBe('Refuel');
		expect(fr.refuelGroup).toBe('Avitaillement');
	});

	it('keep the refuelling plan’s note rule off its other paragraphs', () => {
		// As `.refuel p` it outweighed .recommend, .demoted, .caution-lead and
		// the shared .fp-page .warn, and the refusal lines printed grey.
		expect(all.some((r) => r.sel.includes('.refuel p'))).toBe(false);
		expect(all.some((r) => r.sel.includes('.refuel .note'))).toBe(true);
		expect(src).toContain('<p class="note">{t.flightprep.refuelPlanNote}</p>');
		// The refusals' lead rode that rule for its size and margins; freed, it
		// needs its own or it prints at the body's 14 px with 1 em margins.
		expect(only(all, '.refuel p.warn')?.body).toMatch(/font-size:\s*12\.5px;/);
		expect(only(all, '.refuel p.warn')?.body).not.toMatch(/color/);
	});
});

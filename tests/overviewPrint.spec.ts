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

	it('keeps the weather table inside its box, its lines wrapping on screen and paper', () => {
		// Sized to its longest unbroken line, the automatic layout printed a
		// French missed-legs line 117 px past box B (measured 2026-10-09).
		const screen = rules(style.slice(0, style.indexOf('@media print')));
		expect(only(screen, '.fp-table.wx-state')?.body).toMatch(/table-layout:\s*fixed;/);
		const cells = screen.find((r) => r.sel.includes('.fp-table.wx-state td'));
		expect(cells?.body).toMatch(/white-space:\s*normal;/);
		expect(
			print.some((r) => r.sel.some((s) => s.includes('wx-state')) && /white-space:\s*nowrap/.test(r.body)),
		).toBe(false);
	});

	it('sets the briefing link on box B’s heading row, no taller than the heading', () => {
		// A line of its own cost the taller column 16 px of the sheet.
		const src = read('src/lib/components/flightprep/DossierPage.svelte');
		expect(src).toMatch(/<div class="box-head">\s*<h3>\{t\.flightprep\.secWeather\}<\/h3>\s*<p class="muted">\s*\{t\.flightprep\.wxBriefingOn\}/);
		const screen = rules(style.slice(0, style.indexOf('@media print')));
		expect(only(screen, '.box-head .muted')?.body).toMatch(/line-height:\s*inherit;/);
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

	it('head the takeoffs’ columns once, each by its aerodrome alone, as fuel at takeoff', () => {
		// The figures under them are each takeoff's fuel (the strategy's load),
		// not the uplift: a head reading "Refuel (L)" over 66 read as 66 L to add.
		expect(src).toContain('<th class="group" colspan={fuel.inputs.length}>{t.flightprep.fuelAtTakeoff} (L)</th>');
		expect(src).toMatch(/<th[^>]*>\{takeoffLabel\(i\)\}<\/th>/);
		expect(src).not.toContain('t.flightprep.refuelAt(stopLabel(i - 1))} (L)');
		expect(src).not.toContain('refuelGroup');
		expect(en.fuelAtTakeoff).toBe('Fuel at takeoff');
		expect(fr.fuelAtTakeoff).toBe('Carburant au décollage');
	});

	it('pin their line box on paper, so no platform face adds a sheet', () => {
		expect(only(rules(printBlock(styleOf(src))), '.page')?.body).toMatch(/line-height:\s*1(\.\d+)?;/);
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

describe('the fuel table', () => {
	const src = read('src/lib/components/flightprep/FuelTable.svelte');
	const style = styleOf(src);
	const all = rules(style);
	const screen = blockAt(style, style.indexOf('{', style.indexOf('@media screen')));
	/** The rules both media read (a selector can have a screen twin). */
	const outside = rules(style.replace(screen, ''));

	it('lets its heads and row labels wrap, of its cells the control, and on paper the verdicts', () => {
		expect(only(all, '.fuel-plan th')?.body).toMatch(/white-space:\s*normal;/);
		const tdWraps = all.filter((r) => r.sel.some((x) => /\btd\b/.test(x)) && /white-space:\s*normal/.test(r.body));
		expect(tdWraps.map((r) => r.sel)).toEqual([['td.control'], ['tr.verdict-row td']]);
		// The verdicts on paper alone, which has no pan: on one line "NON, à
		// sec en navigation 3" ran six French columns 97 px past the sheet.
		// The figures never wrap.
		const print = rules(printBlock(style));
		expect(only(print, 'tr.verdict-row td')?.body).toMatch(/white-space:\s*normal;/);
	});

	it('keeps the refuelling list whole on paper, its lead never alone at a sheet’s foot', () => {
		const print = rules(printBlock(style));
		expect(print.find((r) => r.sel.includes('.refuel-block'))?.body).toMatch(/break-inside:\s*avoid;/);
		expect(src).toMatch(/<div class="refuel-block">\s*<p class="line muted lead">/);
	});

	it('holds each pair at its two least widths on screen and paper alike, the minutes column its box', () => {
		const print = rules(printBlock(style));
		expect(only(print, '.fuel-plan')?.body).toMatch(/width:\s*100%;/);
		// Outside @media screen (2026-10-06): left to its own figures on
		// paper, each pair printed its trip a few pixels from the next, the
		// English three at 157, 143 and 153 px.
		expect(outside.find((r) => r.sel.includes('.fuel-plan td.t'))?.body).toMatch(/min-width:\s*var\(--min-w\);/);
		expect(outside.find((r) => r.sel.includes('.fuel-plan td.l'))?.body).toMatch(/min-width:\s*var\(--l-w\);/);
		expect(screen).not.toMatch(/min-width:\s*var\(--(min|l)-w\)/);
		// The minutes column holds its box within the cell's 8 + 8 px padding
		// and 1 px rule, folded or not: a folded group hides its boxes, and
		// unfolding widened every English pair by 5 px.
		expect(only(outside, '.fuel-wrap')?.body).toMatch(/--min-w:\s*calc\(var\(--num-w\) \+ 17px\);/);
		const cell = all.find((r) => r.sel.includes('.fuel-plan td') && r.sel.includes('.fuel-plan th'));
		expect(cell?.body).toMatch(/padding:\s*3px 8px;/);
		expect(cell?.body).toMatch(/border-right:\s*1px solid/);
	});

	it('closes the legend’s two strong rules at the corner, on screen and paper', () => {
		// The corner spans the head's two rows, so the last-row rule missed
		// it: thin above the first group and left of the first trip's head.
		const corner = only(all, '.fuel-plan td.corner');
		expect(corner?.body).toMatch(/border-right:\s*2px solid var\(--border-strong\);/);
		expect(corner?.body).toMatch(/border-bottom:\s*2px solid var\(--border-strong\);/);
		expect(src).toMatch(/<td class="corner" rowspan=\{paired \? 2 : 1\}><\/td>/);
		expect(only(outside, '.fuel-plan .rowhead')?.body).toMatch(/border-right:\s*2px solid var\(--border-strong\);/);
	});

	it('reads its sub-heads, figures, boxes and part labels the same on screen and paper', () => {
		expect(only(all, '.fuel-plan th.sub')?.body).toMatch(/text-align:\s*center;/);
		// The span replacing a minute box on paper takes the cell's right.
		expect(only(all, '.fuel-plan td.t .num')?.body).toMatch(/text-align:\s*right;/);
		expect(src).toMatch(/oninput=\{\(e\) => setMinutes\(k, key, e\)\}\s*\/><span class="print-value">\{inForce\}<\/span>/);
		// One indent for both: past the fold's chevron on screen, under the
		// group's label on paper (14 px there and 22 on screen before).
		expect(only(all, 'tr.detail .rowhead')?.body).toMatch(/padding-left:\s*24px;/);
		const print = rules(printBlock(style));
		expect(print.filter((r) => r.sel.some((s) => s.includes('.rowhead')))).toEqual([]);
	});

	it('lets its label column take the room there is, never narrower than its snap padding', () => {
		// Capped at the padding, the labels wrapped with room to spare: a
		// one-trip plan left a phone 83 px unused.
		expect(style).not.toMatch(/max-width:\s*var\(--rowhead-w\)/);
		expect(only(rules(screen), '.fuel-plan .rowhead')?.body).toMatch(/min-width:\s*var\(--rowhead-w\);/);
		expect(screen).toMatch(/scroll-padding-left:\s*var\(--rowhead-w\);/);
	});

	it('folds its groups on screen alone, so every paper prints them open', () => {
		expect(only(rules(screen), '.fuel-plan tbody.folded tr.detail')?.body).toMatch(/display:\s*none;/);
		expect(rules(style.replace(screen, '')).filter((r) => r.sel.some((x) => x.includes('folded')))).toEqual([]);
		// Paper carries no control: the fold's button stays off it, its label
		// printed alone, and so does the typed-minutes marker.
		expect(src).toMatch(/<button\s+class="fold no-print"/);
		expect(src).toContain('<span class="print-only">{label}</span>');
		expect(src).toMatch(/<span\s+class="stated no-print"/);
	});

	it('keeps the comparison of every refuelling plan off paper, which prints the advice', () => {
		const page = read('src/lib/components/flightprep/FuelPlanPage.svelte');
		expect(page).toContain('<details class="compare no-print">');
		expect(page).toContain('<FuelTable {fuel} {comp} />');
	});
});

describe('the mass and balance sheets on paper', () => {
	const page = read('src/lib/components/flightprep/MassBalancePage.svelte');
	const sheet = read('src/lib/components/flightprep/TripSheet.svelte');
	const doc = read('src/lib/components/flightprep/PrintDoc.svelte');

	it('start each pack sheet after the first with its own 12 mm, never cut', () => {
		const print = rules(printBlock(styleOf(page)));
		const opener = print.find((r) => r.sel.includes('.block + .block'));
		expect(opener?.body).toMatch(/break-before:\s*page;/);
		expect(opener?.body).toMatch(/padding-top:\s*12mm;/);
		expect(print.find((r) => r.sel.includes('.block'))?.body).toMatch(/break-inside:\s*avoid;/);
	});

	it('pin the packs\' line box on screen as on paper, the measure reading the print', () => {
		const all = rules(styleOf(page));
		expect(only(all, '.page.pack')?.body).toMatch(/line-height:\s*1\.2;/);
		// Outside @media print: the measure lays the pack out on screen.
		expect(printBlock(styleOf(page))).not.toContain('.block.pair');
	});

	it('hold a pair\'s tables and charts level: six rows both columns share', () => {
		// A two-line fuel line and a note set one table, and its chart with
		// it, 14.8 mm below its neighbour's (2026-10-06). The pair's rows,
		// each column a subgrid over all six.
		const all = rules(styleOf(page));
		expect(only(all, '.block.pair')?.body).toMatch(/grid-template-rows:\s*repeat\(6, auto\);/);
		const col = only(all, '.block.pair > .col');
		expect(col?.body).toMatch(/grid-row:\s*1 \/ -1;/);
		expect(col?.body).toMatch(/grid-template-rows:\s*subgrid;/);
		// TripSheet: every level a row subgrid, the head in row 1, the body
		// over 2 to 6, its main over 2 to 4 and its chart over 5 and 6.
		const ts = rules(styleOf(sheet));
		const levels = ['.sheet.pair', '.sheet.pair .sheet-body', '.sheet.pair .main', '.sheet.pair .chart'];
		const sub = ts.find((r) => levels.every((x) => r.sel.includes(x)));
		expect(sub?.body).toMatch(/grid-template-rows:\s*subgrid;/);
		expect(sub?.body).toMatch(/row-gap:\s*0;/);
		expect(only(ts, '.sheet.pair')?.body).toMatch(/grid-row:\s*1 \/ -1;/);
		expect(only(ts, '.sheet.pair .sheet-body')?.body).toMatch(/grid-row:\s*2 \/ -1;/);
		expect(only(ts, '.sheet.pair .main')?.body).toMatch(/grid-row:\s*1 \/ 4;/);
		expect(only(ts, '.sheet.pair .chart')?.body).toMatch(/grid-row:\s*4 \/ -1;/);
		// The six parts in their order: the head; the lead, the table and
		// the notes under it in the main; the figure and its verdicts.
		const order = [
			'class="sheet-head"',
			'class="main"',
			'class="lead"',
			'class="mb-wrap"',
			'class="after"',
			'class="chart"',
			'class="figure"',
			'class="chart-lines"',
		].map((c) => sheet.indexOf(c));
		expect(order.every((i) => i > 0)).toBe(true);
		expect([...order].sort((x, y) => x - y)).toEqual(order);
		// Elsewhere the wrappers draw no box: the screen and a sheet alone
		// lay out as they did.
		const wrappers = ts.find((r) => ['.lead', '.after', '.figure', '.chart-lines'].every((x) => r.sel.includes(x)));
		expect(wrappers?.body).toMatch(/display:\s*contents;/);
	});

	it('measure each pair as printed, never a column alone', () => {
		const measure = read('src/lib/components/flightprep/mbMeasure.ts');
		expect(measure).toContain('blocks: candidatePairs(n)');
		expect(measure).toContain("querySelectorAll<HTMLElement>('[data-block]')");
		expect(page).toContain("data-block={block.join('-')}");
		expect(page).toContain('{@const pair = block.length > 1}');
	});

	it('widen the fuel page\'s column from five trips', () => {
		expect(rules(printBlock(styleOf(doc))).find((r) => r.sel.includes('.fpd-narrow.fpd-wide'))?.body).toMatch(
			/max-width:\s*none;/,
		);
	});

	it('never print a chip or a button, and never reach for the URL', () => {
		expect(page).toMatch(/<nav class="chips no-print"/);
		expect(sheet).toMatch(/class="cure no-print"/);
		for (const src of [page, sheet]) {
			expect(src).not.toMatch(/href="#|location\.hash/);
		}
	});
});

describe('the takeoff fuel control in a table cell', () => {
	const src = read('src/lib/components/flightprep/TakeoffFuelControl.svelte');
	const all = rules(styleOf(src));

	it('keeps its column one width whatever is picked or read', () => {
		// No refuel listed at the departure from the start, greyed until a
		// reading: a list is as wide as its longest row, and offered late it
		// widened the French departure's column from 141 to 162 px the moment
		// the reading landed (2026-10-06).
		expect(src).toContain(
			"out.push({ value: 'none', label: t.flightprep.modeNone, disabled: k === 0 && aboard === null && mode !== 'none' });",
		);
		// The Custom box under its list: beside it, 162 to 231 px.
		expect(only(all, '.ctl.cell .pick')?.body).toMatch(/flex-direction:\s*column;/);
		// The notes wrap inside the list's width and never set it: on paper,
		// where the list prints without its arrow, they made three columns
		// 150, 131 and 146 px. Never by size containment, which a column
		// flexbox lays out at no width at all, a word a line.
		const notes = all.find((r) => r.sel.includes('.ctl.cell .pump') && r.sel.includes('.ctl.cell .source'));
		expect(notes?.body).toMatch(/width:\s*0;/);
		expect(notes?.body).toMatch(/min-width:\s*100%;/);
		expect(all.some((r) => /contain:\s*inline-size/.test(r.body))).toBe(false);
	});

	it('sizes the journey log’s hours and minutes boxes as its litres box', () => {
		const form = rules(styleOf(read('src/lib/components/flightprep/OnBoardForm.svelte')));
		const boxes = form.find((r) => ['.hh', '.mm', '.litres'].every((s) => r.sel.includes(s)));
		expect(boxes?.body).toMatch(/width:\s*4\.6em;/);
		expect(form.filter((r) => r !== boxes && r.sel.some((s) => ['.hh', '.mm', '.litres'].includes(s)))).toEqual([]);
	});
});

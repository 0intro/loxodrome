/* The printed nav log's PAPER: the two geometries the split is packed
 * against, and the sheet's own lockstep between the page rendition and the
 * print stylesheet.
 *
 * Both are cross-file agreements a type checker cannot see. The geometries
 * (navlogCards.ts) are numbers in TypeScript; the boxes they describe are
 * `padding` and `gap` declarations in NavLogModal's print CSS, and a
 * measure taken against the wrong box packs a page that does not fit,
 * which prints as a spilled fragment on a sheet of its own. The sheet's
 * `.portrait` block and its `@media print` block state the same grid on
 * purpose (the class is what makes the geometry media-independent, so the
 * measuring mount lays out on screen exactly what the page prints); if
 * they drift, every band is measured at a column width the page never
 * uses. readFileSync per the paletteSync.spec.ts / aircraftData.spec.ts
 * precedent. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KNEEBOARD_CARD, PORTRAIT_PAGE } from '$lib/components/navlogCards';
import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const modal = read('src/lib/components/NavLogModal.svelte');
const sheet = read('src/lib/components/NavLogSheet.svelte');
const schedule = read('src/lib/components/NavLogSchedule.svelte');
const measure = read('src/lib/components/navlogMeasure.ts');
const dossier = read('src/lib/components/flightprep/PrintDoc.svelte');
const notamHost = read('src/lib/components/NotamPrintHost.svelte');
const notamDoc = read('src/lib/components/NotamPrintDoc.svelte');

const PX_PER_MM = 96 / 25.4;
const mm = (v: number): number => v * PX_PER_MM;

/** The block of declarations a selector opens, as raw text. */
function block(css: string, selector: string): string {
	const at = css.indexOf(selector);
	expect(at, `selector ${selector} is missing`).toBeGreaterThan(0);
	const open = css.indexOf('{', at);
	const close = css.indexOf('}', open);
	return css.slice(open + 1, close);
}

/** One millimetre length declared in a block, e.g. `padding: 12mm`. A
 *  multi-value shorthand (`padding: 12mm 10mm`) is refused: the geometry
 *  assumes one margin on every side, and reading the first value alone
 *  would let an asymmetric box pass with a wrong width. */
function mmOf(css: string, selector: string, prop: string): number {
	const m = new RegExp(`${prop}:\\s*([\\d.]+)mm\\s*;`).exec(block(css, selector));
	expect(m, `${selector} { ${prop} } is not one length stated in mm`).not.toBeNull();
	return Number(m![1]);
}

describe('the A4 portrait page geometry matches the page CSS', () => {
	it('is A4 portrait less the printed margin the page carries as padding', () => {
		// The margin is a content padding, not an @page margin: a print
		// dialog can strip the latter (NavLogModal's own comment).
		const pad = mmOf(modal, ':global(html.navlog-paged) .pg-page', 'padding');
		expect(PORTRAIT_PAGE.widthPx).toBeCloseTo(mm(210 - 2 * pad), 6);
		// The height allowance keeps a slack under the box; it must be real
		// but small enough to cost no band (a band runs ~30mm).
		const slackMm = (mm(297 - 2 * pad) - PORTRAIT_PAGE.budgetPx) / PX_PER_MM;
		expect(slackMm).toBeGreaterThan(0);
		expect(slackMm).toBeLessThanOrEqual(5);
	});

	it('prints on the portrait sheet the geometry assumes', () => {
		expect(/@page\s*\{[^}]*size:\s*a4 portrait/i.test(modal)).toBe(true);
		expect(/@page\s*\{[^}]*margin:\s*0/i.test(modal)).toBe(true);
	});

	it('mounts the page document with the rendition prop it was measured at', () => {
		expect(PORTRAIT_PAGE.rendition).toBe('portrait');
		const mount = /<div class="pg-page">\s*<NavLogSheet([\s\S]*?)\/>/.exec(modal);
		expect(mount, 'the paged document mounts no NavLogSheet').not.toBeNull();
		expect(mount![1]).toMatch(/\bportrait\b/);
	});
});

describe('the A5 kneeboard card geometry matches the sheet CSS', () => {
	const kb = ':global(html.navlog-kneeboard) .kb-sheet';

	it('is half a landscape sheet less its side paddings and central gap', () => {
		const side = mmOf(modal, kb, 'padding-inline');
		const end = mmOf(modal, kb, 'padding-block');
		const gap = mmOf(modal, kb, 'gap');
		expect(KNEEBOARD_CARD.widthPx).toBeCloseTo(mm((297 - 2 * side - gap) / 2), 6);
		expect(KNEEBOARD_CARD.budgetPx).toBeCloseTo(mm(210 - 2 * end), 6);
		expect(KNEEBOARD_CARD.rendition).toBe('kneeboard');
		// The card's own flex basis states the gap a second time (half of it
		// per card); the geometry is wrong the moment the two disagree.
		const basis = /flex:\s*0 0 calc\(50% - ([\d.]+)mm\)/.exec(
			block(modal, ':global(html.navlog-kneeboard) .kb-card'),
		);
		expect(basis, '.kb-card states no calc(50% - <half gap>) basis').not.toBeNull();
		expect(Number(basis![1])).toBeCloseTo(gap / 2, 6);
	});

	it('clears the paper at its sides by the A4 page margin', () => {
		// The sides are the landscape sheet's short edges, where some printers
		// lose more than 8mm: they take the margin the A4 page prints with.
		const page = mmOf(modal, ':global(html.navlog-paged) .pg-page', 'padding');
		expect(mmOf(modal, kb, 'padding-inline')).toBe(page);
	});

	it('is the geometry of the dossier cards and the NOTAM bulletin', () => {
		// The dossier packs its cards against KNEEBOARD_CARD too.
		for (const prop of ['padding-inline', 'padding-block', 'gap']) {
			expect(mmOf(dossier, '.fpd-cards', prop), `.fpd-cards { ${prop} }`).toBe(
				mmOf(modal, kb, prop),
			);
		}
		// The bulletin carries the margins as its own padding, cloned on every
		// page, on the job's zero @page margin, which a print dialog's Margins
		// control cannot strip. Then the gap between its two columns.
		expect(notamHost).toContain("installDocumentPageCss(['notam-print']);");
		const own = ':global(html.notam-print) .npd-print {';
		for (const prop of ['padding-inline', 'padding-block']) {
			expect(mmOf(notamDoc, own, prop), `.npd-print { ${prop} }`).toBe(mmOf(modal, kb, prop));
		}
		expect(block(notamDoc, own)).toContain('box-decoration-break: clone;');
		expect(mmOf(notamDoc, '.npd-doc {', 'column-gap')).toBe(mmOf(modal, kb, 'gap'));
		expect(read('src/lib/ui/printJob.ts')).toContain("'@media print { @page { size: A4 landscape; margin: 0; } }'");
	});
});

describe('the schedule prints the layout it is measured at', () => {
	// A continuation part of the A4 schedule must lay its columns out as
	// the full table the parts were measured on: the page rendition pins
	// the table layout, and both the page mount and the measuring mount
	// carry it.
	it('pins the page rendition to a slice-invariant table', () => {
		const b = block(schedule, '.portrait table.nav');
		expect(b).toMatch(/table-layout:\s*fixed/);
		expect(block(schedule, '.portrait .scroll')).toMatch(/overflow:\s*visible/);
	});

	it('mounts the page document and the measuring mount with it', () => {
		const mount = /<div class="pg-page">\s*<NavLogSchedule([\s\S]*?)\/>/.exec(modal);
		expect(mount, 'the paged document mounts no NavLogSchedule').not.toBeNull();
		expect(mount![1]).toMatch(/\bportrait\b/);
		// The measuring mount spreads the geometry's rendition props whole.
		const measuring = /mount\(NavLogSchedule,([\s\S]*?)\}\);/.exec(measure);
		expect(measuring, 'navlogMeasure mounts no NavLogSchedule').not.toBeNull();
		expect(measuring![1]).toMatch(/\.\.\.renditionProps\(geom\)/);
	});
});

describe('the schedule card holds its enter / leave badge', () => {
	// The card's columns are fixed, so a badge wider than its column runs
	// under the next cell's chip. Each label's advance in em, measured in
	// Firefox in Bitstream Vera Sans Bold (fontconfig's system-ui on
	// Fedora): a label missing here is to be measured before it prints.
	const EM: Record<string, number> = { Enter: 3.04, Leave: 3.32, Entrée: 3.72, Sortie: 3.4 };

	/** The pixel lengths a block states for a property, in order. */
	function px(b: string, prop: string): number[] {
		const m = new RegExp(`(?:^|[\\s;])${prop}:\\s*([^;]+);`).exec(b);
		expect(m, `${prop} is not stated`).not.toBeNull();
		return m![1].trim().split(/\s+/).map((v) => {
			expect(v, `${prop} is not in px`).toMatch(/^[\d.]+px$/);
			return parseFloat(v);
		});
	}

	it('sets the badge, the band and the zone word at the card size', () => {
		const card = px(block(schedule, '.kneeboard table.nav'), 'font-size');
		for (const sel of ['.kneeboard .badge', '.kneeboard .as-band', '.kneeboard .zone-word']) {
			expect(px(block(schedule, sel), 'font-size'), sel).toEqual(card);
		}
	});

	it('fits the widest label of both languages inside its cell', () => {
		const [font] = px(block(schedule, '.kneeboard .badge'), 'font-size');
		const [, padX] = px(block(schedule, '.kneeboard .badge {'), 'padding');
		const [, cellX] = px(block(schedule, '.kneeboard .ev td {'), 'padding');
		const [column] = px(block(schedule, '.kneeboard .nav th:nth-child(3)'), 'width');
		for (const label of [en.navlog.enter, en.navlog.leave, fr.navlog.enter, fr.navlog.leave]) {
			expect(EM[label], `the badge label ${label} is unmeasured`).toBeDefined();
			expect(EM[label] * font + 2 * padX, label).toBeLessThanOrEqual(column - 2 * cellX);
		}
	});
});

describe('the sheet prints the geometry it is measured at', () => {
	// The `.portrait` class exists so the measuring mount renders the print
	// grid ON SCREEN; the @media print block states it for the print that
	// was never prepared. Same declarations, two carriers.
	const declarations = (b: string): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const [, prop, value] of b.matchAll(/([a-z-]+):\s*([^;]+);/g)) {
			out[prop] = value.replace(/\s+/g, ' ').trim();
		}
		return out;
	};
	const printBlock = sheet.slice(sheet.lastIndexOf('@media print'));

	it('states one grid for the page rendition and the print stylesheet', () => {
		const byClass = declarations(block(sheet, '.portrait .navlog'));
		const byMedia = declarations(block(printBlock, '.navlog'));
		expect(byClass['grid-template-columns']).toBeDefined();
		expect(byClass).toEqual(byMedia);
	});

	it('unclips the scroller in both', () => {
		expect(declarations(block(sheet, '.portrait .scroll'))).toEqual(
			declarations(block(printBlock, '.scroll')),
		);
	});
});

describe('the two papers print every route', () => {
	const modal = readFileSync('src/lib/components/NavLogModal.svelte', 'utf8');
	const at = modal.indexOf('async function printRoutes(mode: Paper)');
	const body = modal.slice(at, modal.indexOf('\n\t}\n', at));

	it('take the plan\'s printable routes, never the one on screen', () => {
		expect(at).toBeGreaterThan(-1);
		expect(body).toContain('const list = printableRoutes;');
		expect(body).not.toContain('activeRoute(');
		expect(modal).toContain("onclick={() => { close(); void printRoutes('page'); }}");
		expect(modal).toContain("onclick={() => { close(); void printRoutes('kneeboard'); }}");
	});

	it('name each paper\'s file apart, after the plan', () => {
		expect(modal).toContain("page: { kind: 'navlog-a4', orientation: 'portrait' },");
		expect(modal).toContain("kneeboard: { kind: 'navlog-a5', orientation: DOCUMENT_ORIENTATION },");
		expect(body).toContain('markDocumentPrint(planPrintStem(PAPER[mode].kind));');
	});

	it('head each A4 schedule by its route, measured with that heading', () => {
		expect(modal).toContain('measureScheduleCards(r, PORTRAIT_PAGE, { heading: routeTitle(r), live: schedLive })');
		expect(/<div class="pg-page">\s*<NavLogSchedule[\s\S]*?heading=\{routeTitle\(c\.route\)\}[\s\S]*?portrait/.test(modal)).toBe(true);
	});
});

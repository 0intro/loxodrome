/* The overlay z bands, locked by parsing the CSS that declares them.
 *
 * There are four, and only their ORDER matters: the surfaces that share the
 * screen (docked, paged), the popup band a menu raised beside them rests in,
 * the modal band (a full-screen or dialog surface and its backdrop), and the
 * raised band a menu opened from INSIDE a modal surface needs.
 *
 * The bug this pins: the flight-prep and nav-log overflow sheets sat in the
 * popup band while their own box was in the modal band, so on a phone (where
 * every non-docking surface collapses to full screen) the sheet opened
 * BEHIND the box, laid out and painted under it, and the "..." button read as
 * dead. Nothing in a unit test can see paint order, but the numbers that
 * decide it are text, and this is what keeps them in the right order.
 *
 * readFileSync per the paletteSync.spec.ts precedent. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** A component's <style> block, or a .css file whole. Svelte markup carries
 *  braces of its own, so the block has to come out before any rule parsing. */
function styles(src: string): string {
	const at = src.indexOf('<style>');
	return at < 0 ? src : src.slice(at + '<style>'.length, src.lastIndexOf('</style>'));
}

/** The z-index declared by the LAST rule listing this exact selector, in
 *  source order. Every rule involved is a flat class selector with no nesting
 *  or at-rule around it, which is what makes this parse honest. */
function zOf(css: string, selector: string): number {
	const flat = styles(css).replace(/\/\*[\s\S]*?\*\//g, '');
	const hits: number[] = [];
	for (const rule of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const listed = rule[1].split(',').some((s) => s.trim() === selector);
		const z = /(?:^|[\s;])z-index:\s*(\d+)/.exec(rule[2]);
		if (listed && z) {
			hits.push(Number(z[1]));
		}
	}
	if (hits.length === 0) {
		throw new Error(`no z-index for ${selector}`);
	}
	return hits[hits.length - 1];
}

const appCss = read('src/app.css');
const popup = read('src/lib/components/PopupMenu.svelte');
const head = read('src/lib/components/HeadOverlay.svelte');
const stackMenu = read('src/lib/components/ProfileStackMenu.svelte');
const toggles = read('src/lib/components/TogglesPopover.svelte');

describe('overlay z bands', () => {
	const sharedBox = zOf(appCss, '.modal-box.at-page');
	const modalBackdrop = zOf(appCss, '.modal-backdrop');
	const modalBox = zOf(appCss, '.modal-box');

	it('a shared surface sits under the modal band', () => {
		expect(sharedBox).toBeLessThan(modalBackdrop);
		expect(modalBackdrop).toBeLessThan(modalBox);
	});

	it('the popup band clears a shared surface and stays under the modal one', () => {
		for (const [file, css, scrim, panel] of [
			['PopupMenu', popup, '.backdrop', '.menu'],
			['HeadOverlay', head, '.scrim', '.sheet'],
		] as const) {
			const back = zOf(css, scrim);
			const front = zOf(css, panel);
			expect(back, file).toBeGreaterThan(sharedBox);
			expect(front, file).toBeGreaterThan(back);
			expect(front, file).toBeLessThan(modalBackdrop);
		}
	});

	it('the raised band clears the modal box, one band for every carrier', () => {
		const raised = [
			['PopupMenu', zOf(popup, '.backdrop.above'), zOf(popup, '.menu.above')],
			['HeadOverlay', zOf(head, '.scrim.above'), zOf(head, '.sheet.above')],
			['ProfileStackMenu', zOf(stackMenu, '.ctx-backdrop'), zOf(stackMenu, '.ctx-menu')],
			['TogglesPopover', zOf(toggles, '.ctx-backdrop'), zOf(toggles, '.toggles-panel')],
		] as const;
		for (const [file, back, front] of raised) {
			expect(back, file).toBeGreaterThan(modalBox);
			expect(front, file).toBeGreaterThan(back);
		}
		// One band, not four: a menu raised over a surface always layers the
		// same way, whichever component draws it.
		expect(new Set(raised.map(([, back]) => back)).size).toBe(1);
		expect(new Set(raised.map(([, , front]) => front)).size).toBe(1);
	});
});

describe('menus raised from inside a surface name their surface', () => {
	/** The HeadOverlay call's attributes, from `<HeadOverlay` to the `>`
	 *  closing the opening tag. */
	function calls(src: string): string[] {
		return [...src.matchAll(/<HeadOverlay\b([^>]*)>/g)].map((m) => m[1]);
	}

	it('SurfaceShell hands its own id to the overflow sheet', () => {
		const found = calls(read('src/lib/components/SurfaceShell.svelte'));
		expect(found).toHaveLength(1);
		expect(found[0]).toMatch(/surface=\{id\}/);
	});

	it('the flights export menu names the flights surface', () => {
		const found = calls(read('src/lib/components/FlightsModal.svelte'));
		expect(found).toHaveLength(1);
		expect(found[0]).toMatch(/surface="flights"/);
	});
});

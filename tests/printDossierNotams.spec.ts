/* The flight dossier's NOTAM annex, read from the sources (the printReview
 * precedent): the planned flight's bulletin (tests/flightNotamSections.spec.ts
 * pins its selection), between the trips and the weather, on the
 * kneeboard's margins carried by its wrapper on every page it spans. The
 * standalone bulletin stays as it was. The review's hold on the briefing, in
 * every pack: tests/printReview.spec.ts. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const doc = read('src/lib/components/flightprep/PrintDoc.svelte');
const bulletin = read('src/lib/components/NotamPrintDoc.svelte');

/** The declarations of the first `selector {` block after `from`. */
function block(src: string, selector: string, from = 0): string {
	const at = src.indexOf(`${selector} {`, from);
	expect(at, selector).toBeGreaterThan(-1);
	return src.slice(at, src.indexOf('}', at));
}

describe('the annex', () => {
	it('sits in the dossier between the trips and the weather', () => {
		const dossier = doc.indexOf("{#if mode === 'dossier'}");
		const trips = doc.indexOf('{#each navGroups', dossier);
		const annex = doc.indexOf('<NotamPrintDoc annex {past} />', trips);
		const weather = doc.indexOf('{#if annex && tripWx}');
		expect(dossier).toBeGreaterThan(-1);
		expect(trips).toBeGreaterThan(dossier);
		expect(annex).toBeGreaterThan(trips);
		expect(weather).toBeGreaterThan(annex);
		expect(doc.slice(annex - 200, annex)).toContain('{#if briefingLoaded()}');
	});

	it('keeps the kneeboard\'s margins on every page it spans', () => {
		const printCss = doc.slice(doc.indexOf('@media print'));
		const annex = block(printCss, '.fpd-notams');
		const cards = block(printCss, '.fpd-cards');
		for (const prop of ['padding-block', 'padding-inline']) {
			const of = (b: string): string | undefined => new RegExp(`${prop}: ([^;]+);`).exec(b)?.[1];
			expect(of(annex), prop).toBeDefined();
			expect(of(annex), prop).toBe(of(cards));
		}
		expect(annex).toContain('box-decoration-break: clone;');
		expect(annex).toContain('break-before: page;');
		expect(printCss).toMatch(/\.fpd-notams:last-child \{\s*break-after: auto;/);
	});

	it('parks only the standalone bulletin, and prints both renditions', () => {
		expect(bulletin).toContain('<div class="npd-print" class:annex>');
		expect(bulletin).toContain('.npd-print:not(.annex) {');
		expect(bulletin).toMatch(/:global\(html\.notam-print\) \.npd-print,\s*\.npd-print\.annex \{/);
		expect(read('src/lib/components/NotamPrintHost.svelte')).toContain('<NotamPrintDoc />');
	});
});

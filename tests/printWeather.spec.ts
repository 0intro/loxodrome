/* The printed flight preparation and the weather it was computed from.
 *
 * The performance grid's QNH, temperature, wind and chosen runway come from
 * the nearest METAR, and the fuel reserve, the landing mass and every
 * distance come from the forecast winds. Both used to be fetched by a
 * mount-time effect that cannot land before the print snapshot: the pack
 * mounted its print document one frame before window.print(), so the sheet
 * carried ISA / 1013 / calm and the into-wind runway was chosen at zero wind,
 * silently, while the dossier's own annex printed the real METAR three sheets
 * later.
 *
 * The prefetch is what fixes it, and its failure mode is invisible (a plausible
 * sheet with the wrong numbers), so the ordering is pinned here in the
 * printOrientation.spec.ts idiom: no unit test can mount the component, and a
 * regression would not fail anything else. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const modal = read('src/lib/components/FlightPrepModal.svelte');
const page = read('src/lib/components/flightprep/PerformancePage.svelte');

/** The prefetch's task list, the literal that the cancel race awaits. */
const tasksLiteral = ((): string => {
	const from = modal.indexOf('const tasks: Promise<unknown>[] = [');
	const to = modal.indexOf('\n\t\t\t];', from);
	expect(from).toBeGreaterThan(-1);
	expect(to).toBeGreaterThan(from);
	return modal.slice(from, to);
})();

describe('the pack print resolves the weather before it mounts the document', () => {
	it('awaits the prefetch race before printMode is set', () => {
		const race = modal.indexOf('await Promise.race([Promise.all(tasks), abortedPromise(ctrl.signal)]);');
		const mount = modal.indexOf('printMode = mode;');
		expect(race).toBeGreaterThan(-1);
		expect(mount).toBeGreaterThan(race);
	});

	it('fetches the aerodrome weather and the forecast winds inside that race', () => {
		expect(tasksLiteral).toContain('ensureRouteWindFor');
		expect(modal.indexOf('fetchTripWx(wxStops')).toBeGreaterThan(-1);
		expect(modal.indexOf('fetchTripWx(wxStops')).toBeLessThan(modal.indexOf('printMode = mode;'));
	});

	it('runs both in the four-page pack too, not only in the dossier', () => {
		// The winds ride the same task list as the weather, outside every
		// `if (dossier)`: they carry the fuel reserve and the landing mass, so a
		// prep pack without them prints a different aircraft.
		const dossierOnly = modal.indexOf('if (dossier) {\n\t\t\t\ttasks.push(');
		expect(dossierOnly).toBeGreaterThan(modal.indexOf('const tasks: Promise<unknown>[] = ['));
		expect(tasksLiteral).not.toContain('dossier');
	});

	it('asks for the performance grid’s own aerodromes, not just the annex stops', () => {
		expect(modal).toContain('perfWxStops(perfIdents');
		expect(modal).toContain('perfIcaos(orderedTrips(routes.list), flightPrep.perf.manualIcaos)');
	});

	it('adopts the picks so the grid and the annex quote one observation', () => {
		const adopt = modal.indexOf('adoptNearestMetar(');
		expect(adopt).toBeGreaterThan(-1);
		expect(adopt).toBeLessThan(modal.indexOf('printMode = mode;'));
	});
});

describe('the printed sheet says where its numbers came from', () => {
	it('prints the provenance strip and keeps its buttons off the paper', () => {
		expect(page).toContain('<div class="wx-strip">');
		expect(page).toContain('<div class="wx-actions no-print">');
	});

	it('states the fallback when live weather is off', () => {
		expect(page).toContain('t.flightprep.wxLiveOffNote');
	});

	it('tints an estimated cell on paper, where the placeholder never prints', () => {
		expect(page).toContain("class:no-live={f.override == null && f.source === 'estimate'}");
		expect(page).toMatch(/\.print-value\.no-live \{\s*color: var\(--no-live-data\);/);
	});

	it('hands the post-fold sheet’s 12mm to the strip that now opens it', () => {
		expect(page).toMatch(/\.poh\[open\] ~ \.wx-strip \{\s*padding-top: 12mm;/);
		expect(page).toMatch(/\.poh\[open\] ~ \.wx-strip ~ \.phase \{\s*padding-top: 0;/);
	});
});

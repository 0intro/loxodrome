/* Where the print review sits in the two print hosts, read from their
 * source (the tests/printWeather.spec.ts precedent): the decision is asked
 * after every prefetch task has settled, so every issue is known, and before
 * the document mounts and the dialog opens, so none is read after the paper.
 * A Retry re-runs from the finally, once the busy flag is released. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function order(src: string, needles: string[]): void {
	let at = -1;
	for (const n of needles) {
		const i = src.indexOf(n, at + 1);
		expect(i, `"${n}" after the previous one`).toBeGreaterThan(at);
		at = i;
	}
}

describe('the flight preparation packs', () => {
	const src = read('src/lib/components/FlightPrepModal.svelte');

	it('ask after the prefetch and before the document', () => {
		order(src, [
			'await Promise.race([Promise.all(tasks), abortedPromise(ctrl.signal)]);',
			'const decision = await awaitPrintDecision(gen);',
			'adoptNearestMetar(',
			'printMode = mode;',
			'printPage(DOCUMENT_ORIENTATION);',
		]);
	});

	it('retry from the finally, after releasing the busy flag', () => {
		order(src, ['} finally {', 'preparingPrint = false;', 'if (again) {', 'void printPack(mode);']);
	});

	it('ask for the chart catalogs before reading the datasets', () => {
		order(src, ['startChartCatalogs(printableRoutes, runStartMs);', 'const retried = retryDataNow(']);
	});

	it('judge a flight already flown once the fleet is read, and then ask SOFIA nothing', () => {
		order(src, [
			'if (dossier && live && !pastFlight(runStartMs)) {',
			'startChartCatalogs(printableRoutes, runStartMs);',
			'requireAircraftLibrary()',
			'const past = pastFlight();',
			"addPrintIssue(gen, { code: 'flight-past', ...past });",
			'out.charts = pastChartsDoc(past);',
			'return;',
			'const doc = await fetchChartsForPrint(printableRoutes',
			'const decision = await awaitPrintDecision(gen);',
		]);
	});
});

describe('the weather briefing', () => {
	const src = read('src/lib/components/WxPrintHost.svelte');

	it('asks after the prefetch and before the document', () => {
		order(src, [
			'const decision = await awaitPrintDecision(gen);',
			'printing = true;',
			'printPage(DOCUMENT_ORIENTATION);',
		]);
	});

	it('retries from the finally', () => {
		order(src, ['} finally {', 'wxPrint.preparing = false;', 'if (again) {', 'void run();']);
	});

	it('judges a flight already flown once the fleet is read, and then asks SOFIA nothing', () => {
		order(src, [
			'if (!pastFlight(runStartMs)) {',
			'startChartCatalogs(routesNow, runStartMs);',
			'requireAircraftLibrary()',
			'const past = pastFlight();',
			"addPrintIssue(gen, { code: 'flight-past', ...past });",
			'out.charts = pastChartsDoc(past);',
			'return;',
			'const doc = await fetchChartsForPrint(routesNow',
			'const decision = await awaitPrintDecision(gen);',
		]);
	});
});

describe('the summary after the paper', () => {
	it('is gone from every reader', () => {
		for (const p of [
			'src/lib/components/FlightPrepModal.svelte',
			'src/lib/components/WxPrintHost.svelte',
			'src/lib/components/flightprep/PrintProgress.svelte',
			'src/lib/state/printProgress.svelte.ts',
		]) {
			expect(read(p), p).not.toMatch(/printProgress\.summary|progressPrintedIssues/);
		}
	});
});

/* Where the print review sits in the two print hosts, read from their
 * source (the tests/printWeather.spec.ts precedent): the decision is asked
 * after every prefetch task has settled, so every issue is known, and before
 * the document mounts and the dialog opens, so none is read after the paper.
 * A Retry re-runs from the finally, once the busy flag is released. The
 * packs fetch the NOTAM briefing in their prefetch and hold on its verdict
 * in every mode. */
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
	const src = read('src/lib/components/PackPrintHost.svelte');

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
		order(src, ['} finally {', 'packPrint.preparing = false;', 'if (again) {', 'void printPack(mode);']);
	});

	it('start again when the plan moved under the prefetch, the review or the layout', () => {
		// The MSA, terrain and annex stops are the plan's at the run's start,
		// and the sheets read them by leg index (tests/printPlan.spec.ts). A
		// briefing landing after the review moves the nav logs' NOTAM lines.
		order(src, [
			'const planKey = printPlanKey(printableRoutes, routeSettings);',
			'await Promise.race([Promise.all(tasks), abortedPromise(ctrl.signal)]);',
			'if (planMoved()) {',
			'again = true;',
			'briefGen = briefingGeneration();',
			'judgedKey = past ? null : judged();',
			'const decision = await awaitPrintDecision(gen);',
			'if (planMoved() || briefingMoved() || judgedMoved()) {',
			'again = true;',
			'printMode = mode;',
			'if (planMoved() || briefingMoved() || judgedMoved()) {',
			'again = true;',
			'printPage(DOCUMENT_ORIENTATION);',
		]);
	});

	it('start again when what the review judged moved under it, the briefing unchanged', () => {
		// Box B and box C print the SIGMETs and the verdict as they stand
		// when the document mounts: the SIGMETs refetch every 5 min, and the
		// verdict moves with its age, the SUP AIP list and the airspaces.
		order(src, [
			'const judged = (): string => {',
			'const reasons = briefingVerdictNow()',
			'.reasons.map((r) => r.code)',
			"const sigs = ps?.status === 'ok' ? ps.list.map((s) => s.id).join(',') : (ps?.status ?? '');",
			'const judgedMoved = (): boolean => judgedKey !== null && judged() !== judgedKey;',
		]);
	});

	it('fetch the briefing in the prefetch, once a fetch in flight has landed, unless cancelled or flown', () => {
		order(src, [
			'const past = pastFlight();',
			'const tasks: Promise<unknown>[] = [',
			'notamFetchLanded()',
			"printProgress.cancelled || gen !== printProgress.gen || past ? 'skipped' : ensureBriefing(),",
			'.then(supaipRead)',
			"() => stepEnd(gen, 'notams', briefingVerdictNow().reasons.length === 0),",
			'await Promise.race([Promise.all(tasks), abortedPromise(ctrl.signal)]);',
		]);
	});

	it('read the SUP AIP list a French trigger cites before judging the verdict', () => {
		// The supaip reason waits for the list, which its layer, off by
		// default, would load, and BriefingHost asks only after a commit.
		order(src, [
			'const supaipRead = async (): Promise<void> => {',
			'if (!briefingCitesFrSups()) {',
			'await ensureSupaip();',
			"addPrintIssue(gen, { code: 'datasets' });",
			'.then(supaipRead)',
			'await notamFetchLanded();',
			'await Promise.race([supaipRead(), abortedPromise(ctrl.signal)]);',
			'const verdict = briefingVerdictNow();',
		]);
	});

	it('read the airspaces for every run with a route, the verdict reading the RTBA zones', () => {
		order(src, [
			'if (printableRoutes.length > 0) {',
			"read.push('airspaces');",
			"const plan: { kind: PrintStepKind; total?: number }[] = [{ kind: 'datasets', total: read.length }];",
			'if (!sheets && printableRoutes.length > 0) {',
			'await Promise.race([dsSettled(ensureAirspaces()), abortedPromise(ctrl.signal)]);',
			'if (sheets) {',
			'dsSettled(ensureAirspaces()),',
			'if (read.some(retryingGroup)) {',
		]);
	});

	it('read the SIGMETs the flight meets in the prefetch, and name them before the decision', () => {
		const prefetch = 'await Promise.race([Promise.all(tasks), abortedPromise(ctrl.signal)]);';
		order(src, [
			'const sigmetsRead = pages && live && printableRoutes.length > 0;',
			"plan.push({ kind: 'sigmets' });",
			'sigmetsSettled().then(',
			prefetch,
			'const ps = planSigmetsNow();',
			"addPrintIssue(gen, { code: 'sigmets-unknown' });",
			"addPrintIssue(gen, { code: 'sigmets', list: ps.list, fromMs: ps.fromMs });",
			'const decision = await awaitPrintDecision(gen);',
		]);
	});

	it('hold on the verdict in every mode, a fetch the pilot started landed first', () => {
		const prefetch = 'await Promise.race([Promise.all(tasks), abortedPromise(ctrl.signal)]);';
		const issue = "addPrintIssue(gen, { code: 'notams', reasons: verdict.reasons, source: verdict.source });";
		order(src, [
			prefetch,
			'await notamFetchLanded();',
			'if (!past) {',
			'const verdict = briefingVerdictNow();',
			issue,
			"addPrintIssue(gen, { code: 'sigmets-unknown' });",
			'const decision = await awaitPrintDecision(gen);',
		]);
		expect(src.slice(src.indexOf(prefetch), src.indexOf(issue))).not.toContain('if (dossier) {');
	});

	it('hold a flight already flown on that alone, the verdict judging the present', () => {
		const guarded = src.slice(src.indexOf('if (!past) {'), src.indexOf('briefGen = briefingGeneration();'));
		expect(guarded).toContain("code: 'notams'");
		expect(guarded).toContain("code: 'sigmets'");
		expect(guarded).toContain("code: 'sigmets-unknown'");
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
			'src/lib/components/PackPrintHost.svelte',
			'src/lib/components/WxPrintHost.svelte',
			'src/lib/components/flightprep/PrintProgress.svelte',
			'src/lib/state/printProgress.svelte.ts',
		]) {
			expect(read(p), p).not.toMatch(/printProgress\.summary|progressPrintedIssues/);
		}
	});
});

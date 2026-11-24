/* The paper of a flight already flown (flightprep/chartsPrefetch.ts
 * pastFlightNow), read from the sheets' source as tests/printReview.spec.ts
 * reads the print host's: the verdict and the SIGMETs judge the flight from
 * the present on (briefingWindow rolls a past window to now), so every
 * sheet that states them gives way to the past sentence, said once on the
 * Overview, and the profiles' crossings read the dated flight's span, the
 * NOTAM annex's. The screen's own surfaces keep judging from now. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('the paper of a flight already flown', () => {
	it('reads pastFlight at the minute', () => {
		const src = read('src/lib/components/flightprep/chartsPrefetch.ts');
		expect(src).toMatch(/export function pastFlightNow\(\): FlightPast \| null \{\s*void notamState\.tick;\s*return pastFlight\(\);/);
	});

	it('states the past once on the Overview, its SIGMET line gone', () => {
		const src = read('src/lib/components/flightprep/DossierPage.svelte');
		expect(src).toContain('const past = $derived(pastFlightNow());');
		expect(src).toContain('const sigLine = $derived(past ? null : sigmetBoxLine(planSigmetsNow(), 1));');
		expect(src).toContain('briefingPaperParts(briefingVerdictNow(), past ? flightPastText(past) : null)');
	});

	it('drops the performance and fuel pages’ notes', () => {
		for (const [f, sheet] of [
			['src/lib/components/flightprep/PerformancePage.svelte', 'perf'],
			['src/lib/components/flightprep/FuelPlanPage.svelte', 'fuel'],
		] as const) {
			expect(read(f), f).toContain(
				`const briefNote = $derived(pastFlightNow() ? null : briefingSheetNote(briefingVerdictNow(), '${sheet}', 0, true));`,
			);
		}
	});

	it('drops the dossier’s tags and the annex’s verdict, and reads the dated span for the crossings', () => {
		const doc = read('src/lib/components/flightprep/PrintDoc.svelte');
		expect(doc).toContain('const past = $derived(pastFlightNow() !== null);');
		expect(doc).toMatch(
			/const verdictWindow = \$derived\(\s*\(past \? planScope\.flight\?\.window\(\) : planScope\.flight\?\.briefingWindow\(\)\) \?\? activeEvalWindow\(\),\s*\);/,
		);
		expect(doc).toContain('past ? null : briefingActivityUnknown(routeEndpointsLabel(r)),');
		expect(doc).toContain('warn={past ? null : briefingShortTag(briefingVerdictNow(), Date.now())}');
		expect(doc).toMatch(/kneeboard\s+briefing=\{!past\}/);
		expect(doc).toContain('<NotamPrintDoc annex {past} />');
		const sheet = read('src/lib/components/NavLogSheet.svelte');
		expect(sheet).toContain('const briefTag = $derived(briefing ? briefingShortTag(briefingVerdictNow(), Date.now()) : null);');
		const annex = read('src/lib/components/NotamPrintDoc.svelte');
		expect(annex).toContain('const v = past ? null : planScope.briefingVerdict?.();');
	});

	it('starts the print again when the flight turns past under its review', () => {
		expect(read('src/lib/components/PackPrintHost.svelte')).toContain("return `${reasons}|${sigs}|${pastFlight() ? 'past' : ''}`;");
	});

	it('leaves the screen’s own surfaces judging from now', () => {
		const modal = read('src/lib/components/RouteProfileModal.svelte');
		expect(modal).toContain('verdictWindow: () => planScope.flight?.briefingWindow() ?? activeEvalWindow(),');
		expect(modal).not.toContain('pastFlight');
	});
});

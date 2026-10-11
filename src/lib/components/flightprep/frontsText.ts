/* The DWD front charts' sentences, one wording for the print-progress card,
 * the paper and the Weather tab (PrintProgress, PrintDoc, WeatherTab), the
 * chartsText.ts pattern: every function reads `t` at call time (docs/i18n.md
 * rule 2) and formats the instants in the invariant UTC style, the times on
 * the same day as `nowMs` as a bare "13:00Z". */

import { t } from '$lib/state/i18n.svelte';
import { formatZulu, formatZuluNear } from '$lib/format/datetime';
import type { PrintIssue } from '$lib/state/printProgress.svelte';
import {
	frontChartToken,
	type FrontChart,
	type FrontChartsDoc,
	type FrontFailure,
	type FrontNote,
} from '$lib/weather/frontCharts';

/** A failure's translated cause (its wire line rides as a tooltip). */
export function frontCauseText(failure: FrontFailure): string {
	return t.weather.fronts.cause[failure.code];
}

/** One note as the pilot reads it. */
export function frontNoteText(n: FrontNote, nowMs: number): string {
	const when = n.validAtMs != null ? formatZuluNear(n.validAtMs, nowMs) : null;
	const cause = n.failure ? frontCauseText(n.failure) : '';
	switch (n.kind) {
		case 'none-near':
			return t.weather.fronts.noneNear(when);
		case 'beyond':
			return t.weather.fronts.beyond(when ?? '–');
		case 'analyses-unavailable':
			return t.weather.fronts.analysesUnavailable(cause);
		case 'forecasts-unavailable':
			return t.weather.fronts.forecastsUnavailable(cause);
		case 'undated':
			return t.weather.fronts.undated(n.count ?? 0);
		case 'situation-old':
			return t.weather.fronts.situationOld(when ?? '–');
	}
}

/** A chart that could not be retrieved. */
export function frontFailedText(chart: FrontChart, failure: FrontFailure): string {
	return t.weather.fronts.failed({ chart: frontChartToken(chart), cause: frontCauseText(failure) });
}

/** Everything the paper says beside the charts: each note, then each chart
 *  not retrieved. */
export function frontNoteLines(doc: FrontChartsDoc): string[] {
	const at = doc.fetchedAtMs;
	return [
		...doc.notes.map((n) => frontNoteText(n, at)),
		...doc.failed.map((f) => frontFailedText(f.chart, f.failure)),
	];
}

/** A chart's label: its kind and validity, and a forecast's lead (the run
 *  in full is the paper's head and the chart's own legend; on one line the
 *  list reads like the TEMSI and WINTEM rows below it). */
export function frontChartLabel(c: FrontChart): string {
	const when = formatZulu(new Date(c.validAtMs));
	return c.kind === 'analysis'
		? t.weather.fronts.analysis(when)
		: t.weather.fronts.forecast({ when, leadH: c.leadH ?? 0 });
}

/** A front-chart issue of the print-progress card, worded as the paper
 *  words it. */
export function frontIssueText(
	issue: Extract<PrintIssue, { code: 'fronts-unavailable' | 'fronts-missing' | 'fronts-failed' }>,
	nowMs: number,
): string {
	switch (issue.code) {
		case 'fronts-unavailable':
			return issue.half === 'analyses'
				? t.weather.fronts.analysesUnavailable(frontCauseText(issue.failure))
				: t.weather.fronts.forecastsUnavailable(frontCauseText(issue.failure));
		case 'fronts-missing': {
			const when = issue.validAtMs != null ? formatZuluNear(issue.validAtMs, nowMs) : null;
			return issue.kind === 'beyond'
				? t.weather.fronts.beyond(when ?? '–')
				: t.weather.fronts.noneNear(when);
		}
		case 'fronts-failed':
			return t.weather.fronts.failed({ chart: issue.chart, cause: frontCauseText(issue.failure) });
	}
}

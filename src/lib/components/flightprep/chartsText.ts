/* The TEMSI / WINTEM annex's sentences, one wording for the print-progress
 * card and the paper (PrintProgress, PrintDoc): every function reads `t` at
 * call time (docs/i18n.md rule 2) and formats the instants in the invariant
 * UTC style, the times near `nowMs` as a bare "13:00Z". */

import { t } from '$lib/state/i18n.svelte';
import { formatZulu, formatZuluNear } from '$lib/format/datetime';
import type { SofiaChartProduct } from '$lib/sofia/charts';
import type { SofiaFailure } from '$lib/sofia/failure';
import { chartToken, type FlightPast, type TripChartNoteKind } from '$lib/weather/tripCharts';
import type { ChartsReadiness } from './chartsPrefetch';

/** SOFIA's own invariant tokens: "TEMSI FRANCE", "WINTEM EUROC FL50-100". */
export function chartLabel(product: SofiaChartProduct, zone: string, level: string | null): string {
	return `${product} ${zone}${level ? ` ${level}` : ''}`;
}

/** One chart note (weather/tripCharts.ts) as the pilot reads it. */
export function chartNoteText(
	n: {
		product: SofiaChartProduct;
		zone: string;
		level: string | null;
		kind: TripChartNoteKind;
		validAtMs: number | null;
		publishAtMs: number | null;
	},
	nowMs: number,
): string {
	const chart = chartLabel(n.product, n.zone, n.level);
	const valid = n.validAtMs != null ? formatZuluNear(n.validAtMs, nowMs) : null;
	const at = n.publishAtMs != null ? formatZuluNear(n.publishAtMs, nowMs) : null;
	switch (n.kind) {
		case 'not-yet-published':
			return t.flightprep.chartsNotYetPublished({ chart, valid, at });
		case 'missing':
			return t.flightprep.chartsMissing({ chart, valid: valid ?? '–', at });
		case 'later':
			return t.flightprep.chartsLater({ chart, valid: valid ?? '–', at });
		case 'none':
			return t.flightprep.chartsNone(chart);
		case 'undated':
			return t.flightprep.chartsUndated(chart);
		case 'extrapolated':
			return t.flightprep.chartExtrapolated({ next: valid ?? '–', at: at ?? '–' });
	}
}

/** A chart that could not be downloaded or drawn. */
export function chartFailedText(chart: string, validAtMs: number | null, nowMs: number): string {
	return t.flightprep.chartDownloadFailed({
		chart,
		valid: validAtMs != null ? formatZuluNear(validAtMs, nowMs) : '–',
	});
}

/** A catalog that could not be listed, with its translated cause. */
export function chartCatalogText(product: SofiaChartProduct, zone: string, failure: SofiaFailure): string {
	return t.flightprep.chartsCatalogFailed({
		chart: chartLabel(product, zone, null),
		cause: t.errors.sofiaCause[failure.code],
	});
}

/** The print menu's readiness line: what a print now would carry, in the
 *  paper's own sentences (the charts, each catalog that could not be
 *  listed, each note), or why it would carry none. The chart an
 *  extrapolated TEMSI stands in for is said as the chart not out yet, which
 *  is what the pilot can act on: when to print again. Null with nothing to
 *  say. */
export function readinessText(r: ChartsReadiness, nowMs: number): string | null {
	switch (r.kind) {
		case 'past':
			return flightPastText(r.past);
		case 'checking':
			return t.flightprep.chartsChecking;
		case 'ready': {
			const parts: string[] = [];
			if (r.picks.length > 0) {
				const list = r.picks.map((c) =>
					c.validAtMs != null ? `${chartToken(c)} ${formatZuluNear(c.validAtMs, nowMs)}` : chartToken(c),
				);
				parts.push(t.flightprep.chartsPrintedNow(list.join(', ')));
			}
			for (const f of r.catalogFailures) {
				parts.push(chartCatalogText(f.product, f.zone, f.failure));
			}
			for (const n of r.notes) {
				parts.push(chartNoteText(n.kind === 'extrapolated' ? { ...n, kind: 'not-yet-published' } : n, nowMs));
			}
			return parts.length > 0 ? parts.join(' ') : null;
		}
	}
}

/** The flight the dossier plans is behind us: its stated departure, or its
 *  date alone when no departure time was given. */
export function flightPastText(past: FlightPast): string {
	const when = formatZulu(new Date(past.startMs));
	return t.flightprep.flightPast(past.dayOnly ? when.slice(0, 10) : when);
}

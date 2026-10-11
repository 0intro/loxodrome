/* The Overview's weather box, worded: the wind each trip flies
 * (windBasis.ts), what the forecast says beside it (the levels behind its
 * mean, the ISA deviation, the lowest freezing level) and the departure's
 * QNH, the performance page's own. It STATES what the plan uses; the wind is
 * set where it acts (the Route tab's wind switch), a QNH where it acts (a
 * performance column). Builds text from the catalogs at call time, nothing
 * translated stored (docs/i18n.md). */

import { t } from '$lib/state/i18n.svelte';
import { fmtLevelUnit, fmtWind, isFlightLevelAt } from '$lib/route/format';
import { formatZuluNear } from '$lib/format/datetime';
import { fmtIsaDev } from '$lib/weather/openMeteo';
import type { Route } from '$lib/state/route.svelte';
import type { WindBasis } from './windBasis';
import type { MeanForecastWind, PlanForecastFacts, WindVec } from '$lib/route/legWind';
import type { AutoSource, WxPick } from './runwayPerf';

/** A stretch of a line in its own ink: the freezing level in the manual
 *  ink where the plan flies into it. Never muted inline, whose taller line
 *  box (app.css `.muted`) would grow the line. */
export interface BoxPart {
	text: string;
	ink: 'plain' | 'manual';
}

/** One line of a cell: `manual` in the manual ink (what the pilot set or the
 *  plan should not fly unnoticed), `muted` for a source. `parts`, when set,
 *  are the line's stretches (`text` is them end to end). */
export interface BoxLine {
	text: string;
	ink: 'plain' | 'muted' | 'manual';
	parts?: readonly BoxPart[] | undefined;
}

/** What the wind cell states beyond each trip's basis, for the whole plan
 *  (routeWind.svelte.ts plansMeanForecast / plansForecastFacts /
 *  plansForecastSource): the mean the plan flies, the forecast's facts, where
 *  that forecast comes from, and the altitude above which a level is a
 *  flight level (the transition altitude under the semicircular rule, else
 *  Infinity: NavLogSheet's convention). */
export interface PlanWx {
	mean: MeanForecastWind | null;
	facts: PlanForecastFacts | null;
	source: string | null;
	taFt: number;
}

/** The levels behind the mean: the one every leg flies, else the range. */
function levelWords(levels: PlanForecastFacts['levels'], taFt: number): string {
	const low = fmtLevelUnit(levels.lowFt, taFt);
	const high = fmtLevelUnit(levels.highFt, taFt);
	if (low === high) {
		return t.flightprep.wxLevelAt({ level: low, fl: isFlightLevelAt(levels.lowFt, taFt) });
	}
	return t.flightprep.wxLevelRange({
		low,
		lowFl: isFlightLevelAt(levels.lowFt, taFt),
		high,
		highFl: isFlightLevelAt(levels.highFt, taFt),
	});
}

function meanLine(m: MeanForecastWind, wx: PlanWx): BoxLine {
	const levels = wx.facts ? levelWords(wx.facts.levels, wx.taFt) : '';
	return {
		text:
			m.kind === 'mean'
				? t.flightprep.wxMean({ wind: fmtWind(m.dirDeg, m.speedKt), levels })
				: m.kind === 'varies'
					? t.flightprep.wxMeanVaries(levels)
					: t.flightprep.wxMeanLight(levels),
		ink: 'plain',
	};
}

/** The forecast's temperatures over the plan, one line: the ISA deviation,
 *  then the lowest freezing level, in the manual ink where a leg flies at or
 *  above its own. None when neither is known. */
function factsLines(f: PlanForecastFacts | null): BoxLine[] {
	if (!f) {
		return [];
	}
	const parts: BoxPart[] = [];
	if (f.isaDevC != null) {
		parts.push({ text: t.flightprep.wxIsa(fmtIsaDev(f.isaDevC)), ink: 'plain' });
	}
	if (f.freezing) {
		const words = { ft: fmtLevelUnit(f.freezing.lowestFt, Infinity), first: parts.length === 0 };
		if (parts.length > 0) {
			parts.push({ text: ', ', ink: 'plain' });
		}
		parts.push({
			text: f.freezing.atOrBelow ? t.flightprep.wxFreezingAtOrBelow(words) : t.flightprep.wxFreezingDownTo(words),
			ink: f.freezing.reached ? 'manual' : 'plain',
		});
	}
	return parts.length === 0 ? [] : [{ text: parts.map((p) => p.text).join(''), ink: 'plain', parts }];
}

/** The wind cell, four lines at most whatever the trip count (the Overview
 *  prints on one sheet): the plan's one manual wind, or still air
 *  everywhere, with the legs flying their own and the forecast's
 *  temperatures under their source; else the forecast's mean over the whole
 *  plan with its levels (each nav log stating its own route's), its
 *  temperatures, the legs it misses and what they fly instead (one missed
 *  leg of a single trip named, more counted: two numbers already outgrow
 *  the French line's column on paper), the legs with a wind of their own,
 *  then where the forecast came from. A plan whose every leg flies its own
 *  wind leads with those: the forecast flies none. */
export function overviewWindLines(trips: readonly { route: Route; basis: WindBasis }[], wx: PlanWx): BoxLine[] {
	const first = trips[0];
	if (!first) {
		return [{ text: '—', ink: 'muted' }];
	}
	const overrides = trips.reduce((n, x) => n + x.basis.overrides, 0);
	const ownLegs: BoxLine[] = overrides > 0 ? [{ text: t.flightprep.wxAndLegs(overrides), ink: 'manual' }] : [];
	const facts = factsLines(wx.facts);
	const source: BoxLine[] = wx.source ? [{ text: wx.source, ink: 'muted' }] : [];
	// Where the wind is not the forecast, its temperatures still say where
	// they come from.
	const factsSourced = facts.length > 0 ? [...facts, ...source] : [];
	if (first.basis.kind === 'manual' && trips.every((x) => x.basis.kind === 'manual')) {
		const w = first.basis.wind;
		return [
			{ text: t.navlog.windSummaryManual(fmtWind(w.dirDeg, w.speedKt)), ink: 'manual' },
			...ownLegs,
			...factsSourced,
		];
	}
	if (trips.every((x) => x.basis.kind === 'none')) {
		return [{ text: t.flightprep.wxNoWind, ink: 'manual' }, ...ownLegs, ...factsSourced];
	}
	if (trips.every((x) => x.basis.legs > 0 && x.basis.overrides === x.basis.legs)) {
		return [...ownLegs, ...factsSourced];
	}
	// The forecast flies the plan; a trip it serves nowhere ('none') is all
	// missed legs.
	let missed = 0;
	let missedWind: WindVec | null = null;
	for (const { basis } of trips) {
		if (basis.kind === 'forecast') {
			missed += basis.missed.length;
			missedWind ??= basis.missedWind;
		} else if (basis.kind === 'none') {
			missed += basis.legs - basis.overrides;
		}
	}
	const lines: BoxLine[] = [
		wx.mean
			? meanLine(wx.mean, wx)
			: { text: source.length === 0 && missed === 0 ? t.route.windFetching : t.flightprep.wxWindForecast, ink: 'plain' },
		...facts,
	];
	if (missed > 0) {
		const only =
			trips.length === 1 && first.basis.kind === 'forecast' && first.basis.missed.length === 1
				? first.basis.missed[0]
				: undefined;
		lines.push({
			text:
				(only !== undefined ? t.flightprep.wxLegWithout(only) : t.flightprep.wxLegsWithoutCount(missed)) +
				(missedWind
					? t.flightprep.wxMissedManual(fmtWind(missedWind.dirDeg, missedWind.speedKt))
					: t.flightprep.wxMissedStillAir),
			ink: 'manual',
		});
	}
	lines.push(...ownLegs, ...source);
	return lines;
}

/** What the departure's QNH cell reads: the take-off column's value and its
 *  source (runwayPerf.ts autoQnh, or the value typed there). */
export interface DepartureQnh {
	icao: string;
	hpa: number;
	typed: boolean;
	source: AutoSource;
	pick: WxPick | null;
}

/** The QNH cell: the value, then where it comes from. */
export function departureQnhLines(q: DepartureQnh | null, nowMs: number): BoxLine[] {
	if (!q) {
		return [{ text: '—', ink: 'muted' }];
	}
	const value: BoxLine = { text: `${Math.round(q.hpa)} hPa`, ink: q.typed ? 'manual' : 'plain' };
	let source: BoxLine;
	if (q.typed) {
		source = { text: t.flightprep.wxQnhTyped, ink: 'manual' };
	} else if (q.source === 'metar' && q.pick?.kind === 'metar') {
		const m = q.pick.pick.metar;
		source = { text: t.flightprep.wxQnhMetar({ id: m.icaoId, at: formatZuluNear(m.obsTime * 1000, nowMs) }), ink: 'muted' };
	} else if (q.source === 'forecast' && q.pick?.kind === 'forecast') {
		source = { text: t.flightprep.wxQnhForecast(formatZuluNear(q.pick.fc.atMs, nowMs)), ink: 'muted' };
	} else if (q.source === 'dossier') {
		source = { text: t.flightprep.wxQnhDefault, ink: 'muted' };
	} else {
		source = { text: t.flightprep.wxQnhStandard, ink: 'muted' };
	}
	return [value, source];
}

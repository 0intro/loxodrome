/* The viewing conditions in words: the period and the level band the map is
 * read at, as the toolbar's chips say them (ViewConditions.svelte) and as the
 * printed NOTAM bulletin states them (NotamPrintDoc.svelte), which must say
 * the same thing. Each reads reactive state: call it from a $derived or a
 * template.
 *
 * The chips say what the pilot SET, a mode that does not resolve included
 * ("Flight" with no flyable trip, a custom range not yet valid, a band typed
 * upside down), since that is what the popover behind them fixes. Paper has
 * no popover: the bulletin states what was APPLIED (`applied`), which is
 * where activeEvalWindow and activeAltitudeBand fall back to, so the page
 * never names a period or a band that did not cut it. */

import {
	activeAltitudeBand,
	customWindow,
	DEFAULT_HORIZON_H,
	filter,
	windowError,
	type WindowMode,
} from '$lib/state/filter.svelte';
import { planScope } from '$lib/state/planScope.svelte';
import { t } from '$lib/state/i18n.svelte';
import { formatZuluSpan, groupThousands } from '$lib/format/datetime';

/** Read the conditions as set (the chips) or as applied (paper). */
export interface ConditionsReading {
	applied?: boolean | undefined;
}

/** The mode the period is read in: as set, or as applied, which is Now
 *  wherever the mode's own window does not resolve (activeEvalWindow's
 *  fallback: a custom range not set, a flight with no window). */
function periodMode(o: ConditionsReading): WindowMode {
	const mode = filter.window.mode;
	if (!o.applied) {
		return mode;
	}
	if (mode === 'custom') {
		return customWindow() ? 'custom' : 'now';
	}
	if (mode === 'flight') {
		return planScope.flight?.window() ? 'flight' : 'now';
	}
	return 'now';
}

/** Whether the period RESTRICTS, the level band's principle: any mode but
 *  Now, and Now with a bounded look-ahead, which keeps what starts past it
 *  off the map. The look-ahead persists (docs/preferences.md), so a bound
 *  chosen last week must not read like the unbounded default. */
export function periodRestricts(o: ConditionsReading = {}): boolean {
	return periodMode(o) !== 'now' || filter.window.horizonH !== DEFAULT_HORIZON_H;
}

/** The period: Now or its look-ahead, the flight's span, or the typed
 *  custom range. */
export function periodLabel(o: ConditionsReading = {}): string {
	if (!o.applied && windowError()) {
		return t.conditions.periodInvalid;
	}
	const mode = periodMode(o);
	if (mode === 'custom') {
		const d = filter.window;
		const part = (date: string, time: string): string =>
			date ? date + (time && time !== '00:00' ? ' ' + time : '') : '–';
		return `${part(d.fromDate, d.fromTime)} – ${part(d.toDate, d.toTime)}`;
	}
	if (mode === 'flight') {
		const w = planScope.flight?.window() ?? null;
		return w ? formatZuluSpan(w.from, w.to) : t.conditions.flight;
	}
	const h = filter.window.horizonH;
	return h == null ? t.conditions.now : t.conditions.next(h);
}

/** Whether the level band restricts: enabled as set, applied only while
 *  its range is one the filter takes (activeAltitudeBand). */
export function levelsRestrict(o: ConditionsReading = {}): boolean {
	return o.applied ? activeAltitudeBand() !== null : filter.altitude.enabled;
}

/** The level band, or All levels while it is off (or, applied, while it
 *  takes no range). */
export function levelsLabel(o: ConditionsReading = {}): string {
	return levelsRestrict(o)
		? `${groupThousands(filter.altitude.floor)}–${groupThousands(filter.altitude.ceiling)} ft`
		: t.conditions.allLevels;
}

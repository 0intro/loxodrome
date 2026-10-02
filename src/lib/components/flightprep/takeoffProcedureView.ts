/* How a take-off pick (aircraft/performance.ts pickTakeoff) reads, the same
 * on the performance page, its print and the Overview: the procedure to fly
 * in its ink, and why. Component-side because it reads the catalogs, which
 * the pure core (performance.ts, runwayPerf.ts) must not. */

import { t } from '$lib/state/i18n.svelte';
import type { TakeoffPick } from '$lib/aircraft/performance';
import type { PerfRow } from './runwayPerf';

/** The procedure to fly: "Normale (volets 0°)", "Terrain court (volets 25°)",
 *  a flap setting alone for a sheet naming no procedure, "Aucune ne
 *  convient" when every judged configuration falls short, the empty-cell
 *  dash when nothing could be judged. */
export function procedureText(pick: TakeoffPick<PerfRow> | null): string {
	if (!pick || pick.status === 'unknown') {
		return '—';
	}
	if (pick.status === 'none') {
		return t.flightprep.procNone;
	}
	const { procedure, flapsDeg } = pick.row;
	if (procedure === 'normal') {
		return t.flightprep.procNormal(flapsDeg);
	}
	if (procedure === 'short-field') {
		return t.flightprep.procShortField(flapsDeg);
	}
	return flapsDeg == null ? t.flightprep.procNormal(null) : t.flightprep.procFlapsOnly(flapsDeg);
}

/** The same answer on two lines, for a narrow cell (the Overview): the
 *  procedure's word, then its flaps on the second line (empty when the
 *  first already names them or the sheet does not say). None fitting reads
 *  as the short word, the danger ink and the cell's title saying the rest:
 *  six trips leave a French column about 44 px wide on paper, where "Aucune
 *  ne convient" broke inside its last word. */
export function procedureLines(pick: TakeoffPick<PerfRow> | null): [string, string] {
	if (pick?.status === 'none') {
		return [t.flightprep.procNoneShort, ''];
	}
	if (pick?.status !== 'fits') {
		return [procedureText(pick), ''];
	}
	const { procedure, flapsDeg } = pick.row;
	const flaps = flapsDeg == null ? '' : t.flightprep.procFlapsOnly(flapsDeg);
	if (procedure === 'normal') {
		return [t.flightprep.procNormal(null), flaps];
	}
	if (procedure === 'short-field') {
		return [t.flightprep.procShortField(null), flaps];
	}
	return [flaps || t.flightprep.procNormal(null), ''];
}

/** Its ink: the short-field procedure in the accent (a checklist change, not
 *  a hazard), none fitting in the danger red. The workbook classes
 *  (styles/workbook.css). */
export function procedureInk(pick: TakeoffPick<PerfRow> | null): '' | 'ok' | 'proc-short' | 'danger' {
	if (!pick || pick.status === 'unknown') {
		return '';
	}
	if (pick.status === 'none') {
		return 'danger';
	}
	return pick.row.procedure === 'short-field' ? 'proc-short' : 'ok';
}

/** Why, where it changes what the pilot does: the short-field procedure's
 *  checklist and speeds. */
export function procedureTip(pick: TakeoffPick<PerfRow> | null): string | undefined {
	return pick?.status === 'fits' && pick.row.procedure === 'short-field'
		? t.flightprep.procShortFieldTip(pick.row.flapsDeg)
		: undefined;
}

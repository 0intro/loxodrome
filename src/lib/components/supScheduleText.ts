/* A supplement's schedule as its panel prints it, a line a period: its
 * dates, its times and the days its rule holds, and how it holds where the
 * supplement says (activable, by NOTAM with its notice, read in part). A
 * standing rule reads over the whole validity. Every function reads the
 * reactive `t` at call time, so callers invoke them from templates. */

import { activationTimes, type SupAipActivation, type SupAipStanding } from '$lib/data/supaip';
import { dayRuleText } from '$lib/format/dayRule';
import { t } from '$lib/state/i18n.svelte';
import { noticeText } from './zoneStateText';

/** A YYYY-MM-DD day as "11 Jun 2026". */
function scheduleDate(d: string): string {
	const [y, m, day] = d.split('-').map(Number);
	return y && m && day ? `${day} ${t.common.months[m - 1]} ${y}` : d;
}

/** "11 Jun 2026, 12:00 - 18:00" / "16 Feb 2026 - 31 Jul 2026, 09:00 - 16:00,
 *  may be activated" / "16 Apr 2026 - 12 Apr 2028" (all day has no times) /
 *  "14 Sep 2026 - 25 Sep 2026, SS+30 - SR-30, Monday to Friday, except public
 *  holidays". */
export function activationText(a: SupAipActivation): string {
	const date = a.dateTo ? `${scheduleDate(a.date)} - ${scheduleDate(a.dateTo)}` : scheduleDate(a.date);
	return [date, ...hoursParts(a), ...modePart(a.mode, a.noticeMin)].join(', ');
}

/** "Throughout the validity: 20:30 - 05:30, activated by NOTAM, 48 h notice
 *  (summer: 1 h earlier)", a rule with no hours reading H24. */
export function standingText(s: SupAipStanding): string {
	const { mode, noticeMin, summerEarlier, ...when } = s;
	const hours = hoursParts({ date: '', ...when });
	const parts = [...(hours.length > 0 ? hours : [t.detail.supStandingH24]), ...modePart(mode, noticeMin)];
	const line = parts.join(', ');
	return t.detail.supStanding(summerEarlier ? `${line} ${t.detail.supSummerEarlier}` : line);
}

/** Its times and the days its rule holds ("Monday to Friday, except public
 *  holidays"). */
function hoursParts(a: SupAipActivation): string[] {
	const times = activationTimes(a, {
		earliest: t.detail.supTimeEarliest,
		latest: t.detail.supTimeLatest,
	});
	const rule = dayRuleText(a, {
		weekdays: t.common.weekdays,
		run: t.detail.supDaysRun,
		list: t.detail.supDaysList,
		except: t.detail.supExceptDays,
	});
	return [times, rule].filter((x) => x !== '');
}

/** How a period holds where the supplement says it: a firm one says
 *  nothing. */
function modePart(mode: SupAipStanding['mode'], noticeMin: number | undefined): string[] {
	const d = t.detail;
	switch (mode) {
		case 'activable':
			return [d.supModeActivable];
		case 'notam':
			return [noticeMin !== undefined ? d.supModeNotamNotice(noticeText(noticeMin)) : d.supModeNotam];
		case 'unread':
			return [d.supModeUnread];
		default:
			return [];
	}
}

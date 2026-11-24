/* A SUP AIP activation's day rule in words: its weekdays as runs and lists
 * ("Monday to Friday", "Tuesday and Thursday"), then the public holidays and
 * their eves it skips. Locale-free: the words come from the caller's
 * catalog. */

import type { SupAipActivation } from '$lib/data/supaip';

export interface DayRuleWords {
	/** The weekdays in ISO order, Monday first. */
	weekdays: readonly string[];
	/** A run of three days or more, by its first and last. */
	run: (from: string, to: string) => string;
	/** Several runs and days. */
	list: (items: string[]) => string;
	/** The public holidays and their eves skipped, empty for none. */
	except: (holidays: boolean, eves: boolean) => string;
}

/** The activation's day rule in words, empty when it holds every day. */
export function dayRuleText(a: SupAipActivation, w: DayRuleWords): string {
	const parts: string[] = [];
	const days = [...new Set(a.days ?? [])].filter((d) => d >= 1 && d <= 7).sort((x, y) => x - y);
	if (days.length > 0 && days.length < 7) {
		const name = (d: number) => w.weekdays[d - 1] ?? '';
		const items: string[] = [];
		for (let i = 0; i < days.length; ) {
			let j = i;
			while (j + 1 < days.length && days[j + 1] === days[j] + 1) {
				j++;
			}
			if (j - i >= 2) {
				items.push(w.run(name(days[i]), name(days[j])));
			} else {
				for (let k = i; k <= j; k++) {
					items.push(name(days[k]));
				}
			}
			i = j + 1;
		}
		parts.push(items.length === 1 ? items[0] : w.list(items));
	}
	const except = w.except(a.exceptHolidays === true, a.exceptHolidayEves === true);
	if (except) {
		parts.push(except);
	}
	return parts.join(', ');
}

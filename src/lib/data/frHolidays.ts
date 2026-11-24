/* The French public holidays, the fêtes légales of Code du travail article
 * L3133-1, which a SUP AIP schedule's "sauf jours fériés" takes off: New
 * Year's Day, Easter Monday, 1 May, 8 May, Ascension Day, Whit Monday, 14
 * July, 15 August, 1 November, 11 November and Christmas Day. The two more
 * days of Alsace-Moselle and the overseas departments' own stay held, the
 * side that keeps a zone drawn. */

const DAY_MS = 86_400_000;

/** Easter Sunday of `year` in the Gregorian calendar, by the anonymous
 *  algorithm Meeus gives, as [month 1 to 12, day]. */
export function easterSunday(year: number): [number, number] {
	const a = year % 19;
	const b = Math.floor(year / 100);
	const c = year % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const f = Math.floor((b + 8) / 25);
	const g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 22 * l) / 451);
	const n = h + l - 7 * m + 114;
	return [Math.floor(n / 31), (n % 31) + 1];
}

const byYear = new Map<number, Set<string>>();

/** The public holidays of `year`, as ISO dates. */
export function publicHolidays(year: number): Set<string> {
	let days = byYear.get(year);
	if (days) {
		return days;
	}
	const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
	const [em, ed] = easterSunday(year);
	const easter = Date.UTC(year, em - 1, ed);
	days = new Set([
		`${year}-01-01`,
		iso(easter + DAY_MS),
		`${year}-05-01`,
		`${year}-05-08`,
		iso(easter + 39 * DAY_MS),
		iso(easter + 50 * DAY_MS),
		`${year}-07-14`,
		`${year}-08-15`,
		`${year}-11-01`,
		`${year}-11-11`,
		`${year}-12-25`,
	]);
	byYear.set(year, days);
	return days;
}

/** Is the ISO date a French public holiday? */
export function isPublicHoliday(date: string): boolean {
	return publicHolidays(Number(date.slice(0, 4))).has(date);
}

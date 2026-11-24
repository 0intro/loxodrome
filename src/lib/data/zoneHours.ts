/* A French restricted area's published hours as activity rules: the HOR
 * column of AIP France ENR 5.1, which cmd/fr carries as `workHr` (the code:
 * H24, HX, HO, HJ, HN, NOTAM, OTHER, TIMSH) and `rmkWorkHr` (the text, a
 * French half and an English one parted by "\\").
 *
 * GEN 2.2 defines the codes: H24 "Service permanent de jour et de nuit", HJ
 * sunrise to sunset, HN sunset to sunrise, HX "Pas d'heures précises de
 * fonctionnement", HO "Service disponible selon les besoins de
 * l'exploitation". The text says how the zone holds in them: "Possible
 * activation H24" (LF-R 151), "Possible activation SR-30 to SS+30 according
 * to protocol", "MON-FRI except public HOL: 0700-2300", the RTBA's
 * "Activation by NOTAM. Except public HOL : - MON : 0830-1100 - TUE ...".
 *
 * The reader takes the English half, its day groups, clock and sun windows
 * and the "(SUM -1HR)" note, and answers a rule per day group and window,
 * in the mode its clause states (activable, by NOTAM, active), a clause
 * stating none in the mode stated before it: LF-R 71 A prints "POSSIBLE
 * ACTIVATION: - MON-FRI: 0600- 2300 ACTIVATION BY NOTAM - SAT: 0600-1100".
 * A window printed with no mode word holds firm only under a code of
 * definite hours (H24, HJ, HN): under HX or HO the hours bound the zone's
 * possible activity. A text it reads in part (a yearly date range, another
 * unit's hours, the activity of another zone, holidays as days of activity)
 * widens: a zone that may be activated may be so at all times, activable
 * where any clause says so, and a firm one reads unread. "Other times ...
 * by NOTAM" and "... by NOTAM outside these SKED" add a rule by NOTAM at all
 * times. The notice a clause states for an activation by NOTAM ("PN 48 HR",
 * "AT H-48HR", "with 7 days prior notice") goes on its rules by NOTAM.
 *
 * Pure, cached per text; pinned by tests/zoneHours.spec.ts. */

import type { ActivityMode, ActivityRule } from './activity';
import { normalizeClause, permanentHours } from './airspaceEntry';

/** ISO weekdays (Monday 1), as a supplement activation's `days`. */
const WEEKDAYS: Record<string, number> = {
	MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6, SUN: 7,
	LUN: 1, MAR: 2, MER: 3, JEU: 4, VEN: 5, SAM: 6, DIM: 7,
};
const DAY_NAME = '(?:MON|TUE|WED|THU|FRI|SAT|SUN|LUN|MAR|MER|JEU|VEN|SAM|DIM)';

/** A day list: "MON-FRI", "MON TO THU", "TUE, WED, THU AND FRI", "MON, WED-SAT". */
const DAYS_RE = new RegExp(
	`^${DAY_NAME}(?:\\s*(?:-|TO|AU|,|AND|ET)\\s*${DAY_NAME})*`,
);
/** The days a clause takes off: "EXCEPT PUBLIC HOL", "EXCEPT SAT, SUN AND HOL", "SAUF JF". */
const EXCEPT_RE = new RegExp(
	`(?:EXCEPT|SAUF)\\s+((?:(?:PUBLIC\\s+)?(?:HOL(?:IDAYS?)?|JF)|${DAY_NAME})(?:\\s*(?:,|AND|ET)\\s*(?:(?:PUBLIC\\s+)?(?:HOL(?:IDAYS?)?|JF)|${DAY_NAME}))*)`,
);
/** A sun end, French "LS" (lever) and "CS" (coucher) read as SR and SS. */
const SUN = '(?:SR|SS)(?:[+-]\\d{1,3}(?:HR?)?)?';
/** A window: "H24", "0800-1700", "SR-30-SS+30", "SS+30-2400", "SR-SS". */
const WINDOW_RE = new RegExp(`^(?:H24|(?:\\d{4}|${SUN})-(?:\\d{4}|${SUN}))`);
/** "(SUM : -1 HR)", "SUM: -1HR.", "SUM : - 1HR": hours printed in winter UTC. */
const SUMMER_RE = /\(?\s*SUM\s*:?\s*-\s*1\s*HR?S?\s*\.?\s*\)?/g;
/** The notice of an activation by NOTAM: "PN 48 HR", "WITH PN 72HR",
 *  "WITH PPR 72 HR", "AT H-48HR", "WITH 7 DAYS PRIOR NOTICE". */
const NOTICE = String.raw`(?:WITH\s+(?:A\s+)?)?(?:\b(?:PN|PPR)\s*:?\s*(\d+)\s*(HRS?|HOURS?|H|DAYS?|MIN(?:UTES?)?)\b|\bAT\s+H\s*-\s*(\d+)\s*(HRS?|H)\b|\b(\d+)\s*(DAYS?|HRS?|HOURS?)\s+PRIOR\s+NOTICE\b)`;
const NOTICE_RE = new RegExp(NOTICE);
/** "Other times, possible activation by NOTAM", "Other hours : activity
 *  announced by NOTAM", "Outside these SKED, activity notified by NOTAM"
 *  and "Possible activation by NOTAM PN 48 HR outside these SKED": a rule
 *  by NOTAM at all times, with the notice it states. */
const OTHER_TIMES_RE = new RegExp(
	[
		String.raw`(?:OTHER (?:TIMES|HOURS)|OUTSIDE (?:(?:THESE|THOSE|THE) )?(?:ACTIVITY )?(?:SKED|SCHEDULES?|HOURS|TIMES)),?[\s#]*:?[\s#]*(?:POSSIBLE ACTIVATION|ACTIVITY (?:ANNOUNCED|NOTIFIED)|ACTIVATION(?: ANNOUNCED)?|ANNOUNCED)?[\s#]*BY\s+NOTAM(?:\s+${NOTICE})?\.?`,
		String.raw`(?:POSSIBLE ACTIVATION|ACTIVATION|ACTIVITY ANNOUNCED)\s+BY\s+NOTAM(?:[\s#]+${NOTICE})?[\s#]+OUTSIDE\s+(?:THESE|THOSE|THE)\s+(?:SKED|SCHEDULES?|HOURS|TIMES)\.?`,
	].join('|'),
	'g',
);
/** The words that say a zone may be activated. */
const ACTIVABLE_RE = /POSSIBLE ACTIVATION|ACTIVATION POSSIBLE|\bACTIVABLES?\b/;
/** "According to protocol": activable where the text states no mode. */
const PROTOCOL_RE = /ACCORDING TO PROTOCOLS?|SELON (?:LES )?(?:MODALITES? )?PROTOCOL/;
const NOTAM_RE = /\bNOTAM\b/;
const ACTIVE_RE = /\bACTIVE\b/;
/** Who knows the activity, a tail that states no hours. */
const KNOWN_RE = /\b(?:ACTUAL |REAL )?ACTIVITY (?:KNOWN|ANNOUNCED ON)|\bACTIVITE (?:REELLE )?CONNUE/;
/** Words a statement wraps its hours in, which state none. */
const FILLER_RE =
	/POSSIBLE ACTIVATION|ACTIVATION POSSIBLE|\bACTIVABLES?\b|ACCORDING TO PROTOCOLS?|(?:ET )?SELON (?:LES )?(?:MODALITES? )?PROTOCOL(?:AIRES?|E)?S?|IN ACCORDANCE WITH LETTERS? OF AGREEMENT|ACTIVITY ANNOUNCED|ACTIVATED|ACTIVATION|\bACTIVE\b|\bACTIVITY\b|\b(?:BY|PAR|VIA)\s+NOTAM\b|\bNOTAM\b|\bDAILY\b|TOUS LES JOURS|\bFROM\b|\bON\b|\bDE\b|\bDU\b|\bWITHOUT RESTRICTIONS?\b|\bONLY\b|\bUNIQUEMENT\b/g;

/** A day rule: the weekdays a group holds on, absent for every day, and
 *  whether it skips the public holidays. */
interface Days {
	days?: number[] | undefined;
	exceptHolidays?: boolean | undefined;
}

interface Group extends Days {
	windows: string[];
	mode: ActivityMode;
	/** The notice of its activation by NOTAM, in minutes. */
	noticeMin: number | null;
}

const cache = new Map<string, ActivityRule[]>();

/** The rules a French restricted area's published hours state. An RTBA
 *  zone's are by NOTAM whatever its words say, its timetable the hours it
 *  may be activated in ("Les horaires d'activation possibles sont définis
 *  dans l'AIP France", the RTBA leaflet). */
export function zoneHoursRules(workHr: string, rmkWorkHr: string, rtba: boolean): ActivityRule[] {
	const key = `${rtba ? 1 : 0}\u0000${workHr}\u0000${rmkWorkHr}`;
	let rules = cache.get(key);
	if (!rules) {
		rules = readHours(workHr, rmkWorkHr, rtba);
		cache.set(key, rules);
	}
	return rules;
}

function readHours(workHr: string, rmkWorkHr: string, rtba: boolean): ActivityRule[] {
	const code = normalizeClause(workHr);
	let text = englishHalf(rmkWorkHr);
	const known = KNOWN_RE.exec(text);
	if (known) {
		text = text.slice(0, known.index);
	}
	text = text.replace(/[#\n\r]+/g, ' # ').replace(/\s+/g, ' ').trim();
	if (text === '') {
		if (rtba || NOTAM_RE.test(code)) {
			return [{ mode: 'notam' }];
		}
		return permanentHours(workHr) ? [{ mode: 'firm' }] : [{ mode: 'unread' }];
	}
	const summerEarlier = text.search(SUMMER_RE) >= 0;
	text = text.replace(SUMMER_RE, ' ');
	let background: ActivityRule | null = null;
	for (const m of text.matchAll(OTHER_TIMES_RE)) {
		background ??= notamRule(noticeIn(m[0]));
	}
	text = text.replace(OTHER_TIMES_RE, ' ');
	// The mode a clause stating none holds in, before any clause states one.
	const base: ActivityMode =
		rtba ? 'notam' : PROTOCOL_RE.test(text) || !(code === 'H24' || code === 'HJ' || code === 'HN') ? 'activable' : 'firm';
	const { groups, modes, notices } = readGroups(text, base, rtba);
	const out: ActivityRule[] = [];
	if (groups === null) {
		// The smallest notice stated: a notice only shortens the silence.
		const notice = notices.length > 0 ? Math.min(...notices) : null;
		out.push(modes.has('activable') ? { mode: 'activable' } : modes.has('notam') ? notamRule(notice) : { mode: 'unread' });
	} else {
		for (const g of groups) {
			const mode = g.mode;
			const notice = mode === 'notam' && g.noticeMin !== null ? { noticeMin: g.noticeMin } : {};
			const days: Pick<ActivityRule, 'days' | 'exceptHolidays'> = {};
			if (g.days) {
				days.days = g.days;
			}
			if (g.exceptHolidays) {
				days.exceptHolidays = true;
			}
			if (g.windows.length === 0) {
				out.push({ mode, ...days, ...notice });
				continue;
			}
			for (const w of g.windows) {
				out.push({ mode, ...days, ...windowRule(w), ...(summerEarlier && clockWindow(w) ? { summerEarlier } : {}), ...notice });
			}
		}
	}
	if (background) {
		out.push(background);
	}
	return out;
}

/** A rule by NOTAM at all times, with its notice where one is stated. */
function notamRule(noticeMin: number | null): ActivityRule {
	return noticeMin === null ? { mode: 'notam' } : { mode: 'notam', noticeMin };
}

/** The notice a clause states, in minutes, or null. */
function noticeIn(s: string): number | null {
	const m = NOTICE_RE.exec(s);
	if (!m) {
		return null;
	}
	const n = Number(m[1] ?? m[3] ?? m[5]);
	const unit = m[2] ?? m[4] ?? m[6];
	return n * (/^D/.test(unit) ? 1440 : /^MIN/.test(unit) ? 1 : 60);
}

/** The English half of a bilingual text, the whole of any other. */
function englishHalf(s: string): string {
	const k = s.lastIndexOf('\\');
	return normalizeClause(k >= 0 ? s.slice(k + 1) : s);
}

/** The mode a clause's words state: by NOTAM, activable, active, or null
 *  for a clause stating none. */
function clauseMode(piece: string): ActivityMode | null {
	if (NOTAM_RE.test(piece)) {
		return 'notam';
	}
	if (ACTIVABLE_RE.test(piece)) {
		return 'activable';
	}
	return ACTIVE_RE.test(piece) ? 'firm' : null;
}

/** The day groups and windows of a text, each in its mode, or null groups
 *  for a text holding something else: a date, a unit's hours, a zone's
 *  activity, the holidays as days of activity. `modes` is every mode its
 *  clauses state and its groups hold in, `base` where there is none. A
 *  clause's mode holds for the groups after it until another clause states
 *  one; an RTBA zone's are by NOTAM whatever they say. A group with no
 *  window holds all day. A group naming days alone ("MON-FRI except HOL :")
 *  gives them to the windows after it, and holds all day in the mode a
 *  clause gives it where no window follows ("SAT : by NOTAM", LF-D 122 A).
 *  A clause taking days off holds for the group it is printed in, and
 *  printed alone (the RTBA's "Except public HOL :") for every group after
 *  it. */
function readGroups(
	text: string,
	base: ActivityMode,
	rtba: boolean,
): { groups: Group[] | null; modes: Set<ActivityMode>; notices: number[] } {
	const modes = new Set<ActivityMode>();
	const notices: number[] = [];
	let mode = base;
	let notice: number | null = null;
	let partial = false;
	const s = text
		.replace(/\b(?:LS)\b/g, 'SR')
		.replace(/\b(?:CS)\b/g, 'SS')
		.replace(/\b(SR|SS)\s*([+-])\s*(\d{1,3})\s*(HRS?|H)?\b/g, (_, e: string, sign: string, n: string, hr?: string) =>
			`${e}${sign}${hr ? Number(n) * 60 : Number(n)}`,
		)
		.replace(/\b(\d{4}|SR(?:[+-]\d+)?|SS(?:[+-]\d+)?)\s*(?:-|TO|A)\s*(\d{4}|SR(?:[+-]\d+)?|SS(?:[+-]\d+)?)\b/g, '$1-$2');
	const groups: Group[] = [];
	const every: Off = { hol: false, days: new Set() };
	let pending: { days: number[]; off: Off; used: boolean; mode: ActivityMode | null; notice: number | null } | null =
		null;
	// A heading no window used holds all day in the mode a clause gave it.
	const flush = (): void => {
		if (pending && !pending.used && pending.mode) {
			groups.push(group(pending.days, [], pending.mode, pending.notice, [pending.off]));
			modes.add(pending.mode);
		}
	};
	for (const piece of s.split(/\s#\s|\s-\s|[.;]\s|:\s|\s#$|^#\s/)) {
		const said = rtba ? null : clauseMode(piece);
		const stated = noticeIn(piece);
		if (said) {
			mode = said;
			notice = stated;
			modes.add(said);
		} else if (stated !== null) {
			notice = stated;
		}
		if (stated !== null) {
			notices.push(stated);
		}
		const off: Off = { hol: false, days: new Set() };
		let rest = piece
			.replace(new RegExp(NOTICE, 'g'), ' ')
			.replace(FILLER_RE, ' ')
			.replace(new RegExp(EXCEPT_RE.source, 'g'), (_, list: string) => {
				takeOff(list, off);
				return ' ';
			})
			.replace(/[.:#]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			// A list marker the split left ("- TUE : 0830-1100"), a connector
			// a line wrapped ("0830-1100#and 1230-2359", LF-R 45 N2).
			.replace(/^(?:[-–•*,]+|AND\b|ET\b)\s*/, '');
		// Its days, before its windows or after them ("Active H24 MON-FRI").
		let days: number[] | undefined;
		const windows: string[] = [];
		let read = true;
		while (rest !== '' && read) {
			const dm = days ? null : DAYS_RE.exec(rest);
			const wm = dm ? null : WINDOW_RE.exec(rest);
			if (dm) {
				days = dayList(dm[0]);
				read = days !== undefined;
			} else if (wm) {
				windows.push(wm[0]);
			} else {
				read = false;
			}
			rest = rest.slice((dm ?? wm)?.[0].length ?? 0).replace(/^\s*(?:AND|ET|,)?\s*/, '');
		}
		// A clause beyond the grammar leaves the text read in part, and the
		// walk goes on for the modes the rest of it states.
		if (!read) {
			partial = true;
			continue;
		}
		if (!days && windows.length === 0) {
			every.hol ||= off.hol;
			off.days.forEach((d) => every.days.add(d));
			if (said && pending && !pending.used) {
				pending.mode = said;
				pending.notice = notice;
			}
			continue;
		}
		if (days && windows.length === 0) {
			flush();
			pending = { days, off, used: false, mode: said, notice: said ? notice : null };
			continue;
		}
		if (!days && pending) {
			pending.used = true;
		}
		const from = days ? null : pending;
		groups.push(group(days ?? from?.days, windows, mode, notice, [off, ...(from ? [from.off] : [])]));
		modes.add(mode);
	}
	flush();
	if (partial) {
		return { groups: null, modes: modes.size > 0 ? modes : new Set([base]), notices };
	}
	if (groups.length === 0) {
		groups.push(group(pending?.days, [], mode, notice, pending ? [pending.off] : []));
		modes.add(mode);
	}
	for (const g of groups) {
		applyOff(g, every);
	}
	return { groups, modes, notices };
}

/** The days a clause takes off: weekdays, and the public holidays. */
interface Off {
	hol: boolean;
	days: Set<number>;
}

function takeOff(list: string, off: Off): void {
	for (const tok of list.split(/\s*(?:,|AND|ET)\s*/)) {
		const t = tok.trim();
		if (/HOL|JF/.test(t)) {
			off.hol = true;
		} else if (WEEKDAYS[t]) {
			off.days.add(WEEKDAYS[t]);
		}
	}
}

function group(
	days: number[] | undefined,
	windows: string[],
	mode: ActivityMode,
	noticeMin: number | null,
	offs: Off[],
): Group {
	const g: Group = { days, windows, mode, noticeMin };
	for (const o of offs) {
		applyOff(g, o);
	}
	return g;
}

function applyOff(g: Group, o: Off): void {
	if (o.days.size > 0) {
		g.days = (g.days ?? [1, 2, 3, 4, 5, 6, 7]).filter((d) => !o.days.has(d));
	}
	if (o.hol) {
		g.exceptHolidays = true;
	}
	if (g.days?.length === 7) {
		g.days = undefined;
	}
}

/** The weekdays a day list names, a range wrapping through Sunday. */
export function dayList(text: string): number[] | undefined {
	const out = new Set<number>();
	const parts = text.split(/\s*(?:,|AND|ET)\s*/);
	for (const p of parts) {
		const r = /^(\w{3})\s*(?:-|TO|AU)\s*(\w{3})$/.exec(p);
		if (r) {
			const a = WEEKDAYS[r[1]];
			const b = WEEKDAYS[r[2]];
			if (!a || !b) {
				return undefined;
			}
			for (let d = a; ; d = (d % 7) + 1) {
				out.add(d);
				if (d === b) {
					break;
				}
			}
			continue;
		}
		const d = WEEKDAYS[p.trim()];
		if (!d) {
			return undefined;
		}
		out.add(d);
	}
	return [...out].sort((x, y) => x - y);
}

/** A window's ends as a rule's clock and sun ends. */
export function windowRule(w: string): Pick<ActivityRule, 'from' | 'to' | 'sunFrom' | 'sunTo'> {
	if (w === 'H24') {
		return {};
	}
	const [a, b] = splitWindow(w);
	const out: Pick<ActivityRule, 'from' | 'to' | 'sunFrom' | 'sunTo'> = {};
	if (/^\d{4}$/.test(a)) {
		out.from = `${a.slice(0, 2)}:${a.slice(2)}`;
	} else {
		out.sunFrom = a;
	}
	if (/^\d{4}$/.test(b)) {
		out.to = `${b.slice(0, 2)}:${b.slice(2)}`;
	} else {
		out.sunTo = b;
	}
	return out;
}

/** A window's two ends: "SR-30-SS+30" parts after the first end's offset. */
function splitWindow(w: string): [string, string] {
	const m = /^(\d{4}|(?:SR|SS)(?:[+-]\d+)?)-(.+)$/.exec(w);
	return m ? [m[1], m[2]] : [w, w];
}

/** Does a window print a clock time, which a summer note moves? */
function clockWindow(w: string): boolean {
	return /\d{4}/.test(w);
}

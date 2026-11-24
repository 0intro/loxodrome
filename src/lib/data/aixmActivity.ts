/* A UK zone's activity as NATS files it in AIXM 5.1: each activation's
 * status with its own hours, one a line, which internal/aixm5 writes as
 * the row's rmkWorkHr ("Available for activation: Activated by NOTAM.",
 * "Active: Mon-Thu 0800-1700 (0700-1600), Fri 0800-1400 (0700-1300)").
 * Read against the UK AIP of 29 October 2026:
 *
 *   - ENR 5.1 prints a zone's "time of activity", so a timetable under
 *     Active holds firm, and Active with no hours is H24 (EGD141 HYTHE,
 *     EGD203 SENNYBRIDGE: "Hours: H24").
 *   - "Permanently available." is ENR 5.2's, an area available for use at
 *     any time (AARA AREA 02), so it may be active at all times, whatever
 *     the status.
 *   - "Activated by NOTAM", "When notified", "to be published by NOTAM"
 *     make the zone's activity by NOTAM, inside the windows the line gives
 *     ("Hours: SR-SS. Activated by NOTAM.", the kite flying sites), and at
 *     other times where they say so ("and as activated by NOTAM",
 *     EGD006A FALMOUTH BAY).
 *   - A clock window's summer hours stand in brackets (GEN 2.1 2.2): an
 *     hour earlier, the window is kept in local time.
 *   - Available for activation is activable. Inactive, Intermittent and
 *     Other are read as unread.
 *
 * "OTHER" in the hours is the AIXM 4.5 code NATS carries over, which says
 * the text holds them. A line read in part (a public holiday, "Normally
 * during daylight hours", "See Note 1", a season) widens as the French
 * reader does (data/zoneHours.ts): by NOTAM and activable hold at all
 * times, a firm one reads unread. Pure, cached per text; pinned by
 * tests/aixmActivity.spec.ts. */

import type { ActivityMode, ActivityRule } from './activity';
import { dayList, windowRule } from './zoneHours';

const STATUS: Record<string, ActivityMode> = {
	Active: 'firm',
	'Available for activation': 'activable',
	Inactive: 'unread',
	Intermittent: 'unread',
	Other: 'unread',
};

const LINE_RE = /^(Active|Available for activation|Inactive|Intermittent|Other)(?::\s*(.*))?$/;
/** A clause saying the activity is by NOTAM. */
const NOTAM_RE = /\bBY NOTAM\b|\bWHEN NOTIFIED\b|\bAS NOTIFIED\b/;
/** A clause by NOTAM at the times the windows leave. */
const BACKGROUND_RE = /^AND AS\b|\bOTHER TIMES\b|\bOUTSIDE\b/;
const DAY = '(?:MON|TUE|WED|THU|FRI|SAT|SUN)';
/** A clock or sun end: "0800", "08:00", "SR", "SS+30". */
const END = String.raw`(?:\d{2}:?\d{2}|(?:SR|SS)(?:[+-]\d{1,3})?)`;
/** One group: its days (or ANY, or none for every day), its window and
 *  the summer window in brackets. */
/** Where a clause parts: a comma, or an "and" opening a group. */
const PART_RE = new RegExp(String.raw`\s*,\s*|\s+AND\s+(?=ANY\b|\d|SR|SS|${DAY}\b)`);
const GROUP_RE = new RegExp(
	String.raw`^(?:(ANY|${DAY}(?:\s*[-/,]\s*${DAY})*)\s+)?(${END})-(${END})(?:\s*\((\d{2}:?\d{2})-(\d{2}:?\d{2})\))?$`,
);

const cache = new Map<string, ActivityRule[] | null>();

/** The activity rules a row's AIXM status lines state, or null where the
 *  text holds none. */
export function aixmActivityRules(rmkWorkHr: string): ActivityRule[] | null {
	let rules = cache.get(rmkWorkHr);
	if (rules === undefined) {
		rules = readLines(rmkWorkHr);
		cache.set(rmkWorkHr, rules);
	}
	return rules;
}

function readLines(text: string): ActivityRule[] | null {
	const out: ActivityRule[] = [];
	let read = false;
	for (const line of text.split('\n')) {
		const m = LINE_RE.exec(line.trim());
		if (!m) {
			continue;
		}
		read = true;
		out.push(...readLine(STATUS[m[1]], m[2] ?? ''));
	}
	return read ? out : null;
}

/** A clock end in minutes, "0800" or "08:00". */
function minutes(t: string): number {
	const d = t.replace(':', '');
	return Number(d.slice(0, 2)) * 60 + Number(d.slice(2));
}

const hhmm = (t: string): string => t.replace(':', '');

function readLine(status: ActivityMode, hours: string): ActivityRule[] {
	// A status the line cannot vouch for holds at all times, its windows
	// aside: "Other: SS-SR" is no inactive day.
	if (status === 'unread') {
		return [{ mode: 'unread' }];
	}
	let mode = status;
	let notam = false;
	let background = false;
	let partial = false;
	let anytime = false;
	const groups: ActivityRule[] = [];
	// The clauses, each cut at its sentences, its commas and an "and"
	// opening a group: "Mon-Fri 0700-1900 (0600-1800), other times by
	// NOTAM" is a window and a NOTAM statement.
	const parts = hours
		.split(/;|\.\s+/)
		.flatMap((c) => c.toUpperCase().split(PART_RE))
		.map((p) => p.trim().replace(/\.$/, ''))
		.filter((p) => p !== '' && p !== 'OTHER');
	if (hours.trim() !== '' && parts.length === 0) {
		partial = true;
	}
	for (const p of parts) {
		if (NOTAM_RE.test(p)) {
			if (BACKGROUND_RE.test(p)) {
				background = true;
			} else {
				notam = true;
			}
			continue;
		}
		if (p === 'PERMANENTLY AVAILABLE') {
			mode = 'activable';
			anytime = true;
			continue;
		}
		if (p === 'H24') {
			anytime = true;
			continue;
		}
		const group = readGroup(p);
		if (group === null) {
			partial = true;
			continue;
		}
		groups.push(group);
	}
	const windowsMode: ActivityMode = notam ? 'notam' : mode;
	// Hours that state neither a window nor a NOTAM nor all the time are
	// read in part: "and as activated by NOTAM" alone is no firm H24.
	if (hours.trim() !== '' && groups.length === 0 && !anytime && !notam) {
		partial = true;
	}
	if (partial) {
		// Read in part: what may be active may be so at all times, and a firm
		// zone's hours are unread.
		const wide = windowsMode === 'firm' ? 'unread' : windowsMode;
		return background && wide !== 'notam' ? [{ mode: wide }, { mode: 'notam' }] : [{ mode: wide }];
	}
	const out: ActivityRule[] =
		groups.length === 0 || anytime ? [{ mode: windowsMode }] : groups.map((g) => ({ ...g, mode: windowsMode }));
	if (background) {
		out.push({ mode: 'notam' });
	}
	return out;
}

/** One group, "Mon-Thu 0800-1700 (0700-1600)", or null outside the
 *  grammar. */
function readGroup(part: string): ActivityRule | null {
	const m = GROUP_RE.exec(part);
	if (!m) {
		return null;
	}
	const [, daysText, from, to, sFrom, sTo] = m;
	const rule: ActivityRule = { mode: 'firm', ...windowRule(`${hhmm(from)}-${hhmm(to)}`) };
	if (daysText && daysText !== 'ANY') {
		const days = dayList(daysText.replace(/\//g, ','));
		if (!days) {
			return null;
		}
		if (days.length < 7) {
			rule.days = days;
		}
	}
	if (sFrom !== undefined) {
		// The bracket must be the window an hour earlier, a window kept in
		// local time, which summerEarlier reads.
		const clock = /^\d/.test(from) && /^\d/.test(to);
		if (!clock || minutes(from) - minutes(sFrom) !== 60 || minutes(to) - minutes(sTo) !== 60) {
			return null;
		}
		rule.summerEarlier = true;
	}
	return rule;
}

/* The ONE wording of the briefing verdict (notam/briefingVerdict.ts): the
 * line and the reasons every NOTAM surface states, on screen and on paper,
 * as chartsText.ts is the charts'. Reads the reactive catalog, so call it
 * from a template or a $derived. */

import type { BriefingReason, BriefingVerdict } from '$lib/notam/briefingVerdict';
import { formatZulu, formatZuluNear, formatZuluSpan } from '$lib/format/datetime';
import { notamSourceName } from '$lib/format/aerodromeFetch';
import type { BriefingNotice } from '$lib/state/briefing.svelte';
import { frSupaipList } from '$lib/state/data.svelte';
import { t } from '$lib/state/i18n.svelte';
import { notamState } from '$lib/state/notam.svelte';
import type { NotamSource } from '$lib/state/notamSource.svelte';
import { formatAge } from '$lib/weather/metar';

/** The supplements the SUP AIP reason names before counting the rest: on
 *  paper one, box C keeping the Overview one sheet. */
const SUPS_NAMED = 3;
const SUPS_NAMED_PAPER = 1;

/** The UTC day of an instant, '2026-11-19'. */
function utcDay(ms: number): string {
	return formatZulu(new Date(ms)).slice(0, 10);
}

/** "12 min ago", "2 h 05 ago". */
export function briefingAge(atMs: number, nowMs: number): string {
	return formatAge(Math.max(0, Math.round((nowMs - atMs) / 60_000)), t.weather.metar);
}

/** One reason as a sentence. `source` words the age of a bulletin loaded
 *  by hand apart from a fetch's. On `paper`, every time is absolute and the
 *  age is the fetch's own instant, a sheet outliving the minute it printed. */
export function briefingReasonText(
	r: BriefingReason,
	nowMs: number,
	source: BriefingVerdict['source'] = 'fetch',
	paper = false,
): string {
	switch (r.code) {
		case 'none':
			return t.briefing.none;
		case 'failed':
			return `${t.notam.routesNotCovered({ missing: r.labels.length, total: r.total, list: true })} ${r.labels.join(', ')}`;
		case 'route': {
			const p = { time: paper ? formatZulu(new Date(r.at)) : formatZuluNear(r.at, nowMs), list: r.labels.join(', ') };
			if (r.cause === 'width') {
				return t.briefing.routeWidth(p);
			}
			return r.cause === 'area' ? t.briefing.routeArea(p) : t.briefing.route(p);
		}
		case 'period':
			return t.briefing.period({
				briefed: formatZuluSpan(r.briefed.from, r.briefed.to),
				flight: formatZuluSpan(r.span.from, r.span.to),
			});
		case 'rtba':
			return t.briefing.rtba({
				day: formatZulu(new Date(r.dayMs)).slice(0, 10),
				release: formatZulu(new Date(r.releaseMs)),
			});
		case 'aerodromes':
			return t.briefing.aerodromes(r.idents.join(', '));
		case 'age':
			if (paper) {
				return (source === 'hand' ? t.briefing.agePaperByHand : t.briefing.agePaper)(formatZulu(new Date(r.at)));
			}
			return (source === 'hand' ? t.briefing.ageByHand : t.briefing.age)(briefingAge(r.at, nowMs));
		case 'supaip': {
			const cap = paper ? SUPS_NAMED_PAPER : SUPS_NAMED;
			const named = r.sups.slice(0, cap).map((s) => t.briefing.supaipCited(s)).join(', ');
			const more = r.sups.length - cap;
			return t.briefing.supaipMissing({
				n: r.sups.length,
				list: more > 0 ? `${named} ${t.briefing.supaipMore(more)}` : named,
				day: r.listAt === null ? null : utcDay(r.listAt),
			});
		}
		default:
			return '';
	}
}

/** The SUP AIP list in use, by the day it was built, which the NOTAMs head
 *  and box C state beside the briefing. Null until the list and its
 *  sidecar have loaded. */
export function briefingSupaipList(): string | null {
	const at = frSupaipList()?.at ?? null;
	return at === null ? null : t.briefing.supaipList(utcDay(at));
}

/** The reasons as one line of sentences: the print review's. */
export function briefingReasonsLine(
	reasons: readonly BriefingReason[],
	source: BriefingVerdict['source'],
	nowMs: number,
): string {
	return reasons.map((r) => `${briefingReasonText(r, nowMs, source)}.`).join(' ');
}

/** The print menu's word on the briefing, before the click: the stamp while
 *  no reason stands, else the first reason, and that the print fetches the
 *  briefing first when it will (`fetches`). */
export function briefingPrintText(
	v: BriefingVerdict,
	source: NotamSource | null,
	fetches: boolean,
	nowMs: number,
): string {
	const r = v.reasons[0];
	if (!r) {
		return briefingStamp(v, source, nowMs);
	}
	const reason = `${briefingReasonText(r, nowMs, v.source)}.`;
	return fetches ? `${reason} ${t.briefing.printFetches}` : reason;
}

/** Where the briefing came from, as the line states it: the source, the
 *  fetch time and its age, the time a bulletin was loaded by hand, or that
 *  there is none. */
export function briefingStamp(v: BriefingVerdict, source: NotamSource | null, nowMs: number): string {
	if (v.source === 'fetch' && v.at !== null && source) {
		return t.briefing.fetched({
			source: notamSourceName(source),
			time: formatZuluNear(v.at, nowMs),
			age: briefingAge(v.at, nowMs),
		});
	}
	if (v.source === 'hand' && v.at !== null) {
		// With no flight planned there is nothing to check it against.
		return (v.plan ? t.briefing.byHand : t.briefing.byHandBare)(formatZuluNear(v.at, nowMs));
	}
	return t.briefing.none;
}

/** What the NOTAMs tab's dot means, for its accessible name: the reason
 *  the briefing is short, else the NOTAMs new since the list last showed
 *  it. Null without a dot. */
export function briefingDotText(n: BriefingNotice, nowMs: number): string | null {
	if (!n.dot) {
		return null;
	}
	if (n.short && n.reason) {
		return briefingReasonText(n.reason, nowMs, n.verdict.source);
	}
	const seen = notamState.seen;
	return seen ? t.briefing.newSince({ n: n.fresh, time: formatZuluNear(seen.at, nowMs) }) : null;
}

/** The stamp as paper prints it, absolute: the source, the fetch's time and
 *  the period it covers, a bulletin by hand's time, or that there is none. */
export function briefingPaperStamp(v: BriefingVerdict): string {
	const f = notamState.lastFetch;
	if (v.source === 'fetch' && f) {
		const time = formatZulu(new Date(f.at));
		const source = notamSourceName(f.source);
		return f.briefed
			? t.briefing.fetchedPaper({ source, time, span: formatZuluSpan(f.briefed.from, f.briefed.to) })
			: t.briefing.fetchedPaperBare({ source, time });
	}
	if (v.source === 'hand' && v.at !== null) {
		return (v.plan ? t.briefing.byHand : t.briefing.byHandBare)(formatZulu(new Date(v.at)));
	}
	return t.briefing.none;
}

/** The reasons as paper prints them, "none" being the stamp itself. */
export function briefingPaperReasons(v: BriefingVerdict): string[] {
	return v.reasons.filter((r) => r.code !== 'none').map((r) => briefingReasonText(r, 0, v.source, true));
}

/** The reasons the line lists under its stamp: none says itself, and a
 *  fetch's stamp states its age. A bulletin by hand states its time alone,
 *  so its age is listed. */
export function briefingLineReasons(v: BriefingVerdict): BriefingReason[] {
	return v.reasons.filter((r) => r.code !== 'none' && (r.code !== 'age' || v.source !== 'fetch'));
}

/** A line closed as a sentence. */
function sentence(s: string): string {
	return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** The reasons as running text on paper, each closed as a sentence: the
 *  printed bulletin's head. */
export function briefingPaperReasonsText(v: BriefingVerdict): string {
	return briefingPaperReasons(v).map(sentence).join(' ');
}

/** Box C's paragraph, part by part: the stamp, then the first reason, the
 *  rest counted, in the no-live-data ink while any stands. One paragraph
 *  keeps the Overview one sheet: the stamp holds one line, and the reason
 *  starts on its last. The stamp prints the briefing's time, so an age is
 *  its ink alone. For a flight already flown, `past` (its sentence) stands
 *  in the reasons' place: they judge from the present on, and the stamp
 *  states the briefing loaded alone. */
export function briefingPaperParts(v: BriefingVerdict, past: string | null = null): { text: string; short: boolean }[] {
	if (past !== null) {
		return [
			{ text: sentence(briefingPaperStamp({ ...v, plan: false })), short: false },
			{ text: sentence(past), short: true },
		];
	}
	const reasons = v.reasons.filter((r) => r.code !== 'none' && r.code !== 'age');
	const parts = [{ text: sentence(briefingPaperStamp(v)), short: v.plan && v.reasons.length > 0 }];
	if (reasons.length > 0) {
		parts.push({ text: sentence(briefingReasonText(reasons[0], 0, v.source, true)), short: true });
	}
	if (reasons.length > 1) {
		parts.push({ text: t.briefing.paperMore(reasons.length - 1), short: true });
	}
	return parts;
}

/** The first reason a sheet reading NOTAMs states. The SUP AIP list's
 *  reaches the map, the alerts and box C: the runways, fuel, frequencies
 *  and profile bands rest on the briefing alone. */
function sheetReason(v: BriefingVerdict): BriefingReason | undefined {
	return v.reasons.find((r) => r.code !== 'supaip');
}

/** A sheet's warning slot while the briefing is short (the nav log's title
 *  line, the profile's head): a short tag, the first reason in full on its
 *  title. Null while the verdict holds no reason. */
export function briefingShortTag(v: BriefingVerdict, nowMs: number): { text: string; title: string } | null {
	const r = sheetReason(v);
	if (!r) {
		return null;
	}
	return {
		text: r.code === 'none' ? t.briefing.shortTagNone : t.briefing.shortTag,
		title: briefingReasonText(r, nowMs, v.source),
	};
}

/** The line a sheet that reads NOTAMs states while the briefing is short:
 *  the first reason, then what the sheet's figures rest on instead. Null
 *  while the verdict holds no reason. */
export function briefingSheetNote(
	v: BriefingVerdict,
	sheet: keyof (typeof t.briefing)['readsAip'],
	nowMs: number,
	paper = false,
): string | null {
	const r = sheetReason(v);
	if (!r) {
		return null;
	}
	const reads = r.code === 'none' ? t.briefing.readsAip[sheet] : t.briefing.readsBriefing[sheet];
	return `${briefingReasonText(r, nowMs, v.source, paper)}. ${reads}`;
}

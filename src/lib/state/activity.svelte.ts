/* The periods a NOTAM puts on the zones it names, read from the RAW
 * briefing: a list filter, the viewing period or the wall clock under a
 * replay must not take an activation away from a verdict (airspace-alerts,
 * "The wiring"). The alerts read them over the traversal, and every
 * surface stating a zone's state reads the same join, a panel through
 * zoneActivity. */

import {
	nextChange,
	resolveActivity,
	type ActivePeriod,
	type ActivityAnswer,
	type ActivityInput,
	type ConfirmedPeriod,
} from '$lib/data/activity';
import type { Airspace } from '$lib/data/airspaces';
import type { KnownUnit } from '$lib/data/knownFrom';
import type { SupAip } from '$lib/data/supaip';
import type { ZoneState } from '$lib/components/zoneStateText';
import { airspaceVolumes, notamVolumes, supaipVolumes, volumeLinksActivations, zsmVolumes, type AlertVolume } from '$lib/nav/alertVolumes';
import { notamAnchor } from '$lib/notam/geometry';
import { isActivationQCode, isAmendmentQCode } from '$lib/notam/qcode';
import { isRtbaActivationNotam, rtbaZoneActivations } from '$lib/notam/rtba';
import { notamItemD } from '$lib/notam/schedule';
import type { Notam } from '$lib/notam/types';
import { sunLookupFor } from '$lib/route/sun';
import { airspaceByKey, dataState, getAirspaces, getSupaips } from './data.svelte';
import { briefedAtNow, briefingLoaded, joinNotams, notamState } from './notam.svelte';
import { zsmById } from './zsm.svelte';
import { activatedAirspaceIds, notamMentionsAirspace } from './notamLinks.svelte';
import { supZoneActivationsRaw } from './supaipLinks.svelte';
import { nav } from './navRecording.svelte';
import type { Route } from './route.svelte';
import { routeClock } from './routeWind.svelte';
import { plannedFlightAt, plannedFlightTimed } from './timeWindow.svelte';
import { planScope } from './planScope.svelte';
import type { ZoneNote } from './zoneNotes.svelte';

let windowCache: {
	notams: Notam[];
	supLinks: unknown;
	airspaces: Airspace[] | null;
	map: Map<string, ConfirmedPeriod[]>;
} | null = null;

/** The activation periods by zone, an airspace's id or a supplement zone's
 *  key, memoised on the briefing, the SUP AIP links and the airspace
 *  dataset: activatedAirspaceIds confirms the SIA's detached sub-lettering
 *  ("LF-R368 A B C1 C2") against the loaded rows, so periods built before
 *  the rows land lack those zones. A NOTAM's period holds in its D) item's
 *  windows (data/activity.ts reads them over the range asked about), the
 *  sun at the NOTAM's own position. */
export function activationPeriods(
	notams: Notam[],
	supLinks: ReadonlyMap<string, { notam: Notam }[]>,
	airspaces: Airspace[] | null,
): Map<string, ConfirmedPeriod[]> {
	if (
		windowCache &&
		windowCache.notams === notams &&
		windowCache.supLinks === supLinks &&
		windowCache.airspaces === airspaces
	) {
		return windowCache.map;
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt whole on input change, consumers key on the reference
	const map = new Map<string, ConfirmedPeriod[]>();
	const add = (id: string, w: ConfirmedPeriod): void => {
		const list = map.get(id);
		if (list) {
			list.push(w);
		} else {
			map.set(id, [w]);
		}
	};
	const validity = (n: Notam): ConfirmedPeriod | null => {
		const a = notamAnchor(n);
		const slots = {
			by: 'notam' as const,
			schedule: notamItemD(n),
			sun: a ? sunLookupFor(a.lat, a.lon) : undefined,
			...(n.fgLower || n.fgUpper ? { levels: { lower: n.fgLower, upper: n.fgUpper } } : {}),
		};
		if (n.permanent) {
			return { startMs: 0, endMs: Infinity, ...slots };
		}
		// Missing bounds resolve inactive, the activatedAirspaceLinks rule.
		if (!n.startDate || !n.endDate) {
			return null;
		}
		return { startMs: n.startDate.getTime(), endMs: n.endDate.getTime(), ...slots };
	};
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- build-local dedup, discarded with the pass
	const seen = new Set<string>();
	for (const n of notams) {
		if (!isActivationQCode(n.qCode) || seen.has(n.id)) {
			continue;
		}
		seen.add(n.id);
		if (isRtbaActivationNotam(n)) {
			for (const z of rtbaZoneActivations(n)) {
				add(z.airspaceId, { startMs: z.start.getTime(), endMs: z.end.getTime(), by: 'rtba' });
			}
			continue;
		}
		const w = validity(n);
		if (!w) {
			continue;
		}
		for (const id of activatedAirspaceIds(n)) {
			add(id, w);
		}
	}
	for (const [zoneKey, entries] of supLinks) {
		for (const { notam } of entries) {
			const w = validity(notam);
			if (w) {
				add(zoneKey, w);
			}
		}
	}
	windowCache = { notams, supLinks, airspaces, map };
	return map;
}

let amendedCache: { notams: Notam[]; airspaces: Airspace[] | null; map: Map<string, ActivePeriod[]> } | null = null;

/** The periods each zone a NOTAM changes is in doubt over, by airspace id:
 *  a restricted area "changed" (isAmendmentQCode) citing it by designator
 *  (notamMentionsAirspace), over the NOTAM's validity, from the RAW
 *  briefing. Memoised on the briefing and the airspace dataset. */
export function amendedPeriods(notams: Notam[], airspaces: Airspace[] | null): Map<string, ActivePeriod[]> {
	if (amendedCache && amendedCache.notams === notams && amendedCache.airspaces === airspaces) {
		return amendedCache.map;
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt whole on input change, consumers key on the reference
	const map = new Map<string, ActivePeriod[]>();
	for (const n of notams) {
		if (!isAmendmentQCode(n.qCode)) {
			continue;
		}
		const w = n.permanent
			? { startMs: 0, endMs: Infinity }
			: n.startDate
				? { startMs: n.startDate.getTime(), endMs: n.endDate?.getTime() ?? Infinity }
				: null;
		if (!w) {
			continue;
		}
		for (const a of airspaces ?? []) {
			if (notamMentionsAirspace(n, a)) {
				const list = map.get(a.id);
				if (list) {
					list.push(w);
				} else {
					map.set(a.id, [w]);
				}
			}
		}
	}
	amendedCache = { notams, airspaces, map };
	return map;
}

/** How far past the viewed time a panel looks for the next change: a week,
 *  which a weekly timetable comes round in. */
const NEXT_HORIZON_MS = 7 * 86_400_000;
/** The vertices of a zone the briefing is asked at, beside its centre. */
const MAX_POINTS = 16;

/** When the briefing was made: its fetch's time, or a bulletin's loading. */
export function briefingMadeMs(): number | undefined {
	return notamState.lastFetch?.at ?? notamState.byHand?.at;
}

/** The points of a zone the briefing is asked at: its box's centre and up
 *  to MAX_POINTS of its vertices and circle centres. */
function zonePoints(v: AlertVolume): [number, number][] {
	const b = v.bbox;
	const pts: [number, number][] = [[(b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2]];
	const all: [number, number][] = [...v.rings.flat(), ...v.circles.map((c): [number, number] => [c.lat, c.lon])];
	const step = Math.max(1, Math.ceil(all.length / MAX_POINTS));
	for (let i = 0; i < all.length; i += step) {
		pts.push(all[i]);
	}
	return pts;
}

/** Does the briefing cover the zone at `ms`: one of its points inside the
 *  briefed region and window, as an activation NOTAM's Q) circle covers its
 *  whole zone. `rtba` asks the day's release too. */
function briefedAtZone(pts: [number, number][], ms: number): { notam: boolean; rtba: boolean } {
	let notam = false;
	let rtba = false;
	for (const [lat, lon] of pts) {
		const b = briefedAtNow({ lat, lon, ms });
		notam ||= b.notam;
		rtba ||= b.rtba;
	}
	return { notam, rtba };
}

/** The pilot's note in force on a zone, through the flight app's scope:
 *  none in the NOTAM Viewer. */
export function noteOn(id: string): ZoneNote | null {
	return planScope.zoneNotes?.note(id) ?? null;
}

/** A zone's activity input over `at`, as the panels and the map read it,
 *  from the alerts' reading: its volume's rules, the raw activation join,
 *  the amendments, the pilot's note, and the briefing asked at the zone at
 *  both ends of the range, for a zone activated by NOTAM under a publisher
 *  whose activation NOTAMs the app links (no other answer reads it). */
export function zoneInput(v: AlertVolume, at: { fromMs: number; toMs: number }): ActivityInput {
	const airspaces = dataState.airspacesLoaded ? getAirspaces() : null;
	const notams = joinNotams();
	let briefed = false;
	if (briefingLoaded() && volumeLinksActivations(v) && v.activity.rules.some((r) => r.mode === 'notam')) {
		const pts = zonePoints(v);
		const from = briefedAtZone(pts, at.fromMs);
		const to = briefedAtZone(pts, at.toMs);
		briefed = v.rtba ? from.rtba && to.rtba : from.notam && to.notam;
	}
	return {
		...v.activity,
		rtba: v.rtba,
		confirmed: activationPeriods(notams, supZoneActivationsRaw(), airspaces).get(v.id),
		amended: amendedPeriods(notams, airspaces)
			.get(v.id)
			?.some((w) => w.startMs <= at.toMs && w.endMs >= at.fromMs),
		briefed,
		briefedAtMs: briefingMadeMs(),
		note: noteOn(v.id) ?? undefined,
	};
}

/** A zone's state over `at` as a panel says it (zoneInput), and its next
 *  change within a week. */
export function zoneActivity(v: AlertVolume, at: { fromMs: number; toMs: number }): ZoneState {
	const input = zoneInput(v, at);
	const notices = v.activity.rules.flatMap((r) => (r.mode === 'notam' && r.noticeMin !== undefined ? [r.noticeMin] : []));
	return {
		answer: resolveActivity(input, at.fromMs, at.toMs),
		next: nextChange(input, at.toMs, at.toMs + NEXT_HORIZON_MS),
		noticeMin: notices.length > 0 ? Math.min(...notices) : null,
		briefedAtMs: input.briefedAtMs,
		note: noteOn(v.id),
	};
}

/** The zone a restricted or transit airspace row is, or null for any other
 *  row: a controlled sector's activity is its existence. */
export function airspaceZone(a: Airspace): AlertVolume | null {
	if (a.category !== 'restricted' && a.category !== 'transit') {
		return null;
	}
	return airspaceVolumes([a])[0] ?? null;
}

/** A supplement's zone `i`, or null for one drawn nowhere. */
export function supZone(sup: SupAip, i: number): AlertVolume | null {
	return supaipVolumes([sup]).find((v) => v.id === `${sup.id}#${i}`) ?? null;
}

/** The area a NOTAM creates, every entry of its id, the loaded briefing's
 *  or the zone answer's, or null for a NOTAM that creates none. */
export function notamArea(n: Notam): AlertVolume | null {
	return notamVolumes(joinNotams().filter((x) => x.id === n.id))[0] ?? null;
}

/** The volume a profile band's key names: an airspace row's, a NOTAM's area
 *  (`notam:<id>`), a supplement's zone (`sup:<supId>#<zone>`), a raptor
 *  zone (`zsm:<id>`). */
function bandVolume(key: string): AlertVolume | null {
	if (key.startsWith('zsm:')) {
		const z = zsmById(key);
		return z ? (zsmVolumes([z])[0] ?? null) : null;
	}
	if (key.startsWith('notam:')) {
		const id = key.slice('notam:'.length);
		return notamVolumes(joinNotams().filter((n) => n.id === id))[0] ?? null;
	}
	if (key.startsWith('sup:')) {
		const ref = key.slice('sup:'.length);
		const hash = ref.lastIndexOf('#');
		const sup = (getSupaips() ?? []).find((s) => s.id === ref.slice(0, hash));
		return sup ? supZone(sup, Number(ref.slice(hash + 1))) : null;
	}
	const row = airspaceByKey(key);
	return row ? (airspaceVolumes([row])[0] ?? null) : null;
}

/** How long before a crossing's planned entry, and after its planned exit,
 *  a zone's state is judged, in minutes: a flight keeps to its plan within
 *  a margin. */
export const CROSSING_LEAD_MIN = 15;
export const CROSSING_TAIL_MIN = 60;

/** The range each crossing is judged over, by band key: from 15 minutes
 *  before the route enters the band to an hour after it leaves, by the
 *  route's clock (state/routeWind.svelte.ts routeClock). */
export function crossingRanges(
	bands: readonly { key: string; spans: readonly { enterNM: number; leaveNM: number }[] }[],
	clock: (nm: number) => number,
): Map<string, { fromMs: number; toMs: number }> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a derived's input, rebuilt whole
	const out = new Map<string, { fromMs: number; toMs: number }>();
	for (const b of bands) {
		if (b.spans.length === 0) {
			continue;
		}
		const enter = Math.min(...b.spans.map((s) => s.enterNM));
		const leave = Math.max(...b.spans.map((s) => s.leaveNM));
		out.set(b.key, {
			fromMs: clock(enter) - CROSSING_LEAD_MIN * 60_000,
			toMs: clock(leave) + CROSSING_TAIL_MIN * 60_000,
		});
	}
	return out;
}

/** Each profile band's state, by band key, for the crossings strip: an
 *  airspace band's zone, a NOTAM band's area and a supplement band's zone
 *  read as the alerts read them, over the band's own range in `ranges`
 *  where it has one (crossingRanges), else over `at`. `unknown` is the
 *  briefing's answer for the flight, what it leaves unknown of the zones
 *  activated by NOTAM, an RTBA zone's apart
 *  (state/briefing.svelte.ts briefingActivityUnknown); null reads them
 *  briefed. A band whose volume is none (a FIR, a FIS sector) is left out. */
export function bandStates(
	bands: readonly { key: string }[],
	at: { fromMs: number; toMs: number },
	unknown: { notam: boolean; rtba: boolean } | null,
	ranges?: ReadonlyMap<string, { fromMs: number; toMs: number }> | null,
): Map<string, ActivityAnswer> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a derived's output, rebuilt whole
	const out = new Map<string, ActivityAnswer>();
	for (const b of bandInputs(bands, at, unknown, ranges)) {
		out.set(b.key, resolveActivity(b.input, b.range.fromMs, b.range.toMs));
	}
	return out;
}

/** What the strip says of a crossing beside its state. */
export interface BandNote {
	/** Who knows the zone's real activity (AlertVolume.knownFrom). */
	known: readonly KnownUnit[];
	/** Its first change after the band's range that raises its state. */
	next: { atMs: number; answer: ActivityAnswer } | null;
	/** The pilot's note in force on the zone. */
	note: ZoneNote | null;
}

/** What the strip says of each crossing beside its state, by band key: who
 *  knows the zone's real activity, its first change after the band's range
 *  and before `untilMs` that raises its state (nextChange), the margin a
 *  late flight has, and the pilot's note. The arguments are bandStates's. */
export function bandNotes(
	bands: readonly { key: string }[],
	at: { fromMs: number; toMs: number },
	unknown: { notam: boolean; rtba: boolean } | null,
	ranges: ReadonlyMap<string, { fromMs: number; toMs: number }> | null,
	untilMs: number,
): Map<string, BandNote> {
	const rank = { inactive: 0, activable: 1, active: 2 };
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a derived's output, rebuilt whole
	const out = new Map<string, BandNote>();
	for (const b of bandInputs(bands, at, unknown, ranges)) {
		const now = resolveActivity(b.input, b.range.fromMs, b.range.toMs).state;
		const next = untilMs > b.range.toMs ? nextChange(b.input, b.range.toMs, untilMs) : null;
		out.set(b.key, {
			known: b.v.knownFrom,
			next: next && rank[next.answer.state] > rank[now] ? next : null,
			note: noteOn(b.v.id),
		});
	}
	return out;
}

/** Who knows the real activity of the zone a band key names
 *  (AlertVolume.knownFrom): none for a key naming no zone. */
export function bandKnownFrom(key: string): readonly KnownUnit[] {
	return bandVolume(key)?.knownFrom ?? [];
}

/** The pilot's note in force on the zone a band key names, null where
 *  there is none. */
export function bandNote(key: string): ZoneNote | null {
	const v = bandVolume(key);
	return v ? noteOn(v.id) : null;
}

/** Each band's volume and its activity input over its own range in
 *  `ranges`, else over `at`, as the alerts build them. A band whose volume
 *  is none (a FIR, a FIS sector) is left out. */
function bandInputs(
	bands: readonly { key: string }[],
	at: { fromMs: number; toMs: number },
	unknown: { notam: boolean; rtba: boolean } | null,
	ranges: ReadonlyMap<string, { fromMs: number; toMs: number }> | null | undefined,
): { key: string; v: AlertVolume; input: ActivityInput; range: { fromMs: number; toMs: number } }[] {
	const airspaces = dataState.airspacesLoaded ? getAirspaces() : null;
	const notams = joinNotams();
	const confirmed = activationPeriods(notams, supZoneActivationsRaw(), airspaces);
	const amended = amendedPeriods(notams, airspaces);
	const briefedAtMs = briefingMadeMs();
	const out: { key: string; v: AlertVolume; input: ActivityInput; range: { fromMs: number; toMs: number } }[] = [];
	for (const b of bands) {
		const v = bandVolume(b.key);
		if (!v) {
			continue;
		}
		const linked = volumeLinksActivations(v);
		const range = ranges?.get(b.key) ?? at;
		const input: ActivityInput = {
			...v.activity,
			rtba: v.rtba,
			confirmed: confirmed.get(v.id),
			amended: amended.get(v.id)?.some((w) => w.startMs <= range.toMs && w.endMs >= range.fromMs),
			briefed: linked && (unknown === null || !(v.rtba ? unknown.rtba : unknown.notam)),
			briefedAtMs,
			note: noteOn(v.id) ?? undefined,
		};
		out.push({ key: b.key, v, input, range });
	}
	return out;
}

/** How the strip judges the planned flight's crossings, following the
 *  verdict window (timeWindow.svelte.ts briefingWindow): 'timed', each at
 *  its planned time, while the plan states its times and its window is
 *  still to come or under way. 'day', over the flight's day, for a plan
 *  dated alone. 'now', from the current minute for the flight's length,
 *  during a recording and once the planned window has passed. */
export type CrossingJudgement = 'timed' | 'day' | 'now';

export function crossingJudgement(): CrossingJudgement {
	void notamState.tick;
	if (nav.recording || plannedFlightAt().toMs <= Date.now()) {
		return 'now';
	}
	return plannedFlightTimed() ? 'timed' : 'day';
}

/** The clock the strip judges a route's crossings by (routeClock) while
 *  crossingJudgement is 'timed', else null: the crossings are then judged
 *  over the whole verdict window. */
export function crossingClock(route: Route): ((nm: number) => number) | null {
	return crossingJudgement() === 'timed' ? routeClock(route) : null;
}

/* The NOTAM briefing judged against the planned flight: one verdict every
 * surface that reads NOTAMs states, and the same test asked of a position and
 * an instant (briefedAt), which the alerts read.
 *
 * Pure: the briefing's record, the plan's tracks and corridor, the flight's
 * window, the RTBA crossing and the clock come in as arguments, so the rules
 * are plain function tests. state/briefing.svelte.ts feeds it.
 *
 * What a briefing can be short of, each a reason:
 *  - none: nothing loaded.
 *  - failed: a route the fetch asked for and lost.
 *  - route: a plan corridor reaching outside what the fetch's answer covers:
 *    a route edited, or a plan replaced, since.
 *  - period: the flight's window running outside what the fetch briefed.
 *  - rtba: a plan crossing the RTBA network on a day whose actual activity
 *    the briefing predates, the window's first such day. The SIA publishes
 *    it "chaque jour à partir de
 *    17h" (RTBA leaflet 2025, p. 10), read here as 17:00 UTC, the later of
 *    the two readings, plus half an hour for the bulletin to reach the
 *    source. An RTBA activation NOTAM starting that day proves it earlier.
 *  - aerodromes: an aerodrome asked by name that did not answer.
 *  - age: older than three hours on the ground.
 *  - supaip: a trigger NOTAM of the briefing citing a metropolitan AIP SUP
 *    the SUP AIP list in use lacks, a list older than the supplement (the
 *    APK carries the one it was built with). Only a newer list cures it.
 * A bulletin pasted or opened by hand states no fetch: only its age, the
 * RTBA proof and the SUP AIP list can be judged of it. */

import { extractAipSupsFor, notamSupPublisher } from './aipSup';
import { pointToPolylineDistanceM } from './geometry';
import type { Bbox } from './geometry';
import { isTriggerNotam } from './relations';
import type { LatLon, Notam } from './types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const NM_M = 1852;

/** How much later than a window a briefing may open before that reads as a
 *  gap. A request carries a forward margin, no source briefing a departure
 *  already behind the clock, and the Flight period opens the ramp hour before
 *  the departure, the hour a briefing is read in. An hour covers both and
 *  leaves the gap for a window reaching into the past: a flight dated without
 *  an hour, a period typed over a flight already flown. */
export const HEAD_TOLERANCE_MS = HOUR_MS;
/** The fetch's own forward margin alone: SOFIA's bulletin opens a minute or
 *  two after its request (sofia/client.ts sofiaDepartureMs). A window
 *  already open, a recording's or a flight's whose ramp hour has begun,
 *  and an instant have no ramp hour left to spare. */
export const HEAD_MARGIN_MS = 3 * MINUTE_MS;
/** How much earlier than the flight's window a briefing may end: SOFIA briefs
 *  23 h 59 and a day ends at 23:59:59.999, so a dated flight on an untouched
 *  plan stays covered. */
export const TAIL_TOLERANCE_MS = MINUTE_MS;
/** The plan's corridor may pass the answer's by this much. autorouter answers
 *  the plan's own width, so the same route would otherwise rest on rounding. */
export const ROUTE_TOLERANCE_NM = 0.1;
/** The step a plan track is sampled at for the coverage test. */
export const SAMPLE_STEP_NM = 0.1;
/** A briefing older than this on the ground reads short: urgent NOTAMs (a
 *  runway shut, a temporary zone for a fire) come out within hours. */
export const AGE_LIMIT_MS = 3 * HOUR_MS;
/** The RTBA release, minutes after 00:00 UTC on the day before the day it
 *  publishes. */
export const RTBA_RELEASE_MIN = 17 * 60 + 30;

/** What a fetch asked for (state/notam.svelte.ts BriefingAsk, restated so the
 *  module stays pure). */
export interface AskedRegion {
	region:
		| { kind: 'box'; bbox: Bbox }
		| {
				kind: 'tracks';
				tracks: { label: string; path: LatLon[]; landed: boolean; ends: readonly string[] | null }[];
				halfWidthNM: number;
		  };
	aim: 'flight' | 'period';
}

export interface PlanTrack {
	label: string;
	path: LatLon[];
}

export interface VerdictInput {
	nowMs: number;
	/** Any NOTAM loaded, a fetch committed or an aerodrome fetched. */
	loaded: boolean;
	/** The fetch the loaded briefing came from, null for a paste or a file. */
	fetch: {
		at: number;
		briefed: { from: number; to: number } | null;
		asked: AskedRegion | null;
	} | null;
	/** When a bulletin pasted or opened by hand was loaded. */
	byHand: { at: number } | null;
	/** The routes a fetch lost, by label, when it recorded no tracks. */
	gaps: { total: number; labels: string[] } | null;
	/** The UTC days ('2026-11-25') an RTBA activation NOTAM of the briefing
	 *  starts on. */
	rtbaDays: ReadonlySet<string>;
	/** The plan's tracks and its NOTAM corridor's half-width, null with no
	 *  route of two waypoints. */
	plan: { tracks: PlanTrack[]; halfWidthNM: number } | null;
	/** The flight's window (timeWindow.svelte.ts briefingWindow). */
	span: { from: number; to: number } | null;
	/** Outside a recorded flight's air time. */
	onGround: boolean;
	/** Does a plan corridor cross an RTBA zone? */
	crossesRtba: boolean;
	/** Aerodromes the automatic run asked for by name and did not get. */
	aerodromesMissed?: readonly string[] | undefined;
	/** The French SUP AIP list's build time (null while its sidecar is
	 *  unread) and the supplements the briefing's trigger NOTAMs cite that
	 *  it lacks (supsMissing), null while the list is unread. */
	supaip?: { listAt: number | null; missing: readonly MissingSup[] } | null | undefined;
	/** The coverage test, routeCoverage unless the caller memoises it. */
	cover?: typeof routeCoverage | undefined;
}

export type BriefingReason =
	| { code: 'none' }
	| { code: 'failed'; labels: string[]; total: number }
	| { code: 'route'; labels: string[]; at: number; cause: RouteCause }
	| { code: 'period'; briefed: { from: number; to: number }; span: { from: number; to: number } }
	| { code: 'rtba'; dayMs: number; releaseMs: number }
	| { code: 'aerodromes'; idents: string[] }
	| { code: 'age'; at: number; ageMs: number }
	| { code: 'supaip'; listAt: number | null; sups: MissingSup[] };

export type BriefingReasonCode = BriefingReason['code'];

export interface BriefingVerdict {
	/** Is there a planned flight to judge the briefing against? */
	plan: boolean;
	/** Where the briefing came from. */
	source: 'fetch' | 'hand' | 'none';
	/** When it was fetched or loaded. */
	at: number | null;
	/** What it is short of for the flight, in the order the line states them,
	 *  empty when it covers the flight. */
	reasons: BriefingReason[];
}

/** The UTC day key of an instant, '2026-11-25'. */
export function dayKey(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** The instant the RTBA activity of the UTC day holding `ms` is released. */
export function rtbaReleaseMs(ms: number): number {
	const day = Math.floor(ms / DAY_MS) * DAY_MS;
	return day - DAY_MS + RTBA_RELEASE_MIN * MINUTE_MS;
}

/** Does the briefing know the RTBA activity of the day holding `ms`? */
function knowsRtba(i: Pick<VerdictInput, 'rtbaDays' | 'fetch'>, ms: number): boolean {
	return i.rtbaDays.has(dayKey(ms)) || (i.fetch !== null && i.fetch.at >= rtbaReleaseMs(ms));
}

/** The start of the window's first UTC day whose RTBA activity the briefing
 *  lacks, null when it knows every one. A day past the fetch's next release
 *  is always unknown, so the walk ends whatever the window's length. */
function unknownRtbaDay(i: Pick<VerdictInput, 'rtbaDays' | 'fetch'>, span: { from: number; to: number }): number | null {
	for (let day = Math.floor(span.from / DAY_MS) * DAY_MS; day <= span.to; day += DAY_MS) {
		if (!knowsRtba(i, day)) {
			return day;
		}
	}
	return null;
}

/** Points every SAMPLE_STEP_NM along a track, its vertices included. */
function samples(path: readonly LatLon[]): LatLon[] {
	const out: LatLon[] = [];
	for (let k = 0; k + 1 < path.length; k++) {
		const a = path[k];
		const b = path[k + 1];
		const lenNM = segmentNM(a, b);
		const n = Math.max(1, Math.ceil(lenNM / SAMPLE_STEP_NM));
		for (let j = 0; j < n; j++) {
			const f = j / n;
			out.push({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f });
		}
	}
	if (path.length > 0) {
		out.push(path[path.length - 1]);
	}
	return out;
}

/** An equirectangular length in NM: the sampling step, never a distance a
 *  verdict reads. */
function segmentNM(a: LatLon, b: LatLon): number {
	const mid = ((a.lat + b.lat) / 2) * (Math.PI / 180);
	const dLat = b.lat - a.lat;
	const dLon = (b.lon - a.lon) * Math.cos(mid);
	return Math.hypot(dLat, dLon) * 60;
}

/** Is every point of `track` within `radiusNM` of one of `paths`? */
function within(track: readonly LatLon[], paths: LatLon[][], radiusNM: number): boolean {
	if (radiusNM < 0 || paths.length === 0) {
		return false;
	}
	const limitM = radiusNM * NM_M;
	for (const p of samples(track)) {
		if (!paths.some((path) => path.length >= 2 && pointToPolylineDistanceM(p.lat, p.lon, path) <= limitM)) {
			return false;
		}
	}
	return true;
}

/** Is a position inside the box? */
function inBox(p: { lat: number; lon: number }, b: Bbox): boolean {
	return p.lat >= b.minLat && p.lat <= b.maxLat && p.lon >= b.minLon && p.lon <= b.maxLon;
}

/** Is a position within `halfWidthNM` of a track? */
function nearTrack(p: { lat: number; lon: number }, path: LatLon[], halfWidthNM: number): boolean {
	return path.length >= 2 && pointToPolylineDistanceM(p.lat, p.lon, path) <= halfWidthNM * NM_M;
}

/** Does a corridor `halfWidthNM` wide around `track` lie inside the box? */
function insideBox(track: readonly LatLon[], halfWidthNM: number, box: Bbox): boolean {
	for (const p of samples(track)) {
		const dLat = halfWidthNM / 60;
		const dLon = halfWidthNM / (60 * Math.max(0.01, Math.cos((p.lat * Math.PI) / 180)));
		if (p.lat - dLat < box.minLat || p.lat + dLat > box.maxLat || p.lon - dLon < box.minLon || p.lon + dLon > box.maxLon) {
			return false;
		}
	}
	return true;
}

/** Why plan tracks fall outside a fetch: a track off the ones briefed, a
 *  corridor wider than the briefing's (widened since, or past what SOFIA
 *  accepts), or a route leaving a map view's box. */
export type RouteCause = 'track' | 'width' | 'area';

/** The plan tracks a fetch covers, and the ones it lost or never asked. */
export function routeCoverage(
	plan: { tracks: PlanTrack[]; halfWidthNM: number },
	asked: AskedRegion,
): { failed: string[]; outside: string[]; cause: RouteCause } {
	const failed: string[] = [];
	const outside: string[] = [];
	const region = asked.region;
	if (region.kind === 'box') {
		for (const tr of plan.tracks) {
			if (!insideBox(tr.path, plan.halfWidthNM, region.bbox)) {
				outside.push(tr.label);
			}
		}
		return { failed, outside, cause: 'area' };
	}
	// Negative for a corridor wider than the briefing's, which then covers
	// no track. A lost one is still told by its path.
	const radius = region.halfWidthNM - plan.halfWidthNM + ROUTE_TOLERANCE_NM;
	const match = Math.max(radius, ROUTE_TOLERANCE_NM);
	const landed = region.tracks.filter((t) => t.landed).map((t) => t.path);
	const lost = region.tracks.filter((t) => !t.landed);
	for (const tr of plan.tracks) {
		if (within(tr.path, landed, radius)) {
			continue;
		}
		// A track the fetch asked for and lost is a failure, never a change.
		const miss = lost.find((t) => within(tr.path, [t.path], match));
		if (miss) {
			failed.push(tr.label);
		} else {
			outside.push(tr.label);
		}
	}
	return { failed, outside, cause: radius < 0 ? 'width' : 'track' };
}

/** Does a briefing over `briefed`, fetched at `at`, cover the window, as
 *  judged at `nowMs`? */
export function coversWindow(
	briefed: { from: number; to: number },
	span: { from: number; to: number },
	at: number,
	nowMs: number,
): boolean {
	const from = Math.max(span.from, at);
	const head = span.from <= nowMs ? HEAD_MARGIN_MS : HEAD_TOLERANCE_MS;
	return briefed.from <= from + head && briefed.to + TAIL_TOLERANCE_MS >= span.to;
}

/** The briefing judged against the planned flight. */
export function briefingVerdict(i: VerdictInput): BriefingVerdict {
	const source: BriefingVerdict['source'] = i.fetch ? 'fetch' : i.byHand ? 'hand' : 'none';
	const at = i.fetch?.at ?? i.byHand?.at ?? null;
	if (!i.plan || i.plan.tracks.length === 0 || !i.span) {
		return { plan: false, source, at, reasons: [] };
	}
	if (source === 'none') {
		return { plan: true, source, at, reasons: [{ code: 'none' }] };
	}
	const reasons: BriefingReason[] = [];
	if (i.fetch) {
		if (i.fetch.asked) {
			const cov = (i.cover ?? routeCoverage)(i.plan, i.fetch.asked);
			if (cov.failed.length > 0) {
				reasons.push({ code: 'failed', labels: cov.failed, total: i.plan.tracks.length });
			}
			if (cov.outside.length > 0) {
				reasons.push({ code: 'route', labels: cov.outside, at: i.fetch.at, cause: cov.cause });
			}
		} else if (i.gaps && i.gaps.labels.length > 0) {
			reasons.push({ code: 'failed', labels: i.gaps.labels, total: i.gaps.total });
		}
		const briefed = i.fetch.briefed;
		if (briefed && !coversWindow(briefed, i.span, i.fetch.at, i.nowMs)) {
			reasons.push({ code: 'period', briefed, span: i.span });
		}
	}
	const rtbaDay = i.crossesRtba ? unknownRtbaDay(i, i.span) : null;
	if (rtbaDay !== null) {
		reasons.push({ code: 'rtba', dayMs: rtbaDay, releaseMs: rtbaReleaseMs(rtbaDay) });
	}
	if (i.aerodromesMissed && i.aerodromesMissed.length > 0) {
		reasons.push({ code: 'aerodromes', idents: [...i.aerodromesMissed] });
	}
	if (i.onGround && at !== null && i.nowMs - at > AGE_LIMIT_MS) {
		reasons.push({ code: 'age', at, ageMs: i.nowMs - at });
	}
	if (i.supaip && i.supaip.missing.length > 0) {
		reasons.push({ code: 'supaip', listAt: i.supaip.listAt, sups: [...i.supaip.missing] });
	}
	return { plan: true, source, at, reasons };
}

/** A supplement a trigger NOTAM cites and the SUP AIP list lacks: the
 *  citation as the chips write it ("AIP SUP 247/26") and the NOTAM. */
export interface MissingSup {
	ref: string;
	notam: string;
}

/** The metropolitan AIP SUPs the French trigger NOTAMs among `notams` cite
 *  and the SUP AIP list lacks (`listed` false), each once, with the first
 *  NOTAM citing it. A trigger announces a supplement in force, so a list
 *  built before it lacks the zones the briefing activates. The IFR series
 *  is numbered apart from the list's. */
export function supsMissing(
	notams: Iterable<Notam>,
	listed: (number: number, year: number) => boolean,
): MissingSup[] {
	const out: MissingSup[] = [];
	const seen = new Set<string>();
	for (const n of notams) {
		if (!isTriggerNotam(n) || notamSupPublisher(n) !== 'fr') {
			continue;
		}
		for (const r of extractAipSupsFor(n.fullContent, 'fr')) {
			const key = `${r.year}/${r.number}`;
			if (r.series !== 'A' || seen.has(key)) {
				continue;
			}
			seen.add(key);
			if (!listed(r.number, r.year)) {
				out.push({ ref: r.display, notam: n.id });
			}
		}
	}
	return out;
}

/** What the briefing says of a position at an instant. */
export interface BriefedAt {
	/** Inside its region and its window: the honest ground for calling a
	 *  zone activated by NOTAM cold there. */
	notam: boolean;
	/** And the day's RTBA activity is in it. */
	rtba: boolean;
	/** Where `notam` fails: no briefing, the position outside its region,
	 *  the instant outside its window. */
	miss: 'none' | 'position' | 'period' | null;
}

/** Is a position at an instant inside what the briefing covers? A bulletin
 *  by hand states no region and no window, so it covers wherever and
 *  whenever it is read, the RTBA activity only through a NOTAM of the day.
 *  A fetch that named no geometry covers wherever it is read. Aerodromes
 *  fetched by name alone hold their own fields' NOTAMs and no area's, which
 *  the verdict reads as no briefing too. */
export function briefedAt(
	i: Pick<VerdictInput, 'loaded' | 'fetch' | 'byHand' | 'rtbaDays'>,
	at: { lat: number; lon: number; ms: number },
): BriefedAt {
	if (!i.loaded || (!i.fetch && !i.byHand)) {
		return { notam: false, rtba: false, miss: 'none' };
	}
	const f = i.fetch;
	if (f) {
		const region = f.asked?.region;
		const inside =
			region?.kind === 'box'
				? inBox(at, region.bbox)
				: region?.kind === 'tracks'
					? region.tracks.some((t) => t.landed && nearTrack(at, t.path, region.halfWidthNM))
					: true;
		if (!inside) {
			return { notam: false, rtba: false, miss: 'position' };
		}
		// No head hour for an instant, the fetch's margin alone: SOFIA's
		// bulletin holds what is active from its departure on, a minute or
		// two after the request. A window still to open keeps the hour
		// (coversWindow).
		if (f.briefed && (at.ms < f.briefed.from - HEAD_MARGIN_MS || at.ms > f.briefed.to + TAIL_TOLERANCE_MS)) {
			return { notam: false, rtba: false, miss: 'period' };
		}
	}
	return { notam: true, rtba: knowsRtba(i, at.ms), miss: null };
}

/** How a briefing holds the NOTAMs filed under an aerodrome, by what its
 *  fetch asked:
 *  - full: inside a map view's box or an autorouter corridor, or at a SOFIA
 *    track's first or last aerodrome, the ones SOFIA briefs whole.
 *  - thin: elsewhere inside a SOFIA corridor, where about one in six of a
 *    field's own NOTAMs comes back.
 *  - none: outside every landed track and box.
 *  A fetch that named no geometry reads full: nothing says what it left out. */
export function aerodromeReach(
	asked: AskedRegion | null,
	ad: { ident: string; lat: number; lon: number },
): 'full' | 'thin' | 'none' {
	const region = asked?.region;
	if (!region) {
		return 'full';
	}
	if (region.kind === 'box') {
		return inBox(ad, region.bbox) ? 'full' : 'none';
	}
	const id = ad.ident.toUpperCase();
	let reach: 'full' | 'thin' | 'none' = 'none';
	for (const t of region.tracks) {
		if (!t.landed) {
			continue;
		}
		if (t.ends?.includes(id)) {
			return 'full';
		}
		if (nearTrack(ad, t.path, region.halfWidthNM)) {
			if (t.ends === null) {
				return 'full';
			}
			reach = 'thin';
		}
	}
	return reach;
}

/** Where a briefing over `briefed` leaves the viewing period: the instant it
 *  starts covering when the period opens materially before it, and the one
 *  it stops covering when the period runs past it. The map reads the
 *  viewing period while the briefing covers the flight, so a session opened
 *  on Now over a flight dated later reads a briefing of the flight's day. */
export function viewGaps(
	briefed: { from: number; to: number },
	view: { from: number; to: number },
): { from: number | null; until: number | null } {
	return {
		from: view.from < briefed.from - HEAD_TOLERANCE_MS ? briefed.from : null,
		until: view.to > briefed.to + TAIL_TOLERANCE_MS ? briefed.to : null,
	};
}


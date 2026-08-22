/* Airspace traversal + radio-frequency schedule for a drawn route. Samples the
 * route at its per-waypoint altitudes, tracks which airspaces are active, and
 * emits an ordered enter/leave timeline with each airspace's radio. Drives the
 * "Radio & airspace schedule" section of the nav-log modal.
 *
 * Pure (takes the airspaces array): the modal calls it inside a $derived after
 * ensureAirspaces(). Kept free of Svelte so it is unit-testable in Node. */

import {
	airspaceBadge,
	firIdent,
	narrowToRai,
	pointInRing,
	raiRadioIndex,
	type Airspace,
	type AirspaceRadio,
	type VerticalLimit,
	type VLimit,
} from '$lib/data/airspaces';
import { floorMinFt, ceilingMaxFt } from '$lib/vertical/limits';
import type { EntryConditions } from '$lib/data/airspaceEntry';
import type { TerrainSample } from '$lib/map/terrain';
import { bboxesOverlap, equirectangularDistanceM, type Bbox } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import {
	coalesceRadioLines,
	formatFreqMHz,
	preferredChannel,
	sortRadios,
	workableRadios,
} from '$lib/format/radio';
import type { AirspaceCategory } from '$lib/state/layers.svelte';
import type { Waypoint } from '$lib/state/route.svelte';
import { EU_REGIME, US_REGIME, type CruisingRegime } from '$lib/route/cruisingLevels';

export interface RouteAirspaceEvent {
	kind: 'enter' | 'leave';
	/** Along-route distance (NM) at which the transition happens. */
	atNM: number;
	/** Minutes from the start at the cruise speed, or null when unset. */
	eteMin: number | null;
	key: string;
	name: string;
	type: string;
	airClass: string;
	category: AirspaceCategory;
	vLower: VLimit | null;
	vUpper: VLimit | null;
	radio: AirspaceRadio[];
}

// Sampling: one point per nautical mile, widened for very long routes so the
// total stays bounded. A thin airspace sliver narrower than the step can be
// missed; acceptable for a nav-log overview.
const STEP_NM = 1;
const MAX_SAMPLES = 1000;

export interface RouteSample {
	cumNM: number;
	lat: number;
	lon: number;
	altFt: number;
}

/** FIR/UIR/OCA span the whole route and aren't a frequency-change boundary
 *  (every route is always inside some FIR), so they're left out of the
 *  schedule; SIV (FIS) sectors are kept. */
function scheduleRelevant(a: Airspace): boolean {
	return a.category !== 'fir';
}

/** Does the airspace's band contain the altitude? Datum-aware and
 *  conservative: a missing side is unbounded, and an AGL/ASFC limit
 *  resolves exactly against `groundFt` when the caller has terrain for
 *  the sample, else through its conservative endpoint (floor at its
 *  minimum, ceiling unbounded), so a terrain-hugging zone is included
 *  until terrain proves otherwise. The lower bound is STRICT: flying at
 *  the floor (e.g. 1500 ft into a 1500 ft-base zone) does not count as
 *  inside, so the schedule only lists zones whose floor is below the leg
 *  altitude. */
function inBand(a: Airspace, altFt: number, groundFt?: number | null): boolean {
	const lo = a.vLower ? floorMinFt(a.vLower, groundFt) : -Infinity;
	const hi = a.vUpper ? ceilingMaxFt(a.vUpper, groundFt) : Infinity;
	return lo < altFt && hi >= altFt;
}

function waypointsBbox(wps: Waypoint[]): Bbox {
	let minLat = Infinity;
	let minLon = Infinity;
	let maxLat = -Infinity;
	let maxLon = -Infinity;
	for (const w of wps) {
		if (w.lat < minLat) minLat = w.lat;
		if (w.lat > maxLat) maxLat = w.lat;
		if (w.lon < minLon) minLon = w.lon;
		if (w.lon > maxLon) maxLon = w.lon;
	}
	return { minLat, minLon, maxLat, maxLon };
}

/** Airspaces containing the sample laterally (ring only, no altitude), keyed
 *  by `key`. The lateral half of activeAt; drives the vertical-profile spans,
 *  which show every overflown airspace regardless of the planned altitude. */
function lateralAt(
	candidates: Airspace[],
	lat: number,
	lon: number,
): Map<string, Airspace> {
	const out = new Map<string, Airspace>();
	for (const a of candidates) {
		const b = a.bbox;
		if (lat < b.minLat || lat > b.maxLat || lon < b.minLon || lon > b.maxLon) {
			continue;
		}
		if (pointInRing(lat, lon, a.ring)) {
			out.set(a.key, a);
		}
	}
	return out;
}

/** Airspaces containing the sample laterally and vertically, keyed by `key`. */
function activeAt(
	candidates: Airspace[],
	lat: number,
	lon: number,
	altFt: number,
	groundFt?: number | null,
): Map<string, Airspace> {
	const out = new Map<string, Airspace>();
	for (const a of candidates) {
		const b = a.bbox;
		if (lat < b.minLat || lat > b.maxLat || lon < b.minLon || lon > b.maxLon) {
			continue;
		}
		if (!inBand(a, altFt, groundFt)) {
			continue;
		}
		if (pointInRing(lat, lon, a.ring)) {
			out.set(a.key, a);
		}
	}
	return out;
}

/** Ground elevation per walk sample, matched by nearest distNM against the
 *  route's terrain profile (the caps differ: the walk samples up to 1000
 *  points, sampleProfile 600, so index mapping would drift). Two-pointer
 *  over the two distance-sorted arrays; null entries (failed tiles) stay
 *  null, which the vertical predicates treat conservatively. Null when no
 *  terrain was supplied at all. */
function groundAtSamples(
	samples: RouteSample[],
	terrain: TerrainSample[] | null | undefined,
): (number | null)[] | null {
	if (!terrain || terrain.length === 0) {
		return null;
	}
	const out: (number | null)[] = new Array(samples.length) as (number | null)[];
	let j = 0;
	for (let i = 0; i < samples.length; i++) {
		const d = samples[i].cumNM;
		while (
			j + 1 < terrain.length &&
			Math.abs(terrain[j + 1].distNM - d) <= Math.abs(terrain[j].distNM - d)
		) {
			j++;
		}
		out[i] = terrain[j].elevFt;
	}
	return out;
}

function makeEvent(
	kind: 'enter' | 'leave',
	atNM: number,
	kt: number | null,
	a: Airspace,
): RouteAirspaceEvent {
	return {
		kind,
		atNM,
		eteMin: kt ? (atNM / kt) * 60 : null,
		key: a.key,
		name: a.name,
		type: a.type,
		airClass: a.airClass,
		category: a.category,
		vLower: a.vLower,
		vUpper: a.vUpper,
		// Military / activable airspaces lump their controlling approach's whole
		// frequency set (incl. UHF) onto the airspace; the schedule shows only the
		// RAI contact the VAC cites. Non-RAI airspaces keep their full radio list,
		// less the channels a light aircraft cannot work: 118 French rows publish
		// military UHF or VHF-low and 51 publish guard, and the nav log was
		// printing them as channels to set (CTR PARIS listed 243.000 among 27).
		radio: workableRadios(narrowToRai(a.radio, raiRadioIndex(a))),
	};
}

/** Interior-point sampling of the route in order, one point per ~STEP_NM
 *  (widened so the total stays bounded), shared by every route-airspace walk.
 *  Each leg contributes its start plus interior points; the leg's end is the
 *  next leg's start, so a shared waypoint is sampled once, and the final
 *  endpoint is added last. In the per-leg model a leg flies FLAT at its
 *  from-waypoint's altitude, so each sample's altFt is alt(from) (a non-finite
 *  alt falls back to defaultAltFt); lateral-only callers ignore altFt. Returns
 *  [] for a degenerate route (< 2 waypoints or zero total length). Exported
 *  as THE shared route sampler: the schedule / corridor-span / at-altitude
 *  walks here and the NOTAM profile walk (route/notamProfile.ts) all ride it,
 *  so their along-track distances agree by construction. */
export function sampleRoute(waypoints: Waypoint[], defaultAltFt: number): RouteSample[] {
	if (waypoints.length < 2) {
		return [];
	}
	const legNM: number[] = [];
	let totalNM = 0;
	for (let i = 0; i + 1 < waypoints.length; i++) {
		const d =
			equirectangularDistanceM(
				waypoints[i].lat,
				waypoints[i].lon,
				waypoints[i + 1].lat,
				waypoints[i + 1].lon,
			) / NM_TO_METERS;
		legNM.push(d);
		totalNM += d;
	}
	if (totalNM <= 0) {
		return [];
	}
	const stepNM = Math.max(STEP_NM, totalNM / MAX_SAMPLES);
	const alt = (w: Waypoint): number => (Number.isFinite(w.alt) ? w.alt : defaultAltFt);
	const samples: RouteSample[] = [];
	let cumBase = 0;
	for (let i = 0; i + 1 < waypoints.length; i++) {
		const a = waypoints[i];
		const b = waypoints[i + 1];
		const d = legNM[i];
		const seg = Math.max(1, Math.ceil(d / stepNM));
		for (let k = 0; k < seg; k++) {
			const f = k / seg;
			samples.push({
				cumNM: cumBase + d * f,
				lat: a.lat + (b.lat - a.lat) * f,
				lon: a.lon + (b.lon - a.lon) * f,
				altFt: alt(a),
			});
		}
		cumBase += d;
	}
	const last = waypoints[waypoints.length - 1];
	// The destination has no outbound leg; its endpoint flies the last leg's level.
	samples.push({
		cumNM: totalNM,
		lat: last.lat,
		lon: last.lon,
		altFt: alt(waypoints[waypoints.length - 2]),
	});
	return samples;
}

/** Walk the route, emitting an ordered enter/leave timeline. Airspaces active
 *  at the start enter at 0 NM; airspaces still active at the end are not
 *  "left" (the flight ends inside them, e.g. the destination CTR). */
export function computeAirspaceSchedule(
	waypoints: Waypoint[],
	airspaces: Airspace[],
	cruiseSpeedKt: number | null,
	defaultAltFt: number,
	terrain?: TerrainSample[] | null,
): RouteAirspaceEvent[] {
	const samples = sampleRoute(waypoints, defaultAltFt);
	if (samples.length === 0) {
		return [];
	}

	const box = waypointsBbox(waypoints);
	const candidates = airspaces.filter(
		(a) =>
			scheduleRelevant(a) &&
			// Aerial-activity zones (gliding, parachuting, etc.) are recreational
			// clutter; excluded from the schedule as from the vertical profile.
			a.category !== 'activity' &&
			bboxesOverlap(box, a.bbox),
	);

	const kt = cruiseSpeedKt && cruiseSpeedKt > 0 ? cruiseSpeedKt : null;
	// Ground elevation per sample (routeTerrain's prefetch when the caller
	// has it): AGL floors and ceilings then test exactly instead of
	// conservatively, so an ASFC zone enters the schedule only where the
	// flight is really inside it.
	const ground = groundAtSamples(samples, terrain);
	const events: RouteAirspaceEvent[] = [];
	let prev = new Map<string, Airspace>();
	for (const [i, s] of samples.entries()) {
		const cur = activeAt(candidates, s.lat, s.lon, s.altFt, ground?.[i]);
		// Sorted for deterministic output when several change at one sample.
		// Leaves are emitted before enters at the same point: you leave one
		// airspace to enter the next, so "leave A / enter B" reads in order.
		for (const k of [...prev.keys()].filter((k) => !cur.has(k)).sort()) {
			events.push(makeEvent('leave', s.cumNM, kt, prev.get(k)!));
		}
		for (const k of [...cur.keys()].filter((k) => !prev.has(k)).sort()) {
			events.push(makeEvent('enter', s.cumNM, kt, cur.get(k)!));
		}
		prev = cur;
	}
	return events;
}

export interface EnrouteFreqLine {
	/** The unit to call, by its published call sign ("SEINE - APPROCHE",
	 *  merged "SEINE / MELUN - APPROCHE" where two work one channel). */
	label: string;
	/** The one channel to set on that unit. */
	freq: string;
	/** Row keys of the airspaces this line covers, entry order: the live
	 *  nav log matches the current/next contact against them. */
	keys: string[];
	/** A service-closure NOTAM withdraws this line's frequency: the display
	 *  strikes it and it never carries the contact tint; the seed / export
	 *  snapshot skips it (a seed is "the value to use"). `closedBy` names the
	 *  NOTAM for the tooltip. Closed lines are coalesced apart from open ones
	 *  and appended after them, so a closed sector can never merge into a
	 *  working co-frequency line. */
	closed?: boolean;
	closedBy?: string;
}

/** Airspaces whose controlling unit (or FIS) a pilot must contact while flying:
 *  SIV (FIS) always; RMZ / TMZ-RMZ always (SERA.6005 radio watch); ICAO class
 *  B / C / D always; class A or E only under IFR (VFR cannot enter A and needs no
 *  contact in E); a CONTROLLED volume with no published class but a published
 *  frequency, since the class is what is missing, not the contact. Everything
 *  else (class F / G, R / D / P, TRA, activity, plain TMZ) is not a radio
 *  contact and is excluded. Matches the legislation summarised in
 *  AIRSPACE_CLASS_DESC. */
export function enrouteRelevant(ev: RouteAirspaceEvent, ifr: boolean): boolean {
	if (ev.category === 'siv') {
		return true;
	}
	if (ev.type === 'RMZ' || ev.type === 'TMZ-RMZ') {
		return true;
	}
	const c = ev.airClass;
	if (c === 'B' || c === 'C' || c === 'D') {
		return true;
	}
	// A controlled volume whose class the publisher did not state, but
	// which publishes a frequency, is a contact: the missing class is a
	// gap in the data, not a statement that nobody need be called, and
	// the frequency is the evidence. Without this the nav log drops a
	// published channel the detail panel goes on showing (66 German ED-R
	// rows, 24 delegated-ATS areas). Restricted and danger areas stay
	// out: asking a controlling authority to cross one is a different act
	// from an enroute contact.
	if (c === '' && ev.category === 'controlled' && ev.radio.length > 0) {
		return true;
	}
	return (c === 'A' || c === 'E') && ifr;
}

/** The FIR-level FIS blanket (type FIC: PARIS / MARSEILLE Information and the
 *  overseas equivalents, split off SIV by cmd/fr on their FIR-ident+FS codeId).
 *  It spans the whole FIR from the surface, but its own AIP remark reads
 *  "Excluding areas where the flight information service is provided by an
 *  approach control unit", so where an APP-run SIV covers the flight THAT is
 *  the sector to call and this one is not. Vertically the SIV tops out well
 *  below it (SIV SEINE 1 SFC-FL065 under FIC PARIS SUD SFC-FL195); the schedule
 *  walk is altitude-aware, so above the SIV only the FIC is on the timeline and
 *  there is nothing to supersede. Structural argument: serves an Airspace row
 *  and a schedule event alike. */
export function isFirLevelFis(ev: { type: string }): boolean {
	return ev.type === 'FIC';
}

/** "SEINE / MELUN - APPROCHE" from ["SEINE - APPROCHE", "MELUN - APPROCHE"]: factor
 *  the common leading word(s) and list the distinct tails, else a common trailing
 *  word instead, which is the shape a call sign takes ("<place> - <service>").
 *  Falls back to the full labels joined " / " when neither a prefix nor a suffix
 *  leaves every label a distinct word. Published call signs carry no " / ", so the
 *  caller's split round-trips. */
function mergeContactLabels(labels: string[]): string {
	if (labels.length === 1) {
		return labels[0];
	}
	const split = labels.map((l) => l.split(' ').filter(Boolean));

	// Common leading words: "TMA SEINE 1 / 2 / 5" from "TMA SEINE 1..5".
	let p = 0;
	while (split[0][p] !== undefined && split.every((s) => s[p] === split[0][p])) {
		p++;
	}
	if (p > 0 && split.every((s) => s.length > p)) {
		const prefix = split[0].slice(0, p).join(' ');
		const tails = split.map((s) => s.slice(p).join(' '));
		return `${prefix} ${tails.join(' / ')}`;
	}

	// No usable prefix: factor a common trailing word (the location name), so
	// co-located zones of different type read "CTR / RMZ MELUN".
	let q = 0;
	while (
		split[0][split[0].length - 1 - q] !== undefined &&
		split.every((s) => s[s.length - 1 - q] === split[0][split[0].length - 1 - q])
	) {
		q++;
	}
	if (q > 0 && split.every((s) => s.length > q)) {
		const suffix = split[0].slice(split[0].length - q).join(' ');
		const heads = split.map((s) => s.slice(0, s.length - q).join(' '));
		return `${heads.join(' / ')} ${suffix}`;
	}

	return labels.join(' / ');
}

/** Two-way merge of (call sign, single frequency) pairs, reusing coalesceRadioLines'
 *  bidirectional grouping (several units on one frequency share a line; one unit on
 *  several frequencies joins them), then factoring the shared words so co-frequency
 *  units read "SEINE / MELUN - APPROCHE". Each line keeps the row keys of every
 *  airspace that unit works on this leg, recovered from the pre-merge labels
 *  (published call signs carry no " / ", so the joined label splits back losslessly),
 *  and reduces to the ONE channel to set: a unit publishes a channel per sector and
 *  the chart prints one frequency per box, so a line offering ten is not an answer. */
function coalesceEnrouteFreqs(
	pairs: { label: string; freq: string; key: string; closedBy?: string }[],
): EnrouteFreqLine[] {
	const keysByLabel = new Map<string, string[]>();
	for (const p of pairs) {
		const ks = keysByLabel.get(p.label);
		if (!ks) {
			keysByLabel.set(p.label, [p.key]);
		} else if (!ks.includes(p.key)) {
			ks.push(p.key);
		}
	}
	const merge = (
		subset: { label: string; freq: string; key: string; closedBy?: string }[],
	): EnrouteFreqLine[] => {
		const lines = coalesceRadioLines(
			subset.map((p) => ({ freq: p.freq, unit: p.label, call: p.label })),
			(r) => r.unit,
		);
		return lines.map((l) => {
			const labels = l.label.split(' / ');
			return {
				label: mergeContactLabels(labels),
				freq: preferredChannel(l.freq),
				keys: labels.flatMap((lab) => keysByLabel.get(lab) ?? []),
			};
		});
	};
	// Closed rows coalesce apart and land AFTER the working lines: the
	// bidirectional frequency/label grouping would otherwise fold a closed
	// sector into an open co-frequency line, and half a merged line cannot be
	// struck. The working answer reads first, the withdrawn one under it.
	const open = pairs.filter((p) => p.closedBy === undefined);
	const closed = pairs.filter((p) => p.closedBy !== undefined);
	const out = merge(open);
	if (closed.length > 0) {
		const byLabel = new Map(closed.map((p) => [p.label, p.closedBy ?? '']));
		for (const l of merge(closed)) {
			const first = l.label.split(' / ').find((lab) => byLabel.has(lab));
			out.push({ ...l, closed: true, closedBy: byLabel.get(first ?? '') ?? '' });
		}
	}
	return out;
}

/** Does the union of `covers` (any order, overlaps allowed) span [from, to] up
 *  to `tol`? Sweep in start order extending the reach: sorted that way, a gap
 *  opening before the next interval starts can never be filled by a later one.
 *  Pure. */
function intervalCovered(
	covers: { enterNM: number; leaveNM: number }[],
	from: number,
	to: number,
	tol: number,
): boolean {
	let reach = from;
	for (const c of [...covers].sort((a, b) => a.enterNM - b.enterNM)) {
		if (reach >= to - tol) {
			return true;
		}
		if (c.enterNM > reach + tol) {
			return false;
		}
		reach = Math.max(reach, c.leaveNM);
	}
	return reach >= to - tol;
}

/** Per-leg enroute contact frequencies. For each leg (the hop leaving waypoint i),
 *  every airspace ACTIVE anywhere along that leg whose class requires contact
 *  (enrouteRelevant), each as { label: "TMA SEINE 5", freq: "120.500 / 121.300" },
 *  co-frequency airspaces merged (coalesceEnrouteFreqs). The FIR-level FIS
 *  blanket (isFirLevelFis) is dropped from a leg an APP-run SIV covers whole,
 *  since the FIC is not the sector to call there. Built from the enter/leave
 *  schedule (radios already override-resolved by the caller) and the nav-log leg
 *  boundaries (legCumNM[i] = cumulative NM at the END of leg i; the last entry is the
 *  route total). Returns one entry per leg (length legCumNM.length); index by
 *  from-waypoint (the last waypoint has no outbound leg). Radio-less airspaces are
 *  skipped. Pure. */
export function enrouteFreqsByLeg(
	schedule: RouteAirspaceEvent[],
	legCumNM: number[],
	ifr: boolean,
): EnrouteFreqLine[][] {
	const nLegs = legCumNM.length;
	const out: EnrouteFreqLine[][] = Array.from({ length: nLegs }, () => []);
	if (nLegs === 0) {
		return out;
	}
	const totalNM = legCumNM[nLegs - 1];
	// Reconstruct each airspace's active spans from the enter/leave timeline, kept in
	// ENTER order (route order) so each leg's lines read as the flight meets the
	// airspaces, not as it leaves them. A span is pushed when its enter is seen
	// (default leave = totalNM, the flight ending inside it) and openIdx points the
	// later leave back to it.
	const spans: { enterNM: number; leaveNM: number; ev: RouteAirspaceEvent }[] = [];
	const openIdx = new Map<string, number>();
	for (const ev of schedule) {
		if (ev.kind === 'enter') {
			openIdx.set(ev.key, spans.length);
			spans.push({ enterNM: ev.atNM, leaveNM: totalNM, ev });
		} else {
			const i = openIdx.get(ev.key);
			if (i !== undefined) {
				spans[i].leaveNM = ev.atNM;
				openIdx.delete(ev.key);
			}
		}
	}

	// A small epsilon keeps a span touching a leg boundary on the correct side: an
	// airspace left exactly at the from-waypoint, or entered exactly at the
	// to-waypoint, is not listed on this leg.
	const EPS = 1e-6;
	for (let i = 0; i < nLegs; i++) {
		const start = i === 0 ? 0 : legCumNM[i - 1];
		const end = legCumNM[i];
		const seen = new Set<string>(); // dedupe an airspace within the leg (re-entry / multi-span)
		const pairs: { label: string; freq: string; key: string; closedBy?: string }[] = []; // (airspace label, single freq), entry order
		// The APP-run SIV stretches of this leg, which supersede the FIC blanket
		// below. Only a SIV that actually publishes a USABLE frequency counts:
		// 18 of the 102 French SIV rows have none, and a sector whose frequency
		// a service-closure NOTAM withdrew (r.closed) counts the same way;
		// letting either drop the FIC would leave the leg with no working FIS
		// frequency at all, exactly when the FIC is the unit the NOTAM says to
		// call.
		const sivCover = spans.filter(
			(s) =>
				s.ev.category === 'siv' &&
				!isFirLevelFis(s.ev) &&
				s.leaveNM > start + EPS &&
				s.enterNM < end - EPS &&
				s.ev.radio.some((r) => formatFreqMHz(r.freq) !== '' && !r.closed),
		);
		for (const s of spans) {
			if (s.leaveNM <= start + EPS || s.enterNM >= end - EPS) {
				continue; // no overlap with (start, end)
			}
			if (seen.has(s.ev.key) || !enrouteRelevant(s.ev, ifr)) {
				continue;
			}
			// Drop the FIR-level FIS only where a SIV covers this stretch WHOLE:
			// a leg running out of SIV cover keeps it, because for the rest of
			// the leg the FIC really is the sector to call. Tested per span and
			// before `seen`, so a FIC re-entered later in the leg is judged on
			// its own stretch. EPS, not a sampler-sized slop: adjacent sectors
			// hand over at the SAME cumNM (the walk emits the leave and the
			// enter at one sample), so real SIV cover is exactly contiguous.
			if (
				isFirLevelFis(s.ev) &&
				intervalCovered(sivCover, Math.max(s.enterNM, start), Math.min(s.leaveNM, end), EPS)
			) {
				continue;
			}
			seen.add(s.ev.key);
			// Keyed on the UNIT, the way the chart labels an airspace box
			// ("SEINE App. 118.050") and the way ENR 2.1 hangs the frequency off
			// the call sign rather than off the airspace name. Keyed on the
			// airspace instead, every unit serving it flattened into one line:
			// CTR PARIS, worked by three different approaches, read as nineteen
			// numbers with nothing to say which belonged to whom. The airspace
			// keeps its own column in the radio schedule below.
			const zone = `${s.ev.type} ${s.ev.name}`.trim();
			const fseen = new Set<string>();
			for (const r of sortRadios(s.ev.radio)) {
				const f = formatFreqMHz(r.freq);
				const label = (r.call || r.unit).trim() || zone;
				if (f && !fseen.has(label + '|' + f)) {
					fseen.add(label + '|' + f);
					if (r.closed) {
						// The provenance rides the resolver's own row shape; the
						// pure walk reads it duck-typed so it stays state-free.
						const src = (r as { closedBy?: { source?: { notam?: { id?: string } } } })
							.closedBy?.source?.notam?.id;
						pairs.push({ label, freq: f, key: s.ev.key, closedBy: src ?? '' });
					} else {
						pairs.push({ label, freq: f, key: s.ev.key });
					}
				}
			}
		}
		out[i] = coalesceEnrouteFreqs(pairs);
	}
	return out;
}

/** One contactable airspace's active stretch along the route: an enter/leave
 *  pair from the schedule timeline, kept only for airspaces whose unit a pilot
 *  must contact (enrouteRelevant) AND that carry a usable frequency. leaveNM is
 *  Infinity when the flight ends inside the airspace, so containment tests at
 *  the route's total distance need no special case. */
export interface ContactSpan {
	enterNM: number;
	leaveNM: number;
	/** The enter event (label fields + the caller's override-resolved radio). */
	ev: RouteAirspaceEvent;
}

/** The contact resolution at one along-route position: the airspace whose unit
 *  the flight should be talking to (null outside every contactable span), the
 *  one it talks to after the next change (null when the current contact simply
 *  ends, or when nothing changes ahead), and where that change happens. */
export interface ContactState {
	current: ContactSpan | null;
	next: ContactSpan | null;
	/** Along-route distance (NM) of the next contact change; null when none. */
	boundaryNM: number | null;
	/** Where the CURRENT contact took over, as a schedule row to point at: its
	 *  own enter, or the LEAVE of the span that was covering it until then (the
	 *  handover a pilot hears as "leaving the TMA, back to the FIS"). Without
	 *  it a fallback would point at an enter row far up the route (the FIS
	 *  entered at 0 NM) and the schedule's highlight would jump backwards.
	 *  Non-decreasing along the route by construction. Null with no contact. */
	handover: { span: ContactSpan; kind: 'enter' | 'leave' } | null;
}

/** The schedule's contactable spans, in enter (route) order: the airspaces the
 *  nav log's enroute-frequency lines brief (enrouteRelevant) that carry at
 *  least one usable frequency: one that is published AND not withdrawn by a
 *  service-closure NOTAM (r.closed). A sector whose every frequency is closed
 *  drops out here, which is what hands the contact to the published unit
 *  underneath (the FIC blanket the closure NOTAM itself designates). Same
 *  open-index span reconstruction as enrouteFreqsByLeg; a span never left
 *  stays open to Infinity. Pure. */
export function buildContactSpans(schedule: RouteAirspaceEvent[], ifr: boolean): ContactSpan[] {
	const spans: ContactSpan[] = [];
	const openIdx = new Map<string, number>();
	for (const ev of schedule) {
		if (ev.kind === 'enter') {
			if (
				!enrouteRelevant(ev, ifr) ||
				!ev.radio.some((r) => formatFreqMHz(r.freq) !== '' && !r.closed)
			) {
				continue;
			}
			openIdx.set(ev.key, spans.length);
			spans.push({ enterNM: ev.atNM, leaveNM: Infinity, ev });
		} else {
			const i = openIdx.get(ev.key);
			if (i !== undefined) {
				spans[i].leaveNM = ev.atNM;
				openIdx.delete(ev.key);
			}
		}
	}
	return spans;
}

/** The contactable spans a service closure removed: airspaces the nav log
 *  briefs (enrouteRelevant) that carry a closed frequency and no usable open
 *  one. buildContactSpans drops these; the live selector reads them back to
 *  stamp "who WOULD have been the contact" provenance on the unit that
 *  replaced them (docs/nav-live.md). Same reconstruction. Pure. */
export function closedContactSpans(schedule: RouteAirspaceEvent[], ifr: boolean): ContactSpan[] {
	const spans: ContactSpan[] = [];
	const openIdx = new Map<string, number>();
	for (const ev of schedule) {
		if (ev.kind === 'enter') {
			if (
				!enrouteRelevant(ev, ifr) ||
				!ev.radio.some((r) => r.closed) ||
				ev.radio.some((r) => formatFreqMHz(r.freq) !== '' && !r.closed)
			) {
				continue;
			}
			openIdx.set(ev.key, spans.length);
			spans.push({ enterNM: ev.atNM, leaveNM: Infinity, ev });
		} else {
			const i = openIdx.get(ev.key);
			if (i !== undefined) {
				spans[i].leaveNM = ev.atNM;
				openIdx.delete(ev.key);
			}
		}
	}
	return spans;
}

/** The service tier deciding which of several overlapping contacts the flight
 *  is actually talking to: the controlling unit of controlled airspace (class
 *  B/C/D, A/E under IFR) over an RMZ's self-announce frequency over the FIS
 *  (SIV) watch. Entering a lower tier never takes over (a SIV sector handover
 *  underneath a CTR does not touch the tower contact). Exported so the live
 *  chain can ask whether a unit outranks the FIS watch, which is what lets a
 *  departure aerodrome keep the contact until it does. */
export function contactTier(ev: RouteAirspaceEvent): number {
	if (ev.category === 'siv') {
		return 0;
	}
	if (ev.type === 'RMZ' || ev.type === 'TMZ-RMZ') {
		return 1;
	}
	return 2;
}

/** Does `s` outrank `best` as the contact in force? The service tier first
 *  (contactTier), then the APP-run SIV over the FIR-level FIS blanket
 *  (isFirLevelFis: a flight inside a SIV is never handed PARIS Information by
 *  a nesting or recency tiebreak, which is what keeps this in step with the
 *  nav log's frequency lines), then the most recently entered (max enterNM,
 *  ties to the innermost = min leaveNM, then to the later span in route
 *  order). Pure. */
export function outranksContact(s: ContactSpan, best: ContactSpan): boolean {
	const tier = contactTier(s.ev);
	const bestTier = contactTier(best.ev);
	if (tier !== bestTier) {
		return tier > bestTier;
	}
	const fis = isFirLevelFis(s.ev);
	const bestFis = isFirLevelFis(best.ev);
	if (fis !== bestFis) {
		return bestFis;
	}
	return s.enterNM > best.enterNM || (s.enterNM === best.enterNM && s.leaveNM <= best.leaveNM);
}

/** Resolve the contact at dNM: among the spans containing d
 *  (enterNM <= d < leaveNM) the one that outranksContact all the others, so a
 *  CTR entered inside a SIV takes over and leaving it falls back to the
 *  still-open SIV. `next` scans the span edges ahead of dNM for the first
 *  position where that resolution changes key. Pure. */
export function contactStateAt(spans: ContactSpan[], dNM: number): ContactState {
	const top = (d: number): ContactSpan | null => {
		let best: ContactSpan | null = null;
		for (const s of spans) {
			if (!(s.enterNM <= d && d < s.leaveNM)) {
				continue;
			}
			if (best === null || outranksContact(s, best)) {
				best = s;
			}
		}
		return best;
	};
	const current = top(dNM);
	// Where this contact took over: its own enter, unless a span that outranked
	// it has ended since (leaving a CTR or a TMA hands the flight back to the
	// FIS underneath, and THAT leave is the handover the schedule points at).
	let handover: ContactState['handover'] = current ? { span: current, kind: 'enter' } : null;
	if (current) {
		let atNM = current.enterNM;
		for (const s of spans) {
			if (!Number.isFinite(s.leaveNM) || s.leaveNM > dNM || s.leaveNM <= atNM) {
				continue;
			}
			// The same ladder that resolved the contact, so "who was covering me"
			// and "who wins" cannot drift: leaving a SIV under the FIC points at
			// the SIV's leave row, the handover a pilot actually hears.
			if (outranksContact(s, current)) {
				atNM = s.leaveNM;
				handover = { span: s, kind: 'leave' };
			}
		}
	}
	const edges = [...new Set(spans.flatMap((s) => [s.enterNM, s.leaveNM]))]
		.filter((b) => Number.isFinite(b) && b > dNM)
		.sort((x, y) => x - y);
	for (const b of edges) {
		const t = top(b);
		if ((t?.ev.key ?? '') !== (current?.ev.key ?? '')) {
			return { current, next: t, boundaryNM: b, handover };
		}
	}
	return { current, next: null, boundaryNM: null, handover };
}

/** Absolute schedule row index of the span's ENTER event, by object identity
 *  (spans hold the enter events of the very schedule array they were built
 *  from). Null defensively when the span came from another array. Pure. */
export function contactEnterRowIdx(
	schedule: RouteAirspaceEvent[],
	span: ContactSpan,
): number | null {
	const i = schedule.indexOf(span.ev);
	return i >= 0 ? i : null;
}

/** Absolute schedule row index of the span's LEAVE event: kind 'leave', same
 *  key, atNM equal to the span's leaveNM (the value buildContactSpans copied
 *  from exactly this event; a degenerate equal-atNM re-entry resolves to the
 *  first match, which renders identically). Null while the span is open
 *  (leaveNM Infinity). Pure. */
export function contactLeaveRowIdx(
	schedule: RouteAirspaceEvent[],
	span: ContactSpan,
): number | null {
	if (!Number.isFinite(span.leaveNM)) {
		return null;
	}
	for (let i = 0; i < schedule.length; i++) {
		const ev = schedule[i];
		if (ev.kind === 'leave' && ev.key === span.ev.key && ev.atNM === span.leaveNM) {
			return i;
		}
	}
	return null;
}

export interface AirspaceSpan {
	/** Along-route distance (NM) where the ground track enters the ring. */
	enterNM: number;
	/** Along-route distance (NM) where it leaves (totalNM if it ends inside). */
	leaveNM: number;
}

export interface AirspaceCorridorBand {
	key: string;
	/** Airspace id: matches NOTAM references (activation links join on it);
	 *  `key` addresses one row (the id/key convention). */
	id: string;
	name: string;
	type: string;
	category: AirspaceCategory;
	vLower: VLimit | null;
	vUpper: VLimit | null;
	airClass: string;
	/** The published entry conditions per traffic category
	 *  (Airspace.entry): the forbidden-crossing tier reads them through the
	 *  shared zoneEntryAction. */
	entry: EntryConditions;
	/** The R/D/P designator or ICAO class chip, precomputed. */
	badge: { text: string; kind: 'class' | 'zone' } | null;
	/** One span per disjoint lateral crossing; a route that re-enters a ring
	 *  laterally yields multiple spans. */
	spans: AirspaceSpan[];
}

/** A lateral-only sibling of computeAirspaceSchedule: every airspace whose ring
 *  the ground track crosses (no altitude test), as one band per airspace
 *  carrying its disjoint lateral crossings. Drives the route vertical profile,
 *  where bands are drawn at their floor/ceiling so the pilot sees zones passed
 *  under or over, not just penetrated. FIRs are excluded (scheduleRelevant), as
 *  in the schedule: the whole route is always inside one, so a full-width FIR
 *  band is noise (and would push the chart ceiling to the FIR top). Aerial-
 *  activity zones, SIV sectors and class G airspace are excluded too, as profile
 *  clutter. Pure. */
export function computeAirspaceCorridorSpans(
	waypoints: Waypoint[],
	airspaces: Airspace[],
): AirspaceCorridorBand[] {
	// Altitude unused: the profile shows every laterally-crossed airspace, drawn
	// at its own floor/ceiling so the pilot sees zones passed under or over.
	const samples = sampleRoute(waypoints, 0);
	if (samples.length === 0) {
		return [];
	}
	const totalNM = samples[samples.length - 1].cumNM;

	const box = waypointsBbox(waypoints);
	const candidates = airspaces.filter(
		(a) =>
			scheduleRelevant(a) &&
			// Aerial-activity zones, SIV sectors and class G airspace are clutter on
			// the profile (the schedule still lists SIVs for their radio frequency).
			a.category !== 'activity' &&
			a.category !== 'siv' &&
			a.airClass !== 'G' &&
			bboxesOverlap(box, a.bbox),
	);

	const open = new Map<string, { enterNM: number; a: Airspace }>();
	const bands = new Map<string, AirspaceCorridorBand>();
	const bandFor = (a: Airspace): AirspaceCorridorBand => {
		let bnd = bands.get(a.key);
		if (!bnd) {
			bnd = {
				key: a.key,
				id: a.id,
				name: a.name,
				type: a.type,
				category: a.category,
				vLower: a.vLower,
				vUpper: a.vUpper,
				airClass: a.airClass,
				entry: a.entry,
				badge: airspaceBadge(a),
				spans: [],
			};
			bands.set(a.key, bnd);
		}
		return bnd;
	};

	// Walk the samples, tracking the open span per airspace key. A key present
	// then absent closes a span; absent then present opens one. Lateral re-entry
	// yields multiple spans for one key.
	for (const s of samples) {
		const cur = lateralAt(candidates, s.lat, s.lon);
		for (const [key, a] of cur) {
			if (!open.has(key)) {
				open.set(key, { enterNM: s.cumNM, a });
			}
		}
		const closing: string[] = [];
		for (const [key, o] of open) {
			if (!cur.has(key)) {
				bandFor(o.a).spans.push({ enterNM: o.enterNM, leaveNM: s.cumNM });
				closing.push(key);
			}
		}
		for (const key of closing) {
			open.delete(key);
		}
	}
	// Close spans still open at the route end.
	for (const [, o] of open) {
		bandFor(o.a).spans.push({ enterNM: o.enterNM, leaveNM: totalNM });
	}

	return [...bands.values()];
}

/** Every airspace the route actually flies THROUGH, by `key`: sampled at each
 *  leg's planned altitude and tested both laterally and vertically (activeAt /
 *  inBand), so a zone the ground track passes but the flight clears over or
 *  under in altitude is excluded. Kept across all categories EXCEPT FIR (the
 *  always-enclosing background scheduleRelevant drops); unlike
 *  computeAirspaceCorridorSpans it keeps activity / SIV / class G. Per-route
 *  building block for the "Show only route airspaces" map filter (unioned across
 *  every route by routesAirspaceKeysAtAltitude), which overrides the category
 *  toggles. `defaultAltFt` is the fallback for a waypoint with no finite
 *  altitude. Pure; reuses sampleRoute + activeAt. */
export function routeAirspaceKeysAtAltitude(
	waypoints: Waypoint[],
	airspaces: Airspace[],
	defaultAltFt: number,
	terrain?: TerrainSample[] | null,
): Set<string> {
	const keys = new Set<string>();
	const samples = sampleRoute(waypoints, defaultAltFt);
	if (samples.length === 0) {
		return keys;
	}
	const box = waypointsBbox(waypoints);
	const candidates = airspaces.filter((a) => scheduleRelevant(a) && bboxesOverlap(box, a.bbox));
	const ground = groundAtSamples(samples, terrain);
	for (const [i, s] of samples.entries()) {
		for (const key of activeAt(candidates, s.lat, s.lon, s.altFt, ground?.[i]).keys()) {
			keys.add(key);
		}
	}
	return keys;
}

/** Union of routeAirspaceKeysAtAltitude over several routes' waypoints, each
 *  route sampled at its own per-leg altitudes. Backs the "Show only route
 *  airspaces" map filter, which spans EVERY route, not just the active one.
 *  `terrains`, when given, is parallel to `routeWaypoints` (routeTerrain's
 *  per-route prefetch; null entries fall back to conservative AGL). Pure. */
export function routesAirspaceKeysAtAltitude(
	routeWaypoints: Waypoint[][],
	airspaces: Airspace[],
	defaultAltFt: number,
	terrains?: (TerrainSample[] | null)[] | null,
): Set<string> {
	const keys = new Set<string>();
	for (const [i, waypoints] of routeWaypoints.entries()) {
		for (const key of routeAirspaceKeysAtAltitude(
			waypoints,
			airspaces,
			defaultAltFt,
			terrains?.[i],
		)) {
			keys.add(key);
		}
	}
	return keys;
}

/** Lowest floor (ft AMSL, >0) over the already-filtered Class A candidates whose
 *  ring the leg a->b laterally crosses, or null when it crosses none. Samples the
 *  single leg at STEP_NM (both endpoints included) like the corridor walk. */
function legClassAFloor(a: Waypoint, b: Waypoint, candidates: Airspace[]): number | null {
	if (candidates.length === 0) {
		return null;
	}
	const d = equirectangularDistanceM(a.lat, a.lon, b.lat, b.lon) / NM_TO_METERS;
	const seg = Math.max(1, Math.ceil(d / STEP_NM));
	let floor: number | null = null;
	for (let k = 0; k <= seg; k++) {
		const f = k / seg;
		const lat = a.lat + (b.lat - a.lat) * f;
		const lon = a.lon + (b.lon - a.lon) * f;
		for (const x of candidates) {
			const bx = x.bbox;
			if (lat < bx.minLat || lat > bx.maxLat || lon < bx.minLon || lon > bx.maxLon) {
				continue;
			}
			// Conservative minimum (an AGL Class A floor, unseen in practice,
			// would cap the leg low: the safe direction; metre floors convert).
			const ft = x.vLower ? floorMinFt(x.vLower) : 0;
			// Surface-based Class A (floor <= 0) is skipped: a VFR flight cannot duck
			// under it, so it must not force the leg to 0 ft. Only test the ring when
			// this candidate could actually lower the floor.
			if (ft <= 0 || (floor !== null && ft >= floor)) {
				continue;
			}
			if (pointInRing(lat, lon, x.ring)) {
				floor = ft;
			}
		}
	}
	return floor;
}

/** The lowest Class A floor (ft AMSL) the leg a->b laterally crosses, or null
 *  when it crosses none. Lateral only (no altitude test), so the result can
 *  drive the leg's planned altitude without circularity; surface-based Class A
 *  (floor <= 0) is ignored. Pre-filters to airClass 'A' + the leg's bbox; the
 *  route-wide computeAutoAltitudes pre-filters once and shares legClassAFloor. */
export function classAFloorForLeg(a: Waypoint, b: Waypoint, classA: Airspace[]): number | null {
	const box = waypointsBbox([a, b]);
	const candidates = classA.filter((x) => x.airClass === 'A' && bboxesOverlap(box, x.bbox));
	return legClassAFloor(a, b, candidates);
}

/** The lower vertical limit of the lowest Class A laterally over the point
 *  (lat, lon), or null when none. This is the VFR ceiling there - the altitude /
 *  flight level you must stay below. The lowest is ordered by feet (FL -> x100),
 *  but the original limit is returned so a flight-level floor stays "FL 065" rather
 *  than collapsing to 6500. Surface-based Class A (floor <= 0 ft) is ignored. */
export function classAFloorAt(lat: number, lon: number, airspaces: Airspace[]): VerticalLimit | null {
	let bestFt: number | null = null;
	let best: VerticalLimit | null = null;
	for (const x of airspaces) {
		if (x.airClass !== 'A' || !x.lower || !x.vLower) {
			continue;
		}
		const bx = x.bbox;
		if (lat < bx.minLat || lat > bx.maxLat || lon < bx.minLon || lon > bx.maxLon) {
			continue;
		}
		const ft = floorMinFt(x.vLower);
		if (ft <= 0 || (bestFt !== null && ft >= bestFt)) {
			continue;
		}
		if (pointInRing(lat, lon, x.ring)) {
			bestFt = ft;
			best = x.lower;
		}
	}
	return best;
}

/** The "Classe A 1500" / "Classe A FL 065" label for a Class A floor, matching the
 *  source nav-log format: a flight-level floor stays a flight level, an altitude
 *  shows its bare value. Used by the nav-log notes banner and the YAML `airspace`. */
export function classACeilingLabel(lower: VerticalLimit): string {
	const [, val, uom] = lower;
	// i18n-ignore: 'Classe A ...' is SIA nav-log vocabulary, locale-invariant (docs/i18n.md rule 10)
	return `Classe A ${uom === 'FL' ? `FL ${val}` : val}`;
}

/** Per-leg lowest Class A floor (ft AMSL) the leg laterally crosses under the
 *  VFR rule, or null (no crossing / VFR off / no airspace data). One entry per
 *  leg (waypoints.length - 1). The per-leg cap both computeAutoAltitudes and
 *  the semicircular snap clamp to. Pure. */
export function classAFloorsForLegs(
	waypoints: Waypoint[],
	vfr: boolean,
	classA: Airspace[] | null,
): (number | null)[] {
	const n = waypoints.length;
	if (n < 2) {
		return [];
	}
	// Pre-filter Class A candidates once for the whole route (they're few).
	const candidates: Airspace[] = [];
	if (vfr && classA) {
		const box = waypointsBbox(waypoints);
		for (const x of classA) {
			if (x.airClass === 'A' && bboxesOverlap(box, x.bbox)) {
				candidates.push(x);
			}
		}
	}
	const floors: (number | null)[] = [];
	for (let i = 0; i + 1 < n; i++) {
		floors.push(legClassAFloor(waypoints[i], waypoints[i + 1], candidates));
	}
	return floors;
}

/** Per-leg target altitude (ft) under the VFR Class A rule: each leg defaults to
 *  `defaultFt`, but a leg that laterally crosses Class A while VFR is on is
 *  capped to `min(defaultFt, lowest crossed Class A floor)` (cap only, never
 *  raised). VFR off or no airspace data -> every leg is `defaultFt`. One entry
 *  per leg (waypoints.length - 1). Pure. */
export function computeAutoAltitudes(
	waypoints: Waypoint[],
	vfr: boolean,
	defaultFt: number,
	classA: Airspace[] | null,
): number[] {
	return classAFloorsForLegs(waypoints, vfr, classA).map((floor) =>
		floor !== null && floor < defaultFt ? floor : defaultFt,
	);
}

/** Per-leg answer to "may a transition altitude be in force at this leg's
 *  planned level?" (true = the transition-layer advisory is allowed). France
 *  publishes transition altitudes per TMA only (AIP ENR 1.7), so a leg inside
 *  the French metropolitan FIRs and clear of every controlled terminal volume
 *  flies the en-route regime where no TA, hence no transition layer, exists;
 *  the neighbouring states publish blanket TAs (UK 3000 ft, ES 6000 ft,
 *  US 18000 ft), so any leg not provably in that French regime answers true.
 *  Conservative on every unknown: no airspace data, no French FIR rows, a
 *  border-crossing leg, or an AGL floor without terrain (resolved low by
 *  inBand, i.e. more likely inside) all keep the advisory. The volume test
 *  keys on category 'controlled' (TMA / CTR / CTA / DLG-ATS: the Geneva and
 *  Basel delegated areas are typed DLG-ATS, so a type list would miss them);
 *  a level at or below a floor counts as under the shelf (inBand's strict
 *  floor), the en-route side. One entry per leg. Pure. */
export function transitionAltitudesInForce(
	waypoints: Waypoint[],
	airspaces: Airspace[] | null,
): boolean[] {
	const n = waypoints.length;
	if (n < 2) {
		return [];
	}
	if (!airspaces) {
		return new Array<boolean>(n - 1).fill(true);
	}
	const frFirs = airspaces.filter(
		(a) => a.type === 'FIR' && (firIdent(a)?.startsWith('LF') ?? false),
	);
	if (frFirs.length === 0) {
		return new Array<boolean>(n - 1).fill(true);
	}
	const box = waypointsBbox(waypoints);
	const controlled = airspaces.filter(
		(a) => a.category === 'controlled' && bboxesOverlap(box, a.bbox),
	);
	const out: boolean[] = [];
	for (let i = 0; i + 1 < n; i++) {
		out.push(legTaInForce(waypoints[i], waypoints[i + 1], frFirs, controlled));
	}
	return out;
}

/** One leg of transitionAltitudesInForce: true as soon as any sample leaves
 *  the French FIRs or sits inside a controlled volume at the leg's level. */
function legTaInForce(
	a: Waypoint,
	b: Waypoint,
	frFirs: Airspace[],
	controlled: Airspace[],
): boolean {
	// Per-leg model: the leg flies at its from-waypoint's level.
	const altFt = a.alt;
	const d = equirectangularDistanceM(a.lat, a.lon, b.lat, b.lon) / NM_TO_METERS;
	const seg = Math.max(1, Math.ceil(d / STEP_NM));
	for (let k = 0; k <= seg; k++) {
		const f = k / seg;
		const lat = a.lat + (b.lat - a.lat) * f;
		const lon = a.lon + (b.lon - a.lon) * f;
		if (!insideAnyRing(lat, lon, frFirs)) {
			return true;
		}
		for (const x of controlled) {
			const bx = x.bbox;
			if (lat < bx.minLat || lat > bx.maxLat || lon < bx.minLon || lon > bx.maxLon) {
				continue;
			}
			if (inBand(x, altFt) && pointInRing(lat, lon, x.ring)) {
				return true;
			}
		}
	}
	return false;
}

function insideAnyRing(lat: number, lon: number, list: Airspace[]): boolean {
	for (const x of list) {
		const bx = x.bbox;
		if (lat < bx.minLat || lat > bx.maxLat || lon < bx.minLon || lon > bx.maxLon) {
			continue;
		}
		if (pointInRing(lat, lon, x.ring)) {
			return true;
		}
	}
	return false;
}

/** Where the planned routes sit relative to the French metropolitan FIRs
 *  (the LF-prefixed FIR rows; overseas FIRs carry other prefixes): `inside`
 *  when any sampled point of any route lies within one, `outside` when any
 *  lies beyond them all. Legs are sampled at STEP_NM like the
 *  transition-altitude walk, so a border-hugging leg between two French
 *  waypoints still reports its excursion. Null when the airspace dataset (or
 *  its French FIR rows) is unavailable; the printed-chart zone pick then
 *  falls back to FRANCE. Pure. */
export function frenchFirPresence(
	routesWaypoints: readonly (readonly { lat: number; lon: number }[])[],
	airspaces: Airspace[] | null,
): { inside: boolean; outside: boolean } | null {
	if (!airspaces) {
		return null;
	}
	const frFirs = airspaces.filter(
		(a) => a.type === 'FIR' && (firIdent(a)?.startsWith('LF') ?? false),
	);
	if (frFirs.length === 0) {
		return null;
	}
	let inside = false;
	let outside = false;
	const probe = (lat: number, lon: number): void => {
		if (insideAnyRing(lat, lon, frFirs)) {
			inside = true;
		} else {
			outside = true;
		}
	};
	for (const wps of routesWaypoints) {
		if (wps.length === 1) {
			probe(wps[0].lat, wps[0].lon);
		}
		for (let i = 0; i + 1 < wps.length; i++) {
			const a = wps[i];
			const b = wps[i + 1];
			const d = equirectangularDistanceM(a.lat, a.lon, b.lat, b.lon) / NM_TO_METERS;
			const seg = Math.max(1, Math.ceil(d / STEP_NM));
			for (let k = 0; k <= seg; k++) {
				const f = k / seg;
				probe(a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f);
			}
			if (inside && outside) {
				return { inside, outside };
			}
		}
	}
	return { inside, outside };
}

/** The default transition altitude (ft) when neither an aerodrome nor a
 *  blanket FIR value applies: the common French per-TMA value, printed on
 *  the SIA VFR charts only when a TMA differs (AIP France ENR 1.7). */
export const DEFAULT_TRANSITION_ALT_FT = 5000;

/** Blanket transition altitudes of the neighbouring States, keyed on the
 *  containing FIR's ICAO ident prefix (UK AIP ENR 1.7 "3000 FT except in,
 *  or beneath" the notified TMAs; AIP Espana ENR 1.7 6000 ft nationally,
 *  LE mainland + GC Canaries; 14 CFR 91.121 18 000 ft, the pruatlas KZxx
 *  centres). France is deliberately absent: it publishes TAs per TMA only,
 *  so the 5000 ft default covers it. No GE-prefixed FIR exists (Ceuta /
 *  Melilla sit under GC/LE rows and their aerodromes publish 6000). */
const BLANKET_TA: { prefix: string; valueFt: number; region: string }[] = [
	{ prefix: 'EG', valueFt: 3000, region: 'UK' },
	// Brussels FIR: 4 500 ft AMSL except the Luxembourg TMA (eAIP ENR 1.7);
	// ELLX publishes its own TA in the airports dataset, which wins.
	{ prefix: 'EB', valueFt: 4500, region: 'Belgium' },
	{ prefix: 'LE', valueFt: 6000, region: 'Spain' },
	{ prefix: 'GC', valueFt: 6000, region: 'Spain' },
	{ prefix: 'K', valueFt: 18000, region: 'US' },
];

export interface DerivedTransitionAlt {
	valueFt: number;
	source:
		| { kind: 'aip'; ident: string } // lowest published aerodrome TA
		| { kind: 'blanket'; region: string } // containing-FIR blanket
		| { kind: 'default' }; // DEFAULT_TRANSITION_ALT_FT
}

/** The automatic transition altitude for a set of routes, in three tiers:
 *
 *  1. The LOWEST published TA among the airport-anchored waypoints of every
 *     route (flight levels begin at the lowest TA in play, the planning
 *     convention); ties resolve to the alphabetically first ident so the
 *     provenance is deterministic.
 *  2. No aerodrome TA: the lowest blanket value of the FIR-family rows
 *     containing any waypoint. The candidate set is `firIdent(a) != null`
 *     rows, NOT `type === 'FIR'`: the overlay dedup keeps fr's LECB row
 *     typed UIR (shadowing the es/pruatlas FIR rows), and firIdent spans
 *     the whole FIR / UIR / OCA / ARTCC family.
 *  3. Nothing matched (free-waypoint route in France, no airspace data):
 *     the 5000 ft default.
 *
 *  Pure; the reactive wrapper (state/transitionAlt.svelte.ts) memoises it
 *  and supplies the ident resolver. */
export function derivedTransitionAltFt(
	waypointLists: Waypoint[][],
	taByRefId: (refId: string) => number | null,
	airspaces: Airspace[] | null,
): DerivedTransitionAlt {
	let bestFt = Infinity;
	let bestIdent = '';
	const seen = new Set<string>();
	for (const wps of waypointLists) {
		for (const w of wps) {
			if (w.kind !== 'airport' || !w.refId || seen.has(w.refId)) {
				continue;
			}
			seen.add(w.refId);
			const ta = taByRefId(w.refId);
			if (ta === null || ta <= 0) {
				continue;
			}
			if (ta < bestFt || (ta === bestFt && w.refId < bestIdent)) {
				bestFt = ta;
				bestIdent = w.refId;
			}
		}
	}
	if (bestFt !== Infinity) {
		return { valueFt: bestFt, source: { kind: 'aip', ident: bestIdent } };
	}
	if (airspaces) {
		const firs: { row: Airspace; ident: string }[] = [];
		for (const a of airspaces) {
			const ident = firIdent(a);
			if (ident) {
				firs.push({ row: a, ident });
			}
		}
		let blanket: { valueFt: number; region: string } | null = null;
		for (const wps of waypointLists) {
			for (const w of wps) {
				for (const f of firs) {
					const bx = f.row.bbox;
					if (w.lat < bx.minLat || w.lat > bx.maxLat || w.lon < bx.minLon || w.lon > bx.maxLon) {
						continue;
					}
					if (!pointInRing(w.lat, w.lon, f.row.ring)) {
						continue;
					}
					const entry = BLANKET_TA.find((b) => f.ident.startsWith(b.prefix));
					if (entry && (blanket === null || entry.valueFt < blanket.valueFt)) {
						blanket = { valueFt: entry.valueFt, region: entry.region };
					}
				}
			}
		}
		if (blanket) {
			return { valueFt: blanket.valueFt, source: { kind: 'blanket', region: blanket.region } };
		}
	}
	return { valueFt: DEFAULT_TRANSITION_ALT_FT, source: { kind: 'default' } };
}

/** The national cruising-level regime for a set of routes: `US_REGIME` when
 *  any waypoint lies inside a `K`-prefix FIR ring (the ARTCC family, the same
 *  containment test `derivedTransitionAltFt` uses for the US blanket TA), else
 *  `EU_REGIME`. US and European routes never mix for this app's GA aircraft,
 *  so one regime per route-set is sufficient; the FIR-containment walk mirrors
 *  the TA derivation so the two stay consistent. Pure; the reactive wrapper
 *  (state/cruisingRegime.svelte.ts) memoises it. */
export function cruisingRegimeForRoutes(
	waypointLists: Waypoint[][],
	airspaces: Airspace[] | null,
): CruisingRegime {
	if (!airspaces) {
		return EU_REGIME;
	}
	const usFirs: Airspace[] = [];
	for (const a of airspaces) {
		if (firIdent(a)?.startsWith('K')) {
			usFirs.push(a);
		}
	}
	if (usFirs.length === 0) {
		return EU_REGIME;
	}
	for (const wps of waypointLists) {
		for (const w of wps) {
			for (const a of usFirs) {
				const bx = a.bbox;
				if (w.lat < bx.minLat || w.lat > bx.maxLat || w.lon < bx.minLon || w.lon > bx.maxLon) {
					continue;
				}
				if (pointInRing(w.lat, w.lon, a.ring)) {
					return US_REGIME;
				}
			}
		}
	}
	return EU_REGIME;
}

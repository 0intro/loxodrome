/* The ordered, named, positioned points a route hands anything OUTSIDE this
 * app: SendFPL's route string (sendfpl.ts) and the four interchange files
 * (routeExport.ts). One extraction, so a plan cannot say one thing to a
 * navigator and another to a file.
 *
 * What lives here is what every consumer needs and none of them may decide
 * differently: folding a name to the ASCII alphanumerics an identifier may
 * hold, binding a name to the POSITION it names so a fix visited twice stays
 * one waypoint, dropping the aerodrome two legs share, and chaining a plan's
 * trips while leaving its alternates out. The per-consumer limits stay with
 * their consumer: SendFPL's five-character names are a navigator's, the file
 * writers' six are a Garmin user waypoint's.
 *
 * Pure (no Svelte, no dataset access: the caller answers `knownAerodrome`),
 * so tests/routePoints.spec.ts can pin every rule.
 * Contract: docs/route-files.md, docs/sendfpl.md. */

import { clampLat, wrapLon } from '$lib/format/coord';
import type { Route, Waypoint } from '$lib/state/route.svelte';

/** Longest identifier the interchange files write. Garmin's schema allows
 *  twelve (`[A-Z0-9]{1,12}`), but a user waypoint loaded into a G1000 holds
 *  six, and a name the device truncates is a name two points can end up
 *  sharing. The full name rides beside it in every format that has room. */
export const IDENT_LEN = 6;

/** A route a file can state needs a departure and an arrival. Below this every
 *  writer returns '' rather than a document with one point in it: SendFPL's
 *  own emitter refuses the same thing (joinRoute), and a navigator handed a
 *  one-point plan reports it as corrupt rather than as short. */
export const MIN_POINTS = 2;

/** And the most it may state. Garmin's own cap on the route-points of one
 *  FlightPlan v1 route, which is also the number that tells a flight plan
 *  from a TRACK CONVERTED to one: every GPS tool offers that conversion, and
 *  it yields a legal route file of thousands of points that no pilot flew as
 *  a plan and this app cannot draw as one. Writing stays whole above it (a
 *  navigator handed a plan that stops short of its destination is worse than
 *  one that refuses it); READING refuses, because half a converted track is
 *  not half a plan. */
export const MAX_POINTS = 300;

/** What a database can be expected to resolve as an aerodrome: at most four
 *  characters, all alphanumeric. ICAO's alphabet rather than a navigator's,
 *  so LFPL, KSFO and 0S9 all pass and OurAirports' local codes do not (731
 *  rows in airports.json are AD-ALV, AE-0001 and the like). */
export const AERODROME = /^[A-Z0-9]{1,4}$/;

/** A label or an identifier reduced to what an identifier may hold: ASCII
 *  alphanumerics only, so "Pontcarré" gives PONTC and "Poste électrique du
 *  Chesnay" gives POSTE. Accents fold rather than vanish, which is what keeps
 *  the name readable.
 *
 *  An IDENTIFIER goes through the same fold, no dataset being clean enough to
 *  push raw: it-navaids.json states APS1=COLLE ROIO for a reporting point,
 *  fr-navaids.json LFBC-24-M for a marker, the FAA (LANB). The space alone
 *  would split one point into two tokens in a route string and hand the
 *  arrival aerodrome to ROIO; the rest a navigator refuses outright, and
 *  Garmin's own schema refuses in writing. */
export function foldName(label: string): string {
	return label
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '');
}

/** The text a point wants to be named after: its identifier where it has one,
 *  that being what the pilot reads on the chart and in the nav log, and its own
 *  label otherwise. */
export function nameSource(w: Waypoint): string {
	return foldName((w.kind !== 'free' ? w.ident : undefined) ?? w.label ?? '');
}

/** The name a point is emitted under, claimed as it is chosen, or null when its
 *  source folds to nothing and the position has to speak for itself.
 *
 *  `taken` binds a name to the POSITION it names, not merely to the fact that
 *  the name is in use, because a fix visited twice is one waypoint: an out and
 *  back through Melun emitting MLN and then MLN2 would put two beacons in the
 *  navigator's catalogue for the one. A name already bound to this very
 *  position therefore comes back as it stands, and only a DIFFERENT position
 *  has to move aside, which is the CHW case, one identifier for two places.
 *
 *  Truncation first, because it reads best; then the last characters make room
 *  for a counter. `len` is the consumer's own cap. */
export function takeName(
	base: string,
	position: string,
	taken: Map<string, string>,
	len: number,
): string | null {
	if (base === '') {
		return null;
	}
	const head = base.slice(0, len);
	if ((taken.get(head) ?? position) === position) {
		taken.set(head, position);
		return head;
	}
	for (let n = 2; n < 100; n++) {
		const suffix = String(n);
		const candidate = base.slice(0, len - suffix.length) + suffix;
		if ((taken.get(candidate) ?? position) === position) {
			taken.set(candidate, position);
			return candidate;
		}
	}
	return null;
}

/** The identifier a point may be named by bare, or null when it is not an
 *  aerodrome a database resolves.
 *
 *  An aerodrome identifier is the one identifier that is reliably unique: a
 *  beacon's is not (MLN is Melun and Melilla, CHW is Chartres and a reporting
 *  point 400 km away), which is why only this one is ever claimed as more than
 *  a name. A field the caller knows will NOT resolve (closed, or listed under a
 *  code that is no location indicator) is not one either. */
export function aerodromeIdent(w: Waypoint, known: (ident: string) => boolean): string | null {
	if (w.kind !== 'airport') {
		return null;
	}
	const ident = w.ident?.toUpperCase();
	return ident !== undefined && AERODROME.test(ident) && known(ident) ? ident : null;
}

/** Two positions within this are one place under one identifier: the AIXM
 *  overlay replacing an OurAirports row moves an ARP by metres, and the two
 *  CHW (Chartres, and the CH-W reporting point) sit 400 km apart.
 *
 *  Exported for the READING direction, where it answers the same question
 *  from the other side: an identifier a foreign file states is accepted only
 *  when the app's own data puts it where the file does
 *  (state/routeLoad.svelte.ts, docs/route-files.md). */
export const SAME_PLACE_NM = 2;

/** Rough great-circle distance, good to a fraction of a percent over the
 *  distances it is asked about. Takes bare positions, so a waypoint and a
 *  file's own coordinates can be compared without building either. */
export function distanceNM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
	const dLat = a.lat - b.lat;
	const dLon = (a.lon - b.lon) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
	return Math.hypot(dLat, dLon) * 60;
}

/** Whether two consecutive waypoints are one place, so the aerodrome two legs
 *  share is written once. An ANCHORED point is its identifier at (about) its
 *  position: the label and the exact coordinates come from whichever dataset
 *  merge resolved it, and the AIXM overlay replacing the baseline row moves
 *  both by a hair between one leg's typing and the next's, so neither may
 *  break the match; but one identifier does name two places (CHW), and 400 km
 *  is not a hair. A free point is its emitted name at its emitted position,
 *  the caller's `positionKey` deciding how finely position is read. */
export function samePlace(
	a: Waypoint,
	b: Waypoint,
	positionKey: (w: Waypoint) => string,
): boolean {
	if (a.kind !== b.kind) {
		return false;
	}
	if (a.kind !== 'free' && a.ident && b.ident) {
		return a.ident.toUpperCase() === b.ident.toUpperCase() && distanceNM(a, b) < SAME_PLACE_NM;
	}
	return foldName(a.label ?? '') === foldName(b.label ?? '') && positionKey(a) === positionKey(b);
}

/** Drop a waypoint that repeats the one before it: the aerodrome two legs
 *  share, or the same fix entered twice in a row. A genuine there and back
 *  repeats no place in a row.
 *
 *  `merge` decides what the survivor keeps of the repeat. Nothing, by default:
 *  the two are one place and a route string says no more about it. The file
 *  writers pass one, because the junction's OUTBOUND leg is the second row's,
 *  and its altitude is the one the next leg is flown at. */
export function dedupeAdjacent(
	waypoints: readonly Waypoint[],
	positionKey: (w: Waypoint) => string,
	merge?: (kept: Waypoint, repeat: Waypoint) => Waypoint,
): Waypoint[] {
	const out: Waypoint[] = [];
	for (const w of waypoints) {
		const last = out.length - 1;
		if (out.length > 0 && samePlace(out[last], w, positionKey)) {
			if (merge) {
				out[last] = merge(out[last], w);
			}
			continue;
		}
		out.push(w);
	}
	return out;
}

/** Every trip's waypoints in list order, as one route. Alternates are
 *  diversions, not part of the flight as flown, so they are left out, and so
 *  is a route short of a leg (a scratch point is no trip, and chaining it
 *  would move the plan's arrival off the true destination). The adjacent
 *  repeat is dropped by the emitter (the aerodrome two legs share; the
 *  junction rule routesFileBaseName already applies to the save filename). */
export function planWaypoints(list: readonly Route[]): Waypoint[] {
	const out: Waypoint[] = [];
	for (const route of list) {
		if (route.alternate || route.waypoints.length < 2) {
			continue;
		}
		out.push(...route.waypoints);
	}
	return out;
}

// --- The point model the file writers share --------------------------------

/** One point of a route as a file states it. Every field is resolved once,
 *  here, so the four writers cannot disagree about a name, an identifier or
 *  an altitude. */
export interface RoutePoint {
	/** The identifier the file writes: A-Z0-9, at most `identLen`, unique
	 *  within this route per PLACE (a fix visited twice keeps one). */
	ident: string;
	/** The published identifier (ICAO location indicator, navaid ident) as the
	 *  dataset states it, or null for a free point. Unfolded: it is what the
	 *  pilot reads, not what a file may hold. */
	code: string | null;
	/** True when `code` is an aerodrome identifier a database resolves, which
	 *  is the one case a file may claim more than a user waypoint. */
	aerodrome: boolean;
	/** What a human reads: the site's own name where there is one ("LOGNES
	 *  EMERAINVILLE", "L'obélisque"), else the identifier, else the position. */
	name: string;
	/** Degrees, clamped and wrapped: a point dropped on a panned world copy
	 *  carries Leaflet's raw longitude, which runs past 180. */
	lat: number;
	lon: number;
	/** Planned altitude of the leg LEAVING this point, ft AMSL. Null on the
	 *  last point, which has no leg to state: the app's per-leg model stores a
	 *  leg's altitude on the waypoint it leaves. */
	altFt: number | null;
}

export interface RoutePointOptions {
	/** Whether the consumer's database can be expected to hold an aerodrome
	 *  identifier. The caller answers from the airports dataset; the default
	 *  trusts every well-shaped identifier, the pure module's own knowledge. */
	knownAerodrome?: (ident: string) => boolean;
	/** Identifier cap, `IDENT_LEN` by default. */
	identLen?: number;
}

/** Position as an identity key: six decimals, which is a tenth of a metre.
 *  Only points that truly coincide read as one place. */
function positionKey(w: Waypoint): string {
	return `${clampLat(w.lat).toFixed(6)},${wrapLon(w.lon).toFixed(6)}`;
}

/** The site's own name, which is what a file shows beside the identifier.
 *
 *  A point with neither is named after where it IS, and that has to be the
 *  position the file states: a waypoint dropped on a panned world copy
 *  carries Leaflet's raw longitude, and naming it "48.821, 362.623" beside a
 *  written 2.623 would print two different places for one point. */
function siteName(w: Waypoint): string {
	const label = w.label?.trim();
	if (label) {
		return label;
	}
	const ident = w.kind !== 'free' ? w.ident?.trim() : undefined;
	return ident ? ident : `${clampLat(w.lat).toFixed(3)}, ${wrapLon(w.lon).toFixed(3)}`;
}

/** The leg altitude a point states, or null when it states none. */
function legAltFt(w: Waypoint, last: boolean): number | null {
	return last || !Number.isFinite(w.alt) ? null : Math.round(w.alt);
}

/** One route as the points a file writes.
 *
 *  Identifiers are claimed in three passes over the WHOLE route rather than
 *  per point, because a name is only free once nothing else wants it: the
 *  aerodromes take their own identifiers first (an ICAO code is what the pilot
 *  reads and what a database resolves), then the other published identifiers,
 *  so a free point the pilot called MLN cannot take the name the beacon
 *  further down the route is about to want, and only then does every point
 *  fall back to its folded label. A binding is never rewritten, so the last
 *  pass reaches the same answers as the first two. */
export function routeExportPoints(
	waypoints: readonly Waypoint[],
	opts: RoutePointOptions = {},
): RoutePoint[] {
	const known = opts.knownAerodrome ?? ((): boolean => true);
	const len = opts.identLen ?? IDENT_LEN;
	// The junction of two trips is one point, and the leg leaving it is the
	// second row's: that is the altitude the next leg is flown at.
	const points = dedupeAdjacent(waypoints, positionKey, (kept, repeat) => ({
		...kept,
		alt: repeat.alt,
		altAuto: repeat.altAuto,
	}));
	const at = points.map(positionKey);
	const aero = points.map((w) => aerodromeIdent(w, known));

	const taken = new Map<string, string>();
	for (const [i, ident] of aero.entries()) {
		if (ident !== null && !taken.has(ident)) {
			taken.set(ident, at[i]);
		}
	}
	/* The aerodrome identifier this point may keep. A dataset holding one
	 * identifier at two positions (a stale baseline row beside its AIXM
	 * replacement) would otherwise put two rows under one name in the file,
	 * which Garmin's schema refuses outright: the second is demoted to an
	 * ordinary user waypoint and takes a folded name like any other point. */
	const claimed = (i: number): string | null => {
		const ident = aero[i];
		return ident !== null && taken.get(ident) === at[i] ? ident : null;
	};
	for (const [i, w] of points.entries()) {
		if (claimed(i) === null && w.kind !== 'free') {
			takeName(nameSource(w), at[i], taken, len);
		}
	}

	const last = points.length - 1;
	return points.map((w, i) => {
		const code = w.kind !== 'free' ? (w.ident?.trim().toUpperCase() ?? null) : null;
		// A point whose name folds to nothing (an unnamed free point) is still
		// referenced by identifier in every format, so it is given one.
		const ident =
			claimed(i) ??
			takeName(nameSource(w), at[i], taken, len) ??
			takeName(`WP${i + 1}`, at[i], taken, len) ??
			`WP${i + 1}`.slice(0, len);
		return {
			ident,
			code: code === '' ? null : code,
			aerodrome: claimed(i) !== null,
			name: siteName(w),
			lat: clampLat(w.lat),
			lon: wrapLon(w.lon),
			altFt: legAltFt(w, i === last),
		};
	});
}

/** The level each point is FLOWN at: its own outbound leg's, and for the
 *  arrival the level it arrives on, since it has no leg of its own to state.
 *
 *  A format that draws the route in space needs a number there: KML reads a
 *  coordinate with no altitude as sea level and a simulator reads a zero the
 *  same way, so both would dive the last leg into the ground, which is what
 *  SDVFR's own files do. The formats that can simply say nothing (GPX's
 *  optional <ele>) say nothing instead and read `altFt` directly. */
export function levelsFlown(points: readonly RoutePoint[]): (number | null)[] {
	const levels = points.map((p) => p.altFt);
	const last = levels.length - 1;
	if (last > 0 && levels[last] == null) {
		levels[last] = levels[last - 1];
	}
	return levels;
}

/** The whole plan as one route's points, so a plan of one trip is exactly
 *  that trip. */
export function planExportPoints(
	list: readonly Route[],
	opts: RoutePointOptions = {},
): RoutePoint[] {
	return routeExportPoints(planWaypoints(list), opts);
}

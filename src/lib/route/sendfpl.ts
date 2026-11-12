/* The route string SendFPL takes, built from a drawn route or from the whole
 * plan. SendFPL (the sibling `sendfpl` project, app.sendfpl, built on the
 * flight plan encoder recovered in `garmin-cxp`) uploads an ARINC 702A route
 * to a GPS 175 / GNC 355 / GNX 375 over Connext; it accepts a route shared as
 * text and parses it with its own RouteParser. This module writes exactly what
 * that parser reads, and nothing more: the pilot reviews the route in SendFPL's
 * own box before anything reaches the aircraft.
 *
 * EVERY point carries its position, `MLN,N48273E002488`, except the two ends
 * when they are aerodromes SendFPL will read as such. A bare identifier is not
 * enough, and that was measured: a GPS 175 answered "flight plan contains
 * unknown waypoints" to `:F:MLN` and imported `:F:MLN,N48273E002488`, drawing
 * it as the Melun VOR-DME it had in its database all along. Garmin's own
 * guideline makes the coordinates optional for a database waypoint only
 * "unless there are duplicate waypoints with that same identifier", MLN
 * collides with Melilla, and nothing here can know what a navigator holds.
 * This app's own data says the same: fr-navaids.json answers CHW for the
 * Chartres VOR-DME and for the CH-W reporting point both, 400 km apart. Sending
 * both is always safe, the `:F:` handler making no database decision of its
 * own: it records the name and the coordinates and lets the resolver choose.
 *
 * What a route's points ARE (the fold, the position-bound naming, the shared
 * aerodrome, the plan's trips) is route/routePoints.ts, shared with the files
 * routeExport.ts writes; what stays here is what SendFPL alone imposes.
 *
 * Contract, caps and provenance: docs/sendfpl.md. Pure, so tests/sendfpl.spec.ts
 * can pin every token shape against the grammar SendFPL publishes. */

import { clampLat, wrapLon } from '$lib/format/coord';
import type { Route, Waypoint } from '$lib/state/route.svelte';
import {
	aerodromeIdent,
	dedupeAdjacent,
	nameSource,
	planWaypoints,
	takeName,
} from './routePoints';

/** Longest user-waypoint name the navigator reads back (SendFPL's
 *  WAYPOINT_NAME_LEN). Its `:F:` handler stops after this many characters and
 *  then fails to find the comma before the position, so an over-long name costs
 *  the point its coordinates and marks the whole upload malformed. */
const NAME_LEN = 5;

/** Whole degrees and tenths of a minute, as the navigator's own encoder does it
 *  (`dls_format_posn_to_str`): degrees truncate and the tenths round half away
 *  from zero, deliberately not carried into the degrees when they reach 600. */
function splitDegrees(value: number): [number, number] {
	const magnitude = Math.abs(value);
	const degrees = Math.trunc(magnitude);
	return [degrees, Math.floor((magnitude - degrees) * 600 + 0.5)];
}

/** A position as the 13-character ARINC user-waypoint string: 48.82 N, 2.62 E
 *  is `N48492E002372`. This is the form SendFPL echoes and puts on the wire, so
 *  what the pilot reads in its route box is what the navigator receives.
 *
 *  The longitude is wrapped into [-180, 180) first: a waypoint dropped on the
 *  map carries Leaflet's raw longitude, which runs past 180 on the world copy
 *  the user panned onto (format/coord.ts), and SendFPL's own decoder throws
 *  `LongitudeOutOfRange` on `E362372`, refusing the whole route for a point
 *  this app draws happily. */
export function formatArincLatLon(lat: number, lon: number): string {
	const la = clampLat(lat);
	const lo = wrapLon(lon);
	const [latDeg, latTenths] = splitDegrees(la);
	const [lonDeg, lonTenths] = splitDegrees(lo);
	return (
		(la >= 0 ? 'N' : 'S') +
		String(latDeg).padStart(2, '0') +
		String(latTenths).padStart(3, '0') +
		(lo >= 0 ? 'E' : 'W') +
		String(lonDeg).padStart(3, '0') +
		String(lonTenths).padStart(3, '0')
	);
}

/** What the emitter may assume about an aerodrome identifier beyond its
 *  shape: whether the navigator's database can be expected to hold it. The
 *  caller answers from the airports dataset (a CLOSED field, or one the
 *  dataset lists under a local code that is no location indicator, is not
 *  something a Garmin database resolves); the default trusts every
 *  well-shaped identifier, the pure module's own knowledge. */
export interface SendFplOptions {
	knownAerodrome?: (ident: string) => boolean;
}

/** The tokens the emitted route contributes, in order.
 *
 *  Takes the WHOLE route rather than one leg, because being an end is a
 *  property of the finished list: the aerodrome joining two trips of a plan
 *  sits in the middle of what SendFPL parses, and one name space has to cover
 *  the lot or two legs would give one name to two different places. */
function routeTokens(waypoints: readonly Waypoint[], opts: SendFplOptions): string[] {
	const known = opts.knownAerodrome ?? (() => true);
	// SendFPL's own identity for a position is the token it echoes, tenths of a
	// minute: two free points a hundred metres apart under one name are one
	// place to a navigator that cannot state the difference.
	const points = dedupeAdjacent(waypoints, (w) => formatArincLatLon(w.lat, w.lon));
	const last = points.length - 1;
	const at = points.map((w) => formatArincLatLon(w.lat, w.lon));
	// Only an END may be sent bare, and only an aerodrome: SendFPL takes the first
	// and last tokens as the departure and the arrival, an aerodrome identifier is
	// the one identifier that is reliably unique, and a bare LFPL is what the pilot
	// reads in its box. A beacon at an end is not exempt from any of the above:
	// `:F:MLN` is the very token the navigator refused, and a route may perfectly
	// well start on one. A field the caller knows the navigator will NOT resolve
	// (closed, or listed under a code that is no location indicator) carries its
	// position too: a bare identifier the database lacks loads the plan short of
	// its arrival. routePoints.ts applies both tests (aerodromeIdent).
	const bare = points.map((w, i) => (i === 0 || i === last ? aerodromeIdent(w, known) : null));

	// The ends claim their bare identifier first, since it is also a name the
	// rest of the route must not shadow; then every other identifier claims its
	// own, ahead of any label, so a free point the pilot called MLN cannot take
	// the name the beacon further down the route is about to want. A binding is
	// never rewritten, so the pass below reaches the same answers.
	const taken = new Map<string, string>();
	for (const [i, ident] of bare.entries()) {
		if (ident !== null && !taken.has(ident)) {
			taken.set(ident, at[i]);
		}
	}
	for (const [i, w] of points.entries()) {
		if (bare[i] === null && w.kind !== 'free') {
			takeName(nameSource(w), at[i], taken, NAME_LEN);
		}
	}

	const tokens = points.map((w, i) => {
		const ident = bare[i];
		if (ident !== null) {
			return ident;
		}
		const name = takeName(nameSource(w), at[i], taken, NAME_LEN);
		return name === null ? at[i] : `${name},${at[i]}`;
	});
	// Two different waypoints can still emit one token (two free points folding
	// to one name at one position); the navigator would read a zero-length leg.
	return tokens.filter((t, i) => i === 0 || t !== tokens[i - 1]);
}

/** Join tokens into the route string SendFPL parses, or '' when there is no
 *  route to send: its parser wants a departure and an arrival. */
function joinRoute(tokens: readonly string[]): string {
	return tokens.length >= 2 ? tokens.join(' ') : '';
}

/** One route, as SendFPL's route box reads it. */
export function buildSendFplRoute(waypoints: readonly Waypoint[], opts: SendFplOptions = {}): string {
	return joinRoute(routeTokens(waypoints, opts));
}

/** The whole plan as one route, through the same emitter, so a plan of one trip
 *  is exactly that trip. */
export function buildSendFplPlan(list: readonly Route[], opts: SendFplOptions = {}): string {
	return joinRoute(routeTokens(planWaypoints(list), opts));
}

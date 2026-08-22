/* The route string SendFPL takes, built from a drawn route or from the whole
 * plan. SendFPL (the sibling garmin-cxp project, app.sendfpl) uploads an ARINC
 * 702A route to a GPS 175 / GNC 355 / GNX 375 over Connext; it accepts a route
 * shared as text and parses it with its own RouteParser. This module writes
 * exactly what that parser reads, and nothing more: the pilot reviews the route
 * in SendFPL's own box before anything reaches the aircraft.
 *
 * Contract, caps and provenance: docs/sendfpl.md. Pure, so tests/sendfpl.spec.ts
 * can pin every token shape against the grammar SendFPL publishes. */

import type { Route, Waypoint } from '$lib/state/route.svelte';

/** Longest user-waypoint name the navigator reads back (SendFPL's
 *  WAYPOINT_NAME_LEN). Its `:F:` handler stops after this many characters and
 *  then fails to find the comma before the position, so an over-long name costs
 *  the point its coordinates and marks the whole upload malformed. */
const NAME_LEN = 5;

/** SendFPL's airway heuristic: a letter or two then digits (V334, UL9, Q13).
 *  A NAVAID named that way would be sent as an airway, so those few (WM801,
 *  HW806, IM261, G20A, RW08 across the loaded datasets) carry their position
 *  instead; there is a prefix that forces an airway, none that forces a
 *  waypoint. Airports are exempt: thousands of local codes are this shape
 *  (A05, AA00), and an airport has to stay a bare identifier because SendFPL's
 *  `:DA:` / `:AA:` take one and will not take a position. */
const AIRWAY = /^[A-Z]{1,2}\d{1,3}[A-Z]?$/;

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
 *  what the pilot reads in its route box is what the navigator receives. */
export function formatArincLatLon(lat: number, lon: number): string {
	const [latDeg, latTenths] = splitDegrees(lat);
	const [lonDeg, lonTenths] = splitDegrees(lon);
	return (
		(lat >= 0 ? 'N' : 'S') +
		String(latDeg).padStart(2, '0') +
		String(latTenths).padStart(3, '0') +
		(lon >= 0 ? 'E' : 'W') +
		String(lonDeg).padStart(3, '0') +
		String(lonTenths).padStart(3, '0')
	);
}

/** A waypoint label reduced to what a user-waypoint name may hold: ASCII
 *  alphanumerics only (`dls_str_is_alphanum_or_delims` rejects the rest), so
 *  "Pontcarré" gives PONTC and "Poste électrique du Chesnay" gives POSTE.
 *  Accents fold rather than vanish, which is what keeps the name readable. */
function foldName(label: string): string {
	return label
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '');
}

/** A free name that is unique in the route, or null when none can be found.
 *  Truncation first, because it reads best; then the last characters make room
 *  for a counter. `taken` holds every anchored identifier too, since colliding
 *  with an airport or a navaid would be no better than colliding with a name. */
function fitName(base: string, taken: ReadonlySet<string>): string | null {
	if (base === '') {
		return null;
	}
	const head = base.slice(0, NAME_LEN);
	if (!taken.has(head)) {
		return head;
	}
	for (let n = 2; n < 100; n++) {
		const suffix = String(n);
		const candidate = base.slice(0, NAME_LEN - suffix.length) + suffix;
		if (!taken.has(candidate)) {
			return candidate;
		}
	}
	return null;
}

/** The tokens one route contributes, in order.
 *
 *  An anchored waypoint goes by identifier: the navigator resolves it against
 *  its own database, which beats pinning it to whatever coordinate we hold. A
 *  free point is in no database, so it carries its position, under its own name
 *  when the label folds to something the navigator can read back, bare
 *  otherwise. */
function routeTokens(waypoints: readonly Waypoint[]): string[] {
	const taken = new Set<string>();
	for (const w of waypoints) {
		if (w.kind !== 'free' && w.ident) {
			taken.add(w.ident.toUpperCase());
		}
	}
	const out: string[] = [];
	for (const w of waypoints) {
		const ident = w.kind !== 'free' ? w.ident?.toUpperCase() : undefined;
		if (ident && (w.kind === 'airport' || !AIRWAY.test(ident))) {
			out.push(ident);
			continue;
		}
		// Either a free point, or a navaid whose identifier the parser would read
		// as an airway. Both carry their position, and take a name when one fits;
		// an identifier that already fits keeps itself.
		const position = formatArincLatLon(w.lat, w.lon);
		const name =
			ident !== undefined
				? ident.length <= NAME_LEN
					? ident
					: fitName(ident, taken)
				: fitName(foldName(w.label ?? ''), taken);
		if (name === null) {
			out.push(position);
			continue;
		}
		taken.add(name);
		out.push(`${name},${position}`);
	}
	return out;
}

/** Join tokens into the route string SendFPL parses, or '' when there is no
 *  route to send: its parser wants a departure and an arrival. */
function joinRoute(tokens: readonly string[]): string {
	return tokens.length >= 2 ? tokens.join(' ') : '';
}

/** One route, as SendFPL's route box reads it. */
export function buildSendFplRoute(waypoints: readonly Waypoint[]): string {
	return joinRoute(routeTokens(waypoints));
}

/** The whole plan as one route: every trip in list order (alternates are
 *  diversions, not part of the flight as flown), with the aerodrome shared
 *  between consecutive legs written once, the junction rule routesFileBaseName
 *  already applies to the save filename. */
export function buildSendFplPlan(list: readonly Route[]): string {
	const out: string[] = [];
	for (const route of list) {
		if (route.alternate) {
			continue;
		}
		for (const token of routeTokens(route.waypoints)) {
			if (out[out.length - 1] !== token) {
				out.push(token);
			}
		}
	}
	return joinRoute(out);
}

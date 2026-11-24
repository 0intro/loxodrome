/* The distance profiles' right-click stack (RouteProfileModal,
 * NavProfileModal): the airspace and NOTAM bands under the cursor, and what
 * the menu says when that stack is empty. Pure, so both modals give the
 * same answer. */

import type { AirspaceCorridorBand } from '$lib/route/airspaces';
import type { NotamCorridorBand } from '$lib/route/notamProfile';
import { exactFt, type VLimit } from '$lib/vertical/limits';

/** One NOTAM row of the stack: the notams-dataset index for the click
 *  callback and the F)/G) extent (known=false renders the dash, the
 *  unknown-extent convention). */
export interface StackNotamRow {
	id: string;
	index: number;
	vLower: VLimit | null;
	vUpper: VLimit | null;
	known: boolean;
}

/** Where the menu was asked for: the distance and altitude under the
 *  cursor, and the ground there, low end for a floor and high end for a
 *  ceiling, as the drawn band resolves each edge. */
export interface StackPoint {
	distNM: number;
	altFt: number;
	floorGroundFt: number | null;
	ceilGroundFt: number | null;
}

export interface ProfileStack {
	/** The drawn airspace bands containing the point, floor up. */
	bands: AirspaceCorridorBand[];
	notams: StackNotamRow[];
	/** `bands` is empty, and the point sits below every charted floor at
	 *  this distance: the pilot's conclusion is Classe G. */
	belowCharted: boolean;
	/** `bands` is empty, and a band the pilot's filter hid contains the
	 *  point. */
	hiddenHere: boolean;
}

const SPAN_EPS_NM = 1e-6;

/** The stack at `at`. `shown` is the chart's band set and `all` the walk's
 *  whole one, UNGATED: "Classe G (uncharted)" is an assertion about the AIP,
 *  and an absence the pilot's own filter created must be said as one. The
 *  FIS sectors take no part in the empty row's wording: a sector is a
 *  service, never a class, and one under a TMA leaves the airspace below
 *  its floor class G. */
export function profileStackAt(
	at: StackPoint,
	shown: readonly AirspaceCorridorBand[],
	all: readonly AirspaceCorridorBand[],
	notamBands: readonly NotamCorridorBand[],
): ProfileStack {
	const atDistance = (b: { spans: readonly { enterNM: number; leaveNM: number }[] }): boolean =>
		b.spans.some((s) => at.distNM >= s.enterNM - SPAN_EPS_NM && at.distNM <= s.leaveNM + SPAN_EPS_NM);
	const floorFt = (l: VLimit | null): number =>
		l ? (exactFt(l, at.floorGroundFt) ?? l.ft) : Number.NEGATIVE_INFINITY;
	const ceilingFt = (l: VLimit | null): number =>
		l ? (exactFt(l, at.ceilGroundFt) ?? l.ft) : Number.POSITIVE_INFINITY;
	const contains = (b: { vLower: VLimit | null; vUpper: VLimit | null }): boolean =>
		at.altFt >= floorFt(b.vLower) && at.altFt <= ceilingFt(b.vUpper);

	const bands = shown
		.filter((b) => atDistance(b) && contains(b))
		.sort((a, b) => floorFt(a.vLower) - floorFt(b.vLower));
	// An unknown-extent NOTAM band (dashed full-height) matches at any
	// altitude over its span.
	const notams = notamBands
		.filter((b) => atDistance(b) && (!b.knownExtent || contains(b)))
		.map((b) => ({ id: b.id, index: b.index, vLower: b.vLower, vUpper: b.vUpper, known: b.knownExtent }));
	const over = all.filter((b) => b.category !== 'siv' && atDistance(b));
	const empty = bands.length === 0;
	return {
		bands,
		notams,
		// A null floor reads SFC, so such a band would have contained the point.
		belowCharted:
			empty && over.length > 0 && over.every((b) => b.vLower != null && at.altFt < floorFt(b.vLower)),
		hiddenHere: empty && over.some(contains),
	};
}

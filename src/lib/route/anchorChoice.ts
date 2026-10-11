/* Which feature an identifier names, decided by the route around it.
 *
 * An identifier is not unique. The worldwide aerodrome baseline files about
 * 120 airports under the identifier of a navaid more than 50 NM away: BOV is
 * the Beauvais-Tille VOR-DME and Boang Airport in Papua New Guinea, KCIR is
 * Calvi's IR reporting point and Cairo Regional in Illinois. Several hundred
 * more are filed by two publishers (ROA: the Roanne VOR and the Roanoke DME)
 * or twice by one (CHW: the Chartres VOR-DME and a reporting point near
 * Arcachon). Answering the first feature in the datasets, as a lone token
 * must, put those waypoints on the wrong continent with nothing to say so.
 *
 * A route says where it is. Its identifiers are resolved together: each one
 * naming a single feature is that feature, and among several the choice is
 * the one making the shortest route through its neighbours, weighed over
 * the whole route at once (a shortest path through the candidates, so a run
 * of ambiguous points before the first certain one is still placed by it).
 * Two rules keep that from overreaching:
 *   - one PLACE filed twice is one candidate: an aerodrome and the reporting
 *     point the DFS files under its own identifier, metres apart, stay the
 *     aerodrome (the earlier in the resolver's airports-first order wins);
 *   - an aerodrome is preferred by PREFERENCE_NM: a destination typed as an
 *     aerodrome's identifier stays that aerodrome unless the route is shorter
 *     by more than that through another feature of the same name ("LFLP LFEA"
 *     is Annecy to Belle-Ile, not to the LP-EA reporting point beside Annecy,
 *     while "LFLP LFEA LFLB" passes the reporting point). The committed
 *     data's 120 aerodrome-against-navaid collisions split cleanly around
 *     it: six are regional (128 to 446 NM) and keep the aerodrome as a
 *     destination, as before; the other 114 are 530 NM apart or more, and
 *     resolve inside the route that passes them.
 * Pure: tests/anchorChoice.spec.ts, and on the committed data
 * tests/anchorChoiceData.spec.ts. */

import { greatCircleDistanceM } from '$lib/notam/geometry';
import type { LatLon } from '$lib/notam/types';
import { NM_TO_METERS } from '$lib/notam/units';
import type { LoadedWaypoint } from '$lib/route/yaml';
import type { WaypointAnchor } from '$lib/state/route.svelte';
import { SAME_PLACE_NM } from './routePoints';

/** A token resolver as the route builders take it. The call answers one
 *  feature for an identifier, the first in airports-first order, which is all
 *  a lone token can be told; `candidates`, when the resolver can list them,
 *  answers every feature filed under it, in that same order. A resolver
 *  without `candidates` (a test stub, an importer's own confirmed answers) is
 *  taken at its word. */
export interface WaypointResolver {
	(token: string): WaypointAnchor | null;
	candidates?: ((token: string) => readonly WaypointAnchor[]) | undefined;
}

/** A feature a point is already known to name: the one the pilot picked, or
 *  the position a file states beside the identifier. A candidate with the
 *  same kind and refId is kept, else the nearest within SAME_PLACE_NM; when
 *  neither is among the candidates any more, the route decides. */
export interface AnchorKeep {
	lat: number;
	lon: number;
	kind?: WaypointAnchor['kind'] | undefined;
	refId?: string | undefined;
}

/** One point of a route: an identifier to resolve, a free point fixed at its
 *  own position, or nothing to weigh (a name-only point, placed later by dead
 *  reckoning; the route is joined across it). */
export type AnchorItem =
	| { ident: string; keep?: AnchorKeep | undefined }
	| { lat: number; lon: number }
	| null;

/** How much shorter a route must be through another feature of an
 *  aerodrome's identifier for that feature to win over the aerodrome. Above
 *  every regional collision in the data (the largest, Torino's LIMA against
 *  the EDDV LIMA reporting point, 446 NM) and below every distant one (the
 *  nearest, the same LIMA against EDHL's, 530 NM). */
export const PREFERENCE_NM = 500;

function distNM(a: LatLon, b: LatLon): number {
	return greatCircleDistanceM(a.lat, a.lon, b.lat, b.lon) / NM_TO_METERS;
}

function candidatesOf(ident: string, resolve: WaypointResolver): WaypointAnchor[] {
	if (resolve.candidates) {
		return [...resolve.candidates(ident)];
	}
	const one = resolve(ident);
	return one ? [one] : [];
}

function applyKeep(cands: WaypointAnchor[], keep: AnchorKeep | undefined): WaypointAnchor[] {
	if (!keep) {
		return cands;
	}
	if (keep.refId !== undefined) {
		const same = cands.find(
			(c) => c.refId === keep.refId && (keep.kind === undefined || c.kind === keep.kind),
		);
		if (same) {
			return [same];
		}
	}
	let best: WaypointAnchor | null = null;
	let bestNM = Infinity;
	for (const c of cands) {
		const d = distNM(c, keep);
		if (d <= SAME_PLACE_NM && d < bestNM) {
			best = c;
			bestNM = d;
		}
	}
	return best ? [best] : cands;
}

/** One place filed twice is one candidate, the earlier in the resolver's
 *  order (airports first). */
function mergePlaces(cands: WaypointAnchor[]): WaypointAnchor[] {
	const out: WaypointAnchor[] = [];
	for (const c of cands) {
		if (!out.some((o) => distNM(o, c) <= SAME_PLACE_NM)) {
			out.push(c);
		}
	}
	return out;
}

interface Layer {
	/** The item this layer answers, or null for a free point. */
	index: number | null;
	nodes: LatLon[];
	anchors: WaypointAnchor[] | null;
	unary: number[];
}

/** The feature each identifier item names, null for the other items and for
 *  an identifier nothing is filed under. `near` (the map centre, for typed
 *  text) decides only a route with no certain point at all: once one point is
 *  certain, the route alone does. */
export function chooseAnchors(
	items: readonly AnchorItem[],
	resolve: WaypointResolver,
	near?: LatLon | null,
): (WaypointAnchor | null)[] {
	const out: (WaypointAnchor | null)[] = items.map(() => null);
	const layers: Layer[] = [];
	for (let i = 0; i < items.length; i++) {
		const it = items[i];
		if (it === null) {
			continue;
		}
		if ('ident' in it) {
			const cands = mergePlaces(applyKeep(candidatesOf(it.ident, resolve), it.keep));
			if (cands.length === 0) {
				continue;
			}
			const airport = cands.some((c) => c.kind === 'airport');
			layers.push({
				index: i,
				nodes: cands,
				anchors: cands,
				unary: cands.map((c) => (airport && c.kind !== 'airport' ? PREFERENCE_NM : 0)),
			});
		} else {
			layers.push({ index: null, nodes: [{ lat: it.lat, lon: it.lon }], anchors: null, unary: [0] });
		}
	}
	if (layers.every((l) => l.nodes.length === 1)) {
		for (const l of layers) {
			if (l.index !== null && l.anchors) {
				out[l.index] = l.anchors[0];
			}
		}
		return out;
	}
	// A shortest path through the candidates, layer by layer; strict
	// comparisons, so a tie goes to the earlier candidate.
	const anchorless = !layers.some((l) => l.nodes.length === 1);
	const first = layers[0];
	let cost = first.nodes.map(
		(c, k) => first.unary[k] + (near && anchorless ? distNM(near, c) : 0),
	);
	const back: number[][] = [[]];
	for (let j = 1; j < layers.length; j++) {
		const prev = layers[j - 1];
		const cur = layers[j];
		const next: number[] = [];
		const from: number[] = [];
		for (let k = 0; k < cur.nodes.length; k++) {
			let best = Infinity;
			let arg = 0;
			for (let p = 0; p < prev.nodes.length; p++) {
				const c = cost[p] + distNM(prev.nodes[p], cur.nodes[k]);
				if (c < best) {
					best = c;
					arg = p;
				}
			}
			next.push(best + cur.unary[k]);
			from.push(arg);
		}
		cost = next;
		back.push(from);
	}
	let k = 0;
	for (let n = 1; n < cost.length; n++) {
		if (cost[n] < cost[k]) {
			k = n;
		}
	}
	for (let j = layers.length - 1; j >= 0; j--) {
		const l = layers[j];
		if (l.index !== null && l.anchors) {
			out[l.index] = l.anchors[k];
		}
		if (j > 0) {
			k = back[j][k];
		}
	}
	return out;
}

/** The anchors of one parsed route's waypoints, chosen together: an
 *  identifier (with, when the file states it beside the identifier, its
 *  position as the feature to keep), a free point fixed where it is, a
 *  name-only point skipped. The one Phase A of loadRoutes and of
 *  buildCandidatePlan, so what a plan resolves to in the workspace, in the
 *  catalog's rows and previews and in the trace matching is one answer. */
export function routeAnchors(
	waypoints: readonly LoadedWaypoint[],
	resolve: WaypointResolver,
): (WaypointAnchor | null)[] {
	return chooseAnchors(
		waypoints.map((w): AnchorItem => {
			const pos = w.lat !== undefined && w.lon !== undefined ? { lat: w.lat, lon: w.lon } : null;
			if (w.ident) {
				return { ident: w.ident, keep: pos ?? undefined };
			}
			return pos;
		}),
		resolve,
	);
}

/* decoZone.ts: what the airspace decoration paint (decoPaint.ts) needs of a
 * row, as plain data: the ring and the FIR arcs as flat lat / lon arrays, and
 * the symbol spec and the designator label resolved once. Every field
 * survives a structured clone and the arrays can be transferred, so a worker
 * can be handed one; on the page each row object gets one, the first time it
 * is drawn.
 *
 * Keyed by the row OBJECT, not its key: a republished dataset (a late
 * country, airspaceLayer.ts reindex) can bring back a key with new geometry,
 * and a new object gets a new zone. */

import type { Airspace } from '$lib/data/airspaces';
import { airspaceLabel, symbolFor, type AirspaceLabel, type SymbolSpec } from './airspaceSymbology';
import { ringComplement } from './decoGeometry';

export interface DecoZone {
	/** The row's key: what a highlight names it by. */
	key: string;
	/** Ring area, square degrees: labels place smallest first. */
	area: number;
	bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
	/** The ring, [lat0, lon0, lat1, lon1, ...]. */
	ring: Float64Array;
	/** The external FIR arcs, flat like the ring, when the row has arcs AND
	 *  its marks are the FIR comb (the only paint that reads them); null
	 *  otherwise. An EMPTY list is not null: every run of the ring is
	 *  internal, and the whole ring prints in the internal form. */
	arcs: Float64Array[] | null;
	/** The ring's internal chains (the ring less its arcs), flat; null when
	 *  arcs is. */
	internal: Float64Array[] | null;
	spec: SymbolSpec;
	label: AirspaceLabel | null;
}

function flat(line: readonly (readonly [number, number])[]): Float64Array {
	const out = new Float64Array(line.length * 2);
	for (let i = 0, o = 0; i < line.length; i++, o += 2) {
		out[o] = line[i][0];
		out[o + 1] = line[i][1];
	}
	return out;
}

let zones = new WeakMap<Airspace, DecoZone>();

/** Forget every zone made so far, so each is made afresh: the zones sent to
 *  a worker handed their arrays over, and a page that paints them again after
 *  the worker is gone needs its own. */
export function resetDecoZones(): void {
	zones = new WeakMap<Airspace, DecoZone>();
}

/** A row's zone, made once per row object. */
export function decoZoneOf(a: Airspace): DecoZone {
	let z = zones.get(a);
	if (!z) {
		z = makeZone(a);
		zones.set(a, z);
	}
	return z;
}

function makeZone(a: Airspace): DecoZone {
	const spec = symbolFor(a);
	const arcs = a.arcs && spec.marks?.kind === 'comb' ? a.arcs : null;
	return {
		key: a.key,
		area: a.area,
		bbox: a.bbox,
		ring: flat(a.ring),
		arcs: arcs ? arcs.map(flat) : null,
		internal: arcs ? ringComplement(a.ring, arcs).map(flat) : null,
		spec,
		label: airspaceLabel(a),
	};
}

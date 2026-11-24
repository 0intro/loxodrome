/* When the airport layer draws an aerodrome's symbol: the zoom each kind
 * appears from, and the Layers group each kind rides. Kept apart from
 * airportLayer.ts, and free of Leaflet, because the symbol is also what an
 * on-field NOTAM pin collapses into ("Hide airport NOTAM markers"), and that
 * rule (pinHeldByAirport in state/notam.svelte.ts) must ask the question the
 * layer answers. It asked whether ANY airport group was on: a small field is
 * not drawn below zoom 8, nor a field whose kind or publisher is unticked, and
 * its NOTAM then had no representation on the map at all. */

import type { Airport } from '$lib/data/airports';
import type { AirportGroup } from '$lib/state/layers.svelte';

/** Every OurAirports type the layer draws: the zoom it is drawn from, which
 *  keeps the map readable at low zoom without clustering, and the Layers group
 *  it rides (the grouped "Airports" row flips the three fixed-wing sizes
 *  together). A type missing here is never drawn. */
export const AIRPORT_KINDS: Readonly<Record<string, { minZoom: number; group: AirportGroup }>> = {
	large_airport: { minZoom: 5, group: 'airports' },
	medium_airport: { minZoom: 6, group: 'airports' },
	small_airport: { minZoom: 8, group: 'airports' },
	heliport: { minZoom: 8, group: 'heliports' },
	seaplane_base: { minZoom: 8, group: 'seaplane' },
	balloonport: { minZoom: 8, group: 'balloon' },
	closed: { minZoom: 8, group: 'closed' },
};

/** The highest floor at or below `zoom`, 0 below them all. A draw decision
 *  reads nothing else about the zoom, so a reactive caller keyed on this
 *  re-runs where a floor is crossed rather than at every zoom step. */
export function airportZoomFloor(zoom: number): number {
	let floor = 0;
	for (const { minZoom } of Object.values(AIRPORT_KINDS)) {
		if (minZoom <= zoom && minZoom > floor) {
			floor = minZoom;
		}
	}
	return floor;
}

/** Is this aerodrome's symbol drawn at `zoom`, `shown` saying whether its
 *  kind and its publisher are ticked? */
export function airportDrawnAt(a: Pick<Airport, 'type'>, zoom: number, shown: boolean): boolean {
	const kind = AIRPORT_KINDS[a.type];
	return kind !== undefined && zoom >= kind.minZoom && shown;
}

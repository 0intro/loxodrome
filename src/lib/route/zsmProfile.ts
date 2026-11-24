/* The raptor zones on the route profile (AIP France ENR 5.6): each zone the
 * route crosses is a band keyed by its id (`zsm:<id>`), from the surface to
 * the height ENR 5.6-1 asks it to be overflown at, in ENR 5.6-2's crimson.
 * The volumes are the alerts' (nav/alertVolumes.ts zsmVolumes), and the
 * walk and the edges the supplements' (route/supProfile.ts), so a zone's
 * ring, height and season read once for all three. A zone informs: its
 * band forbids nothing and names no filter row, the level band alone
 * hiding it on the chart. Pure. */

import { NO_ENTRY } from '$lib/data/airspaceEntry';
import type { Zsm } from '$lib/data/zsm';
import { ZSM_INK } from '$lib/map/palette';
import type { TerrainSample } from '$lib/map/terrain';
import { zsmVolumes } from '$lib/nav/alertVolumes';
import type { Waypoint } from '$lib/state/route.svelte';
import { formatVLimit, type VLimit } from '$lib/vertical/limits';
import type { PlacedBand } from './routeProfile';
import { placeVolumeSpans, volumeSpans } from './supProfile';

/** A draw-ready raptor zone band, with its limits, which the profile's
 *  level band reads. */
export interface PlacedZsmBand extends PlacedBand {
	vLower: VLimit | null;
	vUpper: VLimit | null;
}

/** Whether a band key names a raptor zone: the key is the zone's id. */
export function isZsmBandKey(key: string): boolean {
	return key.startsWith('zsm:');
}

/** The bands of the raptor zones the route crosses, in flight order, each
 *  chip ZSM before the zone's name. The tooltip is locale-invariant:
 *  the zone's name, its species as the STAC records it and formatVLimit's
 *  vocabulary. */
export function zsmProfileBands(waypoints: Waypoint[], zones: readonly Zsm[], terrain: TerrainSample[]): PlacedZsmBand[] {
	const byId = new Map(zones.map((z) => [z.id, z]));
	return volumeSpans(waypoints, zsmVolumes(zones))
		.map(({ volume: v, spans }): PlacedZsmBand => {
			const z = byId.get(v.id);
			const placed = placeVolumeSpans({ vLower: v.vLower, vUpper: v.vUpper, knownExtent: v.knownExtent, spans }, terrain);
			// i18n-ignore-start: the zone's name and species and formatVLimit, locale-invariant
			const limits = `${formatVLimit(v.vLower)} – ${formatVLimit(v.vUpper)}`;
			const tooltip = [v.name, z?.species ?? '', limits].filter((x) => x).join('\n');
			const badge = 'ZSM';
			// i18n-ignore-end
			return {
				key: v.id,
				color: ZSM_INK,
				category: 'restricted',
				airClass: '',
				type: v.type,
				entry: NO_ENTRY,
				prohibited: false,
				rtba: false,
				activity: 'permanent',
				lowerFt: placed.lowerFt,
				knownExtent: v.knownExtent,
				extent: v.extent,
				topOpen: placed.topOpen,
				minFt: placed.minFt,
				maxFt: placed.maxFt,
				label: z?.name ?? v.name,
				badge,
				badgeKind: 'zone',
				limitsText: limits,
				tooltip,
				spans: placed.spans,
				advisory: true,
				vLower: v.vLower,
				vUpper: v.vUpper,
			};
		})
		.sort((a, b) => a.spans[0].enterNM - b.spans[0].enterNM);
}

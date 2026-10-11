/* The base-map packs that exist: a base layer whose whole pyramid ships as
 * one PMTiles archive, downloaded through the offline manager and served
 * from the device under that base layer (docs/offline-maps.md, "Base-map
 * packs").
 *
 * One today, Plan IGN, and it is an exception by licence rather than a
 * category: the Licence Ouverte lets IGN's map be redistributed, where the
 * OpenStreetMap tile policy forbids bulk downloads of its tiles. The archive
 * is built by cmd/planign and served on the chart worker's archive route,
 * the one the chart and document packs already use.
 *
 * The id is the base layer's own: the base-layer id, the worker's archive id
 * and the OPFS file name are one name. Locale-free and label-free (the
 * docPacks.ts rule): the label is the base layer's. */

import type { BaseLayerId } from '$lib/state/layers.svelte';
import { CHART_WORKER } from '$lib/net/endpoints';

export type BasemapPackId = Extract<BaseLayerId, 'planign'>;

export interface BasemapPackDef {
	id: BasemapPackId;
	/** The archive's last zoom. The archive's own header is what the map
	 *  reads; this is the contract with cmd/planign's maxZoom, pinned by
	 *  tests/planignPack.spec.ts through the fixture that command writes. */
	maxNativeZoom: number;
	archive: string;
}

export const BASEMAP_PACKS: readonly BasemapPackDef[] = [
	{ id: 'planign', maxNativeZoom: 13, archive: `${CHART_WORKER}/planign/archive` },
] as const;

/** The pack that can back a base layer, if any. */
export function basemapPackDef(id: BaseLayerId): BasemapPackDef | undefined {
	return BASEMAP_PACKS.find((d) => d.id === id);
}

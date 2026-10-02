/* Which base layer is on the map, and the swap when the selection or a
 * base-map pack changes (docs/offline-maps.md, "Base-map packs"). Pulled out
 * of MapView so its races can be tested in Node
 * (tests/baseLayerSync.spec.ts): the composite of a held pack is built
 * asynchronously (a lazy module, then the archive's header), and the
 * selection or the pack can change while it is.
 *
 * The rules:
 * - What is mounted is named by (base id, pack File). An unchanged pair is a
 *   no-op, so a re-run of the caller's effect rebuilds nothing.
 * - A new layer is added before the old one is removed: no blank frame.
 * - While a composite is being built, whatever is mounted stays; at boot,
 *   with nothing mounted, the map waits for it rather than mounting the live
 *   layer only to replace it a moment later, which would have fired a burst
 *   of live requests (and, in the Android shell, filled the passive tile
 *   cache) for tiles the pack holds.
 * - A late composite is dropped when the selection or the File moved on
 *   meanwhile, or the map went away.
 * - A failed build mounts the live layer: the base map is never missing
 *   because its pack could not be read.
 * - While the pack store has not reconciled yet (`ready` false for a base
 *   that has a pack), nothing changes: the File is not known yet. */

import type L from 'leaflet';
import type { BaseLayerId } from '$lib/state/layers.svelte';

export type PackBaseFactory = (live: L.TileLayer, archive: File, key: string) => Promise<L.Layer>;

export interface BaseLayerSource {
	/** The live layer for a base id (BaseLayerDef.create). */
	live(id: BaseLayerId): L.TileLayer;
	/** The held pack serving that base, if any. */
	pack(id: BaseLayerId): File | null;
	/** False while that base's pack store has not reconciled yet. */
	ready(id: BaseLayerId): boolean;
	/** The composite's factory, imported on first use. */
	loadPackBase(): Promise<PackBaseFactory>;
}

export interface BaseLayerSync {
	sync(map: L.Map, id: BaseLayerId): void;
	/** Forget the map (its teardown): a late result then lands nowhere. */
	clear(): void;
	/** What is mounted, for tests. */
	readonly mounted: { id: BaseLayerId; pack: File | null; layer: L.Layer } | null;
}

export function createBaseLayerSync(src: BaseLayerSource): BaseLayerSync {
	let map: L.Map | null = null;
	let mounted: { id: BaseLayerId; pack: File | null; layer: L.Layer } | null = null;
	let pending: { id: BaseLayerId; pack: File } | null = null;

	function mount(id: BaseLayerId, pack: File | null, layer: L.Layer): void {
		if (!map) {
			return;
		}
		layer.addTo(map);
		mounted?.layer.remove();
		mounted = { id, pack, layer };
	}

	function build(id: BaseLayerId, pack: File): void {
		const want = { id, pack };
		pending = want;
		void src
			.loadPackBase()
			.then((factory) => factory(src.live(id), pack, `basemap:${id}`))
			.then(
				(layer) => {
					if (pending !== want) {
						return;
					}
					pending = null;
					mount(id, pack, layer);
				},
				() => {
					if (pending !== want) {
						return;
					}
					pending = null;
					// The base map is never missing because its pack failed to
					// read: the live layer, remembered against this File so the
					// next change of File or selection tries the pack again.
					mount(id, pack, src.live(id));
				},
			);
	}

	return {
		sync(m: L.Map, id: BaseLayerId): void {
			map = m;
			if (!src.ready(id)) {
				return;
			}
			const pack = src.pack(id);
			if (mounted && mounted.id === id && mounted.pack === pack) {
				pending = null;
				return;
			}
			if (!pack) {
				pending = null;
				mount(id, null, src.live(id));
				return;
			}
			if (pending && pending.id === id && pending.pack === pack) {
				return;
			}
			build(id, pack);
		},
		clear(): void {
			pending = null;
			mounted = null;
			map = null;
		},
		get mounted() {
			return mounted;
		},
	};
}

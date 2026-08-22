/* emphasisClones.ts: the shared reconcile of the standalone emphasis-clone
 * overlays. Several map features are emphasised by drawing an independent
 * Leaflet clone on a dedicated pane, regardless of every category /
 * publisher / altitude / route filter: the airspaces a selected NOTAM
 * references (airspaceLayer's linked overlays), the navigation-mode contact
 * pair (navContactLayer), the live airspace alerts (navAlertLayer) and the
 * SUP AIP activation hatch (supaipActivationLayer). Each module was hand-
 * writing the same keyed want-set reconcile; the factory owns it once, and
 * each module keeps its config (styles, geometry builder, slot semantics)
 * plus its public exports over the instance, so the hit-test exception
 * family keeps reading the same functions (navContactKeys / navAlertKeys).
 *
 * activationLayer.ts stays custom by charter: its hatch polygons are
 * INTERACTIVE (the stopPropagation click path) and its emphasis is keyed by
 * row key inside id-keyed slots; it shares only setPathStrokeWidth. */

import L from 'leaflet';
import { ensurePane } from './directDrawLayer';

/** Set the SVG stroke-width of a path by poking the element directly rather
 *  than via setStyle, so Leaflet's _updateStyle can't overwrite a <pattern>
 *  fill with a solid colour. Returns the path for chaining (bringToFront). */
export function setPathStrokeWidth(path: L.Path, weight: string): L.Path {
	(path.getElement() as SVGElement | null)?.setAttribute('stroke-width', weight);
	return path;
}

export interface CloneLayerConfig<T> {
	pane: string;
	paneZ: string;
	/** Reconcile identity: one live clone per key (navContact keys by SLOT,
	 *  so the occupant swap rebuilds in place). */
	keyOf(item: T): string;
	/** Build the clone from the item; `opts` carries the assembled pane /
	 *  renderer / interactive:false / style options to spread into the
	 *  Leaflet constructor(s). */
	geometryOf(item: T, opts: L.PathOptions): L.Layer;
	styleOf(item: T): L.PathOptions;
	/** Style-relevant signature; a change rebuilds the slot (default: never
	 *  rebuild a kept key). */
	sigOf?(item: T): string;
	/** Geometry identity; a REFERENCE change rebuilds the slot (navAlert's
	 *  volume object). Default: geometry is static per key. */
	geomRefOf?(item: T): unknown;
	/** Post-add hook (the SUP AIP hatch points its fill at the inline
	 *  <pattern>). Runs before the emphasis re-apply. */
	onAttach?(item: T, layer: L.Layer): void;
	/** The keys() surface for the hit-test chain; defaults to keyOf. The
	 *  contact clones reconcile by slot but are hit-tested by airspace row
	 *  key. */
	hitKeyOf?(item: T): string;
	/** Create no dedicated SVG renderer: the clones resolve the pane's
	 *  implicit renderer instead (airspaceLayer's linked overlays share the
	 *  'airspaces' pane with the highlight clone, one SVG so bringToFront
	 *  interleaves them). */
	sharedPaneRenderer?: boolean;
	/** bringToFront every KEPT clone on sync (the linked overlays re-stack
	 *  above the re-ordered base polygons on refreshAirspaceOrder). */
	frontOnSync?: boolean;
}

export interface CloneLayerInstance<T> {
	/** Reconcile the live clones against `items`: remove stale keys, add
	 *  missing ones, rebuild a kept key whose sig / geometry identity
	 *  changed. Idempotent. */
	sync(map: L.Map, items: readonly T[]): void;
	/** The hit-test keys of the live clones (the exception family). */
	keys(): ReadonlySet<string>;
	/** Widen one clone's stroke (2 -> 3) as the selected signal, restoring
	 *  the previous one; the requested key survives a membership churn and
	 *  re-applies on re-add. Pass null to clear. */
	setEmphasis(key: string | null): void;
	/** Remove every clone from the map and drop refs (teardown while the
	 *  map is still alive). */
	clear(map: L.Map): void;
	/** Drop refs only (the map itself is being destroyed; airspaceLayer's
	 *  clearAirspaceLayer contract). */
	reset(): void;
}

interface Slot<T> {
	item: T;
	sig: string | null;
	geomRef: unknown;
	layer: L.Layer;
	hitKey: string;
}

export function createCloneLayer<T>(cfg: CloneLayerConfig<T>): CloneLayerInstance<T> {
	let renderer: L.SVG | null = null;
	const slots = new Map<string, Slot<T>>();
	// The live hit-test keys, kept beside the slots so the per-candidate
	// lookup is allocation-free.
	const hitKeys = new Set<string>();
	// The REQUESTED emphasis; deliberately survives a slot's removal so a
	// still-selected clone whose membership drops and returns (the
	// minute-tick re-render) gets its bold stroke back in the add path,
	// since the ui.detail highlight effect never re-fires on an unchanged
	// selection.
	let emphasizedKey: string | null = null;

	function buildSlot(m: L.Map, item: T): Slot<T> {
		ensurePane(m, cfg.pane, cfg.paneZ);
		// The styles never carry pane / renderer / interactive, so the merge
		// order is inert; the literals go last for the exact option types.
		const opts: L.PathOptions = {
			...cfg.styleOf(item),
			pane: cfg.pane,
			interactive: false,
		};
		if (!cfg.sharedPaneRenderer) {
			renderer ??= L.svg({ pane: cfg.pane });
			opts.renderer = renderer;
		}
		const layer = cfg.geometryOf(item, opts).addTo(m);
		cfg.onAttach?.(item, layer);
		const key = cfg.keyOf(item);
		// Re-apply the selected bold on re-add (see emphasizedKey above).
		if (key === emphasizedKey && layer instanceof L.Path) {
			setPathStrokeWidth(layer, '3');
		}
		return {
			item,
			sig: cfg.sigOf ? cfg.sigOf(item) : null,
			geomRef: cfg.geomRefOf ? cfg.geomRefOf(item) : null,
			layer,
			hitKey: (cfg.hitKeyOf ?? cfg.keyOf)(item),
		};
	}

	function sync(map: L.Map, items: readonly T[]): void {
		const want = new Set(items.map((it) => cfg.keyOf(it)));
		for (const [key, slot] of slots) {
			if (!want.has(key)) {
				map.removeLayer(slot.layer);
				slots.delete(key);
			}
		}
		for (const item of items) {
			const key = cfg.keyOf(item);
			const existing = slots.get(key);
			if (existing) {
				const sig = cfg.sigOf ? cfg.sigOf(item) : null;
				const geomRef = cfg.geomRefOf ? cfg.geomRefOf(item) : null;
				if (existing.sig === sig && existing.geomRef === geomRef) {
					if (cfg.frontOnSync && existing.layer instanceof L.Path) {
						existing.layer.bringToFront();
					}
					continue;
				}
				map.removeLayer(existing.layer);
			}
			slots.set(key, buildSlot(map, item));
		}
		hitKeys.clear();
		for (const slot of slots.values()) {
			hitKeys.add(slot.hitKey);
		}
	}

	function findPath(key: string | null): L.Path | null {
		if (key === null) {
			return null;
		}
		const layer = slots.get(key)?.layer;
		return layer instanceof L.Path ? layer : null;
	}

	function setEmphasis(key: string | null): void {
		if (key === emphasizedKey) {
			return;
		}
		const prev = findPath(emphasizedKey);
		if (prev) {
			setPathStrokeWidth(prev, '2');
		}
		emphasizedKey = key;
		const next = findPath(key);
		if (next) {
			setPathStrokeWidth(next, '3').bringToFront();
		}
	}

	function clear(map: L.Map): void {
		for (const slot of slots.values()) {
			map.removeLayer(slot.layer);
		}
		reset();
	}

	function reset(): void {
		slots.clear();
		hitKeys.clear();
		emphasizedKey = null;
		renderer = null;
	}

	return {
		sync,
		keys: () => hitKeys,
		setEmphasis,
		clear,
		reset,
	};
}

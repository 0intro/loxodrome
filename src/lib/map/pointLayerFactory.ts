/* pointLayerFactory.ts: the shared skeleton of the four direct-draw point
 * overlays (airport / navaid / obstacle / nature layers). Each of those
 * modules was one class written four times: module state (item index, r-tree,
 * layer + captured map, highlight, cues), the attach/detach reconcile, the
 * highlight-drawn-last _draw pipeline, and the r-tree hit probes. The factory
 * owns that skeleton once; each module keeps its config (visibility flags,
 * symbol painter, zoom gates) and re-exports its public API over the instance,
 * so every existing export name and signature survives verbatim
 * (tests/interactions.spec.ts mocks those modules by export name).
 *
 * The documented zoom-gate asymmetry is per-layer config
 * (zoomFloorHidesHighlight): airports draw nothing at zoom <= 3, so no
 * highlight shows below the floor, while the navaid / obstacle / nature
 * layers gate only the bulk pass, so a lone highlight still draws at any
 * zoom.
 *
 * A point layer paints while the map moves (directDrawLayer.ts), on the
 * main thread and so only while a paint costs the move's frames little:
 * its recent paints average MOTION_PAINT_BUDGET_MS or less (the base's
 * _paintsCheaply). It draws the extent it paints, the lead ahead of a
 * moving view included, padded by how far a symbol reaches, so one whose
 * position is just past the edge still shows the part of it inside. */

import L from 'leaflet';
import RBush from 'rbush';
import { M_PER_DEG } from '$lib/notam/geometry';
import { DirectDrawLayer, ensurePane } from './directDrawLayer';
import type { DeviceFrame } from './symbolSprites';

interface PointIndexEntry<T> {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	item: T;
}

/** Per-symbol draw context: the highlight pass sets `highlight` (the +3 size
 *  and every zoom-gate bypass belong to the module's painter), `cued` comes
 *  from the factory's cue set, `zoom` lets a painter keep its own
 *  zoom-laddered extras (the obstacle CABLE word), and `dev` is the paint's
 *  transform, which a symbol stamped from a sprite places itself by
 *  (symbolSprites.ts). */
export interface DrawSymbolOpts {
	highlight: boolean;
	cued: boolean;
	zoom: number;
	dev: DeviceFrame;
}

export interface PointLayerConfig<T> {
	pane: string;
	paneZ: string;
	canvasClass: string;
	/** Index / highlight / cue key of an item (airports uppercase the ident). */
	keyOf(item: T): string;
	posOf(item: T): { lat: number; lon: number };
	/** Whether the bulk pass runs at all (airport: the groups flag; the
	 *  others: their layer-wide minimum zoom). */
	bulkVisible(zoom: number): boolean;
	/** Per-item gate shared by the bulk pass and the hit probes (group /
	 *  publisher toggles, per-type zoom thresholds). */
	drawnAt(item: T, zoom: number): boolean;
	/** Any group toggle on; the factory ORs the live highlight onto it for
	 *  the attach/detach reconcile. */
	anyVisible(): boolean;
	drawSymbol(
		ctx: CanvasRenderingContext2D,
		item: T,
		x: number,
		y: number,
		o: DrawSymbolOpts,
	): void;
	/** The documented airport floor: return before the dpr scale at
	 *  zoom <= this, hiding the highlight there too. Omit for the layers
	 *  whose lone highlight draws at any zoom. */
	zoomFloorHidesHighlight?: number;
	/** Zoom gate of the hit probe / radius gather (airports: strictly above
	 *  their pane floor, `z > 3`; the others: their bulk minimum, `z >= min`).
	 *  Kept a predicate so each module's original comparison survives
	 *  verbatim. */
	interactZoomOk(zoom: number): boolean;
	/** Attached-layer requirement of the hit probe / radius gather
	 *  (airports only; the others gate on zoom + per-item state alone). */
	interactRequiresLayer?: boolean;
	/** Half-window of the hit probe's r-tree query, px (largest glyph +
	 *  click tolerance). */
	hitWindowPx: number;
	/** How far a drawn symbol reaches from its position, px, what is drawn
	 *  beside it included (the cue ring, the obstacles' CABLE mark): the
	 *  painted extent is queried padded by it. Defaults to hitWindowPx. */
	drawReachPx?: number;
	/** Pixel hit radius of one item (symbol half-extent + tolerance). */
	hitRadiusPx(item: T): number;
	/** Radius gather ordering: airports distance-filter and sort nearest
	 *  first; the others return every bbox candidate unordered. */
	sortGather?: boolean;
	/** Module-specific flag resets on clear (the factory resets its own
	 *  state; the Layers-tab style prefs each module decides for itself). */
	onClear?(): void;
	/** Post-attach hook (airports re-sync their pane's zoom-floor display). */
	onAttach?(map: L.Map): void;
}

export interface PointLayerInstance<T> {
	/** Build the canvas layer once, and index the dataset: again whenever a
	 *  different array arrives, which is what a country loading late hands
	 *  out (its dataset is re-merged whole), a no-op for the same array. */
	build(map: L.Map, items: T[]): void;
	/** Reconcile the canvas's presence on the map (attached while a group is
	 *  on OR a highlight is live) and redraw. Defaults to the map captured at
	 *  build time so no-map callers (hide on teardown races) stay safe. */
	sync(map?: L.Map): void;
	/** Repaint if built (publisher / cue / flag flips read state at draw). */
	redraw(): void;
	/** Detach + drop every handle so a rebuilt map starts clean (HMR). */
	clear(map: L.Map): void;
	/** Highlight one item by key, or clear with null. Attaches the canvas
	 *  when needed so a selection shows even with every group off. */
	highlight(key: string | null): void;
	/** Sync the "has active NOTAM" cue-ring key set. */
	setCues(keys: Set<string>): void;
	/** Pixel-distance hit probe for left-click: nearest item under the
	 *  cursor honouring the same gates the drawn glyphs honour. */
	hit(map: L.Map, lat: number, lon: number): T | null;
	/** Every visible item within radiusM of (lat, lon); the context menu's
	 *  near-click gather. */
	at(map: L.Map, lat: number, lon: number, radiusM: number): T[];
	/** Nearest item within radiusM IGNORING every visibility gate (route
	 *  waypoint snapping works with the layers off). */
	nearestUngated(lat: number, lon: number, radiusM: number): { item: T; distM: number } | null;
	built(): boolean;
	highlightedKey(): string | null;
}

export function createPointLayer<T>(cfg: PointLayerConfig<T>): PointLayerInstance<T> {
	// Module-level state of the old copies, now per instance.
	const byKey = new Map<string, T>();
	let spatialIndex: RBush<PointIndexEntry<T>> | null = null;
	let layer: PointCanvasLayer | null = null;
	// The map captured at build time, so highlight() can attach the canvas
	// (to show a selection / hover even with every group off) without every
	// caller threading the map through. Mirrors airspaceLayer's layerMap.
	let layerMap: L.Map | null = null;
	let highlightedId: string | null = null;
	const cueKeys = new Set<string>();
	// The array the index was built from. Built once and never again, the
	// layer went on drawing the first merge after a late country re-merged
	// its dataset, while every lookup (the pin hide rule, the closure cross,
	// the panels) answered from the new one.
	let indexed: T[] | null = null;

	class PointCanvasLayer extends DirectDrawLayer {
		protected override readonly canvasClass = cfg.canvasClass;
		protected override readonly paneName = cfg.pane;

		/** Paints while the map moves while a paint costs the move little. */
		protected override paintsInMotion(): boolean {
			return this._paintsCheaply();
		}

		protected override _draw(): void {
			const canvas = this._canvas;
			const ctx = this._ctx;
			const map = this._map;
			if (!canvas || !ctx || !map || !spatialIndex) {
				return;
			}
			// Clear, and set the transform so container points draw where
			// they belong: the ratio the canvas was sized at, and the margin
			// a painting made ahead of a moving view reaches with. A symbol
			// stamped from a sprite lands texel on device pixel, which no
			// smoothing may blur.
			const ratio = this._applied?.dpr ?? (window.devicePixelRatio || 1);
			this._beginPaint(ctx, canvas, ratio);
			ctx.imageSmoothingEnabled = false;
			const dev: DeviceFrame = { ratio, x: this._margin.left * ratio, y: this._margin.top * ratio };
			const zoom = map.getZoom();
			// The documented asymmetry: with a floor configured (airports),
			// nothing draws below it, the highlight included; without one, a
			// lone highlight still draws at any zoom.
			if (cfg.zoomFloorHidesHighlight != null && zoom <= cfg.zoomFloorHidesHighlight) {
				return;
			}
			if (cfg.bulkVisible(zoom)) {
				// The extent painted, padded by how far a symbol reaches: one
				// whose position is just past the edge still shows its part.
				const e = this._paintExtent(map);
				const pad = cfg.drawReachPx ?? cfg.hitWindowPx;
				const sw = map.containerPointToLatLng([e.x0 - pad, e.y1 + pad]);
				const ne = map.containerPointToLatLng([e.x1 + pad, e.y0 - pad]);
				const candidates = spatialIndex.search({
					minX: sw.lng,
					minY: sw.lat,
					maxX: ne.lng,
					maxY: ne.lat,
				});
				for (const entry of candidates) {
					const item = entry.item;
					if (!cfg.drawnAt(item, zoom)) {
						continue;
					}
					const key = cfg.keyOf(item);
					// Skip the highlighted item here; it draws last so it
					// sits on top of any overlapping neighbour.
					if (key === highlightedId) {
						continue;
					}
					const { lat, lon } = cfg.posOf(item);
					const pt = map.latLngToContainerPoint([lat, lon]);
					cfg.drawSymbol(ctx, item, pt.x, pt.y, {
						highlight: false,
						cued: cueKeys.has(key),
						zoom,
						dev,
					});
				}
			}
			// Selected symbol on top, drawn regardless of its group / publisher
			// toggle and per-type zoom, so a selection or hover (e.g. from a
			// NOTAM panel row) is always visible even with the layers off.
			if (highlightedId) {
				const item = byKey.get(highlightedId);
				if (item) {
					const { lat, lon } = cfg.posOf(item);
					const pt = map.latLngToContainerPoint([lat, lon]);
					cfg.drawSymbol(ctx, item, pt.x, pt.y, {
						highlight: true,
						cued: cueKeys.has(highlightedId),
						zoom,
						dev,
					});
				}
			}
		}
	}

	function build(map: L.Map, items: T[]): void {
		if (layer && items === indexed) {
			return;
		}
		layerMap = map;
		ensurePane(map, cfg.pane, cfg.paneZ);
		byKey.clear();
		const entries: PointIndexEntry<T>[] = [];
		for (const item of items) {
			byKey.set(cfg.keyOf(item), item);
			const { lat, lon } = cfg.posOf(item);
			entries.push({ minX: lon, minY: lat, maxX: lon, maxY: lat, item });
		}
		// Bulk-load is ~2-3x faster than per-row insert at dataset scale.
		spatialIndex = new RBush<PointIndexEntry<T>>();
		spatialIndex.load(entries);
		indexed = items;
		if (layer) {
			layer.redraw();
			return;
		}
		layer = new PointCanvasLayer();
		// Attached to the map by the group setters via sync(); that fires
		// moveend on add and triggers the first paint.
	}

	function sync(map?: L.Map): void {
		const m = map ?? layerMap;
		if (!m || !layer) {
			return;
		}
		// A live highlight (selected or hovered item) keeps the canvas
		// attached even with every group off, so the lone selected symbol
		// stays drawable.
		const should = cfg.anyVisible() || highlightedId != null;
		const has = m.hasLayer(layer);
		if (should && !has) {
			layer.addTo(m);
			cfg.onAttach?.(m);
		} else if (!should && has) {
			m.removeLayer(layer);
		} else if (has) {
			layer.redraw();
		}
	}

	function clear(map: L.Map): void {
		if (layer && map.hasLayer(layer)) {
			map.removeLayer(layer);
		}
		layer = null;
		layerMap = null;
		indexed = null;
		byKey.clear();
		cueKeys.clear();
		highlightedId = null;
		spatialIndex = null;
		cfg.onClear?.();
	}

	function highlight(key: string | null): void {
		if (highlightedId === key) {
			return;
		}
		highlightedId = key;
		// sync attaches the canvas when a highlight appears (groups may be
		// off) and detaches it again when the highlight clears and no group
		// is on.
		if (layerMap) {
			sync();
		} else {
			layer?.redraw();
		}
	}

	function setCues(keys: Set<string>): void {
		cueKeys.clear();
		for (const k of keys) {
			cueKeys.add(k);
		}
		layer?.redraw();
	}

	function interactReady(map: L.Map): boolean {
		if (!spatialIndex) {
			return false;
		}
		if (cfg.interactRequiresLayer && (!layer || !map.hasLayer(layer))) {
			return false;
		}
		return cfg.interactZoomOk(map.getZoom());
	}

	function bboxQuery(
		lat: number,
		lon: number,
		dLat: number,
		dLon: number,
	): PointIndexEntry<T>[] {
		if (!spatialIndex) {
			return [];
		}
		return spatialIndex.search({
			minX: lon - dLon,
			minY: lat - dLat,
			maxX: lon + dLon,
			maxY: lat + dLat,
		});
	}

	function hit(map: L.Map, lat: number, lon: number): T | null {
		if (!interactReady(map)) {
			return null;
		}
		const zoom = map.getZoom();
		const clickPt = map.latLngToLayerPoint([lat, lon]);
		// Window covers the largest glyph + tolerance in lat/lon.
		const corner = map.layerPointToLatLng(
			clickPt.add(L.point(cfg.hitWindowPx, cfg.hitWindowPx)),
		);
		const dLat = Math.abs(corner.lat - lat);
		const dLon = Math.abs(corner.lng - lon);
		let best: T | null = null;
		let bestD = Infinity;
		for (const entry of bboxQuery(lat, lon, dLat, dLon)) {
			const item = entry.item;
			if (!cfg.drawnAt(item, zoom)) {
				continue;
			}
			const pos = cfg.posOf(item);
			const p = map.latLngToLayerPoint([pos.lat, pos.lon]);
			const dx = p.x - clickPt.x;
			const dy = p.y - clickPt.y;
			const d2 = dx * dx + dy * dy;
			const rPx = cfg.hitRadiusPx(item);
			if (d2 > rPx * rPx) {
				continue;
			}
			if (d2 < bestD) {
				bestD = d2;
				best = item;
			}
		}
		return best;
	}

	function at(map: L.Map, lat: number, lon: number, radiusM: number): T[] {
		if (!interactReady(map)) {
			return [];
		}
		const zoom = map.getZoom();
		const cosLat = Math.cos((lat * Math.PI) / 180) || 1;
		const dLat = radiusM / M_PER_DEG;
		const dLon = radiusM / (M_PER_DEG * cosLat);
		const candidates = bboxQuery(lat, lon, dLat, dLon);
		if (!cfg.sortGather) {
			const out: T[] = [];
			for (const entry of candidates) {
				if (cfg.drawnAt(entry.item, zoom)) {
					out.push(entry.item);
				}
			}
			return out;
		}
		// Airports refine the bbox window by exact distance and hand the
		// stack back nearest first (equirectangular is plenty at this radius).
		const scored: Array<{ item: T; d: number }> = [];
		for (const entry of candidates) {
			const item = entry.item;
			if (!cfg.drawnAt(item, zoom)) {
				continue;
			}
			const pos = cfg.posOf(item);
			const dLatM = (pos.lat - lat) * M_PER_DEG;
			const dLonM = (pos.lon - lon) * M_PER_DEG * cosLat;
			const d = Math.sqrt(dLatM * dLatM + dLonM * dLonM);
			if (d > radiusM) {
				continue;
			}
			scored.push({ item, d });
		}
		scored.sort((x, y) => x.d - y.d);
		return scored.map((s) => s.item);
	}

	function nearestUngated(
		lat: number,
		lon: number,
		radiusM: number,
	): { item: T; distM: number } | null {
		if (!spatialIndex) {
			return null;
		}
		const cosLat = Math.cos((lat * Math.PI) / 180) || 1;
		const dLat = radiusM / M_PER_DEG;
		const dLon = radiusM / (M_PER_DEG * cosLat);
		const candidates = bboxQuery(lat, lon, dLat, dLon);
		let best: T | null = null;
		let bestD = Infinity;
		for (const entry of candidates) {
			const pos = cfg.posOf(entry.item);
			const dLatM = (pos.lat - lat) * M_PER_DEG;
			const dLonM = (pos.lon - lon) * M_PER_DEG * cosLat;
			const d = Math.sqrt(dLatM * dLatM + dLonM * dLonM);
			if (d > radiusM) {
				continue;
			}
			if (d < bestD) {
				bestD = d;
				best = entry.item;
			}
		}
		return best ? { item: best, distM: bestD } : null;
	}

	return {
		build,
		sync,
		redraw: () => layer?.redraw(),
		clear,
		highlight,
		setCues,
		hit,
		at,
		nearestUngated,
		built: () => layer !== null,
		highlightedKey: () => highlightedId,
	};
}

/* The single visibility chokepoint for SUP AIP zones. It subsets the loaded
 * dataset to the individual sub-zones in force during the evaluation window
 * (the supplement's validity, narrowed to the zone's own schedule where the
 * PDF published one) and passing the altitude filter, mirroring
 * visibleNotams() for NOTAMs: the map layer and any list read from here.
 * The window is activeEvalWindow(), shared with the activation hatch and the
 * SIGMET overlay: now onwards by default, so an expired supplement stops
 * drawing while an upcoming one still does, and the period condition's range when
 * the user sets one. Layer toggles are NOT applied here (they are
 * display-only: they decide what the map draws, never what this set
 * contains); the map layer applies its own toggle. Zones without geometry
 * are skipped. */

import { bandIntersects } from '$lib/vertical/limits';
import {
	activationRunsOverlap,
	exclusionSpan,
	hasDayRule,
	hasSunEnd,
	supZoneSun,
	sunWindow,
	validityEmpty,
	zoneSchedule,
	type SupAip,
	type SupAipActivation,
	type SupAipGeometry,
	type SupAipZone,
} from '$lib/data/supaip';
import type { SunLookup } from '$lib/notam/schedule';
import {
	circleAreaM2,
	equirectangularDistanceM,
	ringAreaM2,
} from '$lib/notam/geometry';
import { dataState, getSupaips } from './data.svelte';
import { activeAltitudeBand } from './filter.svelte';
import { layers } from './layers.svelte';
import { activeEvalWindow } from './notam.svelte';
import { parseSupZoneKey, supZoneKey } from './supaipLinks.svelte';
import { supNotamComing, supStates, type SupDrawState } from './zoneStates.svelte';

const DAY_MS = 86_400_000;

/** A single drawable zone with its parent supplement and index. */
export interface VisibleZone {
	sup: SupAip;
	zoneIndex: number;
	zone: SupAipZone;
}

/** Does the supplement's validity window overlap [from, to] (epoch ms UTC)?
 *  A missing bound is open-ended, and a validity that ends before it begins
 *  overlaps nothing. */
export function validityOverlaps(s: SupAip, from: number, to: number): boolean {
	if (validityEmpty(s)) {
		return false;
	}
	const start = s.validFrom ? Date.parse(s.validFrom + 'T00:00:00Z') : -Infinity;
	const end = s.validTo ? Date.parse(s.validTo + 'T23:59:59Z') : Infinity;
	return start <= to && end >= from;
}

/** Does one activation window overlap [from, to]? A range ("Du ... au ...") and
 *  a daily slot are both treated as one continuous block, which can only widen
 *  the window, so a zone is never wrongly hidden, and one with a day rule is a
 *  block per run of the days it holds (activationRunsOverlap). A slot whose end reads before
 *  its start runs past midnight, so its block ends the morning after the last
 *  day, where the alert volumes end it too (alertVolumes.ts
 *  supActivationWindows). An end of 24:00 (cmd/supaip keeps "2400" as
 *  printed) is the end of its day, and an end the sun sets the sun's at the
 *  zone (data/supaip.ts sunWindow). */
function activationOverlaps(a: SupAipActivation, from: number, to: number, sun?: SunLookup): boolean {
	if (hasDayRule(a)) {
		return activationRunsOverlap(a, from, to, sun);
	}
	if (hasSunEnd(a)) {
		const first = Date.parse(`${a.date}T00:00:00Z`);
		const last = Date.parse(`${a.dateTo || a.date}T00:00:00Z`);
		if (!Number.isFinite(first) || !Number.isFinite(last)) {
			return true;
		}
		return sunWindow(a, first, sun)[0] <= to && sunWindow(a, last, sun)[1] >= from;
	}
	const start = Date.parse(`${a.date}T${a.from || '00:00'}:00Z`);
	const close = !a.to || a.to === '24:00' ? '23:59' : a.to;
	let end = Date.parse(`${a.dateTo || a.date}T${close}:59Z`);
	if (a.from && a.to && a.to <= a.from) {
		end += DAY_MS;
	}
	return start <= to && end >= from;
}

/** Does the zone show in the date window? A zone with parsed activations uses
 *  them, cut to the supplement's validity (zoneSchedule), and shows when any
 *  overlaps. One without falls back to the supplement's validity, so coverage
 *  gaps never hide a zone. */
function zoneDateOverlaps(s: SupAip, z: SupAipZone, from: number, to: number): boolean {
	const schedule = zoneSchedule(s, z);
	if (schedule) {
		const sun = supZoneSun(s, z);
		return schedule.some((a) => activationOverlaps(a, from, to, sun));
	}
	return validityOverlaps(s, from, to);
}

/** Does the zone's vertical extent overlap [floor, ceiling] (feet)? Null
 *  limits are unbounded, so a zone with unknown altitudes is never hidden.
 *  Same datum-aware conservative test as the airspace overlay. */
function altOverlaps(z: SupAipZone, floor: number, ceiling: number): boolean {
	return bandIntersects(z.vLower, z.vUpper, { floor, ceiling });
}

let zonesCache: {
	all: SupAip[] | null;
	from: number;
	to: number;
	band: string;
	out: VisibleZone[];
} | null = null;

/** SUP AIP zones in force during the evaluation window (per supplement, or
 *  per zone where it has its own schedule) and passing the altitude filter.
 *  Reads reactive filter state and, through activeEvalWindow's default
 *  branch, the minute tick, so callers inside $derived / $effect re-run when
 *  a filter changes and as a supplement's validity slips behind now.
 *
 *  The answer is kept while its inputs hold: supaipZonesAt calls this on
 *  MapView's per-frame cursor loop, and the cost is not the ring tests
 *  (0.1 ms for ~900 zones) but the Date.parse pairs inside zoneDateOverlaps,
 *  over a millisecond a frame rebuilt for nothing. Reference-compared like
 *  partitionByWindow's own split in notam.svelte.ts, and SHARED the same way:
 *  the array is the cache, so a caller that needs to add to it copies
 *  (MapView's selection top-up does) and none may sort it in place. */
export function visibleSupaipZones(): VisibleZone[] {
	// Every reactive input read unconditionally, ahead of the cache check (the
	// memoSelector contract). getSupaips reads a plain module variable, so the
	// flag is what wakes a caller when the dataset lands, exactly as
	// supaipsInForce does.
	void dataState.supaipLoaded;
	const all = getSupaips();
	const win = activeEvalWindow();
	const band = activeAltitudeBand();
	const bandKey = band ? `${band.floor},${band.ceiling}` : '';
	if (
		zonesCache &&
		zonesCache.all === all &&
		zonesCache.from === win.from &&
		zonesCache.to === win.to &&
		zonesCache.band === bandKey
	) {
		return zonesCache.out;
	}
	const out: VisibleZone[] = [];
	if (!all) {
		zonesCache = { all, from: win.from, to: win.to, band: bandKey, out };
		return out;
	}
	for (const sup of all) {
		sup.zones.forEach((zone, zoneIndex) => {
			if (!zone.geometry) {
				return;
			}
			if (!zoneDateOverlaps(sup, zone, win.from, win.to)) {
				return;
			}
			if (band && !altOverlaps(zone, band.floor, band.ceiling)) {
				return;
			}
			out.push({ sup, zoneIndex, zone });
		});
	}
	zonesCache = { all, from: win.from, to: win.to, band: bandKey, out };
	return out;
}

/** The supplements IN FORCE over the evaluation window: the briefing list,
 *  which is not the same set as the drawable one. A supplement whose PDF
 *  yielded no coordinates, or that creates no zone at all (a VAC amendment,
 *  a reporting-point move), draws nothing and is still something the pilot
 *  has to have read; visibleSupaipZones answers the MAP's question and
 *  would leave those out. A supplement counts when any of its zones
 *  overlaps on its own schedule, else on its own validity. */
export function supaipsInForce(): SupAip[] {
	// The flag, not just the rows: getSupaips reads a plain module variable,
	// so without this a caller inside a derived never wakes when the
	// supplements land and the list stays empty for the session (the map's
	// own call site does the same at MapView).
	void dataState.supaipLoaded;
	const all = getSupaips();
	if (!all) {
		return [];
	}
	const win = activeEvalWindow();
	return all.filter((sup) =>
		sup.zones.length > 0
			? sup.zones.some((zone) => zoneDateOverlaps(sup, zone, win.from, win.to))
			: validityOverlaps(sup, win.from, win.to),
	);
}

/** Ray-casting point-in-polygon for a [lat, lon] ring. */
function pointInRing(lat: number, lon: number, ring: [number, number][]): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const yi = ring[i][0];
		const xi = ring[i][1];
		const yj = ring[j][0];
		const xj = ring[j][1];
		if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}

/** The footprint (m²) of the PIECE of this zone containing the point, or
 *  null when the point is outside it, or in a sector going through the
 *  zone's whole band, which the map draws as a hole (exclusionSpan). A
 *  multipolygon zone has to rank as the piece you are in and not as their
 *  sum: two sub-areas 200 km apart are two drawn shapes, and the sum would
 *  make the small one under the cursor lose to a medium airspace in the
 *  click resolver's ranking. */
function zoneHitAreaM2(z: SupAipZone, lat: number, lon: number): number | null {
	if (z.exclusions.some((e) => exclusionSpan(z, e) === 'through' && geometryHitAreaM2(e.geometry, lat, lon) != null)) {
		return null;
	}
	return geometryHitAreaM2(z.geometry, lat, lon);
}

function geometryHitAreaM2(g: SupAipGeometry | null, lat: number, lon: number): number | null {
	if (!g) {
		return null;
	}
	if (g.type === 'polygon') {
		return pointInRing(lat, lon, g.ring) ? ringAreaM2(g.ring) : null;
	}
	if (g.type === 'multipolygon') {
		let best: number | null = null;
		for (const r of g.rings) {
			if (!pointInRing(lat, lon, r)) {
				continue;
			}
			const a = ringAreaM2(r);
			if (best == null || a < best) {
				best = a;
			}
		}
		return best;
	}
	return equirectangularDistanceM(lat, lon, g.center[0], g.center[1]) <= g.radiusM
		? circleAreaM2(g.radiusM)
		: null;
}

function zoneContains(z: SupAipZone, lat: number, lon: number): boolean {
	return zoneHitAreaM2(z, lat, lon) != null;
}

/** A supplement zone the layer draws, with its state: active on its own
 *  published period (the hatch), may be active (the band inside its
 *  boundary) or later in the period (a dashed outline). */
export interface DrawnSupZone extends VisibleZone {
	state: Extract<SupDrawState, 'active' | 'may' | 'later'>;
}

let drawnCache: {
	states: ReadonlyMap<string, SupDrawState>;
	coming: ReadonlySet<string>;
	visible: VisibleZone[];
	band: string;
	hatch: ReadonlySet<string>;
	layer: DrawnSupZone[];
	notam: DrawnSupZone[];
} | null = null;

/** What the map draws of the supplements' zones (state/zoneStates.svelte.ts
 *  supStates): the activation hatch, the zones a NOTAM or the pilot's note
 *  activates over the viewed time inside the level band, whatever the
 *  layer's toggle; and the layer, the zones of the viewing period
 *  (visibleSupaipZones) active on their own published period, that may be
 *  active, or that become either later, those a NOTAM of the period
 *  activates later drawn whatever the toggle (`notam`, supNotamComing). An
 *  inactive zone is drawn by neither. */
function drawnSupZones(): { hatch: ReadonlySet<string>; layer: DrawnSupZone[]; notam: DrawnSupZone[] } {
	const states = supStates();
	const coming = supNotamComing();
	const visible = visibleSupaipZones();
	const band = activeAltitudeBand();
	const bandKey = band ? `${band.floor},${band.ceiling}` : '';
	if (
		drawnCache &&
		drawnCache.states === states &&
		drawnCache.coming === coming &&
		drawnCache.visible === visible &&
		drawnCache.band === bandKey
	) {
		return drawnCache;
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a memo's output, rebuilt whole
	const hatch = new Set<string>();
	const all = getSupaips() ?? [];
	for (const sup of all) {
		sup.zones.forEach((zone, i) => {
			const key = supZoneKey(sup.id, i);
			if (zone.geometry && states.get(key) === 'activated' && (!band || altOverlaps(zone, band.floor, band.ceiling))) {
				hatch.add(key);
			}
		});
	}
	const layer: DrawnSupZone[] = [];
	for (const it of visible) {
		const state = states.get(supZoneKey(it.sup.id, it.zoneIndex));
		if (state === 'active' || state === 'may' || state === 'later') {
			layer.push({ ...it, state });
		}
	}
	const notam = layer.filter((z) => coming.has(supZoneKey(z.sup.id, z.zoneIndex)));
	drawnCache = { states, coming, visible, band: bandKey, hatch, layer, notam };
	return drawnCache;
}

/** The zone keys the activation hatch draws, whatever the layer's toggle:
 *  those a NOTAM or the pilot's note activates. */
export function supHatchZones(): ReadonlySet<string> {
	return drawnSupZones().hatch;
}

/** The zones the SUP AIP layer draws while it is on. */
export function supLayerZones(): DrawnSupZone[] {
	return drawnSupZones().layer;
}

/** The zones the layer draws while it is off: those a NOTAM of the
 *  viewing period activates later (supNotamComing), beside its marker. */
export function supNotamZones(): DrawnSupZone[] {
	return drawnSupZones().notam;
}

/** The zones a selection adds to those the layer draws (`drawn`): the zone
 *  it names, else every zone of a supplement selected whole, each the
 *  layer leaves undrawn, in the state the map gives it, so a selected zone
 *  keeps its look whatever the toggle and the other zones of its
 *  supplement stay as the map draws them. A zone inactive over the viewed
 *  time comes without a state. */
export function supSelectionZones(
	sel: SupAip,
	zone: number | undefined,
	drawn: readonly VisibleZone[],
): (VisibleZone | DrawnSupZone)[] {
	const states = supStates();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a lookup local to one call
	const have = new Set(drawn.filter((it) => it.sup.id === sel.id).map((it) => it.zoneIndex));
	return sel.zones.flatMap((z, zoneIndex) => {
		if (z.geometry === null || have.has(zoneIndex) || (zone !== undefined && zone !== zoneIndex)) {
			return [];
		}
		const s = states.get(supZoneKey(sel.id, zoneIndex));
		const state = s === 'activated' ? 'active' : s;
		return [state === 'active' || state === 'may' || state === 'later' ? { sup: sel, zoneIndex, zone: z, state } : { sup: sel, zoneIndex, zone: z }];
	});
}

/** Is the zone `key` drawn: by the hatch, by the layer while it is on, or
 *  by it while it is off where a NOTAM activates the zone later? */
export function supZoneDrawn(key: string): boolean {
	const d = drawnSupZones();
	const drawn = layers.supaip ? d.layer : d.notam;
	return d.hatch.has(key) || drawn.some((z) => supZoneKey(z.sup.id, z.zoneIndex) === key);
}

/** The SUP AIP zones stacked under a point, for the right-click context menu
 *  (and, gated, the left-click hit-test via supaipAt). Deliberately NOT gated
 *  by the layers.supaip toggle: the menu is a "what's here?" location query,
 *  so it lists every zone passing the evaluation-window / altitude data
 *  filters (visibleSupaipZones), PLUS any zone the hatch draws even when
 *  those filters hide it, mirroring the activated-airspace exception in
 *  airspaceLayer's visibleEntriesAt. */
export function supaipZonesAt(lat: number, lon: number): VisibleZone[] {
	const out: VisibleZone[] = [];
	// Local, intentionally non-reactive dedup index by supZoneKey.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const seen = new Set<string>();
	for (const it of visibleSupaipZones()) {
		if (zoneContains(it.zone, lat, lon)) {
			out.push(it);
			seen.add(supZoneKey(it.sup.id, it.zoneIndex));
		}
	}
	// Active zones are hatched whatever the toggle and the window filter, so
	// keep them in the list: they are on screen and a click reaches them,
	// including under the very NOTAM area that activated them, which is what
	// the area tier in featureAt is for (docs/map-hit-testing.md). The hatch
	// is empty until the dataset loads, so this is free when no SUP is in
	// play.
	const activated = [...supHatchZones()];
	if (activated.length > 0) {
		const all = getSupaips();
		if (all) {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
			const byId = new Map(all.map((s) => [s.id, s]));
			for (const key of activated) {
				if (seen.has(key)) {
					continue;
				}
				const parsed = parseSupZoneKey(key);
				const sup = parsed && byId.get(parsed.supId);
				const zone = sup && sup.zones[parsed.zoneIndex];
				if (sup && zone && zoneContains(zone, lat, lon)) {
					out.push({ sup, zoneIndex: parsed.zoneIndex, zone });
					seen.add(key);
				}
			}
		}
	}
	return out;
}

/** A SUP AIP zone under the point, with the footprint of the drawn piece that
 *  contained it: what the click resolver ranks against the other area kinds. */
export interface SupaipAreaHit {
	zone: VisibleZone;
	areaM2: number;
}

/** The single SUP AIP zone a left-click should select: the smallest one under
 *  the point (so overlapping zones resolve to the most specific). Unlike the
 *  context-menu list, the click is WYSIWYG: a zone captures a click only
 *  where it is drawn (supZoneDrawn), the hatch of an active zone whatever
 *  the toggle, the band or the outline the layer draws while it is on. Null
 *  when nothing clickable is under the point.
 *
 *  Ranked by the true ring area, not by the bbox this used to compare: a bbox
 *  overstates a thin diagonal corridor several-fold, which is exactly the
 *  shape a drone ZRT takes, and "the most specific" has to mean the shape. */
export function supaipAreaAt(lat: number, lon: number): SupaipAreaHit | null {
	const hits = supaipZonesAt(lat, lon).filter((h) => supZoneDrawn(supZoneKey(h.sup.id, h.zoneIndex)));
	let best: SupaipAreaHit | null = null;
	for (const h of hits) {
		const areaM2 = zoneHitAreaM2(h.zone, lat, lon);
		if (areaM2 == null) {
			continue;
		}
		if (!best || areaM2 < best.areaM2) {
			best = { zone: h, areaM2 };
		}
	}
	return best;
}

/** The same answer without the footprint, for callers that only need the row. */
export function supaipAt(lat: number, lon: number): VisibleZone | null {
	return supaipAreaAt(lat, lon)?.zone ?? null;
}

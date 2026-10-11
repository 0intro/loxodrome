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
import type { SupAip, SupAipActivation, SupAipGeometry, SupAipZone } from '$lib/data/supaip';
import {
	circleAreaM2,
	equirectangularDistanceM,
	ringAreaM2,
} from '$lib/notam/geometry';
import { dataState, getSupaips } from './data.svelte';
import { activeAltitudeBand } from './filter.svelte';
import { layers } from './layers.svelte';
import { activeEvalWindow } from './notam.svelte';
import { parseSupZoneKey, supZoneActivations, supZoneKey } from './supaipLinks.svelte';

/** A single drawable zone with its parent supplement and index. */
export interface VisibleZone {
	sup: SupAip;
	zoneIndex: number;
	zone: SupAipZone;
}

/** Does the supplement's validity window overlap [from, to] (epoch ms UTC)?
 *  A missing bound is open-ended. */
function validityOverlaps(s: SupAip, from: number, to: number): boolean {
	const start = s.validFrom ? Date.parse(s.validFrom + 'T00:00:00Z') : -Infinity;
	const end = s.validTo ? Date.parse(s.validTo + 'T23:59:59Z') : Infinity;
	return start <= to && end >= from;
}

/** Does one activation window overlap [from, to]? A range ("Du ... au ...") and
 *  a daily slot are both treated as one continuous block, which can only widen
 *  the window, so a zone is never wrongly hidden. */
function activationOverlaps(a: SupAipActivation, from: number, to: number): boolean {
	const start = Date.parse(`${a.date}T${a.from || '00:00'}:00Z`);
	const end = Date.parse(`${a.dateTo || a.date}T${a.to || '23:59'}:59Z`);
	return start <= to && end >= from;
}

/** Does the zone show in the date window? A zone with parsed activations uses
 *  them (visible when any overlaps); one without falls back to the supplement's
 *  validity, so coverage gaps never hide a zone. */
function zoneDateOverlaps(s: SupAip, z: SupAipZone, from: number, to: number): boolean {
	if (z.activations.length > 0) {
		return z.activations.some((a) => activationOverlaps(a, from, to));
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

/** The footprint (m²) of the PIECE of this geometry containing the point, or
 *  null when the point is outside it. A multipolygon zone has to rank as the
 *  piece you are in and not as their sum: two sub-areas 200 km apart are two
 *  drawn shapes, and the sum would make the small one under the cursor lose to
 *  a medium airspace in the click resolver's ranking. */
function zoneHitAreaM2(
	g: SupAipGeometry | null,
	lat: number,
	lon: number,
): number | null {
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

function zoneContains(g: SupAipGeometry | null, lat: number, lon: number): boolean {
	return zoneHitAreaM2(g, lat, lon) != null;
}

/** The SUP AIP zones stacked under a point, for the right-click context menu
 *  (and, gated, the left-click hit-test via supaipAt). Deliberately NOT gated
 *  by the layers.supaip toggle: the menu is a "what's here?" location query,
 *  so it lists every zone passing the evaluation-window / altitude data
 *  filters (visibleSupaipZones), PLUS any zone activated by a NOTAM even
 *  when those filters hide it: the magenta hatch (supaipActivationLayer) is
 *  drawn regardless, mirroring the activated-airspace exception in
 *  airspaceLayer's visibleEntriesAt. */
export function supaipZonesAt(lat: number, lon: number): VisibleZone[] {
	const out: VisibleZone[] = [];
	// Local, intentionally non-reactive dedup index by supZoneKey.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const seen = new Set<string>();
	for (const it of visibleSupaipZones()) {
		if (zoneContains(it.zone.geometry, lat, lon)) {
			out.push(it);
			seen.add(supZoneKey(it.sup.id, it.zoneIndex));
		}
	}
	// Activated zones are hatched whatever the toggle and the window /
	// altitude filters, so keep them in the list: the stripes are on screen and
	// a click reaches them, including under the very NOTAM area that activated
	// them, which is what the area tier in featureAt is for
	// (docs/map-hit-testing.md). supZoneActivations is empty until the dataset
	// loads, so this is free when no SUP is in play.
	const activated = supZoneActivations();
	if (activated.size > 0) {
		const all = getSupaips();
		if (all) {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
			const byId = new Map(all.map((s) => [s.id, s]));
			for (const key of activated.keys()) {
				if (seen.has(key)) {
					continue;
				}
				const parsed = parseSupZoneKey(key);
				const sup = parsed && byId.get(parsed.supId);
				const zone = sup && sup.zones[parsed.zoneIndex];
				if (sup && zone && zoneContains(zone.geometry, lat, lon)) {
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
 *  context-menu list, the click is WYSIWYG: with the layer off only the
 *  NOTAM-activated zones are drawn (the magenta hatch), so only those may
 *  capture a click. Null when nothing clickable is under the point.
 *
 *  Ranked by the true ring area, not by the bbox this used to compare: a bbox
 *  overstates a thin diagonal corridor several-fold, which is exactly the
 *  shape a drone ZRT takes, and "the most specific" has to mean the shape. */
export function supaipAreaAt(lat: number, lon: number): SupaipAreaHit | null {
	let hits = supaipZonesAt(lat, lon);
	if (!layers.supaip) {
		const activated = supZoneActivations();
		hits = hits.filter((h) => activated.has(supZoneKey(h.sup.id, h.zoneIndex)));
	}
	let best: SupaipAreaHit | null = null;
	for (const h of hits) {
		const areaM2 = zoneHitAreaM2(h.zone.geometry, lat, lon);
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

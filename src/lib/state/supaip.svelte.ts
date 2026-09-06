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
import { equirectangularDistanceM } from '$lib/notam/geometry';
import { getSupaips } from './data.svelte';
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

/** SUP AIP zones in force during the evaluation window (per supplement, or
 *  per zone where it has its own schedule) and passing the altitude filter.
 *  Reads reactive filter state and, through activeEvalWindow's default
 *  branch, the minute tick, so callers inside $derived / $effect re-run when
 *  a filter changes and as a supplement's validity slips behind now. */
export function visibleSupaipZones(): VisibleZone[] {
	const all = getSupaips();
	if (!all) {
		return [];
	}
	const win = activeEvalWindow();
	const band = activeAltitudeBand();
	const out: VisibleZone[] = [];
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
	return out;
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

function zoneContains(g: SupAipGeometry | null, lat: number, lon: number): boolean {
	if (!g) {
		return false;
	}
	if (g.type === 'polygon') {
		return pointInRing(lat, lon, g.ring);
	}
	if (g.type === 'multipolygon') {
		return g.rings.some((r) => pointInRing(lat, lon, r));
	}
	return equirectangularDistanceM(lat, lon, g.center[0], g.center[1]) <= g.radiusM;
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
	// altitude filters, so keep them in the list (the stripes are on screen and a
	// click, especially under a NOTAM area, is expected to reach them).
	// supZoneActivations is empty until the dataset loads, so this is free
	// when no SUP is in play.
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

function bboxArea(b: SupAip['bbox']): number {
	return b ? (b.maxLat - b.minLat) * (b.maxLon - b.minLon) : Infinity;
}

/** The single SUP AIP zone a left-click should select: the smallest one under
 *  the point (so overlapping zones resolve to the most specific). Unlike the
 *  context-menu list, the click is WYSIWYG: with the layer off only the
 *  NOTAM-activated zones are drawn (the magenta hatch), so only those may
 *  capture a click. Null when nothing clickable is under the point. */
export function supaipAt(lat: number, lon: number): VisibleZone | null {
	let hits = supaipZonesAt(lat, lon);
	if (!layers.supaip) {
		const activated = supZoneActivations();
		hits = hits.filter((h) => activated.has(supZoneKey(h.sup.id, h.zoneIndex)));
	}
	if (hits.length === 0) {
		return null;
	}
	let best = hits[0];
	for (const h of hits) {
		if (bboxArea(h.zone.bbox) < bboxArea(best.zone.bbox)) {
			best = h;
		}
	}
	return best;
}

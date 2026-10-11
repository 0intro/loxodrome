/* Which airspaces the vertical profiles plot, and WHAT THEY LEFT OUT.
 * Applied at this single chokepoint so every profile (AltitudeProfile,
 * MapProfileModal) and the right-click action agree:
 *   - the pilot's airspace filter ROWS apply, and aerial activity is one of
 *     them now (default OFF, so the stack reads as it always has until the
 *     pilot asks for it);
 *   - the rest of the rows apply (the Garmin-style kind filter
 *     the two chart profiles share, docs/route-profile.md "Airspace
 *     filter"), the structural background included, which answers to its
 *     own `fir` and `siv` rows; a prohibited area names no row and so is
 *     never hidden;
 *   - the active altitude filter always applies (out-of-band airspaces are
 *     never plotted, matching the map);
 *   - the global all-vs-on-map toggle (display.profileAllAirspaces) then
 *     restricts to map-visible airspaces when it is off.
 *
 * The COUNTS matter as much as the set. Every one of those three can empty a
 * profile outright: the map scope does it out of the box, since every airspace
 * category ships off. An emptied chart that says nothing is not a blank chart,
 * it is a chart asserting clear sky, and `airspaceAbove` cannot tell the two
 * apart (an empty column list and a genuinely open sky are the same value
 * there). So the filtering reports its own work and the surfaces print it.
 *
 * Reads of display / layers / filter here are tracked when these run inside a
 * component $derived. */

import { airspaceGroupShown, type Airspace } from '$lib/data/airspaces';
import { bandIntersects } from '$lib/vertical/limits';
import { profileAirspaceGroups } from './profileAirspaceFilter.svelte';
import { layers } from './layers.svelte';
import { display } from './display.svelte';
import { activeAltitudeBand } from './filter.svelte';

/* The "Show only route airspaces" set as the map applies it, published by
 * MapView beside setRouteAirspaceFilter, null while that filter is off. With
 * it on, the map draws exactly these, every category forced on: an on-map
 * test reading the category toggles alone counted the wrong airspaces as
 * "not drawn on the map". The NOTAM Viewer has no route and leaves it null. */
const routeOnly = $state<{ keys: ReadonlySet<string> | null }>({ keys: null });

export function setRouteOnlyAirspaces(keys: ReadonlySet<string> | null): void {
	routeOnly.keys = keys;
}

/** True when the airspace is currently drawn on the map: its publisher
 *  enabled in the Layers menu, and its category, or while "Show only route
 *  airspaces" is on, a route flying through it. */
export function airspaceShownOnMap(a: Airspace): boolean {
	if (!layers.publisher[a.source]) {
		return false;
	}
	const keys = routeOnly.keys;
	return keys ? keys.has(a.key) : layers.airspace[a.category];
}

/** Does the airspace's vertical extent overlap the altitude band? Mirrors the
 *  map's filter (airspaceLayer's entryPassesAltitude): datum-aware and
 *  conservative, a missing side is unbounded. */
export function airspaceInBand(
	a: Airspace,
	band: { floor: number; ceiling: number },
): boolean {
	return bandIntersects(a.vLower, a.vUpper, band);
}

/** What a profile plots, and what it left out. The three counts partition the
 *  DROPPED rows by their FIRST cause, in the order the filters apply, so each
 *  one names the single control that would bring those rows back. */
export interface ProfileScope {
	/** The airspaces to plot. */
	shown: Airspace[];
	/** Dropped by the pilot's airspace filter rows (the chart's funnel). */
	hiddenRows: number;
	/** Dropped by the viewing conditions' level band. */
	hiddenBand: number;
	/** Dropped by the "only what the map draws" scope. */
	hiddenScope: number;
}

/* Whether the header's airspace-above figure survives all this is NOT a count
 * and is deliberately not here: "was anything hidden" is the wrong question,
 * and answering it suppressed the figure over every French field, the level
 * band shipping on at 0-10 000 ft with a UTA slab above every stack. The right
 * one is "would the answer have been different", which needs the point's
 * GROUND to resolve each base against and so belongs to the surfaces, one
 * `aboveIsComplete` beside the `airspaceAbove` they already compute. */

/** The airspaces a vertical profile should plot, with the reason for each one
 *  it dropped. The pilot's filter rows and the active altitude filter always
 *  apply (aerial activity is one of those rows now, default off, so the stack
 *  reads as it always did until it is asked for); the global all-vs-on-map
 *  toggle additionally restricts to airspaces shown on the map when it is off.
 *
 *  `keepKey` is the airspace a panel is ABOUT, which no filter may hide: its
 *  own detail page is the one place an activity zone has to appear. It is kept
 *  IN PLACE rather than prepended, the input already being in band order, and
 *  it is kept out of the counts, which is the point of passing it here rather
 *  than re-adding it downstream: a note reading "1 hidden" beside the column
 *  it names would be its own contradiction. */
export function profileScope(list: Airspace[], keepKey?: string | null): ProfileScope {
	const band = activeAltitudeBand();
	const onMapOnly = !display.profileAllAirspaces;
	const out: ProfileScope = { shown: [], hiddenRows: 0, hiddenBand: 0, hiddenScope: 0 };
	for (const a of list) {
		if (keepKey != null && a.key === keepKey) {
			out.shown.push(a);
			continue;
		}
		if (airspaceGroupShown(a, profileAirspaceGroups)) {
			if (!band || airspaceInBand(a, band)) {
				if (!onMapOnly || airspaceShownOnMap(a)) {
					out.shown.push(a);
					continue;
				}
				out.hiddenScope++;
			} else {
				out.hiddenBand++;
			}
		} else {
			out.hiddenRows++;
		}
	}
	return out;
}

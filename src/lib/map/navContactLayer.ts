/* navContactLayer.ts: the navigation-mode "airspace to contact" emphasis. Two
 * standalone polygon clones (the emphasis-clone idiom, emphasisClones.ts) on
 * their own pane: the CURRENT contact solid, the NEXT contact dashed, both in
 * the nav identity orange so the pair reads as live-navigation state, not as
 * an airspace category ink. Drawn regardless of every category / publisher /
 * altitude / route filter by construction (own pane, own reconcile); the
 * polygons are non-interactive, and map-clickability rides airspaceLayer's
 * hit-test through navContactKeys(), the linkedOverlays exception family.
 * Fed imperatively from a MapView effect reading state/navLive; this
 * module holds no reactive state and never imports it (state -> MapView ->
 * layer). */

import L from 'leaflet';
import { createCloneLayer } from './emphasisClones';
import type { Airspace } from '$lib/data/airspaces';

const PANE = 'nav-contact';
// 372 sits above the activation hatch (370) and below the obstacle glyphs
// (380): over all airspace context, under point symbols and NOTAM features.
const PANE_Z = '372';

/** The nav identity orange (navLayer's TRACE_COLOR family; app-identity
 *  colours stay out of palette.ts by charter). */
const CONTACT_COLOR = '#e8590c';
const CURRENT_STYLE: L.PathOptions = {
	color: CONTACT_COLOR,
	weight: 4,
	opacity: 0.95,
	fillColor: CONTACT_COLOR,
	fillOpacity: 0.12,
};
// Dashed = upcoming, echoing the trajectory vector's dashed-future language
// (different dash pattern and weight, so the two never read as one mark).
const NEXT_STYLE: L.PathOptions = {
	color: CONTACT_COLOR,
	weight: 3,
	opacity: 0.85,
	dashArray: '10 8',
	fillColor: CONTACT_COLOR,
	fillOpacity: 0.06,
};

interface ContactItem {
	slot: 'current' | 'next';
	airspace: Airspace;
}

// Reconciled by SLOT (two stable keys), so swapping the occupant rebuilds
// the slot in place; the hit-test keys are the occupants' row keys.
const clones = createCloneLayer<ContactItem>({
	pane: PANE,
	paneZ: PANE_Z,
	keyOf: (it) => it.slot,
	sigOf: (it) => it.airspace.key,
	geometryOf: (it, opts) => L.polygon(it.airspace.ring, opts),
	styleOf: (it) => (it.slot === 'current' ? CURRENT_STYLE : NEXT_STYLE),
	hitKeyOf: (it) => it.airspace.key,
});

/** Reconcile the two emphasis clones against the requested current / next
 *  airspaces (null clears a slot). Idempotent. */
export function syncNavContact(m: L.Map, current: Airspace | null, next: Airspace | null): void {
	const items: ContactItem[] = [];
	if (current) {
		items.push({ slot: 'current', airspace: current });
	}
	if (next) {
		items.push({ slot: 'next', airspace: next });
	}
	clones.sync(m, items);
}

/** The row keys currently emphasised, for airspaceLayer's hit-test: the user
 *  sees the contact clones and expects to click them even with the category
 *  toggle off. */
export function navContactKeys(): ReadonlySet<string> {
	return clones.keys();
}

/** Teardown before the map goes (HMR / remount): drop the clones and the
 *  dead-map renderer handle. */
export function clearNavContact(m: L.Map): void {
	clones.clear(m);
}

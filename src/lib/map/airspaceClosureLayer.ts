/* airspaceClosureLayer.ts: the airspaces whose published radio a NOTAM has
 * withdrawn, drawn so the map says it without being asked.
 *
 * The navContactLayer idiom over an N-set (navAlertLayer's shape): one
 * standalone clone per closed row through emphasisClones.ts, own pane, drawn
 * regardless of every category / publisher / altitude / route filter by
 * construction. That ungating is the whole point. The FIS categories are OFF
 * out of the box, so a sector whose service is out would otherwise be invisible
 * on a map that knows perfectly well it is out: A5453/26 closes SIV BEAUVAIS 2
 * and, before this layer, drew nothing anywhere on the chart.
 *
 * The mark is a DASHED BOUNDARY IN THE SECTOR'S OWN GREEN, with no fill.
 * Three deliberate restraints:
 *
 *  - no fill, because chart-faithful interiors carry none at rest
 *    (docs/airspace-symbology.md) and this is a resting state, not a hover;
 *  - the sector's own ink rather than a warning colour, because a closed
 *    radio is not a hazard: nobody answers, the airspace is unchanged, and
 *    the published unit underneath is already the designated substitute;
 *  - dashed rather than the activation hatch, which means the opposite thing
 *    (a zone switched ON, stay out). Borrowing it would conflate the two.
 *
 * There is deliberately NO emphasis setter here, unlike the activation hatch.
 * That hatch is keyed by shared airspace id on a pane of its own and is not
 * what highlightAirspace clones, so it has to carry its own selected state;
 * these clones are keyed by the same row `key` as airspaceLayer's highlight
 * clones, which already draw a selected row whose own polygon is hidden. A
 * second widening would be redundant, and setEmphasis restores a hard-coded
 * stroke width of 2 that is not this layer's.
 *
 * Non-interactive, like every filled overlay; map-clickability rides
 * airspaceLayer's hit-test through airspaceClosureKeys(), the same exception
 * family as the activation hatch and the contact clones. Fed imperatively from
 * a MapView / NotamMapView effect reading state/freqOverride; this module holds
 * no reactive state and never imports it (state -> component -> layer). */

import L from 'leaflet';
import { createCloneLayer } from './emphasisClones';
import type { Airspace } from '$lib/data/airspaces';
import { DARK, SIA } from './palette';

const PANE = 'airspaces-closed';
// 371 sits directly above the activation hatch (370) and below the
// navigation-mode contact emphasis (372): with the rest of the "a NOTAM said
// something about this airspace" family, under everything the pilot aims at.
const PANE_Z = '371';

/** The FIS green's dark companion, the same ink the sector's own boundary and
 *  label carry (palette.ts). */
const CLOSED_COLOR = DARK[SIA.siv] ?? SIA.siv;

const CLOSED_STYLE: L.PathOptions = {
	color: CLOSED_COLOR,
	weight: 2.5,
	opacity: 0.95,
	// Long dash, short gap: a boundary that is drawn but not answering. The
	// contact clones' upcoming-state dash is '10 8' at weight 3 and the alert
	// tiers' is '4 5', so no two of the three read as one mark.
	dashArray: '7 5',
	fill: false,
};

// Reconciled by row key; a row that stops being closed loses its clone.
// geomRefOf is the ring itself, so a row whose GEOMETRY changes under an
// unchanged key rebuilds rather than keeping the old outline: a coverage
// extension re-merges the airspace datasets in source order, and a key a
// higher-priority publisher also carries comes back as a different row. This
// set lives as long as the briefing does, so a stale ring would sit there.
const clones = createCloneLayer<Airspace>({
	pane: PANE,
	paneZ: PANE_Z,
	keyOf: (a) => a.key,
	geomRefOf: (a) => a.ring,
	geometryOf: (a, opts) => L.polygon(a.ring, opts),
	styleOf: () => CLOSED_STYLE,
});

/** Reconcile the closed-airspace clones against the rows currently closed.
 *  Idempotent; an empty list clears the layer. */
export function syncAirspaceClosures(m: L.Map, rows: readonly Airspace[]): void {
	clones.sync(m, rows);
}

/** The row keys currently drawn as closed, for airspaceLayer's hit-test: the
 *  user can see the sector and expects to click it even with the FIS category
 *  off, which is the normal case since it is off by default. */
export function airspaceClosureKeys(): ReadonlySet<string> {
	return clones.keys();
}

/** Teardown before the map goes (HMR / remount): drop the clones and the
 *  dead-map renderer handle. */
export function clearAirspaceClosures(m: L.Map): void {
	clones.clear(m);
}

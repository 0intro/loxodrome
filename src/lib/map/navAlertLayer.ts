/* navAlertLayer.ts: the live airspace-alert emphasis. The navContactLayer
 * idiom generalised to an N-set: one standalone clone per alerted volume
 * (rings and circles both, a volume can be either), keyed reconcile via
 * emphasisClones.ts, own pane, drawn regardless of every category /
 * publisher / altitude / route filter by construction. Planned advisories
 * are NOT drawn: the contact clones already emphasise the briefed
 * traversal, and a second outline on the same volume would read as two
 * states. Non-interactive; airspace-row clickability rides airspaceLayer's
 * hit-test through navAlertKeys(), the linkedOverlays exception family.
 * Fed imperatively from a MapView effect reading state/airspaceAlert; this
 * module holds no reactive state. */

import L from 'leaflet';
import { createCloneLayer } from './emphasisClones';
import { SEVERITY_RANK, type VolumeAlert } from '$lib/nav/airspaceAlert';

const PANE = 'nav-alert';
// 373 sits above the contact clones (372) and below the obstacle glyphs
// (380): alert emphasis over the briefed-contact emphasis, under symbols.
const PANE_Z = '373';

/** Mirrors theme.css --danger (day); Leaflet paths need a concrete colour,
 *  the --supaip precedent. */
const DANGER = '#d40000';
/** Mirrors theme.css --workbook-orange (day), the caution amber. */
const CAUTION = '#9e6400';

function styleFor(a: VolumeAlert): L.PathOptions {
	// Present tense doubles the fill wash, the banner's solid form on the
	// map: the aircraft is IN the volume, not heading for it.
	const inside = a.severity === 'inside' && !a.acked;
	if (a.action === 'avoid') {
		return {
			color: DANGER,
			weight: 4,
			opacity: a.acked ? 0.5 : 0.95,
			fillColor: DANGER,
			fillOpacity: a.acked ? 0.06 : inside ? 0.28 : 0.14,
		};
	}
	if (a.action === 'caution') {
		return {
			color: CAUTION,
			weight: 2,
			opacity: a.acked ? 0.4 : 0.8,
			dashArray: '4 5',
			fillColor: CAUTION,
			fillOpacity: inside ? 0.08 : 0.04,
		};
	}
	// The clearance / equipment tiers: the danger ink one step back, dashed
	// like the not-yet state of the contact clones.
	return {
		color: DANGER,
		weight: 3,
		opacity: a.acked ? 0.35 : 0.7,
		dashArray: '10 8',
		fillColor: DANGER,
		fillOpacity: a.acked ? 0.03 : inside ? 0.16 : 0.08,
	};
}

/** Style-relevant identity of a drawn alert; a change rebuilds the clone. */
function slotSig(a: VolumeAlert): string {
	return `${a.action}|${a.acked ? 1 : 0}|${a.severity === 'inside' ? 1 : 0}`;
}

const clones = createCloneLayer<VolumeAlert>({
	pane: PANE,
	paneZ: PANE_Z,
	keyOf: (a) => a.key,
	sigOf: slotSig,
	// A volume swap (fresh evaluator geometry) rebuilds the clone too.
	geomRefOf: (a) => a.volume,
	geometryOf: (a, opts) => {
		const layers: L.Layer[] = [];
		for (const ring of a.volume.rings) {
			layers.push(L.polygon(ring, opts));
		}
		for (const c of a.volume.circles) {
			layers.push(L.circle([c.lat, c.lon], { radius: c.radiusM, ...opts }));
		}
		return L.layerGroup(layers);
	},
	styleOf: styleFor,
});

/** Which alerts earn a map clone: the dominant one plus everything at
 *  imminent or inside, planned advisories excluded. */
export function drawableAlerts(alerts: VolumeAlert[], dominant: VolumeAlert | null): VolumeAlert[] {
	return alerts.filter(
		(a) =>
			!a.planned &&
			(a === dominant || SEVERITY_RANK[a.severity] >= SEVERITY_RANK.imminent),
	);
}

/** Reconcile the emphasis clones against the requested alerts (null or
 *  empty clears everything). Idempotent. */
export function syncNavAlerts(m: L.Map, alerts: VolumeAlert[] | null): void {
	clones.sync(m, alerts ?? []);
}

/** The row keys currently emphasised, for airspaceLayer's hit-test: the
 *  user sees the alert clone and expects to click it even with the
 *  category toggle off. */
export function navAlertKeys(): ReadonlySet<string> {
	return clones.keys();
}

/** Teardown before the map goes (HMR / remount). */
export function clearNavAlerts(m: L.Map): void {
	clones.clear(m);
}

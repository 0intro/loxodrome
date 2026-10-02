/* terrainThreatLayer.ts: where the terrain alert is (docs/terrain-awareness.md
 * "On the map"). TSO-C151c 3.5(e): terrain that generates an alert is shown
 * apart from the rest, at the level of the alert. Two clones at most: the
 * alerting stretch of the corridor ahead (a quad the width of the searched
 * corridor over the bins inside the clearance) and a ring round the alerting
 * obstacle, each in the alert's ink over a white casing (the ground under it
 * is already shaded red or yellow), the warning solid and the caution dashed,
 * an acknowledged row stepped back.
 *
 * The emphasisClones reconcile on its own pane, over the airspace-alert
 * clones and under every symbol, drawn whatever the terrain layer's toggle
 * says: the nav-alert rule, an alert's emphasis is not a display preference.
 * Non-interactive. Fed imperatively from a MapView effect over
 * state/terrainAlert's terrainThreats(); holds no reactive state. */

import L from 'leaflet';
import { createCloneLayer } from './emphasisClones';

const PANE = 'terrain-threat';
// 374: over the airspace-alert clones (373), under the obstacle glyphs (380),
// so the ring round an obstacle never hides the symbol it names.
const PANE_Z = '374';

/** The alert inks as fixed hex, the navAlertLayer precedent: Leaflet paths
 *  need a concrete colour. They are the day --danger and --workbook-orange
 *  as they stood before theme.css darkened those for TEXT contrast on their
 *  tints, a test a stroke over the map does not take (the --nav-orange
 *  line's own precedent). */
const DANGER = '#d40000';
/** The caution amber (see DANGER). */
const CAUTION = '#9e6400';
const CASING = '#ffffff';
/** The ring round an obstacle, CSS px: clear of its glyph at every size. */
const RING_PX = 15;

export type TerrainThreat =
	| {
			kind: 'terrain';
			level: 'caution' | 'warning';
			acked: boolean;
			/** The threatening stretch: four [lat, lon] corners. */
			quad: [number, number][];
	  }
	| {
			kind: 'obstacle';
			level: 'caution' | 'warning';
			acked: boolean;
			lat: number;
			lon: number;
	  };

function inkOf(t: TerrainThreat): L.PathOptions {
	const warning = t.level === 'warning';
	const ink = warning ? DANGER : CAUTION;
	return {
		color: ink,
		weight: 3,
		opacity: t.acked ? 0.45 : 0.95,
		dashArray: warning ? undefined : '7 5',
		fillColor: ink,
		fillOpacity: t.kind === 'obstacle' ? 0 : t.acked ? 0.06 : warning ? 0.3 : 0.2,
	};
}

/** The white casing under the ink: the ground beneath is already shaded red
 *  or yellow, and the outline must stand off it. */
function casingOf(t: TerrainThreat): L.PathOptions {
	return {
		color: CASING,
		weight: 6,
		opacity: t.acked ? 0.4 : 0.85,
		dashArray: undefined,
		fill: false,
	};
}

const clones = createCloneLayer<TerrainThreat>({
	pane: PANE,
	paneZ: PANE_Z,
	keyOf: (t) => t.kind,
	sigOf: (t) => `${t.level}|${t.acked ? 1 : 0}`,
	// A fresh quad each evaluation rebuilds the patch (at most once a fix); an
	// obstacle is rebuilt only when another one takes the row.
	geomRefOf: (t) => (t.kind === 'terrain' ? t.quad : `${t.lat},${t.lon}`),
	// Every path spreads the factory's `opts` (pane, renderer, interactive
	// false) first; the casing overrides the style alone.
	geometryOf: (t, opts) => {
		const casing = casingOf(t);
		if (t.kind === 'terrain') {
			return L.layerGroup([L.polygon(t.quad, { ...opts, ...casing }), L.polygon(t.quad, opts)]);
		}
		const at: L.LatLngExpression = [t.lat, t.lon];
		return L.layerGroup([
			L.circleMarker(at, { ...opts, ...casing, radius: RING_PX }),
			L.circleMarker(at, { ...opts, radius: RING_PX, fill: false }),
		]);
	},
	styleOf: inkOf,
});

/** Reconcile the threat clones (empty clears them). Idempotent. */
export function syncTerrainThreats(m: L.Map, threats: readonly TerrainThreat[]): void {
	clones.sync(m, threats);
}

/** Teardown before the map goes (HMR / remount). */
export function clearTerrainThreats(m: L.Map): void {
	clones.clear(m);
}

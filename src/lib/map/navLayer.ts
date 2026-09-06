/* navLayer.ts: the live-navigation overlay. A single orange trace polyline (over
 * a white casing, the routeLayer legibility trick) plus one heading-rotated
 * aircraft marker for the current / replay position. Both are non-interactive
 * (a readout, clicks fall through). Fed imperatively from MapView effects that
 * read navRecording state; this module holds no reactive state and never imports
 * it, so the dependency runs one way (state -> MapView -> layer). Follow / drag
 * bookkeeping lives here so the layer can pan the map without a state round-trip:
 * while following, the map holds the aircraft at the container centre (the
 * moving-map convention); a user pan gesture suspends that, and the on-map
 * recentre control, visible only while suspended, or a fresh checkbox toggle
 * re-arms it (docs/nav-ux-review.md finding 7). The flight start flow
 * (state/flightAction.svelte.ts) is the second sanctioned caller of that
 * re-arm, through rearmFollow / recenterNav below.
 *
 * The aircraft glyph points north at 0 deg; heading rotation is applied to the
 * inner <svg> (marker.getElement().firstElementChild), never the Leaflet-owned
 * container whose translate3d positions the marker. */

import L from 'leaflet';
import { ensurePane } from './directDrawLayer';
import { projectedPositions, VECTOR_MINUTES, type TrackPoint, type Fix } from '$lib/nav/trace';
import type { PositionQuality } from '$lib/nav/positionQuality';

type IconKind = 'plane' | 'helicopter' | 'glider';

/** Fixed map-layer colours (theme tokens don't reach Leaflet layers).
 *  This is the nav identity orange as a LINE over map tiles, where the
 *  judgement is saturation against terrain; the UI's reading of the same
 *  identity is the darker `--nav-orange` token, which has to pass a text
 *  contrast test the stroke never takes (styles/theme.css states both). */
const TRACE_COLOR = '#e8590c';

/** The aircraft's own ink per position quality: solid orange while the fix is
 *  current, pale while it is stale or coarse, grey once there is no position
 *  at all. The symbol stays in place either way (it is still the last known
 *  position, which is worth showing), but it must not keep claiming to be
 *  where the aircraft IS: the EFB convention is to grey the ownship rather
 *  than to remove it. */
const AIRCRAFT_INK: Record<PositionQuality, { fill: string; stroke: string; opacity: number }> = {
	good: { fill: '#ff6d00', stroke: '#ffffff', opacity: 1 },
	degraded: { fill: '#ffd8a8', stroke: '#e8590c', opacity: 1 },
	lost: { fill: '#ced4da', stroke: '#868e96', opacity: 0.75 },
};

// i18n-ignore-start: SVG marker markup, not display text
function svgOpen(opacity: number): string {
	return (
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="36" height="36"' +
		(opacity < 1 ? ` opacity="${opacity}"` : '') +
		'>'
	);
}

/* The aeroplane and glider silhouettes are traced from real top views:
 * the PA-28-161 Warrior II 3-view line drawing (35 ft span over 23.8 ft,
 * constant-chord inner wing then both-edge taper to squared tips,
 * 13 ft stabilator, rudder tip past its trailing edge) and the ASK 21
 * three-view (17 m over 8.35 m, pod-and-boom, swept T-tail). Nose up,
 * mass centred on (12,12) for the track rotation; fuselage widths and
 * the glider chord are exaggerated where true scale would fall under a
 * pixel at the marker's 36 px. Every fill paints paint-order="stroke",
 * so the white halo sits OUTSIDE the shape and thin members keep their
 * full ink width. Tuned against local/icon-preview.html renders at
 * 30-240 px on light and dark tiles. */

const HALO = 'paint-order="stroke" stroke-linejoin="round"';

/** PA-28 Warrior/Archer: spinner + prop bar, semi-tapered wing with
 *  squared tips, one-piece stabilator, rudder tip beyond it. */
function planeSvg(fill: string, stroke: string, opacity: number): string {
	return (
		svgOpen(opacity) +
		`<rect x="9.7" y="4.6" width="4.6" height="0.85" rx="0.42" fill="${fill}" stroke="${stroke}" stroke-width="0.8" ${HALO}/>` +
		'<path d="M12 4.4C12.5 4.42 12.72 4.75 12.78 5.3L13.15 6.6Q13.6 7.6 13.75 8.8Q13.8 9.2 13.78 9.6' +
		'L16.9 9.6L22.5 10.12Q22.9 10.18 22.9 10.55L22.9 12Q22.9 12.35 22.5 12.37L16.9 12.9L13.55 12.9' +
		'Q13.15 15.1 12.85 17.53L15.95 17.72Q16.4 17.78 16.4 18.2L16.38 18.72Q16.35 19.12 15.9 19.12' +
		'L12.5 19.05L12.26 19.5Q12.2 19.95 12 19.95Q11.8 19.95 11.74 19.5L11.5 19.05L8.1 19.12' +
		'Q7.65 19.12 7.62 18.72L7.6 18.2Q7.6 17.78 8.05 17.72L11.15 17.53Q10.85 15.1 10.45 12.9' +
		'L7.1 12.9L1.5 12.37Q1.1 12.35 1.1 12L1.1 10.55Q1.1 10.18 1.5 10.12L7.1 9.6L10.22 9.6' +
		'Q10.2 9.2 10.25 8.8Q10.4 7.6 10.85 6.6L11.22 5.3C11.28 4.75 11.5 4.4 12 4.4Z" ' +
		`fill="${fill}" stroke="${stroke}" stroke-width="1.1" ${HALO}/>` +
		'</svg>'
	);
}

/** The original helicopter glyph (cabin ellipse, boom, tail bar), its
 *  four X-rotor arms respaced to true 90 degrees around the hub. */
function heliSvg(fill: string, stroke: string, opacity: number): string {
	return (
		svgOpen(opacity) +
		`<line x1="5.85" y1="3.85" x2="18.15" y2="16.15" stroke="${fill}" stroke-width="1.4" stroke-linecap="round"/>` +
		`<line x1="18.15" y1="3.85" x2="5.85" y2="16.15" stroke="${fill}" stroke-width="1.4" stroke-linecap="round"/>` +
		`<line x1="12" y1="12" x2="12" y2="21" stroke="${fill}" stroke-width="1.8" stroke-linecap="round"/>` +
		`<line x1="9.5" y1="21" x2="14.5" y2="21" stroke="${fill}" stroke-width="1.4" stroke-linecap="round"/>` +
		`<ellipse cx="12" cy="10" rx="3" ry="4.6" fill="${fill}" stroke="${stroke}" stroke-width="0.7"/>` +
		'</svg>'
	);
}

/** ASK 21-style glider: gently swept double-tapered wings, pod-and-boom
 *  fuselage, swept T-tail trapezoid with the rudder tip beyond. */
function gliderSvg(fill: string, stroke: string, opacity: number): string {
	return (
		svgOpen(opacity) +
		'<path d="M12 6.2Q13.05 6.55 13.05 8.2L12.95 8.9L23 9.6Q23.3 9.65 23.28 9.95Q23.25 10.3 22.95 10.35' +
		'L12.9 11.3Q12.5 12.4 12.4 16L14.45 16.5Q14.78 16.6 14.75 16.9Q14.7 17.2 14.4 17.22L12.35 17.3' +
		'L12.2 17.75Q12.15 18.05 12 18.05Q11.85 18.05 11.8 17.75L11.65 17.3L9.6 17.22Q9.3 17.2 9.25 16.9' +
		'Q9.22 16.6 9.55 16.5L11.6 16Q11.5 12.4 11.1 11.3L1.05 10.35Q0.75 10.3 0.72 9.95Q0.7 9.65 1 9.6' +
		'L11.05 8.9L10.95 8.2Q10.95 6.55 12 6.2Z" ' +
		`fill="${fill}" stroke="${stroke}" stroke-width="1" ${HALO}/>` +
		'</svg>'
	);
}
// i18n-ignore-end

// One cached icon per kind and quality (a cache, not reactive state).
const iconCache = new Map<string, L.DivIcon>();

function iconFor(kind: IconKind, quality: PositionQuality): L.DivIcon {
	const key = `${kind}:${quality}`;
	let icon = iconCache.get(key);
	if (!icon) {
		const ink = AIRCRAFT_INK[quality];
		// Opacity rides the <svg> itself, never a wrapper: rotateMarker turns
		// the element's firstElementChild, which has to stay the glyph.
		const svg =
			kind === 'helicopter'
				? heliSvg(ink.fill, ink.stroke, ink.opacity)
				: kind === 'glider'
					? gliderSvg(ink.fill, ink.stroke, ink.opacity)
					: planeSvg(ink.fill, ink.stroke, ink.opacity);
		icon = L.divIcon({
			html: svg,
			className: 'nav-aircraft-icon',
			iconSize: [36, 36],
			iconAnchor: [18, 18],
		});
		iconCache.set(key, icon);
	}
	return icon;
}

// One cached circle icon per lead minute; the number IS the lead time.
const vectorIconCache = new Map<number, L.DivIcon>();

function vectorIcon(min: number): L.DivIcon {
	let icon = vectorIconCache.get(min);
	if (!icon) {
		// i18n-ignore-start: SVG marker markup; the number is locale-invariant
		const html =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">' +
			// A divIcon is DOM, so unlike the Leaflet paths above it CAN read
			// the theme token; the numeral is 10px text on a white disc, which
			// is a contrast test the saturated line colour fails.
			'<circle cx="12" cy="12" r="9" fill="#ffffff" fill-opacity="0.92" stroke="var(--nav-orange)" stroke-width="2"/>' +
			`<text x="12" y="12" text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="700" fill="var(--nav-orange)">${min}</text>` +
			'</svg>';
		// i18n-ignore-end
		icon = L.divIcon({ html, className: 'nav-vector-mark', iconSize: [24, 24], iconAnchor: [12, 12] });
		vectorIconCache.set(min, icon);
	}
	return icon;
}

// Non-reactive module state (Leaflet objects + follow bookkeeping).
let group: L.LayerGroup | null = null;
let line: L.Polyline | null = null;
let casing: L.Polyline | null = null;
let marker: L.Marker | null = null;
let currentIconKey: string | null = null;
let dragBound = false;
// The user has grabbed the map: follow suspends until they re-enable it.
let userPanning = false;
let prevFollow = false;
// Live trajectory vector: the dashed track line + one circle mark per lead minute.
let vectorLine: L.Polyline | null = null;
let vectorMarks: L.Marker[] = [];
// The pose the map last saw, plus the recentre control: the control (and a
// fresh toggle-on) must centre at once, without waiting for the next fix.
let lastPose: L.LatLng | null = null;
let recenterCtl: L.Control | null = null;
let recenterBtn: HTMLElement | null = null;

function onPanGesture(): void {
	userPanning = true;
	updateRecenter();
}

/** Arrow keys pan the map through Leaflet's Keyboard handler without firing
 *  dragstart, so they are caught here; the +/- zoom keys fall through, like
 *  every zoom gesture (a followed map zooms on the aircraft). */
function onMapKeyDown(e: L.LeafletKeyboardEvent): void {
	const k = e.originalEvent.key;
	if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') {
		onPanGesture();
	}
}

/** The recentre control shows exactly while follow is armed but suspended by a
 *  user pan gesture (and there is a pose to centre on): the checkbox stays the
 *  armed switch in the Navigation tab, and resuming is one tap on the map,
 *  where the pilot's attention already is. */
function updateRecenter(): void {
	const el = recenterCtl?.getContainer();
	if (el) {
		const show = prevFollow && userPanning && lastPose != null;
		el.style.display = show ? '' : 'none';
	}
}

/** Clear a standing pan suspension so follow re-arms on the next fix; the
 *  flight start flow's fresh-trace form. Deliberately NO pan: lastPose is
 *  non-reactive and still holds the OLD trace's endpoint until the MapView
 *  effect re-syncs, so panning here would fly to the previous flight. */
export function rearmFollow(): void {
	userPanning = false;
	updateRecenter();
}

/** The recentre control's action: re-arm follow and centre on the last pose
 *  now. Also the flight start flow's continue-onto-a-trace form, where the
 *  trace tip is roughly where the aircraft is. */
export function recenterNav(m: L.Map): void {
	userPanning = false;
	if (lastPose) {
		m.panTo(lastPose);
	}
	updateRecenter();
}

/** Create (once) the recentre control: leaflet-bar markup like the zoom
 *  control, so it inherits its styling and stacks under it in the top-left
 *  corner (which the in-flight strip's .leaflet-top padding keeps clear). */
function ensureRecenterControl(m: L.Map): void {
	if (recenterCtl) {
		return;
	}
	const RecenterControl = L.Control.extend({
		onAdd: (): HTMLElement => {
			const bar = L.DomUtil.create('div', 'leaflet-bar');
			const btn = L.DomUtil.create('a', 'nav-recenter', bar);
			btn.href = '#';
			btn.setAttribute('role', 'button');
			// i18n-ignore-start: SVG control glyph, not display text
			btn.innerHTML =
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" style="display:block;width:100%;height:100%">' +
				'<path d="M12 1.4v3.2M12 19.4v3.2M1.4 12h3.2M19.4 12h3.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/>' +
				'<g transform="translate(12 12) scale(0.58) translate(-12 -12)">' +
				'<path d="M12 2c-.83 0-1.5.67-1.5 1.5V10.5L2 16v1.5l8.5-2.5V20l-2.5 1.5v1L12 21.5l4 1v-1L13.5 20v-4.5l8.5 2.5V16l-8.5-5.5V3.5C13.5 2.67 12.83 2 12 2z" ' +
				`fill="${TRACE_COLOR}"/>` +
				'</g></svg>';
			// i18n-ignore-end
			L.DomEvent.disableClickPropagation(bar);
			L.DomEvent.on(btn, 'click', (ev) => {
				L.DomEvent.preventDefault(ev);
				recenterNav(m);
			});
			recenterBtn = btn;
			return bar;
		},
	});
	recenterCtl = new RecenterControl({ position: 'topleft' });
	recenterCtl.addTo(m);
	updateRecenter();
}

function ensureNavPanes(m: L.Map): void {
	// Above the route line (455) / NOTAM areas (450), below the trigger (470).
	ensurePane(m, 'nav-trace', '460');
	// Above every marker pane (route-markers 655, NOTAM pins 600).
	ensurePane(m, 'nav-aircraft', '660');
	// The trajectory vector line reads over route pins but under the aircraft; its
	// numbered circles sit one above the line so the dash never crosses their face.
	ensurePane(m, 'nav-vector', '658');
	ensurePane(m, 'nav-vector-mark', '659');
}

/** Create (once) the layer group, trace polyline + casing, and the follow
 *  drag guard. Idempotent, safe to call from every sync. */
export function buildNavLayer(m: L.Map): void {
	ensureNavPanes(m);
	if (!group) {
		group = L.layerGroup().addTo(m);
	}
	if (!casing) {
		casing = L.polyline([], {
			pane: 'nav-trace',
			interactive: false,
			color: '#ffffff',
			weight: 6,
			lineCap: 'round',
			lineJoin: 'round',
		});
		casing.addTo(group);
	}
	if (!line) {
		line = L.polyline([], {
			pane: 'nav-trace',
			interactive: false,
			color: TRACE_COLOR,
			weight: 3,
			lineCap: 'round',
			lineJoin: 'round',
		});
		line.addTo(group);
	}
	if (!dragBound) {
		// Every user pan gesture suspends follow: drag, box zoom, arrow keys.
		// Zoom gestures keep it, recentring at the new zoom on the next pan (a
		// clean pinch never fires dragstart: Draggable bails on multi-touch; a
		// sloppy pinch whose first finger travels past the drag threshold does,
		// and the suspension it causes is visible on the recentre control and
		// one tap away from resumed).
		m.on('dragstart boxzoomstart', onPanGesture); // i18n-ignore: Leaflet event names, not display text
		m.on('keydown', onMapKeyDown);
		dragBound = true;
	}
}

/** Set the trace polyline (and its casing) to the recorded track, or clear it
 *  when hidden or too short. */
export function syncNavTrace(m: L.Map, points: TrackPoint[], show: boolean): void {
	buildNavLayer(m);
	const ll: L.LatLngTuple[] =
		show && points.length >= 2 ? points.map((p) => [p.lat, p.lon] as L.LatLngTuple) : [];
	line?.setLatLngs(ll);
	casing?.setLatLngs(ll);
}

function rotateMarker(deg: number | null): void {
	const el = marker?.getElement()?.firstElementChild as HTMLElement | null;
	if (el) {
		el.style.transform = `rotate(${deg ?? 0}deg)`;
	}
}

/** Position + rotate the aircraft marker at `pose` (null detaches it), inked
 *  for the position quality, and hold the map centred on it while following.
 *  `recenterLabel` is the recentre control's tooltip, passed in because map
 *  modules never import the i18n catalogs. */
export function syncNavAircraft(
	m: L.Map,
	pose: Fix | null,
	kind: IconKind,
	follow: boolean,
	quality: PositionQuality,
	recenterLabel: string,
): void {
	if (!pose) {
		if (marker && group?.hasLayer(marker)) {
			group.removeLayer(marker);
		}
		lastPose = null;
		updateRecenter();
		return;
	}
	buildNavLayer(m);
	const g = group;
	if (!g) {
		return;
	}
	const iconKey = `${kind}:${quality}`;
	if (!marker) {
		marker = L.marker([pose.lat, pose.lon], {
			pane: 'nav-aircraft',
			icon: iconFor(kind, quality),
			interactive: false,
			keyboard: false,
		});
		currentIconKey = iconKey;
		marker.addTo(g);
	} else {
		if (!g.hasLayer(marker)) {
			marker.addTo(g);
		}
		marker.setLatLng([pose.lat, pose.lon]);
		if (currentIconKey !== iconKey) {
			marker.setIcon(iconFor(kind, quality));
			currentIconKey = iconKey;
		}
	}
	rotateMarker(pose.trackDeg);

	lastPose = L.latLng(pose.lat, pose.lon);
	ensureRecenterControl(m);
	if (recenterBtn && recenterBtn.title !== recenterLabel) {
		recenterBtn.title = recenterLabel;
		recenterBtn.setAttribute('aria-label', recenterLabel);
	}

	// Follow: re-arm on a fresh toggle-on, then hold the aircraft at the
	// container centre. The pan is skipped inside one pixel of centre: Leaflet
	// fires a bare moveend even for a zero-offset pan, and the 1 Hz position-
	// quality clock re-runs this sync while parked, which would otherwise storm
	// the moveend listeners (hash restamp, canvas repaints) with the map still.
	// A user pan gesture sets userPanning, suspending the pan until the
	// recentre control or a fresh toggle-on clears it.
	if (follow && !prevFollow) {
		userPanning = false;
	}
	prevFollow = follow;
	if (follow && !userPanning) {
		const off = m.latLngToContainerPoint(lastPose).subtract(m.getSize().divideBy(2));
		if (Math.abs(off.x) >= 1 || Math.abs(off.y) >= 1) {
			m.panTo(lastPose);
		}
	}
	updateRecenter();
}

/** Draw (or clear) the live trajectory vector: a dashed line from `pose` along
 *  the smoothed ground track, with a numbered circle at each lead-minute
 *  projected position. Cleared when off, or with no pose / motion. */
export function syncNavVector(
	m: L.Map,
	pose: Fix | null,
	motion: { speedKt: number; trackDeg: number } | null,
	on: boolean,
): void {
	buildNavLayer(m);
	const g = group;
	if (!g) {
		return;
	}
	const proj =
		on && pose && motion
			? projectedPositions(pose.lat, pose.lon, motion.trackDeg, motion.speedKt, VECTOR_MINUTES)
			: [];
	if (proj.length === 0 || !pose) {
		vectorLine?.setLatLngs([]);
		for (const mk of vectorMarks) {
			if (g.hasLayer(mk)) {
				g.removeLayer(mk);
			}
		}
		return;
	}
	if (!vectorLine) {
		vectorLine = L.polyline([], {
			pane: 'nav-vector',
			interactive: false,
			color: TRACE_COLOR,
			weight: 2,
			opacity: 0.9,
			dashArray: '6 5',
			lineCap: 'round',
		});
		vectorLine.addTo(g);
	} else if (!g.hasLayer(vectorLine)) {
		vectorLine.addTo(g);
	}
	vectorLine.setLatLngs([
		[pose.lat, pose.lon],
		...proj.map((p) => [p.lat, p.lon] as L.LatLngTuple),
	]);
	// One circle mark per lead minute (VECTOR_MINUTES is fixed, so index -> minute
	// is stable and the cached icon never needs swapping).
	proj.forEach((p, i) => {
		let mk = vectorMarks[i];
		if (!mk) {
			mk = L.marker([p.lat, p.lon], {
				pane: 'nav-vector-mark',
				icon: vectorIcon(p.min),
				interactive: false,
				keyboard: false,
			});
			vectorMarks[i] = mk;
			mk.addTo(g);
		} else {
			if (!g.hasLayer(mk)) {
				mk.addTo(g);
			}
			mk.setLatLng([p.lat, p.lon]);
		}
	});
	for (let i = proj.length; i < vectorMarks.length; i++) {
		if (g.hasLayer(vectorMarks[i])) {
			g.removeLayer(vectorMarks[i]);
		}
	}
}

/** Detach the overlay and drop refs (HMR / unmount teardown). */
export function clearNavLayer(m: L.Map): void {
	if (dragBound) {
		m.off('dragstart boxzoomstart', onPanGesture); // i18n-ignore: Leaflet event names, not display text
		m.off('keydown', onMapKeyDown);
		dragBound = false;
	}
	recenterCtl?.remove();
	if (group && m.hasLayer(group)) {
		m.removeLayer(group);
	}
	line = null;
	casing = null;
	marker = null;
	vectorLine = null;
	vectorMarks = [];
	group = null;
	currentIconKey = null;
	lastPose = null;
	recenterCtl = null;
	recenterBtn = null;
	userPanning = false;
	prevFollow = false;
}

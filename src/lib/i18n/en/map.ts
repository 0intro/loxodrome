/* Map-chrome strings: the Leaflet zoom control and the map context menu
 * (incl. its per-kind section headings). Only DOM-side text belongs here:
 * the canvas layers draw invariant aviation tokens and are import-banned
 * from $lib/i18n (docs/i18n.md). */

import { plural } from './plural';

export const map = {
	addWaypoint: 'Add waypoint here',
	/* The long-press menu in flight (docs/nav-live.md, docs/nav-ux-review.md
	   finding 12): Garmin's two verbs. */
	directToHere: 'Direct to here',
	directToHereTip:
		'Fly direct from the present position to this point: an alternate route is appended to the plan and flown from now on. The plan itself is untouched.',
	activateLeg: 'Activate leg',
	activateLegTip: 'Read the navigation log on this leg from now on (the projection re-anchors here).',
	whatsHere: 'What is here',
	addWaypointTip: 'Add a route waypoint here (snaps to a nearby airport / navaid)',
	airportsHeading: (n: number) => `Airports (${n})`,
	airspacesHeading: (n: number) => `Airspaces (${n})`,
	altitudeProfile: (n: number) =>
		`Altitude profile (${n} ${plural(n, 'airspace', 'airspaces')})`,
	altitudeProfileTip: 'Show the altitude profile of the airspaces at this point',
	copyCoords: 'Copy coordinates',
	copyCoordsTip: 'Copy these coordinates to the clipboard',
	insertWaypoint: 'Insert waypoint here',
	insertWaypointTip: 'Insert a route waypoint on this leg (snaps to a nearby airport / navaid)',
	navaidsHeading: (n: number) => `Navaids (${n})`,
	notamCount: (n: number) => `${n} ${plural(n, 'NOTAM', 'NOTAMs')}`,
	notamsHeading: (n: number) => `NOTAMs (${n})`,
	obstaclesHeading: (n: number) => `Obstacles (${n})`,
	profilePoint: 'Altitude profile point (drag to move)',
	/* The in-flight lock's worded escape (state/routeLock.svelte.ts): the menu
	   row that frees one pin for one drag, and the line at the map's foot
	   while it is armed. */
	moveWaypoint: 'Move waypoint',
	moveWaypointNamed: (name: string) => `Move waypoint ${name}`,
	moveWaypointTip: 'While recording, the route is locked on the map. This frees this waypoint for one drag.',
	moveArmed: 'Drag the waypoint to its new position',
	moveArmedNamed: (name: string) => `Drag ${name} to its new position`,
	removeWaypoint: 'Remove waypoint',
	removeWaypointNamed: (name: string) => `Remove waypoint ${name}`,
	removeWaypointTip: 'Remove this waypoint from the route',
	radarHeading: 'Precipitation radar',
	sigmetsHeading: (n: number) => `SIGMET (${n})`,
	chartsHeading: (n: number) => `Aerodrome charts (${n})`,
	pinChart: 'Bring to the top',
	unpinChart: 'Pinned to the top',
	stationsHeading: (n: number) => `METAR stations (${n})`,
	supaipHeading: (n: number) => `SUP AIP (${n})`,
	/* The map's undo chip (state/undoChip.svelte.ts): the route edit just
	   made on the map, beside its Undo button. */
	undoMoved: 'Waypoint moved',
	undoAdded: 'Waypoint added',
	undoInserted: 'Waypoint inserted',
	undoRemoved: 'Waypoint removed',
	unserviceable: 'Unserviceable',
	zoomIn: 'Zoom in',
	zoomOut: 'Zoom out',
};

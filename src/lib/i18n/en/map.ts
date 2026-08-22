/* Map-chrome strings: the Leaflet zoom control and the map context menu
 * (incl. its per-kind section headings). Only DOM-side text belongs here:
 * the canvas layers draw invariant aviation tokens and are import-banned
 * from $lib/i18n (docs/i18n.md). */

import { plural } from './plural';

export const map = {
	addWaypoint: 'Add waypoint here',
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
	removeWaypoint: 'Remove waypoint',
	removeWaypointNamed: (name: string) => `Remove waypoint ${name}`,
	removeWaypointTip: 'Remove this waypoint from the route',
	sigmetsHeading: (n: number) => `SIGMET (${n})`,
	stationsHeading: (n: number) => `METAR stations (${n})`,
	supaipHeading: (n: number) => `SUP AIP (${n})`,
	unserviceable: 'Unserviceable',
	zoomIn: 'Zoom in',
	zoomOut: 'Zoom out',
};

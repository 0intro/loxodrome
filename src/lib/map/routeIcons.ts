/* Numbered waypoint marker icons for the route overlay. Coloured by role
 * (start green, end red, intermediate blue), with a white inner ring on
 * anchored (airport / navaid) waypoints and an amber outer ring when selected.
 * One cached L.DivIcon per (role, anchored, number, selected, highlighted)
 * tuple, like positionIcon's iconCache in markerIcons.ts.
 *
 * The highlight (a waypoint list pointing at this pin, see highlightWaypoint in
 * routeLayer.ts) is a modifier CLASS, not more SVG: the 26x26 box is already
 * filled to r 12 by the selected ring, and the class rides the icon's own
 * options so Leaflet re-applies it on every setIcon (DivIcon.createIcon
 * reassigns className wholesale, which would wipe a hand-toggled class on the
 * next route sync). */

import L from 'leaflet';
import type { Waypoint } from '$lib/state/route.svelte';

type Role = 'start' | 'end' | 'mid';

const ROLE_FILL: Record<Role, string> = {
	start: '#2e7d32',
	end: '#c62828',
	mid: '#1f5fbf',
};

function discSvg(
	fill: string,
	label: string,
	anchored: boolean,
	selected: boolean,
	estimated: boolean,
): string {
	// i18n-ignore-start: SVG icon markup, not display text
	// An estimated (dead-reckoned) waypoint draws a translucent, dashed-edge disc so
	// it reads as approximate; an exact waypoint draws a solid disc.
	const disc = estimated
		? `<circle cx="13" cy="13" r="10" fill="${fill}" fill-opacity="0.45" stroke="#fff" stroke-width="2" stroke-dasharray="3 2"/>`
		: `<circle cx="13" cy="13" r="10" fill="${fill}" stroke="#fff" stroke-width="2"/>`;
	// Ring sits near the disc edge (r 7 of the r-10 disc) so it frames the number
	// rather than cutting across it.
	const inner = anchored
		? '<circle cx="13" cy="13" r="7" fill="none" stroke="#fff" stroke-width="1.3"/>'
		: '';
	const sel = selected
		? '<circle cx="13" cy="13" r="12" fill="none" stroke="#ffb300" stroke-width="2"/>'
		: '';
	const fontSize = label.length > 1 ? 9 : 11;
	return (
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 26" width="26" height="26">' +
		disc +
		inner +
		sel +
		'<text x="13" y="13" text-anchor="middle" dominant-baseline="central" ' +
		`font-size="${fontSize}" font-weight="700" ` +
		`font-family="ui-sans-serif, system-ui, sans-serif" fill="#fff">${label}</text>` +
		'</svg>'
	);
	// i18n-ignore-end
}

const iconCache = new Map<string, L.DivIcon>();

/** A numbered disc icon for a waypoint at `index` of `total`. Centered anchor
 *  so a snapped waypoint sits on the feature symbol. */
export function waypointIcon(
	wp: Waypoint,
	index: number,
	total: number,
	selected: boolean,
	highlighted: boolean,
): L.DivIcon {
	const role: Role = index === 0 ? 'start' : index === total - 1 ? 'end' : 'mid';
	const anchored = wp.kind !== 'free';
	const estimated = wp.estimated === true;
	const label = String(index + 1);
	const key = `${role}|${anchored ? 'a' : 'f'}|${estimated ? 'e' : ''}|${label}|${selected ? 's' : ''}|${highlighted ? 'h' : ''}`;
	let icon = iconCache.get(key);
	if (!icon) {
		icon = L.divIcon({
			html: discSvg(ROLE_FILL[role], label, anchored, selected, estimated),
			// i18n-ignore: CSS class names on the marker element, not display text
			className: highlighted ? 'route-pin route-pin--hl' : 'route-pin',
			iconSize: [26, 26],
			iconAnchor: [13, 13],
		});
		iconCache.set(key, icon);
	}
	return icon;
}

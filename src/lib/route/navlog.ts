/* Pure nav-log computation for a drawn route: per-leg true track, leg /
 * cumulative distance, and ETE from a single cruise speed. No NOTAMs (those
 * show on the map), no wind / fuel / magnetic-variation modelling. Kept free of
 * Svelte and I/O so it is unit-testable in Node. */

import { equirectangularDistanceM, initialBearingDeg } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import type { Waypoint } from '$lib/state/route.svelte';

export interface NavLeg {
	/** 1-based leg number. */
	index: number;
	fromLabel: string;
	toLabel: string;
	fromWptId: string;
	toWptId: string;
	/** Great-circle initial bearing, degrees true, 0..360. */
	trackTrueDeg: number;
	legNM: number;
	/** Cumulative distance including this leg. */
	cumNM: number;
	/** Minutes at the cruise speed, or null when it is unset / <= 0. */
	eteMin: number | null;
}

export interface NavLog {
	legs: NavLeg[];
	totalNM: number;
	totalEteMin: number | null;
	cruiseSpeedKt: number | null;
}

/** A short display label for a waypoint: its ident / name, else its coords. */
export function waypointLabel(wp: Waypoint): string {
	return wp.ident || wp.label || `${wp.lat.toFixed(3)}, ${wp.lon.toFixed(3)}`;
}

/** Build the nav log for the ordered waypoints. < 2 waypoints -> empty. */
export function computeNavLog(
	waypoints: Waypoint[],
	cruiseSpeedKt: number | null,
): NavLog {
	const kt = cruiseSpeedKt && cruiseSpeedKt > 0 ? cruiseSpeedKt : null;
	const legs: NavLeg[] = [];
	let cumNM = 0;
	for (let i = 0; i + 1 < waypoints.length; i++) {
		const a = waypoints[i];
		const b = waypoints[i + 1];
		const legNM = equirectangularDistanceM(a.lat, a.lon, b.lat, b.lon) / NM_TO_METERS;
		cumNM += legNM;
		legs.push({
			index: i + 1,
			fromLabel: waypointLabel(a),
			toLabel: waypointLabel(b),
			fromWptId: a.id,
			toWptId: b.id,
			// Bearing is undefined for coincident points; report 0.
			trackTrueDeg: legNM < 1e-6 ? 0 : initialBearingDeg(a.lat, a.lon, b.lat, b.lon),
			legNM,
			cumNM,
			eteMin: kt ? (legNM / kt) * 60 : null,
		});
	}
	const totalNM = legs.reduce((s, l) => s + l.legNM, 0);
	return {
		legs,
		totalNM,
		totalEteMin: kt ? (totalNM / kt) * 60 : null,
		cruiseSpeedKt,
	};
}

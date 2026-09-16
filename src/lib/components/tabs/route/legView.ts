/* The per-leg view contract between RouteTab and WaypointRow. A plain .ts
 * module (not WaypointRow's module script) so the typed eslint rules can
 * resolve it; svelte-check reads either. */

import type { EffectiveLegWind } from '$lib/route/legWind';

/** The semicircular warning for one leg: a non-compliant level
 *  (click-to-fix, never auto-rewritten) or the transition-layer advisory. */
export type LegWarn =
	| { kind: 'level'; fixFt: number | null; title: string }
	| { kind: 'layer'; title: string };

/** Per-leg view data for the connector row under waypoint i. Computed once
 *  at route level in RouteTab (they are whole-route deriveds: tracks,
 *  auto targets, warnings, advisor, winds) and passed down, so a row never
 *  recomputes a route-wide walk. Null on the last waypoint (no leg). */
export interface LegView {
	distNM: number;
	trackDeg: number;
	/** The leg's auto target altitude; wp.alt equal to it means "auto",
	 *  which hides the reset cue. */
	autoAltFt: number | null;
	warn: LegWarn | null;
	/** Level-advisor cue: a faster usable level with its tooltip + aria. */
	suggestion: { bestFt: number; title: string; aria: string } | null;
	/** Effective wind for the W/V chip; the tip carries the provenance. */
	wind: EffectiveLegWind | null;
	windTip: string | null;
}

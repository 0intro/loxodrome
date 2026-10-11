/* The per-leg view contract between RouteTab and WaypointRow. A plain .ts
 * module (not WaypointRow's module script) so the typed eslint rules can
 * resolve it; svelte-check reads either. */

import type { EffectiveLegWind, WindVec } from '$lib/route/legWind';

/** The one warning slot of a leg, the first that applies: a non-compliant
 *  semicircular level (click-to-fix, never auto-rewritten), a twin's
 *  one-engine net ceiling under the leg's MSA (click opens the profile),
 *  the transition-layer advisory. The title carries every one that applies,
 *  the slot's own first, so none hides behind another. */
export type LegWarn =
	| { kind: 'level'; fixFt: number | null; title: string }
	| { kind: 'oei'; title: string }
	| { kind: 'layer'; title: string };

/** Per-leg view data for the connector row under waypoint i. Computed once
 *  at route level in RouteTab (they are whole-route deriveds: tracks,
 *  auto targets, warnings, advisor, winds) and passed down, so a row never
 *  recomputes a route-wide walk. Null on the last waypoint (no leg). */
export interface LegView {
	distNM: number;
	trackDeg: number;
	/** The leg's auto target altitude: what a pilot's leg box shows in grey
	 *  and hands back when emptied (whether the leg IS automatic is its own
	 *  altAuto flag). */
	autoAltFt: number | null;
	warn: LegWarn | null;
	/** Level-advisor cue: a faster usable level with its tooltip + aria. */
	suggestion: { bestFt: number; title: string; aria: string } | null;
	/** Effective wind for the W/V chip; the tip carries the provenance. */
	wind: EffectiveLegWind | null;
	windTip: string | null;
	/** The AUTOMATIC wind (the forecast, else the global wind; the override
	 *  skipped): the W/V editor's grey value, what clearing hands back. */
	autoWind: WindVec | null;
}

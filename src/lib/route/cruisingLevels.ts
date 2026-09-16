/* Semicircular cruising levels (the ICAO/SERA table of cruising levels).
 *
 * Rules implemented:
 *   - ICAO Annex 2 Appendix 3 / SERA Appendix 3: a level cruise keeps a level
 *     keyed on the MAGNETIC track: [000, 180) odd thousands, [180, 360) even
 *     thousands; VFR adds 500 ft, IFR flies the whole thousands.
 *   - SERA.5005(g): the VFR rule binds only above 900 m (3000 ft) from the
 *     ground or water, hence the per-leg applicability floor over the minimum
 *     ground elevation along the leg (unknown terrain falls back to sea level,
 *     the conservative side: the rule binds more often, never less). France
 *     specifies no higher datum (no FRA.5005 g)).
 *   - SERA.5025(a) + FRA.5025 a): the IFR table has no height floor; it binds
 *     from the lowest usable level up, the higher of 3000 ft AMSL and 1000 ft
 *     above the surface (SERA.5020(b) extends the table inside controlled
 *     airspace, ATC clearances prevailing), hence the IFR applicability floor.
 *   - SERA.5005(d)(2): VFR flight above FL 195 is prohibited, so VFR levels
 *     cap there.
 *   - AIP France ENR 1.7.5: above FL 195 (UTA) the IFR parity flips to the
 *     090..269 (odd) / 270..089 (even) split, the lower hemicycle rotated a
 *     quarter turn. Above the UTA (FL 660) the lower split legally resumes,
 *     and above FL 410 the per-track spacing widens to 4000 ft; both are out
 *     of scope here (docs/cruising-levels.md).
 *   - AIP France ENR 1.7.2.3: the transition level is the lowest usable
 *     flight level at least 1000 ft above the transition altitude; the
 *     published QNH tables step one 1000 ft band per 36 hPa.
 *
 * Pure module: levels in feet (a flight level is its feet x100, the same
 * standard-atmosphere approximation as $lib/vertical/limits.ts), tracks in
 * magnetic degrees. Display formatting lives in route/format.ts (fmtLevel).
 */

import type { Airspace } from '$lib/data/airspaces';
import { classAFloorsForLegs } from '$lib/route/airspaces';
import { legMagneticTrackDeg } from '$lib/route/magnetic';
import { computeNavLog } from '$lib/route/navlog';
import type { Waypoint } from '$lib/state/route.svelte';

export const RULE_FLOOR_AGL_FT = 3000;
/** FRA.5025 a): the lowest usable IFR level outside controlled airspace is
 *  the higher of 3000 ft AMSL and 1000 ft above the surface. */
export const IFR_MIN_LEVEL_AMSL_FT = 3000;
export const IFR_MIN_LEVEL_AGL_FT = 1000;
export const LEVEL_SPACING_FT = 2000;
export const VFR_LEVEL_OFFSET_FT = 500;
export const VFR_CEILING_FT = 19500;
/** Strictly above this level the French UTA parity applies (ENR 1.7.5,
 *  195 < FL < 660; IFR only, VFR is capped at FL 195 anyway). */
export const UTA_FLOOR_FT = 19500;
export const FT_PER_HPA = 1000 / 36;

/** The national cruising-level regime, selected per route by
 *  `cruisingRegimeForRoutes` (route/airspaces.ts) from the containing FIR.
 *  Only two axes differ between the supported States:
 *   - `vfrCeilingFt`: the highest legal VFR cruising level (SERA.5005(d)(2)
 *     FL 195 in Europe; 14 CFR 91.135 puts Class A at 18 000 ft, so US VFR
 *     tops one level below at 17 500 ft).
 *   - `utaFloorFt`: the level strictly above which the French UTA parity
 *     flip applies (ENR 1.7.5). Europe uses 19 500 ft (France-correct,
 *     advisory for the other SERA states); the US uses Infinity: standard
 *     ICAO hemispheric parity holds throughout, no rotated table. */
export interface CruisingRegime {
	vfrCeilingFt: number;
	utaFloorFt: number;
}

/** Europe / SERA: VFR capped at FL 195, France UTA parity above it. The
 *  default regime, so any caller that passes none keeps today's behaviour. */
export const EU_REGIME: CruisingRegime = {
	vfrCeilingFt: VFR_CEILING_FT,
	utaFloorFt: UTA_FLOOR_FT,
};

/** United States (14 CFR 91.135 / 91.159): VFR capped at 17 500 ft (Class A
 *  begins at 18 000), standard hemispheric parity throughout (no UTA flip). */
export const US_REGIME: CruisingRegime = {
	vfrCeilingFt: 17500,
	utaFloorFt: Infinity,
};

/** Odd-thousands hemicycle: magnetic track [000, 180) exclusive of 180. */
export function oddHemicycle(trackMagDeg: number): boolean {
	return ((trackMagDeg % 360) + 360) % 360 < 180;
}

/** Grid offset of the compliant levels for a track: levels are
 *  offset + k * LEVEL_SPACING_FT (k >= 0). In the UTA the parity split is
 *  the lower one rotated a quarter turn: 090..269 odd, 270..089 even
 *  (ENR 1.7.5's table: 090-269 carries FL 210, 230, ...). */
function levelOffsetFt(trackMagDeg: number, vfr: boolean, uta: boolean): number {
	const odd = oddHemicycle(uta ? trackMagDeg + 270 : trackMagDeg);
	return (odd ? 1000 : 0) + (vfr ? VFR_LEVEL_OFFSET_FT : 0);
}

/** True when `altFt` is a cruising level of the table for this track and
 *  flight rules (parity + the regime's VFR ceiling; above the regime's UTA
 *  floor the France UTA parity). Applicability (the floor) is the caller's
 *  test, so badges and snapping share one predicate. */
export function isCompliantLevel(
	altFt: number,
	trackMagDeg: number,
	vfr: boolean,
	regime: CruisingRegime = EU_REGIME,
): boolean {
	if (altFt <= 0 || (vfr && altFt > regime.vfrCeilingFt)) {
		return false;
	}
	const offset = levelOffsetFt(trackMagDeg, vfr, altFt > regime.utaFloorFt);
	const rem = (((altFt - offset) % LEVEL_SPACING_FT) + LEVEL_SPACING_FT) % LEVEL_SPACING_FT;
	return rem === 0;
}

/** The altitude (ft) a leg must exceed for the rule to bind. VFR: 3000 ft
 *  above the minimum ground elevation along the leg (SERA.5005(g) binds
 *  strictly above that height, so the boundary itself stays free). IFR: the
 *  table binds from the lowest usable level up (SERA.5025(a) has no height
 *  floor), i.e. the higher of 3000 ft AMSL and 1000 ft above the surface
 *  (FRA.5025 a)); that boundary level itself must comply, so the returned
 *  floor sits 1 ft below it, making the shared strictly-above comparisons
 *  inclusive there. Unknown terrain (null) counts as sea level, the
 *  conservative fallback (the rule binds more often, never less). */
export function applicabilityFloorFt(minGroundElevFt: number | null, vfr: boolean): number {
	const ground = minGroundElevFt ?? 0;
	if (vfr) {
		return ground + RULE_FLOOR_AGL_FT;
	}
	return Math.max(IFR_MIN_LEVEL_AMSL_FT, ground + IFR_MIN_LEVEL_AGL_FT) - 1;
}

/** Nearest level of the grid `offset + k * LEVEL_SPACING_FT` inside the band
 *  strictly above `floorFt`, at or below `capFt` (exact half-way ties resolve
 *  DOWN); null when the band holds no grid level. */
function snapWithin(altFt: number, offset: number, floorFt: number, capFt: number): number | null {
	const kLow = Math.max(0, Math.floor((floorFt - offset) / LEVEL_SPACING_FT) + 1);
	const kHigh = Number.isFinite(capFt) ? Math.floor((capFt - offset) / LEVEL_SPACING_FT) : Infinity;
	if (kHigh < kLow) {
		return null;
	}
	const q = (altFt - offset) / LEVEL_SPACING_FT;
	let k = Math.round(q);
	if (k - q === 0.5) {
		k -= 1;
	}
	k = Math.min(Math.max(k, kLow), kHigh);
	return offset + k * LEVEL_SPACING_FT;
}

/** Nearest compliant level to `altFt` (exact half-way ties resolve DOWN),
 *  clamped into the usable band: strictly above `floorFt` and at or below
 *  `capFt` (and the VFR FL 195 ceiling). The FL 195 boundary is piecewise:
 *  the lower-airspace and UTA grids each offer their nearest member and the
 *  closer one wins (a tie resolves to the lower level). Null when no
 *  compliant level fits the band, i.e. the rule cannot be satisfied there. */
export function snapToLevel(
	altFt: number,
	trackMagDeg: number,
	vfr: boolean,
	opts: { floorFt: number; capFt?: number | undefined },
	regime: CruisingRegime = EU_REGIME,
): number | null {
	const ceiling = Math.min(opts.capFt ?? Infinity, vfr ? regime.vfrCeilingFt : Infinity);
	const lower = snapWithin(
		altFt,
		levelOffsetFt(trackMagDeg, vfr, false),
		opts.floorFt,
		Math.min(ceiling, regime.utaFloorFt),
	);
	const upper =
		ceiling > regime.utaFloorFt
			? snapWithin(
					altFt,
					levelOffsetFt(trackMagDeg, vfr, true),
					Math.max(opts.floorFt, regime.utaFloorFt),
					ceiling,
				)
			: null;
	if (lower === null || upper === null) {
		return lower ?? upper;
	}
	return Math.abs(upper - altFt) < Math.abs(lower - altFt) ? upper : lower;
}

/** The grid levels offset + k * spacing (k >= 0) strictly above `floorFt`,
 *  at or below `capFt`, ascending. */
function levelsWithin(offset: number, spacing: number, floorFt: number, capFt: number): number[] {
	const kLow = Math.max(0, Math.floor((floorFt - offset) / spacing) + 1);
	const kHigh = Math.floor((capFt - offset) / spacing);
	const out: number[] = [];
	for (let k = kLow; k <= kHigh; k++) {
		out.push(offset + k * spacing);
	}
	return out;
}

/** Every usable cruising level for a track, ascending: strictly above
 *  `floorFt`, at or below `capFt` (and the VFR FL 195 ceiling), the UTA
 *  parity above FL 195. With `hemicycle` false (the semicircular option
 *  off) the parity constraint drops and the ladder halves its spacing
 *  (every thousand, +500 VFR), same clamps. The level-advisor's candidate
 *  set; shares snapToLevel's bounds exactly, so the snap result is always
 *  a member. */
export function compliantLevels(
	trackMagDeg: number,
	vfr: boolean,
	opts: { floorFt: number; capFt?: number | undefined; hemicycle?: boolean },
	regime: CruisingRegime = EU_REGIME,
): number[] {
	const ceiling = Math.min(opts.capFt ?? Infinity, vfr ? regime.vfrCeilingFt : Infinity);
	if (!Number.isFinite(ceiling)) {
		// An uncapped IFR ladder is unbounded; every real caller passes a cap
		// (Class A, aircraft, or model ceiling). Guard rather than loop.
		return [];
	}
	if (!(opts.hemicycle ?? true)) {
		return levelsWithin(vfr ? VFR_LEVEL_OFFSET_FT : 0, LEVEL_SPACING_FT / 2, opts.floorFt, ceiling);
	}
	const out = levelsWithin(
		levelOffsetFt(trackMagDeg, vfr, false),
		LEVEL_SPACING_FT,
		opts.floorFt,
		Math.min(ceiling, regime.utaFloorFt),
	);
	if (ceiling > regime.utaFloorFt) {
		out.push(
			...levelsWithin(
				levelOffsetFt(trackMagDeg, vfr, true),
				LEVEL_SPACING_FT,
				Math.max(opts.floorFt, regime.utaFloorFt),
				ceiling,
			),
		);
	}
	return out;
}

/** The shared badge predicate: the rule binds (above the floor, real track)
 *  and the level is off the table. A null track is a degenerate leg
 *  (coincident waypoints), never flagged. */
export function violatesSemicircular(
	altFt: number,
	trackMagDeg: number | null,
	vfr: boolean,
	floorFt: number,
	regime: CruisingRegime = EU_REGIME,
): boolean {
	return (
		trackMagDeg != null && altFt > floorFt && !isCompliantLevel(altFt, trackMagDeg, vfr, regime)
	);
}

/** Transition level (as its feet x100 value): the lowest flight level,
 *  multiple of 10, whose true altitude clears the transition altitude by
 *  1000 ft (AIP France ENR 1.7.2.3). Without a QNH the standard band
 *  applies: TA + 1000 ft. Matches the published French tables (TA 5000 ft:
 *  QNH 977-1012 gives FL 70, 1013-1048 gives FL 60). */
export function transitionLevelFt(taFt: number, qnhHpa: number | null): number {
	if (qnhHpa == null) {
		return taFt + 1000;
	}
	return 1000 * Math.ceil((taFt + 1000 - (qnhHpa - 1013) * FT_PER_HPA) / 1000);
}

/** True when a planned level sits inside the transition layer: strictly
 *  above the transition altitude, strictly below the transition level.
 *  Advisory only; the planner never snaps out of it. */
export function inTransitionLayer(altFt: number, taFt: number, tlFt: number): boolean {
	return altFt > taFt && altFt < tlFt;
}

export interface CruiseLevelOpts {
	vfr: boolean;
	defaultFt: number;
	classA: Airspace[] | null;
	semicircular: boolean;
	/** Per-leg minimum ground elevation (ft AMSL); null / missing = unknown,
	 *  which the applicability floor treats as sea level. */
	legMinElevFt: readonly (number | null)[];
	/** Decimal year for the WMM magnetic model. */
	timeYears: number;
	/** National cruising-level regime (VFR ceiling + UTA parity floor);
	 *  `EU_REGIME` when absent. */
	regime?: CruisingRegime;
}

/** Per-leg auto target: the VFR Class A rule (min(defaultFt, lowest crossed
 *  Class A floor)), then, with the semicircular option on, snapped to the
 *  nearest cruising level of the table where the rule binds (above the
 *  per-flight-rules applicability floor over the leg's minimum ground). The
 *  Class A floor stays the hard cap; a band with no compliant level keeps
 *  the unsnapped target. Off -> identical to computeAutoAltitudes. Pure. */
export function computeCruiseAltitudes(waypoints: Waypoint[], opts: CruiseLevelOpts): number[] {
	const caps = classAFloorsForLegs(waypoints, opts.vfr, opts.classA);
	const base = caps.map((cap) =>
		cap !== null && cap < opts.defaultFt ? cap : opts.defaultFt,
	);
	if (!opts.semicircular) {
		return base;
	}
	const nav = computeNavLog(waypoints, null);
	return base.map((t, i) => {
		const leg = nav.legs[i];
		// Coincident waypoints have no track: the table does not apply.
		if (leg.legNM < 1e-6) {
			return t;
		}
		const floorFt = applicabilityFloorFt(opts.legMinElevFt[i] ?? null, opts.vfr);
		if (t <= floorFt) {
			return t;
		}
		const track = legMagneticTrackDeg(
			leg.trackTrueDeg,
			waypoints[i],
			waypoints[i + 1],
			opts.timeYears,
		);
		return (
			snapToLevel(
				t,
				track,
				opts.vfr,
				{ floorFt, capFt: caps[i] ?? undefined },
				opts.regime ?? EU_REGIME,
			) ?? t
		);
	});
}

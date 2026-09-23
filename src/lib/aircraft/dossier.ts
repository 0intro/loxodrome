/* Flight-dossier front page: the workbook Dossier tab's trips timeline over
 * the aerodrome chain (the "Heure départ" / "Heure arrivée" / "Temps d'arrêt"
 * rows), the per-trip alternate arrivals, the fuel-limit time ("Heure limite
 * carburant (hors réserve)" = departure + ground stops + fuel endurance -
 * final reserve), and the dossier checklists. Two deliberate deviations from
 * the sheet: the timeline chains the WITH-WIND burn-offs (FuelTripRow's
 * burnOffMin; the sheet chained the still-air column) and the alternate
 * arrival adds the alternate's wind allowance; and the fuel limit runs on
 * the fuel actually on board (the M&B page's load) rather than always the
 * plan minimum, which stays the fallback. Pure (no Svelte, no I/O); the
 * flightprep shared layer adapts routes + fuel rows in. */

import type { AlternateFuelInput } from './fuel';
import { nightMarginMin, type SunTimes } from '$lib/route/sun';

// Re-exported from its new home beside the aeronautical-night test it
// parameterises (isAeroNightUtc, the logbook's night), so the fuel-side
// consumers and pins keep their import.
export { nightMarginMin };

export interface DossierEndpoint {
	/** Display label: the ICAO ident / waypoint label. */
	label: string;
	lat: number;
	lon: number;
}

export interface DossierTripInput {
	from: DossierEndpoint;
	to: DossierEndpoint;
	/** Burn-off with wind: taxi + trip + procedure + wind allowance. */
	burnOffMin: number;
	/** Ground stop at `to` before the next trip departs; the last trip's is
	 *  unused (the journey ends there). */
	stopMin: number;
	alternate: AlternateFuelInput | null;
}

export interface DossierTimelineParams {
	/** First departure, minutes after 00:00 UTC on the flight date. */
	departureMin: number;
	/** Endurance of the embarked fuel, minutes; null hides the limit. */
	fuelOnBoardMin: number | null;
	finalReserveMin: number;
}

export interface DossierTimeline {
	/** Per trip; [0] echoes params.departureMin. */
	departuresMin: number[];
	/** Per trip: arrival at chain aerodrome i + 1. */
	arrivalsMin: number[];
	/** Per trip: arrival at the alternate (destination arrival + alternate
	 *  time + its procedure + its wind allowance); null when no alternate. */
	alternateArrivalsMin: (number | null)[];
	/** Latest landing keeping the final reserve intact: departure + every
	 *  intermediate ground stop + (fuel on board - final reserve). Null when
	 *  fuelOnBoardMin is null or there are no trips. Engine-off stops shift
	 *  it later; a planned refuel is NOT modelled (the limit reads for the
	 *  first tankful, like the sheet's). */
	fuelLimitMin: number | null;
}

/** The aerodrome chain the sheet heads its columns with (Aérodrome 1..N):
 *  the first departure, then every trip's destination. When a trip departs
 *  somewhere other than the previous destination the chain still lists the
 *  destinations and the times still chain, exactly like the sheet (the fuel
 *  plan makes the same simplification). */
export function dossierChain(trips: readonly DossierTripInput[]): DossierEndpoint[] {
	return trips.length === 0 ? [] : [trips[0].from, ...trips.map((t) => t.to)];
}

export function computeDossierTimeline(
	trips: readonly DossierTripInput[],
	params: DossierTimelineParams,
): DossierTimeline {
	const departuresMin: number[] = [];
	const arrivalsMin: number[] = [];
	const alternateArrivalsMin: (number | null)[] = [];
	let t = params.departureMin;
	let stopsSum = 0;
	for (const [i, trip] of trips.entries()) {
		departuresMin.push(t);
		const arr = t + trip.burnOffMin;
		arrivalsMin.push(arr);
		const alt = trip.alternate;
		alternateArrivalsMin.push(
			alt ? arr + alt.timeMin + alt.procedureMin + alt.windAllowanceMin : null,
		);
		if (i < trips.length - 1) {
			stopsSum += trip.stopMin;
			t = arr + trip.stopMin;
		}
	}
	const fuelLimitMin =
		params.fuelOnBoardMin != null && trips.length > 0
			? params.departureMin + stopsSum + (params.fuelOnBoardMin - params.finalReserveMin)
			: null;
	return { departuresMin, arrivalsMin, alternateArrivalsMin, fuelLimitMin };
}

/** The flight's time window off a computed timeline: first departure to the
 *  latest arrival, alternate arrivals included (a diversion extends the
 *  window). Minutes after 00:00 UTC on the flight date, like every timeline
 *  field; null when the timeline holds no trip. Feeds the printed TEMSI /
 *  WINTEM chart selection. */
export function timelineWindowMin(
	tl: DossierTimeline,
): { startMin: number; endMin: number } | null {
	if (tl.departuresMin.length === 0 || tl.arrivalsMin.length === 0) {
		return null;
	}
	let end = -Infinity;
	for (const m of tl.arrivalsMin) {
		end = Math.max(end, m);
	}
	for (const m of tl.alternateArrivalsMin) {
		if (m != null) {
			end = Math.max(end, m);
		}
	}
	return { startMin: tl.departuresMin[0], endMin: end };
}

/** True when any timeline event falls in aeronautical night at its
 *  aerodrome: each departure at its origin column, each arrival and
 *  alternate arrival at its destination column (the alternate approximated
 *  there), night being before sunrise - margin or after sunset + margin,
 *  the margin per that column's latitude (`nightMarginMin`: 15 min at
 *  |lat| <= 30 deg, else 30). A non-null `twilights` column overrides the
 *  margin model with the EASA civil-twilight definition (night strictly
 *  outside dawn..dusk, no margin; callers supply these above 60 deg).
 *  `sun`, `lats` and `twilights` are indexed by chain column (lats omitted
 *  = the temperate 30 min everywhere); unknown sun columns are skipped,
 *  polar night is always night, polar day never. Drives the derived
 *  day/night final-reserve default (30/45 min). */
export function timelineAtNight(
	timeline: DossierTimeline,
	sun: readonly (SunTimes | null)[],
	lats?: readonly (number | null)[],
	twilights?: readonly (SunTimes | null)[],
): boolean {
	const atNight = (min: number, col: number): boolean => {
		// A civil-twilight column (callers supply them above 60 deg lat,
		// where the sunset-margin approximation breaks down) uses the EASA
		// Part-DEF definition directly: night runs from the end of evening
		// to the beginning of morning civil twilight, no margin. Its polar
		// kinds already carry the right meaning at the 96-degree zenith:
		// 'polar-day' = never civil night, 'polar-night' = continuous night.
		const tw = twilights?.[col];
		if (tw) {
			if (tw.sunrise.kind !== 'time' || tw.sunset.kind !== 'time') {
				return tw.sunrise.kind === 'polar-night' || tw.sunset.kind === 'polar-night';
			}
			return min < tw.sunrise.minutesUtc || min > tw.sunset.minutesUtc;
		}
		const s = sun[col];
		if (!s) {
			return false;
		}
		if (s.sunrise.kind !== 'time' || s.sunset.kind !== 'time') {
			// Polar: night when the sun never rises, day when it never sets.
			return s.sunrise.kind === 'polar-night' || s.sunset.kind === 'polar-night';
		}
		const margin = nightMarginMin(lats?.[col] ?? null);
		return (
			min < s.sunrise.minutesUtc - margin ||
			min > s.sunset.minutesUtc + margin
		);
	};
	return (
		timeline.departuresMin.some((m, i) => atNight(m, i)) ||
		timeline.arrivalsMin.some((m, i) => atNight(m, i + 1)) ||
		timeline.alternateArrivalsMin.some((m, i) => m != null && atNight(m, i + 1))
	);
}

/** Wall-clock 'HH:MM' from minutes after 00:00, wrapped into one day. */
export function fmtClock(min: number): string {
	const m = ((Math.round(min) % 1440) + 1440) % 1440;
	return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Minutes after 00:00 from a time-input 'HH:MM' value; null when malformed
 *  (a type=time input always emits zero-padded HH:MM). */
export function parseClock(text: string): number | null {
	const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
	return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes from a duration text, the ground-stop / potential inputs (the
 *  sheet's time-formatted "Temps d'arrêt" / "Potentiel" cells): 'H:MM'
 *  (minutes 00-59, hours up to 4 digits for an airframe potential), or
 *  bare minutes ('45'). Null when malformed. */
export function parseDuration(text: string): number | null {
	const t = text.trim();
	const m = /^(\d{1,4}):([0-5]\d)$/.exec(t);
	if (m) {
		return Number(m[1]) * 60 + Number(m[2]);
	}
	return /^\d+$/.test(t) ? Number(t) : null;
}

/** Duration 'HH:MM' from minutes (no day wrap; hours grow past 99). The
 *  total is rounded BEFORE the split so a fractional input just under an
 *  hour boundary carries ('05:60' can never print). */
export function fmtDuration(min: number): string {
	const total = Math.round(min);
	const h = Math.floor(total / 60);
	const m = total - h * 60;
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export type DossierCheckGroup = 'pilot' | 'documents' | 'weather' | 'threeR' | 'charts';

/** The dossier checklist ids + grouping, in the sheet's order. The ids are
 *  the state / YAML contract (never rename); the display labels live in the
 *  i18n catalogs (t.flightprep.checks, keyed by these ids), keeping this
 *  module locale-free (docs/i18n.md rule 6). */
export const DOSSIER_CHECKS = [
	{ id: 'pax_recency', group: 'pilot' },
	{ id: 'type_recency', group: 'pilot' },
	{ id: 'doc_registration', group: 'documents' },
	{ id: 'doc_airworthiness', group: 'documents' },
	{ id: 'doc_radio', group: 'documents' },
	{ id: 'doc_journey_log', group: 'documents' },
	{ id: 'doc_noise', group: 'documents' },
	{ id: 'doc_mass_balance', group: 'documents' },
	{ id: 'doc_flight_manual', group: 'documents' },
	{ id: 'doc_insurance', group: 'documents' },
	{ id: 'wx_fronts', group: 'weather' },
	{ id: 'wx_temsi', group: 'weather' },
	{ id: 'wx_winterm', group: 'weather' },
	{ id: 'wx_metar_taf_sigmet', group: 'weather' },
	{ id: 'r_legal', group: 'threeR' },
	{ id: 'r_feasible', group: 'threeR' },
	{ id: 'r_reasonable', group: 'threeR' },
	{ id: 'charts_current', group: 'charts' },
	{ id: 'charts_regional', group: 'charts' },
	{ id: 'charts_vac', group: 'charts' },
	{ id: 'charts_complement', group: 'charts' },
] as const satisfies readonly { id: string; group: DossierCheckGroup }[];

/** The checklist-id union; the catalogs' checks record is keyed by it, so a
 *  new check fails the build until both labels exist. */
export type DossierCheckId = (typeof DOSSIER_CHECKS)[number]['id'];

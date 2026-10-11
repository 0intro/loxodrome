/* How the fuel plan and the mass & balance pages name a trip, its two ends
 * and its figures. One place, so the fuel table's column heads, the
 * verdict lines and the sheets' headings cannot name a stop two ways. */

import { waypointLabel } from '$lib/route/navlog';
import { dryBefore, type TripLoad } from '$lib/aircraft/tripLoads';
import { t } from '$lib/state/i18n.svelte';
import type { FuelComputation } from './shared';

/** Chain trip k's title ("LFPL → LFQH"), the fuel page's own column head. */
export function tripTitle(fuel: FuelComputation, k: number): string {
	return fuel.inputColumns[k]?.input?.label ?? '';
}

/** Where chain trip k takes off: the departure, then each stop, named where
 *  the refuelling plan uplifts (the previous trip's last waypoint), which is
 *  also the point a stop's refuel is stored under. */
export function takeoffAt(fuel: FuelComputation, k: number): string {
	const cols = fuel.inputColumns;
	const wps = k === 0 ? cols[0]?.trip.route.waypoints : cols[k - 1]?.trip.route.waypoints;
	const w = k === 0 ? wps?.[0] : wps?.[wps.length - 1];
	return w ? waypointLabel(w) : '';
}

/** Where chain trip k lands. */
export function landingAt(fuel: FuelComputation, k: number): string {
	const wps = fuel.inputColumns[k]?.trip.route.waypoints;
	const w = wps?.[wps.length - 1];
	return w ? waypointLabel(w) : '';
}

const MINUS = '−';

/** One decimal, a true minus sign, never "−0.0". */
export function num1(v: number): string {
	const r = Math.round(v * 10) / 10;
	return r < 0 ? `${MINUS}${(-r).toFixed(1)}` : Math.abs(r).toFixed(1);
}

/** A load as it was asked for or uplifted: whole litres when it is whole
 *  ("63 L", "100 L"), else one decimal. */
export function load1(v: number): string {
	return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : num1(v);
}

/** A verdict's signed margin, rounded TOWARD the verdict so the figure never
 *  contradicts it: a sufficient margin rounds down (+0.04 shows +0.0, never
 *  more than there is), a short one rounds away from zero (−0.04 shows
 *  −0.1, never a deficit that reads as none). */
export function margin1(v: number, sufficient: boolean): string {
	if (sufficient) {
		return `+${(Math.max(0, Math.floor(v * 10 + 1e-9)) / 10).toFixed(1)}`;
	}
	return `${MINUS}${(Math.max(1, Math.ceil(-v * 10 - 1e-9)) / 10).toFixed(1)}`;
}

/** The first letter up, the way a sentence starts (the fixes' clauses are
 *  written lower case to be joined). */
export function capitalize(s: string): string {
	return s.length === 0 ? s : s[0].toLocaleUpperCase() + s.slice(1);
}

/** A trip's fuel verdict as a cell reads it: Yes with its margin, NO with
 *  its deficit, NO and the trip the tanks ran dry on, or unknown; amber and
 *  never green where the fuel came from a stop the AIP or a NOTAM says
 *  cannot serve the aeroplane (`refused`, mbLines.ts dependsOnRefused). */
export function fuelVerdictCell(
	tr: TripLoad,
	refused: boolean,
): { text: string; ink: 'ok' | 'danger' | 'warn' | null; title?: string | undefined } {
	if (tr.sufficient === null || tr.marginL === null) {
		return { text: '—', ink: null };
	}
	const dry = dryBefore(tr);
	if (dry !== null) {
		return { text: t.flightprep.fuelDry(dry + 1), ink: 'danger' };
	}
	if (!tr.sufficient) {
		return { text: t.flightprep.fuelNoMargin(margin1(tr.marginL, false)), ink: 'danger' };
	}
	const text = t.flightprep.fuelYesMargin(margin1(tr.marginL, true));
	return refused ? { text, ink: 'warn', title: t.flightprep.fuelRefusedTip } : { text, ink: 'ok' };
}

/** The same verdict as a word, where the margin has a row of its own (the
 *  fuel plan's "Above the reserve"): Yes, NO, NO and the trip the tanks ran
 *  dry on, or unknown, inked as fuelVerdictCell inks it. */
export function fuelVerdictWord(
	tr: TripLoad,
	refused: boolean,
): { text: string; ink: 'ok' | 'danger' | 'warn' | null; title?: string | undefined } {
	if (tr.sufficient === null) {
		return { text: '—', ink: null };
	}
	const dry = dryBefore(tr);
	if (dry !== null) {
		return { text: t.flightprep.fuelDry(dry + 1), ink: 'danger' };
	}
	if (!tr.sufficient) {
		return { text: t.flightprep.noCaps, ink: 'danger' };
	}
	const text = t.flightprep.yes;
	return refused ? { text, ink: 'warn', title: t.flightprep.fuelRefusedTip } : { text, ink: 'ok' };
}

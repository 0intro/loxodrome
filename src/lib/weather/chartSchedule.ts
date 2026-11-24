/* When Météo-France issues the TEMSI and WINTEM charts the printed dossier
 * selects from, per the Guide aviation de Météo-France 2024 ("Fréquence
 * d'émission des cartes"):
 *   - TEMSI France (basses altitudes): every 3 h from 06 to 00 UTC, made
 *     available 2 h before its validity. There is no 03 UTC chart.
 *   - TEMSI EUROC: every 3 h from 00 UTC, available 4 h before validity.
 *   - WINTEM France: every 3 h from 00 UTC. WINTEM EUROC: every 6 h from
 *     00 UTC. The guide states no lead for either; the SOFIA catalog has been
 *     seen listing WINTEM France five hours ahead (a sheet based on the
 *     previous day's 12 UTC run), so a WINTEM is never late on paper here.
 * And how long a chart serves, per the same guide on the TEMSI ("Limites
 * d'utilisation"): it "peut cependant être utilisée entre 09 h UTC et
 * l'heure d'arrivée du TEMSI suivant", the pilot extrapolating the active
 * systems (fronts, pressure centres), and a cross-section off it "n'est
 * valable que pour 3 heures maximum". Pure, locale-free; read by
 * weather/tripCharts.ts. Contract: docs/sofia-charts.md. */

import type { SofiaChartProduct } from '$lib/sofia/charts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface ChartSchedule {
	/** Validity hours of the UTC day, ascending. */
	hours: readonly number[];
	/** How long before its validity a chart is made available; null where
	 *  the guide states none. */
	leadMs: number | null;
}

const SCHEDULES: Readonly<Record<string, ChartSchedule>> = {
	'TEMSI|FRANCE': { hours: [0, 6, 9, 12, 15, 18, 21], leadMs: 2 * HOUR_MS },
	'TEMSI|EUROC': { hours: [0, 3, 6, 9, 12, 15, 18, 21], leadMs: 4 * HOUR_MS },
	'WINTEM|FRANCE': { hours: [0, 3, 6, 9, 12, 15, 18, 21], leadMs: null },
	'WINTEM|EUROC': { hours: [0, 6, 12, 18], leadMs: null },
};

/** The schedule of one product in one zone; null for a zone the dossier
 *  never prints (the selection then keeps reading the catalog alone). */
export function chartSchedule(product: SofiaChartProduct, zone: string): ChartSchedule | null {
	return SCHEDULES[`${product}|${zone}`] ?? null;
}

/** The longest a TEMSI is printed past its own validity, as the chart in
 *  force while the next is not out yet ("3 heures maximum"). */
export const EXTRAPOLATION_MAX_MS = 3 * HOUR_MS;

/** How long past its due publication a chart may still arrive before it is
 *  called missing: the guide's lead is a target, not a timestamp. */
export const OVERDUE_GRACE_MS = 30 * 60_000;

/** Every scheduled validity in [fromMs, toMs], ascending. */
export function scheduledValidities(s: ChartSchedule, fromMs: number, toMs: number): number[] {
	const out: number[] = [];
	for (let day = Math.floor(fromMs / DAY_MS) * DAY_MS; day <= toMs; day += DAY_MS) {
		for (const h of s.hours) {
			const v = day + h * HOUR_MS;
			if (v >= fromMs && v <= toMs) {
				out.push(v);
			}
		}
	}
	return out;
}

/* What the fuel page's figures were computed with, under its table and on
 * its paper: the wind its allowances read (windBasis.ts: the forecast with
 * its source, a manual wind and what the forecast would change, or still
 * air) and the cruise it burns at (the plan's setting, or its own figures).
 * NCO.OP.125(a) asks the fuel to take the meteorological conditions into
 * account: a plan on a hypothetical wind says so where its fuel is read.
 * Builds text from the catalogs at call time (docs/i18n.md). */

import { t } from '$lib/state/i18n.svelte';
import { fmtWind } from '$lib/route/format';
import type { Route } from '$lib/state/route.svelte';
import type { PlanCruiseSetting } from '$lib/state/aircraft.svelte';
import type { WindBasis } from './windBasis';
import type { BoxLine } from './weatherBox';

/** The cruise the plan burns at: its own figures, or its setting's on the
 *  selected plane's sheet (`plane`), or the default without a plane. */
export interface CruiseBasis {
	custom: boolean;
	setting: PlanCruiseSetting | null;
	plane: string | null;
	kt: number;
	lph: number | null;
}

const lphText = (lph: number): string => String(Math.round(lph * 10) / 10);

function windLine(trips: readonly { route: Route; basis: WindBasis }[]): BoxLine | null {
	const first = trips[0];
	if (!first) {
		return null;
	}
	const own = trips.reduce((n, x) => n + x.basis.overrides, 0);
	const ownText = own > 0 ? ' ' + t.flightprep.fuelBasisOwnLegs(own) : '';
	if (trips.every((x) => x.basis.kind === 'none')) {
		return { text: t.flightprep.fuelBasisNoWind + ownText, ink: 'manual' };
	}
	if (first.basis.kind === 'manual' && trips.every((x) => x.basis.kind === 'manual')) {
		const deltas = trips.map((x) => (x.basis.kind === 'manual' ? x.basis.forecastDeltaMin : null));
		const delta = deltas.every((d) => d !== null) ? deltas.reduce<number>((s, d) => s + (d ?? 0), 0) : null;
		const instead =
			delta === null
				? ''
				: ' ' +
					(Math.round(delta) > 0
						? t.flightprep.fuelBasisForecastMore(Math.round(delta))
						: Math.round(delta) < 0
							? t.flightprep.fuelBasisForecastLess(-Math.round(delta))
							: t.flightprep.fuelBasisForecastSame);
		const w = first.basis.wind;
		return { text: t.flightprep.fuelBasisManual(fmtWind(w.dirDeg, w.speedKt)) + instead + ownText, ink: 'manual' };
	}
	const sources: string[] = [];
	let missed = 0;
	let missedWind: { dirDeg: number; speedKt: number } | null = null;
	for (const { basis } of trips) {
		if (basis.kind === 'forecast') {
			missed += basis.missed.length;
			missedWind ??= basis.missedWind;
			if (basis.source && !sources.includes(basis.source)) {
				sources.push(basis.source);
			}
		} else if (basis.kind === 'none') {
			missed += basis.legs - basis.overrides;
		}
	}
	let text = t.flightprep.fuelBasisForecast(sources.length > 0 ? sources.join(', ') : null);
	if (missed > 0) {
		text +=
			' ' +
			(missedWind
				? t.flightprep.fuelBasisMissedManual({ legs: missed, wind: fmtWind(missedWind.dirDeg, missedWind.speedKt) })
				: t.flightprep.fuelBasisMissedStill(missed));
	}
	return { text: text + ownText, ink: missed > 0 || own > 0 ? 'manual' : 'muted' };
}

function cruiseLine(c: CruiseBasis): BoxLine {
	const kt = Math.round(c.kt);
	const lph = c.lph !== null ? lphText(c.lph) : null;
	if (c.custom) {
		return { text: t.flightprep.fuelBasisCruiseOwn({ kt, lph }), ink: 'manual' };
	}
	if (c.plane !== null) {
		return {
			text: t.flightprep.fuelBasisCruiseSheet({ name: c.setting?.name ?? null, kt, lph, plane: c.plane }),
			ink: 'muted',
		};
	}
	return { text: t.flightprep.fuelBasisCruiseDefault(kt), ink: 'muted' };
}

/** The fuel page's basis: the wind line (none without a trip), then the
 *  cruise line. */
export function fuelBasisLines(trips: readonly { route: Route; basis: WindBasis }[], cruise: CruiseBasis): BoxLine[] {
	const wind = windLine(trips);
	return wind ? [wind, cruiseLine(cruise)] : [cruiseLine(cruise)];
}

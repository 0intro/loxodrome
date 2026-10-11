/* Whether a stop can uplift fuel for this aeroplane, and the words for it.
 *
 * The fuel page's refuelling plan and the fuel control at each takeoff (on
 * the fuel page and on each trip's sheet) read ONE answer through these, so a
 * stop marked as having no fuel in one place is marked in the other, for the
 * same reason and in the same words. The pages that show them still own the
 * fetch (ensureAerodromeFuel, an effect). */

import { fuelForIdent, fuelNotamIdents, resolveAerodromeFuel } from '$lib/state/data.svelte';
import type { IndexedNotam } from '$lib/state/notam.svelte';
import { plannedFlightAt } from '$lib/state/timeWindow.svelte';
import { gradeLabel, type FuelAccess, type FuelOffering, type FuelRefusal } from '$lib/data/fuel';
import type { FuelType } from '$lib/aircraft/schema';
import { t } from '$lib/state/i18n.svelte';

/** The fuel an aerodrome offers on the planned flight.
 *
 *  Resolved rather than published: a grade a NOTAM has withdrawn is not one
 *  the stop can serve, and a plan made days ahead is where that matters most.
 *  Over the planned flight (plannedFlightAt): a withdrawal next month is not
 *  this flight's, and one on the flight's own day is. The NOTAM ident index
 *  is read once per call, so call this once per pass, not once per stop. */
export function plannedFuelLookup(): (icao: string) => FuelOffering<IndexedNotam> | null {
	const notams = fuelNotamIdents();
	return (icao) =>
		notams.has(icao.toUpperCase())
			? resolveAerodromeFuel(icao, 'fr', plannedFlightAt()).fuel
			: fuelForIdent(icao, 'fr');
}

/** Why an aerodrome cannot serve this aeroplane, in words.
 *
 *  The five reasons read differently on purpose. The AIP's three are
 *  permanent until the next cycle and the answer is to plan around them; a
 *  NOTAM's two carry an id and a date and may be gone by the flight, so the
 *  sheet names the NOTAM to go and read. */
export function refusalText(
	icao: string,
	refusal: FuelRefusal<IndexedNotam>,
	types: readonly FuelType[],
): string {
	switch (refusal.kind) {
		case 'aipNone':
			return t.flightprep.fuelNoneAt(icao);
		case 'aipBased':
			return t.flightprep.fuelBasedAt(icao);
		case 'aipGrade':
			return t.flightprep.fuelNotServed({ icao, grades: types.map(gradeLabel).join(', ') });
		case 'notamAll':
			return t.flightprep.fuelNotamNoneAt({ icao, notam: refusal.by.notam.id });
		case 'notamGrade':
			return t.flightprep.fuelNotamGradeAt({
				icao,
				notam: refusal.by.notam.id,
				grades: refusal.grades.map(gradeLabel).join(', '),
			});
	}
}

/** The same sentence, cut around its NOTAM id so the id can be the link onto
 *  the NOTAM panel.
 *
 *  Cutting beats a pair of half-sentences in the catalogs: the id is a
 *  locale-invariant token appearing exactly once, so each language keeps its
 *  own word order and there is still one message to translate. The AIP's
 *  reasons name no NOTAM and come back whole, with no link. */
export function refusalParts(
	icao: string,
	refusal: FuelRefusal<IndexedNotam>,
	types: readonly FuelType[],
): { head: string; item: IndexedNotam | null; tail: string } {
	const text = refusalText(icao, refusal, types);
	const item = refusal.kind === 'notamAll' || refusal.kind === 'notamGrade' ? refusal.by : null;
	const at = item ? text.indexOf(item.notam.id) : -1;
	return item && at >= 0
		? { head: text.slice(0, at), item, tail: text.slice(at + item.notam.id.length) }
		: { head: text, item: null, tail: '' };
}

/** What the AIP or a NOTAM says against the pump at a stop, short (a table
 *  cell's), cut around its NOTAM id so the id can link onto the NOTAM panel. */
export function refusalShort(
	refusal: FuelRefusal<IndexedNotam>,
	types: readonly FuelType[],
): { head: string; item: IndexedNotam | null; tail: string } {
	let text: string;
	let item: IndexedNotam | null = null;
	switch (refusal.kind) {
		case 'aipNone':
			text = t.flightprep.refusalShortNone;
			break;
		case 'aipBased':
			text = t.flightprep.refusalShortBased;
			break;
		case 'aipGrade':
			text = t.flightprep.refusalShortGrade(types.map(gradeLabel).join(', '));
			break;
		case 'notamAll':
			item = refusal.by;
			text = t.flightprep.refusalShortNotamAll(refusal.by.notam.id);
			break;
		case 'notamGrade':
			item = refusal.by;
			text = t.flightprep.refusalShortNotamGrade({
				grades: refusal.grades.map(gradeLabel).join(', '),
				notam: refusal.by.notam.id,
			});
			break;
	}
	const at = item ? text.indexOf(item.notam.id) : -1;
	return item && at >= 0
		? { head: text.slice(0, at), item, tail: text.slice(at + item.notam.id.length) }
		: { head: text, item: null, tail: '' };
}

/** What the AIP wants arranged before an uplift, in words. A CAUTION and not
 *  a reason: the fuel is there, and the stop stands once the call is made.
 *  h24 says nothing, being the absence of a condition. */
export function accessText(icao: string, access: FuelAccess): string | null {
	switch (access) {
		case 'onRequest':
			return t.flightprep.fuelOnRequestAt(icao);
		case 'noHours':
			return t.flightprep.fuelNoHoursAt(icao);
		case 'basedOnly':
			// Unreachable through the callers: fuelRefusal answers aipBased on
			// the same test, and every list drops a point that carries a
			// refusal. Here for the exhaustive switch, and worded rather than
			// blank so a future caller gets a sentence.
			return t.flightprep.fuelBasedAt(icao);
		case 'h24':
			return null;
	}
}

/* What each print job is CALLED (docs/file-names.md).
 *
 * One place, because the alternative is nine print buttons each composing a
 * name of their own, which is how the downloads came to have three slug
 * rules. Every stem here follows the one grammar (files/fileName.ts): the
 * subject, the kind of document, the stamp. The browser appends `.pdf`.
 *
 * The kind tokens in use are `navlog`, `flightprep`, `dossier`, `profile`,
 * `weather`, `notam` and `flights`. Locale-invariant like every other file
 * name (docs/i18n.md): a printed dossier gets sent to a club, and a name is
 * an identifier, not a label.
 *
 * A document ABOUT A PLAN is stamped with the FLIGHT date rather than the
 * instant it was printed: that is what identifies the sheet a pilot files,
 * and reprinting the same dossier twice should not make two documents. A
 * document about the library or the map is stamped when it is made, having
 * no flight to belong to. */

import { fileDayUtc, fileStampUtc, fileStem, APP_SUBJECT } from '$lib/files/fileName';
import { routesFileBaseName } from '$lib/route/routeLabel';
import { dossierFlightDate } from './flightPrep.svelte';
import { routes, type Route } from './route.svelte';

/** The dossier's flight date as a filename field. It is stored 'YYYY-MM-DD'
 *  and read back through the same accessor every display surface uses, so a
 *  printed sheet and its own Overview page cannot disagree about the day. */
function flightDay(): string {
	const parsed = Date.parse(`${dossierFlightDate()}T00:00:00Z`);
	return Number.isNaN(parsed) ? fileDayUtc(Date.now()) : fileDayUtc(parsed);
}

/** A document about the WHOLE plan: the flight-prep pages, the dossier and
 *  kneeboard packs, the weather and NOTAM briefings. */
export function planPrintStem(kind: string): string {
	return fileStem([routesFileBaseName(routes.list), kind, flightDay()]);
}

/** A document about ONE route: the nav log as the surface shows it, the
 *  route vertical profile. `routesFileBaseName` takes a list, and a single
 *  route is a list of one; an alternate names itself like any other. */
export function routePrintStem(kind: string, route: Route): string {
	return fileStem([routesFileBaseName([{ ...route, alternate: false }]), kind, flightDay()]);
}

/** A document about a recorded TRACE: its own flown chain (state/traceFile.ts
 *  loadedTraceSubject) and the instant it started, exactly as the trace's own
 *  exported file is named. */
export function tracePrintStem(kind: string, subject: string, atMs: number | null): string {
	return fileStem([subject, kind, atMs === null ? null : fileStampUtc(atMs)]);
}

/** A document about the application itself rather than one flight: the
 *  flights table. Stamped when it is printed, there being no flight it
 *  belongs to. */
export function appPrintStem(kind: string, atMs: number): string {
	return fileStem([APP_SUBJECT, kind, fileDayUtc(atMs)]);
}

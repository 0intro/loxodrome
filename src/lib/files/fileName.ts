/* The ONE grammar every file this application hands the user is named by
 * (contract: docs/file-names.md).
 *
 *     <subject>_<kind>_<stamp>.<ext>
 *
 * `_` separates the FIELDS, `-` joins the tokens inside one, so an aerodrome
 * chain stays a single readable field and the boundaries survive it:
 * "LFPL-LFPU-LFGO-LFPL_dossier_20260707.pdf" parses, "LFPL-LFPU-...-dossier-
 * 20260707.pdf" does not. A field is omitted when the application has no
 * value for it, or when the extension already states it: .gpx / .igc / .kml
 * are track formats, so a trace carries no kind token, while .yaml, .zip,
 * .csv and .pdf are ambiguous and always do.
 *
 * The stamp is ISO 8601 BASIC, UTC: 20260707T1432Z for an instant,
 * 20260707 for a day. The extended form's colons are reserved on Windows and
 * on macOS, which is why every producer in this field (SDVFR, SkyDemon,
 * Garmin, FlightAware) writes the compact form too. UTC rather than local
 * because these files get emailed to a club and read back elsewhere: IGC
 * mandates UTC for the same reason, and only a file that stays on the
 * pilot's own card can afford local time.
 *
 * Pure: no Svelte, no DOM, no catalogs. Every token here is locale-invariant
 * by decision (docs/i18n.md, the rule that already covers format codes and
 * saved-file header comments): a file name is an identifier, it is read by
 * whoever the file is sent to, and an accented one is a different name on
 * every filesystem. Tested by tests/fileName.spec.ts. */

/** Between two fields. */
const FIELD = '_';

/** The subject of anything the whole application produces rather than one
 *  flight: the library ZIPs, the logbook over every outing. Field 1 is
 *  always the subject, and for those the subject IS the application. */
export const APP_SUBJECT = 'loxodrome';

/** Longest one field may be. No real chain approaches it (six routes of two
 *  aerodromes is 59 characters); a free waypoint carrying a long place name
 *  can, and a 255-byte limit is still the common floor. */
const MAX_FIELD = 100;

/** Windows reserved device names: a file whose STEM is one of these cannot
 *  be created there at all. Unreachable today, since every stem this module
 *  builds carries a kind token or a stamp beside the subject, but a navaid
 *  ident is three letters and the day one of them names a lone-waypoint
 *  route is not the day to discover this. */
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/** One field: diacritics folded to their base letter, everything else that
 *  is not a letter or a digit collapsed to `-`, trimmed and capped.
 *
 *  The fold is what makes "Bâle" read `Bale` rather than `B-le`; it is the
 *  same decomposition nav/igc.ts applies to the IGC character set, and the
 *  strictest practice in the field (SDVFR normalises and strips before its
 *  own class filter). Case is PRESERVED: an ident is upper case and a
 *  registration is upper case, and lower-casing them would make the name
 *  read unlike everything else the application prints. */
export function fileToken(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^A-Za-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_FIELD)
		.replace(/-+$/, '');
}

/** ISO 8601 basic UTC instant to the minute: `20260707T1432Z`. Minutes are
 *  the resolution a flight is identified at; two files that would still
 *  collide are deduped by their archive (files/zip.ts uniqueEntryName). */
export function fileStampUtc(ms: number): string {
	const d = new Date(ms);
	return `${day(d)}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
}

/** ISO 8601 basic UTC day: `20260707`. What a printed document is stamped
 *  with, a dossier being for a date and not for an instant. */
export function fileDayUtc(ms: number): string {
	return day(new Date(ms));
}

function day(d: Date): string {
	return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

/** The stem: the non-empty fields joined, guarded. This is what a PRINT job
 *  sets as the document title, the browser appending `.pdf` itself. */
export function fileStem(fields: readonly (string | null | undefined)[]): string {
	const stem = fields.filter((f): f is string => typeof f === 'string' && f !== '').join(FIELD);
	if (stem === '') {
		return APP_SUBJECT;
	}
	return RESERVED.test(stem) ? `${APP_SUBJECT}${FIELD}${stem}` : stem;
}

/** A complete file name: the stem plus the extension. */
export function fileName(fields: readonly (string | null | undefined)[], ext: string): string {
	return `${fileStem(fields)}.${ext}`;
}

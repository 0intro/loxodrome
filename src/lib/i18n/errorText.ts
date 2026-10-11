/* Deferred error text: state stores a THUNK, never a rendered string, so an
 * error shown across a locale switch re-renders in the new language
 * (docs/i18n.md rule 7). A thunk reading t is translated at render; wire
 * diagnostics (HTTP statuses, upstream err.message) ride a constant thunk
 * and stay untranslated by policy. */

export type ErrorText = () => string;

/** An error whose user-facing text is locale-aware. The English fallback
 *  keeps Error.message meaningful in consoles and logs. */
export class UserFacingError extends Error {
	readonly text: ErrorText;

	constructor(text: ErrorText, fallbackEn: string) {
		super(fallbackEn);
		this.text = text;
	}
}

/** The display thunk for a caught error: a UserFacingError's own text,
 *  anything else frozen verbatim (untranslated upstream diagnostics). */
export function errorTextOf(e: unknown): ErrorText {
	if (e instanceof UserFacingError) {
		return e.text;
	}
	const msg = e instanceof Error ? e.message : String(e);
	return () => msg;
}

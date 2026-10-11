/* Pure formatters for the SOFIA-Briefing-style NOTAM print (the List-tab print
 * bulletin). SOFIA prints a NOTAM's validity as a readable `DU: <from> AU: <to>`
 * line (B)/C) never shown as labels) and the Q) qualifier spaced out. Both are
 * locale-invariant: the numeric date form and the ICAO Q-line are the same in
 * every language; only the `DU`/`AU` (`FROM`/`TO`) words are localized, applied
 * by the caller. Pinned in tests/pib.spec.ts. */

/** Validity pieces for the `DU: <from> AU: <to>` line, dates in SOFIA's
 *  `DD MM YYYY HH:MM` UTC form. `to` is null when the NOTAM is permanent
 *  (printed as `PERM`); `estimated` appends ` EST` after the end date. */
export interface PibValidity {
	from: string;
	to: string | null;
	permanent: boolean;
	estimated: boolean;
}

function pad(n: number, width = 2): string {
	return String(n).padStart(width, '0');
}

/** A UTC date as SOFIA prints it: `DD MM YYYY HH:MM`. */
export function pibDateTime(d: Date): string {
	return (
		`${pad(d.getUTCDate())} ${pad(d.getUTCMonth() + 1)} ${d.getUTCFullYear()} ` +
		`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
	);
}

export function pibValidity(
	start: Date | null,
	end: Date | null,
	permanent: boolean,
	estimated: boolean,
): PibValidity {
	return {
		from: start ? pibDateTime(start) : '',
		to: permanent ? null : end ? pibDateTime(end) : '',
		permanent,
		estimated,
	};
}

/** Re-space a NOTAM Q) qualifier the SOFIA way: `FIR / Qcode / traffic /
 *  purpose / scope / lower/upper / coord+radius`. Accepts the raw Q) content
 *  (the text after `Q)`), whether it arrived compact (`LFFF/QFATT/...`,
 *  autorouter / paste) or already spaced (SOFIA); returns '' when absent. The
 *  lower/upper altitude band stays joined by a bare slash, as SOFIA prints it. */
export function pibQLine(rawQ: string | null | undefined): string {
	if (!rawQ) {
		return '';
	}
	const parts = rawQ.replace(/\s+/g, '').split('/');
	if (parts.length >= 8) {
		const [fir, code, traffic, purpose, scope, lower, upper] = parts;
		const coord = parts.slice(7).join('/');
		return `${fir} / ${code} / ${traffic} / ${purpose} / ${scope} / ${lower}/${upper} / ${coord}`;
	}
	// Malformed / partial Q-line: space what slashes are there rather than drop it.
	return parts.join(' / ');
}

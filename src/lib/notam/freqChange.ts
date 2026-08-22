/* Parse frequency-change NOTAMs.
 *
 * A NOTAM whose Q-code condition is CF / ME (isFrequencyChangeCondition,
 * qcode.ts) reassigns a published COM frequency. The SIA files them in three
 * shapes, all handled here on the whitespace-normalised E) text (the parser
 * collapses the original line breaks, so nothing keys on newlines):
 *
 *   A  REPLACES table        "ATIS: 120.005MHZ REPLACES 120.000MHZ"
 *   B  MODIFICATION list      "- MELUN TWR : 121.105MHZ"
 *   C  single FIS/SIV freq    "FIS SEINE INFORMATION (FIS 4 AND 5) FREQ : 120.330MHZ"
 *
 * `parseFreqAssignments` returns the labelled assignments (A + B); `singleFreq`
 * returns the lone frequency of form C. Both are pure and dependency-free: the
 * frequencies come back with their decimal separator normalised to the dot
 * form, otherwise verbatim (the display chokepoint `formatFreqMHz` finishes
 * the job), and the state resolver ($lib/state/freqOverride.svelte.ts)
 * decides, per link type (airport by ident / SIV by name), which extractor to
 * use and how to tie an assignment to a loaded radio row. This keeps the NOTAM
 * core free of the data / state layers and unit-testable in Node.
 */

/** One "<label> : <freq>MHZ [REPLACES <was>MHZ]" assignment from a
 *  frequency-change NOTAM. Frequencies are the published strings with the
 *  decimal separator normalised to a dot (e.g. "118.93", "120.005"); compare /
 *  display through `formatFreqMHz`. */
export interface FreqAssignment {
	/** Service label exactly as printed, trimmed: "ATIS", "TWR", "MELUN TWR",
	 *  "AFIS MELUN INFORMATION", "ABSENCE ATS A/A". The resolver canonicalises
	 *  it to a radio unit. */
	label: string;
	/** The newly assigned frequency (raw MHz string). */
	freq: string;
	/** The frequency it replaces when the NOTAM gives one ("... REPLACES
	 *  120.000MHZ"), else null. Lets the resolver match the exact prior row. */
	was: string | null;
}

// A VHF COM frequency followed by the MHZ unit. The MHZ suffix is required so a
// bare number (a date, an altitude, an AD chart reference like "ADC 01") is
// never read as a frequency. 1-3 decimals covers the 8.33 kHz channels; the
// SOFIA French corpus prints COMMA decimals ("119,800MHZ", world fixtures
// A3345/26) beside dotted ones in the same NOTAM, so both separators are
// accepted and every captured value is normalised to the dot form by dot().
const FREQ = String.raw`(\d{3}(?:[.,]\d{1,3})?)\s*MHZ`;

/** Normalise a captured frequency to the dot-decimal form. */
function dot(raw: string): string {
	return raw.replace(',', '.');
}

// A label is a run of letters / digits / "/" / "'" / "." / spaces that ends
// right before the "<freq>MHZ" (optionally a ": " separator). It cannot span a
// colon, an opening paren or a list dash, so each table row / list item / the
// "...REF X:" prefix bounds it. Lazy, so it grabs the shortest run abutting the
// frequency ("ATIS", not "...ADC 01: ATIS").
const LABEL = String.raw`([A-Za-z][A-Za-z0-9/'. ]*?)`;

// label : new MHZ [REPLACES|REMPLACE was MHZ]
const ASSIGNMENT_RE = new RegExp(
	`${LABEL}\\s*:\\s*${FREQ}(?:\\s+(?:REPLACES|REMPLACE)\\s+${FREQ})?`,
	'gi',
);

// Labels that are structural prefixes, not a service: the header of a
// MODIFICATION / REPLACES block ("...FREQ", "FREQUENCES CHANGEES") sits right
// before the first row's colon and would otherwise read as a one-off label.
const NOT_A_SERVICE = /^(?:FREQ|FREQUENCE|FREQUENCES|FREQUENCIES)$/i;

/** Labelled frequency assignments in the E) text (shapes A + B), in document
 *  order. Returns [] when nothing matches (the caller then flags the NOTAM as a
 *  bare "frequency changed" notice without a usable value). Pure. */
export function parseFreqAssignments(eText: string): FreqAssignment[] {
	if (typeof eText !== 'string' || eText === '') {
		return [];
	}
	const out: FreqAssignment[] = [];
	for (const m of eText.matchAll(ASSIGNMENT_RE)) {
		const label = m[1].trim();
		const freq = dot(m[2]);
		const was = m[3] != null ? dot(m[3]) : null;
		if (label === '' || NOT_A_SERVICE.test(label)) {
			continue;
		}
		out.push({ label, freq, was });
	}
	return out;
}

/** Every "<freq>MHZ" frequency in the text, raw, in order (duplicates kept). */
export function allFreqs(eText: string): string[] {
	if (typeof eText !== 'string') {
		return [];
	}
	const re = new RegExp(FREQ, 'gi');
	return [...eText.matchAll(re)].map((m) => dot(m[1]));
}

// A new->old replacement stated inline, in any phrasing: "<new> REPLACES <old>",
// "READ <new> (INSTEAD OF <old>)", "LIRE <new> (AU LIEU DE <old>)". The READ /
// LIRE prelude and the parentheses are incidental; only the two MHZ values and
// the connector between them matter. Two FREQ groups -> m[1] new, m[2] old.
const REPLACEMENT_RE = new RegExp(
	`${FREQ}\\s*\\(?\\s*(?:REPLACES|REMPLACE|INSTEAD OF|AU LIEU DE)\\s*${FREQ}`,
	'i',
);

/** The first "<new> ... <old>" replacement pair stated in the text, or null when
 *  there is none. Lets the resolver move only the row currently on the old
 *  frequency: "READ 120.330MHZ (INSTEAD OF 120.325MHZ)" changes the SEINE row on
 *  120.325 and leaves the others alone. Pure. */
export function freqReplacement(eText: string): { freq: string; was: string } | null {
	if (typeof eText !== 'string') {
		return null;
	}
	const m = REPLACEMENT_RE.exec(eText);
	return m ? { freq: dot(m[1]), was: dot(m[2]) } : null;
}

/** The single new frequency of a FIS/SIV change (shape C), or null when the
 *  text carries zero or several distinct frequencies (the caller then flags it,
 *  never guessing which one a SIV sector should adopt). Pure. */
export function singleFreq(eText: string): string | null {
	const freqs = allFreqs(eText);
	if (freqs.length === 0) {
		return null;
	}
	// Collapse "120.330" / "120.33" to one value before counting distinct.
	const distinct = new Set(freqs.map((f) => String(Number(f))));
	if (distinct.size !== 1) {
		return null;
	}
	return freqs[0];
}

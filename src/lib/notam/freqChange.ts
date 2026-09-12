/* Parse frequency-change NOTAMs.
 *
 * A NOTAM the Q-code marks as reassigning a frequency (isFrequencyChangeQCode,
 * qcode.ts) moves a published COM value. The SIA files them in four shapes,
 * all handled here on the whitespace-normalised E) text (the parser collapses
 * the original line breaks, so nothing keys on newlines):
 *
 *   A  REPLACES table        "ATIS: 120.005MHZ REPLACES 120.000MHZ"
 *   B  MODIFICATION list      "- MELUN TWR : 121.105MHZ"
 *   C  single FIS/SIV freq    "FIS SEINE INFORMATION (FIS 4 AND 5) FREQ : 120.330MHZ"
 *   D  document replacement   "A/A, VDF, AFIS AND TWR VATRY MODIFIED :
 *                              READ 129.405MHZ INSTEAD OF 129.400MHZ"
 *
 * `parseFreqAssignments` returns the labelled assignments (A + B), each with
 * the value it takes over from when the row states one; `allReplacements`
 * returns the bare new->old pairs (D, and the tail of A), which are placed by
 * the OLD value rather than by a label; `singleFreq` returns the lone
 * frequency of form C. All are pure and dependency-free: the frequencies come
 * back with their decimal separator normalised to the dot form, otherwise
 * verbatim (the display chokepoint `formatFreqMHz` finishes the job), and the
 * state resolver ($lib/state/freqOverride.svelte.ts) decides, per link type
 * (airport by ident / SIV by name), which extractor to use and how to tie an
 * assignment to a loaded radio row. This keeps the NOTAM core free of the
 * data / state layers and unit-testable in Node.
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

// How a NOTAM names the value the new one takes over from, in both languages
// and every phrasing the corpus prints: "<new> REPLACES <old>" / "REMPLACE",
// "<new> INSTEAD OF <old>" / "AU LIEU DE", the old value parenthesised or not.
// ONE definition, read by the labelled grammar below and by the bare pair
// further down, so a form one of them knows cannot be a form the other misses:
// E3291/26 (LFPT) states AU LIEU DE inside a labelled list, and while only the
// bare pair knew that connector the list parsed as three value-less
// assignments and the prior frequency was lost.
//
// The inner spaces are \s+ because a State wraps its own connector: C0562/26
// (LFAT) breaks the English line between INSTEAD and OF, and the French half
// of the same NOTAM does not, so a literal space reads one language only.
const REPLACED = String.raw`(?:REPLACES|REMPLACE|INSTEAD\s+OF|AU\s+LIEU\s+DE)`;

// The connector may name the thing before naming its value ("SHOULD BE FREQ
// 123.975MHZ INSTEAD OF FREQ 118.775MHZ", C0438/26 swapping the two Warsaw
// FIS sectors). A CLOSED set of noise words, deliberately: a run of arbitrary
// words would also bridge two unrelated clauses and pair a value with a
// contact frequency further along the sentence, and a wrong prior value moves
// a wrong row. An old value attributed to some OTHER unit ("READ STRASBOURG
// APPROACH 134.575MHZ INSTEAD OF LORRAINE APPROACH 119.125MHZ") therefore
// stays unmatched on purpose: that is one unit handing over to another, not a
// channel converting, and it is flagged rather than guessed at.
const OF_THE_FREQ = String.raw`(?:(?:THE|LA)\s+)?FREQ(?:UENCE|UENCY)?\s+`;
const REPLACED_TAIL = String.raw`\s*\(?\s*${REPLACED}\s*(?:${OF_THE_FREQ})?${FREQ}\s*\)?`;

// label : new MHZ [<connector> was MHZ]
//
// The frequency must ABUT the colon: a value introduced by READ / LIRE
// ("A/A, VDF, AFIS AND TWR VATRY MODIFIED : READ 129.405MHZ INSTEAD OF
// 129.400MHZ") is deliberately not read here, because what precedes that colon
// is a HEADER listing every service concerned, not one service's label. Those
// are document-level replacements and belong to `allReplacements`, which
// places them by the old value they state, on every row publishing it.
const ASSIGNMENT_RE = new RegExp(`${LABEL}\\s*:\\s*${FREQ}(?:${REPLACED_TAIL})?`, 'gi');

// Labels that are structural prefixes, not a service: the header of a
// MODIFICATION / REPLACES block ("...FREQ", "FREQUENCES CHANGEES") sits right
// before the first row's colon and would otherwise read as a one-off label,
// and an AD 2.18 table prints the word alone above its value ("- FREQUENCY:
// 121.500 MHZ, RMK: EMERGENCY", A2113/23 OITK). Both English numbers are
// listed beside both French ones: the singular FREQUENCY was missing, so the
// two halves of one bilingual NOTAM read differently, which is the one thing
// an extractor here may not do.
const NOT_A_SERVICE = /^(?:FREQ|FREQUENCE|FREQUENCES|FREQUENCY|FREQUENCIES)$/i;

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
const REPLACEMENT_RE = new RegExp(`${FREQ}${REPLACED_TAIL}`, 'gi');

/** One stated replacement: the value that takes over, and the one it takes
 *  over from. Both are raw MHz strings, dot-normalised. */
export interface FreqReplacement {
	freq: string;
	was: string;
}

/** Every "<new> ... <old>" replacement pair stated in the text, in document
 *  order, DEDUPED on the pair itself.
 *
 *  The deduplication is the point rather than tidiness: a State restates one
 *  channel change under each service that shares the channel. E3291/26 lists
 *  PONTOISE TWR and PONTOISE GONIO against the same 121.200 -> 121.205 (the
 *  SIA publishes the gonio on the tower's own channel, which is why cmd/fr
 *  emits no separate VDF row), and that is one move, not two, so the second
 *  statement must not read as a change the app failed to place. Pure. */
export function allReplacements(eText: string): FreqReplacement[] {
	if (typeof eText !== 'string' || eText === '') {
		return [];
	}
	const out: FreqReplacement[] = [];
	const seen = new Set<string>();
	for (const m of eText.matchAll(REPLACEMENT_RE)) {
		const freq = dot(m[1]);
		const was = dot(m[2]);
		const key = `${was}>${freq}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push({ freq, was });
	}
	return out;
}

/** The first "<new> ... <old>" replacement pair stated in the text, or null when
 *  there is none. Lets the resolver move only the row currently on the old
 *  frequency: "READ 120.330MHZ (INSTEAD OF 120.325MHZ)" changes the SEINE row on
 *  120.325 and leaves the others alone. Pure. */
export function freqReplacement(eText: string): FreqReplacement | null {
	return allReplacements(eText)[0] ?? null;
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

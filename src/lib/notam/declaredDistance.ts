/* Read DECLARED DISTANCES out of a NOTAM's E) text: the TORA / TODA / ASDA /
 * LDA a NOTAM restates for a runway end, in metres.
 *
 * The safety argument here is NOT the one notam/fuelChange.ts, runwayChange.ts
 * and aerodromeClosure.ts share, and the difference decides the design. Those
 * three withdraw something: refusing to read them leaves a service, a runway
 * or a field looking available, which is exactly what the panel already
 * showed, so a refusal costs nothing but a note. These do not withdraw, they
 * REPLACE a number the app both prints and calculates with. E0479/26 cuts
 * Aubenas to 320 m; refusing it leaves the AIP's own longer figure standing
 * under a take-off calculation, which is the dangerous direction. So a
 * refusal here is not silence: a runway end a QMD NOTAM names and this
 * grammar could not fully read is CONTESTED, and every surface has to say
 * that the published figures are disputed rather than print them plain.
 *
 * The scope is the RUNWAY MARKER, not the line: the SIA writes one NOTAM per
 * aerodrome with a `RWY <des> :` heading per end and everything until the
 * next heading belonging to it, and it writes those headings inside one long
 * line as readily as on their own.
 *
 * Pure, no Svelte, no I/O; the resolution against the published runway ends
 * lives in state/runwayOverride.svelte.ts. Pinned by
 * tests/declaredDistance.spec.ts. */

import { normalizeRunwayDesignator } from './runwayRefs';

/** The four declared distances, ICAO Annex 14 / PANS-AIM vocabulary. */
export type DistanceKey = 'tora' | 'toda' | 'asda' | 'lda';

export const DISTANCE_KEYS: readonly DistanceKey[] = ['tora', 'toda', 'asda', 'lda'];

/** What a NOTAM says about the ends it names. */
export interface DistanceStatement {
	/** Normalised runway ends the scope heads, in the order it names them. */
	designators: string[];
	/** Distances in METRES, only those the scope actually states. */
	values: Partial<Record<DistanceKey, number>>;
	/** 'declared': the values replace the published ones. 'note': the scope
	 *  says something about these ends that this grammar will not act on, and
	 *  the ends are contested until a reader looks. */
	kind: 'declared' | 'note';
	/** The scope text, folded, for the note. */
	text: string;
}

/** The ROW-TABLE form: a "RWY TODA ASDA LDA" header followed by one row per
 *  end ("06 547 700 597 24 597 700 547", E4399/26 LFOO). The values belong to
 *  the designator opening their own row, not to the scope's heading, and this
 *  grammar does not read rows; its signature is the RWY column sitting in
 *  front of the labels, so it is refused by name rather than by failing to
 *  line up, which for a single-row table it would not do. */
const ROW_TABLE_RE = /\b(?:RWY|RUNWAY|PISTE)\s+(?:TORA|TODA|ASDA|LDA)\b/;

/** The LABEL-THEN-DESIGNATOR form, the other nesting: the distance leads and
 *  the ends follow it ("TODA 02 : 1055M ASDA 20 : 1195M", D3879/26 LFNF;
 *  "-TODA : 32L 450M 14R 450M", D0033/26 LFCN). A runway heading earlier in
 *  the text then scopes values that are not its own, which handed RWY 20 a
 *  take-off distance stated for RWY 02. Refused by name for the same reason
 *  as the row table: it lines up perfectly well and is simply about something
 *  else. */
const LABEL_FIRST_RE =
	/\b(?:TORA|TODA|ASDA|LDA)\s*:?\s*\d{2}[LRCG]?\s*:|\b(?:TORA|TODA|ASDA|LDA)\s*:\s*\d{2}[LRCG]\b/;

/** A plausible runway distance in metres. A value with no unit is only
 *  believed inside this range: the corpus writes bare numbers freely
 *  ("TORA 2443"), and a stray 5 or 12000 is not a runway. */
const MIN_M = 50;
const MAX_M = 6000;

/** An INTERSECTION departure's figures, which are not declared distances:
 *  they are what is left from a taxiway entry. They sit inside an otherwise
 *  valid NOTAM (B1384/26 LFTW states the full runway and then three
 *  intersections), so this cuts a sub-clause rather than a whole scope. */
const INTERSECTION_RE =
	/\b(?:FROM|DEPUIS|AT|AU|A)\s+(?:TWY|TAXIWAY|INTERSECTION|BRETELLE)\b|\bREMAINING\s+DISTANCES?\b|\bDISTANCES?\s+RESTANTES?\b/;

/** Wording that MENTIONS a distance without declaring one: an advisory about
 *  what the existing LDA implies (M2828/26 LFMY, "LDA OF 1951M MEANS A FINAL
 *  APP SLOPE OF 5.1 PER CENT"), or a remark being amended (D4889/26 LFMA,
 *  whose 123M is the length of a strip beyond the runway end). */
const ADVISORY_RE =
	/\b(?:OF|DE)\s+\d+\s*M?\s+(?:MEANS|SIGNIFIE|REPRESENTE)\b|\bSTRIP\b|\bBANDE\b|\bREMARKS?\b|\bREMARQUES?\b/;

/** Fold accents, collapse whitespace, and normalise the separators the SIA
 *  uses between a label and its value so one pattern reads them all. */
function fold(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toUpperCase()
		.replace(/\s+/g, ' ')
		.trim();
}

/** Every "RWY <des>" / "PISTE <des>" heading, with where it starts. */
interface Head {
	at: number;
	designators: string[];
}

// No word boundary is required after the noun: D1882/26 LFET writes
// "RWY01 :" and "RWY19 :" with no space, and missing those two headings gave
// runway 19 the distances of runway 01, which is a wrong LANDING distance.
// The designators are a RUN rather than at most a pair, so "RUNWAYS 06/24 AND
// 06L/24R" heads all four ends instead of three.
const HEAD_RE =
	/\b(?:RUNWAYS?|RWY|PISTES?)(?:\s+(?:NON\s+)?(?:REVETUES?|PAVED|UNPAVED|GRASS|HERBE|GAZONNEES?))?\s*(\d{2}[LRCG]?(?:\s*(?:\/|AND|ET|,)\s*(?:RWY|PISTE)?\s*\d{2}[LRCG]?)*)/g;

function heads(text: string): Head[] {
	const out: Head[] = [];
	for (const m of text.matchAll(HEAD_RE)) {
		const ds = [...m[1].matchAll(/\d{2}[LRCG]?/g)].map((d) => normalizeRunwayDesignator(d[0]));
		if (ds.length > 0) {
			out.push({ at: m.index, designators: ds });
		}
	}
	return out;
}

/** Read a number that may or may not carry its metre unit. */
function metres(raw: string, hadUnit: boolean): number | null {
	const v = Number(raw.replace(',', '.'));
	if (!Number.isFinite(v) || v <= 0) {
		return null;
	}
	// A stated unit is believed as printed; a bare number has to be plausible.
	return hadUnit || (v >= MIN_M && v <= MAX_M) ? v : null;
}

/** Read the assignments of one runway scope.
 *
 *  Three printed forms, all of them in the corpus:
 *    TORA = TODA = ASDA = LDA = 1888M     several labels, one value
 *    TORA 1290M TODA 1350M                label then its own value
 *    TORA TODA ASDA LDA 1404 1404 1404 1145   N labels then N values
 *  The third is why the labels are collected first and the values matched
 *  against the run as a whole rather than each label reading forward on its
 *  own: a label followed by three more labels has no value of its own yet. */
function assignments(scope: string): Partial<Record<DistanceKey, number>> {
	const out: Partial<Record<DistanceKey, number>> = {};
	// Cut every intersection sub-clause before reading anything: those
	// figures are real distances, just not this runway's declared ones.
	const parts = scope
		.split(/(?=\b(?:FROM|DEPUIS)\s+(?:TWY|TAXIWAY|BRETELLE)\b)/)
		.filter((p) => !INTERSECTION_RE.test(p));
	for (const part of parts) {
		if (ADVISORY_RE.test(part) || ROW_TABLE_RE.test(part) || LABEL_FIRST_RE.test(part)) {
			continue;
		}
		// Tokenise into labels and numbers, in order.
		const toks: ({ label: DistanceKey } | { value: number })[] = [];
		const re = /\b(TORA|TODA|ASDA|LDA)\b|(\d{2,4}(?:[.,]\d+)?)\s*(M\b)?/g;
		for (const m of part.matchAll(re)) {
			if (m[1]) {
				toks.push({ label: m[1].toLowerCase() as DistanceKey });
				continue;
			}
			if (m[2] === undefined) {
				continue;
			}
			const v = metres(m[2], m[3] !== undefined);
			if (v !== null) {
				toks.push({ value: v });
			}
		}
		// Walk runs of labels followed by runs of values.
		let i = 0;
		while (i < toks.length) {
			const t = toks[i];
			if (!('label' in t)) {
				i++;
				continue;
			}
			const labels: DistanceKey[] = [];
			while (i < toks.length && 'label' in toks[i]) {
				labels.push((toks[i] as { label: DistanceKey }).label);
				i++;
			}
			const values: number[] = [];
			while (i < toks.length && 'value' in toks[i]) {
				values.push((toks[i] as { value: number }).value);
				i++;
			}
			if (values.length === 0) {
				continue;
			}
			if (values.length === 1 || labels.length === 1) {
				// One value for every label named: the chained-equals form,
				// and the ordinary single pair. A SINGLE label takes the value
				// that follows it and leaves the rest of a longer run alone,
				// because a number further along the sentence belongs to
				// whatever it was written for: D5111/26 LFHX closes its RWY 23
				// scope with "RUNWAY FORBIDDEN TO ACFT WITH TKOF REFERENCE
				// DISTANCE ... 1200M", and refusing the whole scope over that
				// dropped three distances the NOTAM states plainly.
				for (const l of labels) {
					out[l] ??= values[0];
				}
				continue;
			}
			if (values.length === labels.length) {
				// The positional table.
				labels.forEach((l, k) => {
					out[l] ??= values[k];
				});
				continue;
			}
			// Labels and values that do not line up are not read: a wrong
			// pairing here is a wrong take-off distance.
			return {};
		}
	}
	return out;
}

/** Read every runway scope of an E) text. A text naming no runway at all
 *  yields nothing, and one whose scopes state no usable value yields notes,
 *  which is what makes the ends CONTESTED rather than silently published. */
export function parseDeclaredDistances(eText: string): DistanceStatement[] {
	if (typeof eText !== 'string' || eText === '') {
		return [];
	}
	const text = fold(eText);
	const hs = heads(text);
	if (hs.length === 0) {
		return [];
	}
	const out: DistanceStatement[] = [];
	for (let i = 0; i < hs.length; i++) {
		const from = hs[i].at;
		const to = i + 1 < hs.length ? hs[i + 1].at : text.length;
		const scope = text.slice(from, to);
		const values = assignments(scope);
		out.push({
			designators: hs[i].designators,
			values,
			kind: Object.keys(values).length > 0 ? 'declared' : 'note',
			text: scope.trim(),
		});
	}
	return out;
}

/** Does this text state any declared distance at all? */
export function statesDeclaredDistances(eText: string): boolean {
	return parseDeclaredDistances(eText).some((s) => s.kind === 'declared');
}

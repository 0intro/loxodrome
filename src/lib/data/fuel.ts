/* Loader and types for the aerodrome-fuel dataset (public/data/fr-fuel.json).
 *
 * cmd/fuel emits one row per French aerodrome the AIP says anything about,
 * merged from the VAC plate's '10 - AVT' item and the AD 2.4 service entry
 * cmd/fr carries into the facilities dataset. There is no structured fuel
 * field anywhere in the French AIP, so the grades are READ from prose and
 * the prose comes with them: `text` is the source's own words, and every
 * surface that shows a chip shows those too.
 *
 * FR-only, and lazily loaded when an airport panel or the fuel plan asks
 * (see state/aerodromeFuel.svelte.ts). */

import { FUEL_TYPE_INFO, type FuelType } from '$lib/aircraft/schema';

/** A grade an aerodrome publishes.
 *
 * The first four are the aircraft side's own `FuelType` spellings, which is
 * what lets `sellsGrade` be a membership test rather than a mapping table;
 * tests/fuelGrades.spec.ts pins the two vocabularies together across the
 * language boundary. The rest have no aircraft counterpart and never match
 * one: the NATO codes are the armed forces' pumps, and a civil pilot cannot
 * uplift from them however close the product is to a civil grade. */
export type FuelGrade =
	| FuelType
	| 'MOGAS'
	| 'AVGAS'
	| 'F-18'
	| 'F-34'
	| 'F-35'
	| 'F-40'
	| 'F-44'
	| 'F-54'
	| 'F-63';

/** Every grade the dataset can carry, for the checks a type cannot make at
 *  run time. `satisfies` keeps a typo out; that it is COMPLETE is pinned by
 *  tests/fuelGrades.spec.ts against the sidecar cmd/fuel writes, so neither
 *  side of the language boundary can add a grade on its own. */
export const FUEL_GRADES = [
	'100LL',
	'UL91',
	'SUPER AERO+',
	'AVGAS',
	'MOGAS',
	'JET A-1',
	'F-18',
	'F-34',
	'F-35',
	'F-40',
	'F-44',
	'F-54',
	'F-63',
] as const satisfies readonly FuelGrade[];

/** Who a grade is published for. '' is the common case and means the AIP
 *  named no audience, which at a civil aerodrome means anyone. */
export type FuelScope = '' | 'civ' | 'mil';

/** One grade and who may uplift it. */
export interface FuelOffer {
	grade: FuelGrade;
	scope: FuelScope;
}

/** A fixed phrase the AIP states often enough to be worth typing. Everything
 *  else about when fuel is served stays in the verbatim text. */
export type FuelCondition = 'h24' | 'or' | 'hx' | 'based';

/** One aerodrome's fuel entry. An aerodrome the AIP says nothing about has
 *  no row at all, which is why there is no 'unknown' availability: absence
 *  is the unknown, and the panel shows nothing rather than a blank line. */
export interface AerodromeFuel {
	ident: string;
	/** 'no' is the AIP stating the field is dry, which is worth as much to a
	 *  pilot as a grade list. */
	avail: 'yes' | 'no';
	/** Empty where nothing could be read with confidence. That is a real
	 *  answer: the caller shows `text` and no chips. */
	grades: FuelOffer[];
	cond: FuelCondition[];
	/** Which sources contributed. */
	src: 'vac' | 'aixm' | 'both';
	/** The AIP's own words, bilingual "French\\English", '#' between lines,
	 *  for formatAipRemark to render. */
	text: string;
}

export const FR_FUEL_URL = '/data/fr-fuel.json';
export const FR_FUEL_NEXT_URL = '/data/fr-fuel.next.json';

interface FuelDoc {
	fields: string[];
	rows: unknown[][];
}

const SCOPES: FuelScope[] = ['', 'civ', 'mil'];
const CONDITIONS: FuelCondition[] = ['h24', 'or', 'hx', 'based'];

function toOffers(v: unknown): FuelOffer[] {
	if (!Array.isArray(v)) {
		return [];
	}
	const out: FuelOffer[] = [];
	for (const entry of v) {
		if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
			continue;
		}
		const scope = SCOPES.find((s) => s === entry[1]) ?? '';
		out.push({ grade: entry[0] as FuelGrade, scope });
	}
	return out;
}

/** Decode one row, resolving columns by name so an inserted column cannot
 *  shift the reader silently. */
function rowToFuel(
	row: unknown[],
	idx: Record<string, number>
): AerodromeFuel | null {
	const ident = row[idx.ident];
	const avail = row[idx.avail];
	if (typeof ident !== 'string' || (avail !== 'yes' && avail !== 'no')) {
		return null;
	}
	const src = row[idx.src];
	const flags = Array.isArray(row[idx.flags])
		? (row[idx.flags] as unknown[]).filter((c): c is FuelCondition =>
				CONDITIONS.some((k) => k === c)
		  )
		: [];
	return {
		ident: ident.toUpperCase(),
		avail,
		grades: toOffers(row[idx.grades]),
		cond: flags,
		src: src === 'vac' || src === 'aixm' || src === 'both' ? src : 'vac',
		text: typeof row[idx.text] === 'string' ? (row[idx.text] as string) : '',
	};
}

/** Load and decode the dataset. Fail-soft in the two ways every dataset
 *  loader here is: a non-OK response and a non-JSON 200 (Vite dev serves the
 *  SPA shell for a missing file) both read as 'no rows'. */
export async function loadFrFuel(url: string): Promise<AerodromeFuel[]> {
	const res = await fetch(url);
	if (!res.ok) {
		console.warn(`fuel: ${url} -> ${res.status}`);
		return [];
	}
	if (!res.headers.get('content-type')?.includes('json')) {
		return [];
	}
	const doc = (await res.json()) as FuelDoc;
	if (!Array.isArray(doc?.rows) || !Array.isArray(doc?.fields)) {
		return [];
	}
	const idx: Record<string, number> = {};
	doc.fields.forEach((f, i) => {
		idx[f] = i;
	});
	const out: AerodromeFuel[] = [];
	for (const row of doc.rows) {
		const r = rowToFuel(row, idx);
		if (r) {
			out.push(r);
		}
	}
	return out;
}

/** The avgas grades, as the family word covers them.
 *
 *  MOGAS is not an avgas and the NATO codes are never folded into their
 *  civil equivalents; this is the same membership internal/fuel's
 *  dropBareAvgas uses when it decides that "AVGAS 100LL" names one fuel. */
const AVGAS_FAMILY: readonly FuelGrade[] = ['100LL', 'UL91', 'SUPER AERO+'];

/** Whether a string is a grade this build knows.
 *
 *  The NOTAM extractor returns bare strings, parser-core modules knowing
 *  nothing of the fuel vocabulary; this is where they are admitted, so a code
 *  the vocabulary does not carry is ignored rather than coerced into it. */
export function isFuelGrade(v: string): v is FuelGrade {
	return (FUEL_GRADES as readonly string[]).includes(v);
}

/** Whether a published grade is the one a NOTAM's stated grade is about.
 *
 *  Both directions, and that is not symmetry for its own sake: Corte
 *  publishes the unqualified AVGAS and its NOTAM names the family in French
 *  ("AVGAS NON DISPONIBLE") and the grade in English ("AVGAS 100LL NOT
 *  AVBL"). One direction settles one half and the other settles the other,
 *  against the same published row. Without both, one language would strike a
 *  chip the other left standing. */
export function gradeCovers(published: FuelGrade, stated: FuelGrade): boolean {
	if (published === stated) {
		return true;
	}
	if (published === 'AVGAS') {
		return AVGAS_FAMILY.includes(stated);
	}
	if (stated === 'AVGAS') {
		return AVGAS_FAMILY.includes(published);
	}
	return false;
}

/** The shape the two helpers below read. Structural rather than
 *  `AerodromeFuel`, so the NOTAM-resolved row (whose offers carry a
 *  `withdrawn` mark) is the same answer to the same question: what a pilot
 *  may uplift here today. The extension type lives in state/, never here. */
export interface FuelOffering<S = unknown> {
	avail: 'yes' | 'no';
	grades: readonly { grade: FuelGrade; scope: FuelScope; withdrawn?: S }[];
	/** Set where a NOTAM withdrew the whole supply of a row whose prose named
	 *  no grade at all: there is nothing to mark, and still nothing to sell. */
	withdrawnAll?: S;
}

/** The grades a pilot may actually uplift: everything the AIP did not scope
 *  to the armed forces, less anything a NOTAM has withdrawn. The military
 *  ones are still carried, and still shown, marked as what they are. */
export function civilGrades(f: FuelOffering): FuelGrade[] {
	if (f.withdrawnAll != null) {
		return [];
	}
	return f.grades.filter((g) => g.scope !== 'mil' && g.withdrawn == null).map((g) => g.grade);
}

/** Why an aerodrome cannot serve this aeroplane.
 *
 *  The four answers are not interchangeable to a pilot. Two are the AIP's:
 *  this field has no fuel at all, or none of the grades it publishes is one
 *  the aeroplane takes; both are permanent until the next cycle, and the
 *  answer is to plan around them. Two are a NOTAM's, carry a date and an id,
 *  and may well be gone by the flight. Saying only "no fuel" for all four
 *  loses the difference at the one place a pilot decides where to stop.
 *
 *  `by` is the NOTAM, and the source type rides through as a parameter, the
 *  `applyFuelChange` idiom: the data layer does not know what a briefing
 *  entry is, and a caller that does gets it back typed rather than casting
 *  an `unknown` open at the one point that prints the id. */
export type FuelRefusal<S = unknown> =
	| { kind: 'aipNone' }
	| { kind: 'aipGrade' }
	| { kind: 'notamAll'; by: S }
	| { kind: 'notamGrade'; by: S; grades: FuelGrade[] };

/** The reason, or null where the aerodrome CAN serve the aeroplane and null
 *  where nothing is known (no row, or a row whose prose named no grade). The
 *  two nulls are one answer on purpose: neither is a refusal, and a caller
 *  must not turn either into a warning. Pair it with sellsGrade where the
 *  three states matter. */
export function fuelRefusal<S>(
	f: FuelOffering<S> | null,
	types: readonly FuelType[]
): FuelRefusal<S> | null {
	if (!f) {
		return null;
	}
	if (f.avail === 'no') {
		return { kind: 'aipNone' };
	}
	if (f.withdrawnAll != null) {
		return { kind: 'notamAll', by: f.withdrawnAll };
	}
	// Past the two reasons above, every answer is about THIS aeroplane's
	// grades, and an aeroplane whose data sheet names none is not refused by
	// an aerodrome, it is simply unasked. Without this the fuel plan says
	// "LFLL does not publish " of every stop the moment no aeroplane is
	// selected, which is both wrong and, with an empty grade list in it,
	// not a sentence. A field the AIP states is DRY is still a no to it:
	// that fact is about the aerodrome and not about the aeroplane.
	if (types.length === 0 || f.grades.length === 0) {
		return null;
	}
	const civil = civilGrades(f);
	if (types.some((t) => civil.some((g) => g === t))) {
		return null;
	}
	// It publishes none of them TODAY. Whether it published one yesterday is
	// the whole difference between "bring your own" and "ring ahead".
	const withdrawn: { grade: FuelGrade; by: S }[] = [];
	for (const g of f.grades) {
		if (g.withdrawn != null && g.scope !== 'mil' && types.some((t) => t === g.grade)) {
			withdrawn.push({ grade: g.grade, by: g.withdrawn });
		}
	}
	const first = withdrawn[0];
	return first
		? { kind: 'notamGrade', by: first.by, grades: withdrawn.map((w) => w.grade) }
		: { kind: 'aipGrade' };
}

/** Whether this aerodrome publishes a grade this aeroplane takes.
 *
 * `types` is the data sheet's whole accepted list, not the grade currently
 * tanked: the question a fuel stop asks is what the aeroplane MAY take.
 * Null where the aerodrome states no grade, which is not the same as no —
 * the AIP said something we could not read, and a caller must not turn that
 * into a warning.
 *
 * Derived from fuelRefusal so the verdict and the reason for it cannot come
 * to disagree. */
export function sellsGrade(
	f: FuelOffering | null,
	types: readonly FuelType[]
): boolean | null {
	if (!f) {
		return null;
	}
	const refusal = fuelRefusal(f, types);
	if (refusal) {
		return false;
	}
	// No refusal is not yet a yes. A positive answer needs BOTH a grade list
	// to read and a grade to read it for: an aerodrome the AIP says nothing
	// readable about, and an aeroplane that states no fuel, are both unknown.
	// (An explicit NIL never reaches here, being a refusal above.)
	return types.length > 0 && f.grades.length > 0 ? true : null;
}

/** The label a grade wears on screen. Locale-invariant, like the aircraft
 *  side's own grade labels: these are product designations, not words. The
 *  four the aeroplanes know borrow their spelling from FUEL_TYPE_INFO so one
 *  grade never reads two ways in one app. */
export function gradeLabel(g: FuelGrade): string {
	// hasOwn, not `in`: the grade comes off a dataset row, and `in` walks the
	// prototype chain, so a row carrying "toString" would resolve to a
	// function whose .label is undefined and print as such.
	return Object.hasOwn(FUEL_TYPE_INFO, g) ? FUEL_TYPE_INFO[g as FuelType].label : g;
}

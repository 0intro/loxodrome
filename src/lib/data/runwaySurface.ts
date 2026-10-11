/* What a runway's surface string says about the runway: paved, unpaved, a
 * mix of both, or nothing anyone can read. Pure, locale-free, no Leaflet,
 * so the map symbols (map/airportSymbols.ts), the performance page's grass
 * factor (aircraft/aerodromes.ts) and the overlay merge (data/airportMerge.ts)
 * all read one answer. Pinned by tests/runwaySurface.spec.ts, and against
 * every shipped overlay code by tests/symbolCoverage.spec.ts.
 *
 * The strings are free text from a dozen publishers: AIXM codes (ASPH,
 * CONC_ASPH, GRASS), the FAA's COMP_CODE (ASPH-TURF-G, its single-letter
 * condition suffixes), OurAirports' crowd-sourced free text (Piçarra,
 * Graded Hardcore, Asfalt), Australia's single letters. Matching runs on
 * whole TOKENS (letter runs, accents folded), never on substrings: a
 * substring rule read "unsealed" as sealed and "Blacktop on granite" as
 * grass (GRA). Anything no token explains is `unknown`, which every
 * consumer treats as NOT known to be paved: the map draws the open circle,
 * the performance page applies the grass factor and says it assumed one.
 * The vocabulary below was measured on every shipped dataset (2026-10-02,
 * 64,394 runways); each choice carries its evidence. */

export type SurfaceClass = 'hard' | 'mixed' | 'soft' | 'unknown';

/** Paving. Typos and spellings found in the data included (ASFALT, ASHP,
 *  APSH, which the overlays call ASPH). PER is DAFIF's "permanent surface"
 *  (the FAA calls both KCID runways CONC); OILGRAVEL is Finnish oil-bound
 *  gravel, every such runway being ASPH in the Finnish eAIP. REVETU(E) is
 *  here so that NON REVÊTUE can negate it. The structures (ROOF, DECK,
 *  WOOD, METAL...) are heliport pads, which draw no runway bar anyway: hard
 *  keeps them exactly as they were. */
const HARD = new Set([
	'ASP', 'ASPH', 'ASPHALT', 'CON', 'CONC', 'CONCRETE', 'PEM',
	'ASFALT', 'ASHP', 'ASHPALT', 'APSH',
	'CEM', 'CEMENT', 'PER',
	'BIT', 'BITUM', 'BITUMEN', 'BITUMINOUS',
	'MAC', 'MACADAM', 'TAR', 'TARMAC', 'BLACKTOP', 'SEAL', 'SEALED', 'CHIPSEAL', 'OILGRAVEL',
	'PAVED', 'PAVING', 'PAVEMENT', 'REVETU', 'REVETUE',
	'BRICK', 'BRI',
	'ROOF', 'ROOFTOP', 'DECK', 'WOOD', 'MET', 'METAL', 'MTAL', 'ALUM', 'ALUMINUM', 'ALUMINIUM',
]);

/** Not paved. GRE is OurAirports' graded earth or grass (the FAA files those
 *  runways GRASS, DIRT, TURF+DIRT); HARDCORE is compacted rubble (NATS files
 *  the Orkney strips OTHER, OurAirports "Graded Hardcore"); TRTD / TREATED is
 *  the FAA's oiled or stabilised soil; TER is Brazilian terra, PICARRA its
 *  laterite gravel. */
const SOFT = new Set([
	'TURF', 'GRASS', 'GRS', 'GRA', 'GR', 'GRAS', 'GRAAS', 'GRASSS', 'GRASSY', 'GRASSED', 'SOD', 'HERBE', 'GRE',
	'GVL', 'GRVL', 'GRV', 'GRAVEL', 'GRAVE', 'GRAV', 'ROCK', 'CINDERS', 'SLAG', 'SHELL', 'SHELLS',
	'CORAL', 'COR', 'LIMESTONE', 'SHALE', 'SCHIST', 'MAICILLO', 'PICARRA', 'HARDCORE',
	'DIRT', 'EARTH', 'SOIL', 'GROUND', 'NATURAL', 'LOAM', 'SILT', 'MUD', 'TER', 'CLAY', 'CLA',
	'SAND', 'SAN', 'SAIBRO', 'MURRAM', 'LATERITE', 'LAT', 'CALICHE', 'SALT', 'SOFT',
	'TRTD', 'TREATED',
	'WATER', 'WAT', 'WTR', 'SNOW', 'SNO', 'ICE',
]);

/** DAFIF's composite codes: every cross-checked runway has a paved part, half
 *  of them an unpaved one too, so both. */
const COMPOSITE = new Set(['COP', 'COM', 'COMPOSITE']);

/** A string that is ONE token reads through this table first. The single
 *  letters are Australian (OurAirports): B is bitumen (Batchelor, Maralinga,
 *  Caloundra), G is grass (all ten European G runways are GRASS in their
 *  national data), N natural; every other single letter (X, C, S, L, A, H,
 *  U) is unknown, outback strips that no national data confirms. HARD alone
 *  is paved (EDXM and LFEN are ASPH in their overlays); followed by other
 *  words it says nothing ("Hard Gravel"). */
const WHOLE: Readonly<Record<string, SurfaceClass>> = { B: 'hard', G: 'soft', N: 'soft', HARD: 'hard' };

/** A word placed before a paving token negates it: NOT PAVED, NON REVÊTUE,
 *  AIXM 5.1's NON_BITUM_MIX, "Un-paved". */
const NEGATIONS = new Set(['NOT', 'NON', 'NO', 'UN']);

/** The same negations fused onto the paving token: UNPAVED, UNSEALED,
 *  NONPAVED, NOTPAVED. */
const FUSED_NEGATION = /^(?:UN|NON|NOT)(.+)$/;

/** The letter runs of a surface string, upper-cased with the accents folded
 *  (Piçarra reads PICARRA, REVÊTUE reads REVETUE). Digits and punctuation
 *  separate tokens. */
function surfaceTokens(raw: string): string[] {
	return (
		raw
			.normalize('NFD')
			.replace(/\p{M}/gu, '')
			.toUpperCase()
			.match(/\p{L}+/gu) ?? []
	);
}

function paved(tokens: readonly string[], i: number): 'paved' | 'negated' | null {
	const tk = tokens[i];
	if (HARD.has(tk)) {
		return i > 0 && NEGATIONS.has(tokens[i - 1]) ? 'negated' : 'paved';
	}
	const fused = FUSED_NEGATION.exec(tk);
	return fused && HARD.has(fused[1]) ? 'negated' : null;
}

function classify(raw: string): SurfaceClass {
	const tokens = surfaceTokens(raw);
	if (tokens.length === 0) {
		return 'unknown';
	}
	if (tokens.length === 1) {
		const whole = WHOLE[tokens[0]];
		if (whole) {
			return whole;
		}
		if (tokens[0].length === 1) {
			return 'unknown';
		}
	}
	let hard = false;
	let soft = false;
	for (let i = 0; i < tokens.length; i++) {
		// A single letter inside a longer string is a condition or PCN code
		// (the FAA's ASPH-G, -F, -P; 'ASPH 71/F/C/X/T'), never a surface.
		if (tokens[i].length < 2) {
			continue;
		}
		if (COMPOSITE.has(tokens[i])) {
			hard = true;
			soft = true;
			continue;
		}
		const p = paved(tokens, i);
		if (p === 'paved') {
			hard = true;
		} else if (p === 'negated' || SOFT.has(tokens[i])) {
			soft = true;
		}
	}
	if (hard) {
		return soft ? 'mixed' : 'hard';
	}
	return soft ? 'soft' : 'unknown';
}

// Plain .ts, so the reactivity lint does not apply: a module-level memo over
// the ~600 distinct strings the datasets carry, read per runway per paint.
const memo = new Map<string, SurfaceClass>();

/** The class of a runway surface string (see the file header). */
export function classifySurface(raw: string | null | undefined): SurfaceClass {
	const key = raw ?? '';
	let c = memo.get(key);
	if (c === undefined) {
		c = classify(key);
		memo.set(key, c);
	}
	return c;
}

/** Does the runway have a paved part? The map's test: a mixed runway (paved
 *  with a grass or gravel part) still draws as paved, an unknown one does
 *  not (open circle: not KNOWN to be paved). The performance page asks the
 *  stricter `classifySurface(...) === 'hard'` instead. */
export function hasHardPart(c: SurfaceClass): boolean {
	return c === 'hard' || c === 'mixed';
}

/** Canonical English labels by first token; the catalogs translate them
 *  (t.data.surfaces, keyed by the lowercased label). Anything else shows as
 *  published. */
const LABELS: Readonly<Record<string, string>> = {
	ASP: 'Asphalt', ASPH: 'Asphalt', ASPHALT: 'Asphalt', ASFALT: 'Asphalt', ASHP: 'Asphalt', APSH: 'Asphalt',
	BIT: 'Bitumen', BITUM: 'Bitumen', BITUMEN: 'Bitumen', BITUMINOUS: 'Bitumen',
	MAC: 'Macadam', MACADAM: 'Macadam',
	CON: 'Concrete', CONC: 'Concrete', CONCRETE: 'Concrete', PEM: 'Concrete',
	TURF: 'Grass', GRS: 'Grass', GRA: 'Grass', GRASS: 'Grass', GRE: 'Grass', SOD: 'Grass', HERBE: 'Grass',
	GVL: 'Gravel', GRVL: 'Gravel', GRV: 'Gravel', GRAVEL: 'Gravel', GRAVE: 'Gravel', GRAV: 'Gravel',
	WATER: 'Water', WTR: 'Water', WAT: 'Water',
	SNOW: 'Snow', SNO: 'Snow', ICE: 'Ice',
	SAND: 'Sand', SAN: 'Sand', CORAL: 'Coral', COR: 'Coral',
	DIRT: 'Dirt', EARTH: 'Dirt',
	UNK: 'Unknown', UNKNOWN: 'Unknown', OTHER: 'Unknown',
};

/** A readable label for a surface string: the canonical English label of its
 *  first token (ASPH-TURF reads Asphalt, GRAVEL-G Gravel), "Unpaved" for a
 *  negated paving word, "Unknown" for an empty or placeholder string, else
 *  the string as published (Graded Hardcore, Piçarra, MATS). By token, so a
 *  gravel runway no longer reads Grass (the old prefix test took GRAVEL for
 *  GRA). */
export function formatSurface(raw: string | null | undefined): string {
	const tokens = surfaceTokens(raw ?? '');
	if (tokens.length === 0) {
		return 'Unknown';
	}
	const label = LABELS[tokens[0]];
	if (label) {
		return label;
	}
	if (paved(tokens, 0) === 'negated' || (tokens.length > 1 && paved(tokens, 1) === 'negated')) {
		return 'Unpaved';
	}
	return (raw ?? '').trim();
}

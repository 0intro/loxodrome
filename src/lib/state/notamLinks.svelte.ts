/* Geometric link between NOTAMs and airspaces.
 *
 * The two helpers both read `filteredNotams()` and the loaded airspace list so
 * any active filter (date, altitude, status, kind, text) propagates without
 * extra wiring. Reading them inside a derived/template expression tracks
 * everything they touch. */

import type { Airspace } from '$lib/data/airspaces';
import {
	compareAirspaceByBand,
	firIdent,
	pointInRing,
} from '$lib/data/airspaces';
import { bandIntersects, notamBandFt } from '$lib/vertical/limits';
import {
	bboxesOverlap,
	notamBbox,
	pointCircleInRing,
	ringsOverlap,
} from '$lib/notam/geometry';
import {
	controlAirspaceType,
	isActivationQCode,
	isFlightInfoServiceQCode,
} from '$lib/notam/qcode';
import { parseSections } from '$lib/notam/parser';
import {
	hasRestrictedAreaSubject,
	isTriggerNotam,
	notamReferences,
	notamReplacement,
} from '$lib/notam/relations';
import { extractAipSups, extractActivatedSups } from '$lib/notam/aipSup';
import {
	AIRSPACE_ID_RE,
	designatorKey,
	extractCitedDesignators,
	firToPublisher,
} from '$lib/notam/airspaceIds';
import { isReferenceContext } from '$lib/notam/citationContext';
import {
	isRtbaActivationNotam,
	parseRtbaZones,
	rtbaActiveDuring,
} from '$lib/notam/rtba';
import { NM_TO_METERS } from '$lib/notam/units';
import { radiusToNM } from '$lib/notam/radius';
import type { Notam } from '$lib/notam/types';
import {
	activeEvalWindow,
	firNotamIndex,
	notamState,
	filteredNotams,
	type IndexedNotam,
} from './notam.svelte';
import { getAirspaces } from './data.svelte';
import { activeAltitudeBand } from './filter.svelte';
import type { Publisher } from './layers.svelte';

/** Mirrors entryPasses() in airspaceLayer.ts so airspacesForNotam respects
 *  the same altitude filter that hides airspaces on the map. */
function airspacePassesAltitude(
	a: Airspace,
	band: { floor: number; ceiling: number } | null,
): boolean {
	if (!band) {
		return true;
	}
	return bandIntersects(a.vLower, a.vUpper, band);
}

/** NOTAM vertical band (operational F)/G) items first, else the Q-line
 *  band, per OPADD) vs airspace vertical limits, in feet. Datum-aware and
 *  conservative on both sides; a NOTAM with no vertical statement or an
 *  airspace with a missing side keeps the pair. */
function altitudesOverlap(n: Notam, a: Airspace): boolean {
	const nb = notamBandFt(n.fgLower, n.fgUpper, n.qualifier);
	if (!nb) {
		return true;
	}
	return bandIntersects(a.vLower, a.vUpper, { floor: nb.floor, ceiling: nb.ceiling });
}

/** Tolerance (metres) for matching a Q-line fallback coordinate to an
 *  airspace. Covers the Q-line centre's arc-minute rounding (~1 km) so a
 *  NOTAM genuinely about a tiny zone isn't dropped, without using the coarse
 *  Q) scope radius (commonly 25 NM+) that would enclose every airspace for
 *  tens of NM. */
const QLINE_TOLERANCE_M = 2000;

// Exported for the airspace-overlap spec; not part of the public state API.
export function geometryOverlap(n: Notam, a: Airspace): boolean {
	if (n.isPolygon && n.coordinates.length >= 3) {
		const ring = n.coordinates.map(
			(c) => [c.lat, c.lon] as [number, number],
		);
		return ringsOverlap(ring, a.ring);
	}
	// Non-polygon NOTAMs may carry several positions, each drawn separately
	// on the map with its own radius. Match the map: a hit on any of them
	// links the NOTAM to the airspace.
	for (const c of n.coordinates) {
		// The Q-line fallback coordinate carries the Q) scope radius, a coarse
		// ATC bound, not the NOTAM's real area. Used whole it floods small
		// airspaces: a few-km aerial-activity zone sits inside every regional
		// NOTAM's scope circle, so the panel fills with unrelated NOTAMs.
		// Match only within a small tolerance of the (rounded) Q-line centre.
		if (c.type === 'qualifierLine') {
			if (pointCircleInRing(c.lat, c.lon, QLINE_TOLERANCE_M, a.ring)) {
				return true;
			}
			continue;
		}
		if (c.radius != null && c.radiusUnit) {
			const rM = radiusToNM(c.radius, c.radiusUnit) * NM_TO_METERS;
			if (pointCircleInRing(c.lat, c.lon, rM, a.ring)) {
				return true;
			}
		} else if (pointInRing(c.lat, c.lon, a.ring)) {
			return true;
		}
	}
	return false;
}

function overlaps(n: Notam, a: Airspace): boolean {
	if (!altitudesOverlap(n, a)) {
		return false;
	}
	if (!bboxesOverlap(notamBbox(n), a.bbox)) {
		return false;
	}
	return geometryOverlap(n, a);
}

/** Visible NOTAMs related to the airspace, in `filteredNotams()` order.
 *
 *  FIR-like rows (FIR / UIR / OCA / ARTCC) get their own briefing: the NOTAMs
 *  filed under the FIR's indicator in their Item A) (firNotamIndex), exactly
 *  what a FIR briefing request returns; this replaces the old geometric flood
 *  where every NOTAM whose position fell inside the FIR polygon listed here.
 *
 *  Every other airspace lists its RELATIONSHIP links: activation by id
 *  (activatedAirspaceIds: cited codes + RTBA zones, so a multi-zone RTBA
 *  NOTAM whose single Q-line centroid sits far from this zone still lists),
 *  organisation-airspace NOTAMs that name it in their E) text
 *  (notamNamesAirspace), and special-use NOTAMs that cite its designator
 *  whatever the condition (notamMentionsAirspace, so a "limits amended"
 *  QRRCD reaches its zone). Purely geometric containment moved to the
 *  opt-in geometricNotamsForAirspace. Returns `[]` if the airspace is not
 *  loaded. */
export function notamsForAirspace(airspaceId: string): IndexedNotam[] {
	const all = getAirspaces();
	if (!all) {
		return [];
	}
	const a = all.find((sp) => sp.id === airspaceId);
	if (!a) {
		return [];
	}
	const fir = firIdent(a);
	if (fir) {
		return firNotamIndex().briefing.get(fir) ?? [];
	}
	return filteredNotams().filter(
		(it) =>
			activatedAirspaceIds(it.notam).includes(a.id) ||
			notamNamesAirspace(it.notam, a) ||
			notamMentionsAirspace(it.notam, a),
	);
}

/** Visible NOTAMs whose geometry touches the airspace: the location-based
 *  tier (notamsForAirspace's old default), now a separate opt-in list behind
 *  the Display tab's geometric-lists preference. Same overlaps() machinery
 *  as airspacesForNotam: Q-line altitude band, bbox prefilter, ring tests
 *  with the small Q-line-centre tolerance. */
export function geometricNotamsForAirspace(airspaceId: string): IndexedNotam[] {
	const all = getAirspaces();
	if (!all) {
		return [];
	}
	const a = all.find((sp) => sp.id === airspaceId);
	if (!a) {
		return [];
	}
	return filteredNotams().filter((it) => overlaps(it.notam, a));
}

/** Airspaces the NOTAM geometrically crosses (its area or Q-line position
 *  touches the ring), ordered highest-band first (smallest area breaks ties).
 *  This is the location-based "In airspaces" list; the explicit by-name link
 *  is separate (see airspacesNamedByNotam), so a NOTAM that names an airspace
 *  it does not sit inside is not conflated with location. Listed regardless of
 *  the airspace layer toggles, so it shows even with every airspace category
 *  hidden; only the active altitude filter excludes rows (matching the map). */
export function airspacesForNotam(notam: Notam): Airspace[] {
	const all = getAirspaces();
	if (!all) {
		return [];
	}
	const band = activeAltitudeBand();
	return all
		.filter((a) => airspacePassesAltitude(a, band) && overlaps(notam, a))
		.sort(compareAirspaceByBand);
}

/* ------------------------------------------------------------------ */
/* Identity-based link: a NOTAM that activates a named special-use     */
/* airspace (e.g. LFR45A) → that airspace, by ICAO code match against  */
/* airspaces.json. Complements the geometric link above; doesn't       */
/* replace it.                                                         */
/* ------------------------------------------------------------------ */

// The designator grammar lives in $lib/notam/airspaceIds (shared with the
// citation tier); re-exported here so the activation spec and existing
// callers keep their import path.
export { extractAirspaceIds } from '$lib/notam/airspaceIds';

/** Every airspace id this NOTAM activates BY IDENTITY: the special-use codes its
 *  body cites ("LF-R262" → LFR262) plus the RTBA zone ids it lists ("ZONE R45C
 *  ARBOIS" → LFR45C; see notam/rtba.ts). Deduped, in body order, gated to
 *  activation Q-codes (QRRCA family) so a non-activation NOTAM that merely
 *  mentions a code yields nothing. Codes sitting in a reference / exclusion
 *  clause are skipped (isReferenceContext), so a ZRT-creation NOTAM that
 *  "REPLACES ... EXCEPT LF-R400E ..." does not read as activating LF-R400E. The
 *  single source of truth for the id-based activation link in both directions
 *  (activatesAirspaces forward, notamsForAirspace reverse). Exported for the
 *  activation spec. */
export function activatedAirspaceIds(notam: Notam): string[] {
	if (!isActivationQCode(notam.qCode)) {
		return [];
	}
	const out: string[] = [];
	// Local, intentionally non-reactive dedup index.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const seen = new Set<string>();
	for (const m of notam.fullContent.matchAll(AIRSPACE_ID_RE)) {
		if (isReferenceContext(notam.fullContent, m.index ?? 0)) {
			continue;
		}
		const id = m[1] + m[2] + m[3];
		if (!seen.has(id)) {
			seen.add(id);
			out.push(id);
		}
	}
	for (const z of parseRtbaZones(notam)) {
		if (!seen.has(z.airspaceId)) {
			seen.add(z.airspaceId);
			out.push(z.airspaceId);
		}
	}
	return out;
}

/** True iff the NOTAM's validity window overlaps [fromMs, toMs]. Permanent
 *  NOTAMs are always active; NOTAMs without dates are excluded (no way to
 *  know). The single source of truth for the "is this active" time test behind
 *  every map cue; isActiveNow is the degenerate single-instant case.
 *  Exported for the activation spec; not part of the public state API. */
export function isActiveDuring(notam: Notam, fromMs: number, toMs: number): boolean {
	if (notam.permanent) {
		return true;
	}
	if (!notam.startDate || !notam.endDate) {
		return false;
	}
	return notam.startDate.getTime() <= toMs && notam.endDate.getTime() >= fromMs;
}

/** True iff the NOTAM's validity window contains the instant `nowMs`. */
export function isActiveNow(notam: Notam, nowMs: number): boolean {
	return isActiveDuring(notam, nowMs, nowMs);
}

/** The special-use airspaces this NOTAM activates by id match
 *  (activatedAirspaceIds: cited codes + RTBA zones, qCode-filtered to activation
 *  subjects/conditions). The time window is *not* applied here; callers that need
 *  "active now" should additionally check isActiveDuring() (or, for RTBA, the
 *  per-zone rtbaActiveDuring); callers that want every activation in the loaded set
 *  (e.g. the NotamDetail "Activates" section) read this directly. */
export function activatesAirspaces(notam: Notam): Airspace[] {
	if (!isActivationQCode(notam.qCode)) {
		return [];
	}
	const all = getAirspaces();
	if (!all) {
		return [];
	}
	const ids = activatedAirspaceIds(notam);
	if (ids.length === 0) {
		return [];
	}
	// Build a small id→Airspace lookup over the cached list. Cheap relative
	// to the overall route a NOTAM panel takes to mount.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const index = new Map<string, Airspace>();
	for (const a of all) {
		index.set(a.id, a);
	}
	const out: Airspace[] = [];
	for (const id of ids) {
		const a = index.get(id);
		if (a) {
			out.push(a);
		}
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* Affecting link by NAME: a NOTAM about an organisation airspace      */
/* (TMA / CTA / CTR) names it in free text ("HORAIRES TMA SEINE ...",  */
/* "TMA BEAUVAIS ET CTL D'AD") with no structured code and no usable   */
/* geometry (only the coarse Q-line position), never citing the        */
/* airspace id (LFPM1). It does not ACTIVATE the airspace the way a    */
/* restricted area is switched on; the airspace is permanent and the   */
/* NOTAM merely concerns it, so the match feeds the geometric          */
/* "affecting" relationship (notamsForAirspace / airspacesForNotam),   */
/* NOT activatesAirspaces. Scoped by Q-subject → type and Q-line FIR → */
/* publisher, so cross-type ("SEINE" SIV / TMZ) and cross-country      */
/* names cannot match. Conservative: matches nothing when no carried   */
/* name appears, the ~half of these NOTAMs that only say "HORAIRES     */
/* ATS:" with the aerodrome in the A) line.                            */
/*                                                                     */
/* The same path links a Flight Information Service NOTAM (Q-subject    */
/* CA / SE / UE, isFlightInfoServiceQCode) to its SIV sector rows:      */
/* "FIS SEINE INFORMATION (FIS 4 AND 5)" → SEINE 4 + SEINE 5. The SIV  */
/* branch adds two guards over the bare TMA name match (fisServiceNamed */
/* + citedSectors): the base name must sit next to an FIS callsign      */
/* (so a generic CA aerodrome-radio NOTAM cannot match a same-named     */
/* SIV), and when the NOTAM names sector numbers only those sectors     */
/* match (bare "SEINE INFO" with no number falls back to the whole      */
/* base).                                                              */
/* ------------------------------------------------------------------ */

// Trailing slice suffix on a France organisation-airspace name: integer "1" /
// "10", zero-padded "01", decimal "1.1", dash "1-1", a single sector letter
// "H", or a short cardinal "NE" / "W". Anchored at end, stripped once to the
// base ("SEINE 7.2" → "SEINE", "AQUITAINE NE" → "AQUITAINE"). Full French
// cardinal WORDS ("PARIS NORD") are intentionally left in place: a safe miss,
// never a false hit.
const FR_NAME_SUFFIX_RE = /\s+(?:\d+(?:[.-]\d+)?|[A-Z]|N[EW]?|S[EW]?|[EW])$/;

// UK / Spain embed the type word in the name ("LONDON TMA 14", "TMA MADRID").
// Strip only a trailing index / "AREA N" / "PARTE N" / cardinal, keeping the
// type word so bare towns ("LONDON", "MADRID") cannot over-match.
const INTL_NAME_SUFFIX_RE =
	/\s+(?:(?:AREA|PARTE)\s+)?(?:\d+|NORTH|SOUTH|EAST|WEST|[NSEW])$/;

// Direction / filler words and the lone <=3-char FR control base ("AIX") too
// generic to look for safely in free text.
const NAME_BLOCKLIST = new Set([
	'NORD', 'SUD', 'EST', 'OUEST', 'CENTRE',
	'NORTH', 'SOUTH', 'EAST', 'WEST', 'CENTRAL',
	'AREA', 'PARTE', 'AIX',
]);

/** True when a derived name token is safe to look for in free text: long
 *  enough, not numeric-only, not a blocklisted filler / direction word. */
function isSafeNameToken(token: string): boolean {
	if (token.length <= 3 || /^\d+$/.test(token)) {
		return false;
	}
	return !NAME_BLOCKLIST.has(token);
}

/** The whole-word token to look for in a NOTAM's E) text for this airspace,
 *  or null when its name is too risky to match. France reduces to a bare base;
 *  UK / Spain keep the embedded type word. Exported for the name-match spec. */
export function airspaceNameToken(a: Airspace): string | null {
	const name = a.name.trim().toUpperCase();
	let token = (
		a.source === 'fr'
			? name.replace(FR_NAME_SUFFIX_RE, '')
			: name.replace(INTL_NAME_SUFFIX_RE, '')
	).trim();
	if (a.type === 'FIC') {
		// FIR-level FIS sectors are named base + cardinal WORD, optionally
		// numbered (PARIS OUEST, MARSEILLE NORD 1); the on-air callsign is
		// the bare base ("PARIS INFO", "MARSEILLE INFORMATION"). SIV rows
		// keep their full word suffixes (BASTIA SUD is called BASTIA SUD).
		token = token.replace(/\s+(?:NORD|SUD|EST|OUEST)$/, '').trim();
	}
	return isSafeNameToken(token) ? token : null;
}

/** True when `token` occurs as a whole word in `textUpper`. Tokens may contain
 *  spaces ("LONDON TMA") and hyphens ("SAINT-YAN"), so \b is unsafe; require a
 *  non-alphanumeric char (or a string edge) on each side. Exported for the
 *  activation spec. */
export function nameTokenInText(token: string, textUpper: string): boolean {
	const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(?:^|[^A-Z0-9])${esc}(?:[^A-Z0-9]|$)`).test(textUpper);
}

/** True when SIV base name `token` is referenced as a Flight Information
 *  Service callsign in `textUpper`: "<NAME> INFO[RMATION]", "<NAME> FIS",
 *  "FIS <NAME>", "FIS AREA '<NAME>'", "FIS SECTOR 2 <NAME>" (the name may be
 *  single-quoted). French SIV are called "<NAME> INFO"; this adjacency is the
 *  guard that lets the generic CA subject in without an aerodrome-radio NOTAM
 *  ("TOULOUSE TWR ...") matching the same-named SIV. Exported for the FIS spec. */
export function fisServiceNamed(token: string, textUpper: string): boolean {
	const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// Callsign after the name: "SEINE INFORMATION", "LILLE INFO", "'BEAUVAIS' FIS".
	const after = new RegExp(
		`(?:^|[^A-Z0-9])['"]?${esc}['"]?\\s+(?:INFO(?:RMATION)?|FIS)\\b`,
	);
	// Marker before the name: "FIS SEINE", "FIS AREA 'BASTIA SUD'", "FIS 2 'LILLE".
	const before = new RegExp(
		`\\bFIS(?:\\s+(?:AREA|SECTOR|SECTEUR))?(?:\\s+\\d{1,2}(?:\\.\\d)?)?\\s+['"]?${esc}(?:[^A-Z0-9]|$)`,
	);
	return after.test(textUpper) || before.test(textUpper);
}

/** The sector numbers a NOTAM names for SIV base `token`, or null when it names
 *  none (→ the whole base). Collects digit lists introduced by the base name or
 *  an FIS keyword ("FIS 4 AND 5", "FIS 2", "SECTOR 2", "SEINE 4 AND 5"), each
 *  number 1-2 digits with an optional single decimal so frequencies (120.330,
 *  127.815) are never read as sectors. Connectors: AND / ET / & / , / /. Ranges
 *  ("4 TO 6") are not expanded, they degrade to the first number (a safe miss).
 *  Each base mention is scoped to a window so a second SIV in the same NOTAM
 *  ("... LILLE FIS 2") cannot narrow this one. Exported for the FIS spec. */
export function citedSectors(token: string, textUpper: string): Set<string> | null {
	const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const num = '\\d{1,2}(?:\\.\\d)?';
	const list = `${num}(?:\\s*(?:AND|ET|&|,|/)\\s*${num})*`;
	const anchor = new RegExp(`(?:FIS|SECTOR|SECTEUR|${esc})\\s*:?\\s*(${list})`, 'g');
	const base = new RegExp(`(?:^|[^A-Z0-9])${esc}(?:[^A-Z0-9]|$)`, 'g');
	const split = /\s*(?:AND|ET|&|,|\/)\s*/;
	// Local, intentionally non-reactive accumulator.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const out = new Set<string>();
	for (const b of textUpper.matchAll(base)) {
		const i = b.index ?? 0;
		const window = textUpper.slice(Math.max(0, i - 60), i + token.length + 60);
		for (const m of window.matchAll(anchor)) {
			for (const n of m[1].split(split)) {
				out.add(n);
			}
		}
	}
	return out.size > 0 ? out : null;
}

/** A SIV row's trailing sector number ("SEINE 4" → "4", "IROISE 4.2" → "4.2"),
 *  or null for a letter-suffixed ("RENNES COTENTIN B") or bare ("TOULOUSE")
 *  name. Pairs with citedSectors. Exported for the FIS spec. */
export function fisSectorDesignator(name: string): string | null {
	const m = name.toUpperCase().match(/\s(\d{1,2}(?:\.\d)?)$/);
	return m ? m[1] : null;
}

/** A NOTAM's reusable name-match context: the Airspace.type its Q-subject
 *  concerns (AT→TMA, AE→CTA, AC→CTR, or SIV for an FIS subject), the publisher
 *  its FIR scopes to, its upper-cased E) text, and whether this is the FIS/SIV
 *  variant. `typed` marks a NOTAM whose subject is OUTSIDE the organisation /
 *  FIS gate ("GUIDAGE RADAR NON ASSURE DANS LA CTR ET TMA LORIENT" under a
 *  radar subject): it may still name an airspace, but only through the
 *  stricter TYPE-WORD-ADJACENT match (typeAdjacentNameInText), the adjacency
 *  standing in for the guard the subject gate provided. null when the FIR has
 *  no dataset or there is no E) text. */
interface NameMatch {
	type: string;
	source: Publisher;
	eText: string;
	fis: boolean;
	typed: boolean;
}

// Per-Notam context cache: with the typed mode every subject reaches the E)
// parse, so memoise it (the notams array is replaced wholesale on re-parse,
// entries age out with their keys).
const nameMatchCache = new WeakMap<Notam, NameMatch | null>();

function computeNameMatchContext(notam: Notam): NameMatch | null {
	if (!notam.qualifier) {
		return null;
	}
	let type = controlAirspaceType(notam.qCode);
	let fis = false;
	if (!type && isFlightInfoServiceQCode(notam.qCode)) {
		type = 'SIV';
		fis = true;
	}
	const source = firToPublisher(notam.qualifier.fir);
	if (!source) {
		return null;
	}
	const eText = (parseSections(notam.fullContent).E ?? '').toUpperCase();
	if (!eText) {
		return null;
	}
	return { type, source, eText, fis, typed: !type };
}

function nameMatchContext(notam: Notam): NameMatch | null {
	let ctx = nameMatchCache.get(notam);
	if (ctx === undefined) {
		ctx = computeNameMatchContext(notam);
		nameMatchCache.set(notam, ctx);
	}
	return ctx;
}

/** Organisation / mandatory-zone types whose explicit "<TYPE> <NAME>"
 *  citation links under ANY Q-subject (the typed mode). */
const TYPED_NAME_TYPES = new Set(['TMA', 'CTA', 'CTR', 'RMZ', 'TMZ']);

/** True when `token` appears right after the airspace's TYPE WORD in
 *  `textUpper`: "TMA LORIENT", "CTR DE BIARRITZ" (French articles
 *  tolerated), and the conjunction hop "CTR ET TMA LORIENT" (the CTR row
 *  matches across "ET TMA"). Exported for the name-match spec. */
export function typeAdjacentNameInText(
	type: string,
	token: string,
	textUpper: string,
): boolean {
	const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const types = [...TYPED_NAME_TYPES].join('|');
	const re = new RegExp(
		`\\b${type}(?:\\s*(?:ET|AND|,|/|&)\\s*(?:${types}))*` +
			`(?:\\s+(?:DE\\s+LA|DE\\s+L'|DE|DU|DES|LA|LE))?\\s+['"]?${esc}(?:[^A-Z0-9]|$)`,
	);
	return re.test(textUpper);
}

/** True when airspace `a` matches a NOTAM's precomputed name context: same
 *  type and publisher, and its (suffix-stripped) name appears in the E) text.
 *  Organisation airspaces match on a bare whole-word name; SIV rows (ctx.fis)
 *  require an FIS callsign next to the name and, when the NOTAM names sector
 *  numbers, the row's sector among them (else the whole base matches). A
 *  typed context (subject outside the gate) matches only through the
 *  type-word-adjacent form, against the TYPED_NAME_TYPES rows. */
function airspaceMatchesName(a: Airspace, ctx: NameMatch): boolean {
	if (ctx.typed) {
		if (!TYPED_NAME_TYPES.has(a.type) || a.source !== ctx.source) {
			return false;
		}
		const typedToken = airspaceNameToken(a);
		if (typedToken == null) {
			return false;
		}
		// UK / ES tokens keep the embedded type word ("LONDON TMA"), so the
		// plain whole-word test is type-adjacent by construction.
		return a.source === 'fr'
			? typeAdjacentNameInText(a.type, typedToken, ctx.eText)
			: nameTokenInText(typedToken, ctx.eText);
	}
	if (a.source !== ctx.source) {
		return false;
	}
	// The FIS tier names a SERVICE, which both Flight Information Sector
	// types provide: the APP SIVs and the FIR-level FIC sectors ("PARIS
	// INFO" must reach PARIS OUEST). Every other context stays exact-type.
	const typeOk = ctx.fis
		? a.type === 'SIV' || a.type === 'FIC'
		: a.type === ctx.type;
	if (!typeOk) {
		return false;
	}
	const token = airspaceNameToken(a);
	if (token == null) {
		return false;
	}
	if (!ctx.fis) {
		return nameTokenInText(token, ctx.eText);
	}
	if (!fisServiceNamed(token, ctx.eText)) {
		return false;
	}
	const cited = citedSectors(token, ctx.eText);
	if (cited === null) {
		return true;
	}
	const des = fisSectorDesignator(a.name);
	return (
		des !== null &&
		(cited.has(des) || (des.includes('.') && cited.has(des.split('.')[0])))
	);
}

/** True when `notam` names THIS airspace in its E) text: organisation /
 *  FIS subjects match bare names ("HORAIRES TMA SEINE ...", "FIS SEINE
 *  INFORMATION (FIS 4 AND 5)"); ANY other subject matches through the
 *  type-word-adjacent form only ("... DANS LA CTR ET TMA LORIENT" under a
 *  radar subject). `strictOnly` rejects the widened (typed) matches; the
 *  frequency-override resolver passes it so a widened link can never move a
 *  frequency. Pure; exported for the name-match spec and folded into
 *  notamsForAirspace / airspacesForNotam, so a named airspace surfaces under
 *  "Affecting NOTAMs" / "In airspaces", not as an activation. */
export function notamNamesAirspace(
	notam: Notam,
	a: Airspace,
	strictOnly = false,
): boolean {
	const ctx = nameMatchContext(notam);
	if (ctx == null || (strictOnly && ctx.typed)) {
		return false;
	}
	return airspaceMatchesName(a, ctx);
}

/** Organisation airspaces (TMA / CTA / CTR) or FIS sectors (SIV) this NOTAM
 *  names in its E) text (see notamNamesAirspace), altitude filtered and ordered
 *  highest-band first. The explicit by-name link, surfaced as its own
 *  NotamDetail section ("Affected airspaces") so it reads as a named
 *  relationship, distinct from the geometric "In airspaces" / location list
 *  (airspacesForNotam). Listed regardless of the airspace layer toggles. */
export function airspacesNamedByNotam(notam: Notam, strictOnly = false): Airspace[] {
	const all = getAirspaces();
	if (!all) {
		return [];
	}
	const ctx = nameMatchContext(notam);
	if (!ctx || (strictOnly && ctx.typed)) {
		return [];
	}
	const band = activeAltitudeBand();
	return all
		.filter((a) => airspaceMatchesName(a, ctx) && airspacePassesAltitude(a, band))
		.sort(compareAirspaceByBand);
}

/* ------------------------------------------------------------------ */
/* Affecting link by DESIGNATOR CITATION: a special-use airspace NOTAM */
/* cites the zone's designator in its body without being an activation */
/* ("LF-R45 LIMITES MODIFIEES", QRRCD). The activation link            */
/* (activatedAirspaceIds) is deliberately gated to activation Q-codes; */
/* this tier is condition-agnostic so amendments / cancellations /     */
/* schedule changes still reach the zone's panel, and it speaks the    */
/* UK / ES designator grammars the FR-only activation extraction does  */
/* not. Three gates keep it honest: the citation family follows the    */
/* NOTAM's own Q-line FIR, the Q-code subject must concern special-use */
/* or control airspace, and the canonical key must match a loaded id.  */
/* ------------------------------------------------------------------ */

// Per-Notam citation cache; the notams array is replaced wholesale on every
// re-parse, so entries age out with their keys.
const citedKeysCache = new WeakMap<Notam, Set<string>>();

/** Designator keys this NOTAM cites outside reference / exclusion clauses
 *  (isReferenceContext), family-scoped by its own Q-line FIR. Empty for
 *  NOTAMs without a qualifier. */
function citedAirspaceKeys(notam: Notam): Set<string> {
	let keys = citedKeysCache.get(notam);
	if (!keys) {
		// Local, intentionally non-reactive cache payload.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
		keys = new Set<string>();
		for (const m of extractCitedDesignators(
			notam.fullContent,
			notam.qualifier?.fir ?? '',
		)) {
			if (!isReferenceContext(notam.fullContent, m.index)) {
				keys.add(m.key);
			}
		}
		citedKeysCache.set(notam, keys);
	}
	return keys;
}

/** True when the NOTAM's subject family may cite airspace designators:
 *  special-use restrictions (RR/RT/RD/RP/RA/RM) or organisation airspace
 *  (TMA / CTA / CTR subjects). */
function hasCitationSubject(notam: Notam): boolean {
	return hasRestrictedAreaSubject(notam) || controlAirspaceType(notam.qCode) !== '';
}

/** True when this NOTAM is ABOUT special-use / control airspace and cites
 *  THIS airspace's designator in its body, whatever the condition: a QRRCD
 *  "limits amended" links here where the activation tier stays silent.
 *  Activation NOTAMs pass too; the airspace panel folds those into its
 *  "Activated by" section by id. Pure; exported for the mentions spec. */
export function notamMentionsAirspace(notam: Notam, a: Airspace): boolean {
	if (!hasCitationSubject(notam)) {
		return false;
	}
	const key = designatorKey(a.id);
	return key !== null && citedAirspaceKeys(notam).has(key);
}

/** Loaded airspaces this NOTAM cites by designator (notamMentionsAirspace),
 *  minus the ones it ACTIVATES (those render under "Activates"), deduped by
 *  id, altitude filtered and ordered like airspacesNamedByNotam. */
export function airspacesMentionedByNotam(notam: Notam): Airspace[] {
	const all = getAirspaces();
	if (!all || !hasCitationSubject(notam) || citedAirspaceKeys(notam).size === 0) {
		return [];
	}
	// Local, intentionally non-reactive dedup index.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const taken = new Set<string>(activatedAirspaceIds(notam));
	const band = activeAltitudeBand();
	const out: Airspace[] = [];
	for (const a of all) {
		if (taken.has(a.id)) {
			continue;
		}
		if (notamMentionsAirspace(notam, a) && airspacePassesAltitude(a, band)) {
			taken.add(a.id);
			out.push(a);
		}
	}
	return out.sort(compareAirspaceByBand);
}

/** Named ∪ mentioned: every loaded airspace this NOTAM explicitly references
 *  in its body, by organisation name (airspacesNamedByNotam) or special-use
 *  designator (airspacesMentionedByNotam), deduped by key and ordered
 *  highest-band first. Feeds the NotamDetail "Affected airspaces" list and
 *  the map highlight so both render the same set. */
export function airspacesReferencedByNotam(notam: Notam): Airspace[] {
	const named = airspacesNamedByNotam(notam);
	const mentioned = airspacesMentionedByNotam(notam);
	if (mentioned.length === 0) {
		return named;
	}
	if (named.length === 0) {
		return mentioned;
	}
	// Local, intentionally non-reactive dedup index.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const seen = new Set(named.map((a) => a.key));
	const out = named.slice();
	for (const a of mentioned) {
		if (!seen.has(a.key)) {
			seen.add(a.key);
			out.push(a);
		}
	}
	return out.sort(compareAirspaceByBand);
}

/* ------------------------------------------------------------------ */
/* Triggers <-> Triggered NOTAM relation.                              */
/*                                                                     */
/* The "TRIGGER NOTAM" body keyword (and its French "NOTAM TRIGGER"    */
/* sibling) marks a NOTAM as a DORMANT framework: it defines an        */
/* upcoming restricted-area and points at the AIP SUP that carries     */
/* the full text. It is NOT the trigger itself; it is the *triggered*  */
/* end, waiting to be brought into force.                              */
/*                                                                     */
/* The actual triggers are the per-cycle ACTIVATION NOTAMs published   */
/* later with Q-codes like QRRCA / QRTCA / QRDCA / QRPCA / QRACA /     */
/* QRMCA (`isActivationQCode`). Both ends quote the SAME AIP SUP       */
/* number in their body: the framework opens with "TRIGGER NOTAM -    */
/* AIP SUP NNN/YY"; the activation cites the same SUP in prose ("AIP  */
/* SUP NNN/YY : 'ZRT LOURDES' ACT", or "...ZRT OCHEY (AIP SUP 167/25)"*/
/* ...). The shared SUP number is the bridge. Framework bodies don't  */
/* name specific airspace identifiers (the SUP itself enumerates the  */
/* IDs) so an airspace-id bridge does not fire on real corpus data.   */
/*                                                                     */
/* Concrete pairs verified in /home/djc/tmp/france.txt:                */
/*  - SUP 167/25: R2166/25 (framework, Nancy Ochey ZRT)               */
/*               <-> R0916/26 (activation, "ZRT OCHEY (AIP SUP        */
/*               167/25)").                                            */
/*  - SUP 93/26:  R1420/26 (framework, Lourdes ZRT)                   */
/*               <-> R1484/26 (activation, "AIP SUP 093/26 : 'ZRT     */
/*               LOURDES' ACT").                                       */
/*  - Plus five more pairs in the same briefing (SUP 188/25, 199/25,  */
/*    35/26, 84/26, 188/25): total 7 real pairs.                      */
/*                                                                     */
/* The two helpers mirror each other for the two NotamDetail panel    */
/* sections: "Triggered by" on the framework, "Triggers" on the       */
/* activation. */

/** Canonical AIP SUP key for matching: "<number>/<4-digit year>". */
function supKey(ref: ReturnType<typeof extractAipSups>[number]): string {
	return `${ref.number}/${ref.year}`;
}

/** True iff this NOTAM is the dormant framework end of the trigger
 *  relation: body starts with "TRIGGER NOTAM" / "NOTAM TRIGGER" AND
 *  the qCode subject is in the restricted-area family
 *  (RR/RT/RD/RP/RA/RM). The body-text gate is robust; the qCode gate
 *  filters out non-airspace triggers (lighting QLETT, friction QFATT,
 *  snow QSTTT, IFR procedure QPITT, obstacle QOBTT, ...). */
export function isTriggeredFramework(notam: Notam): boolean {
	return isTriggerNotam(notam) && hasRestrictedAreaSubject(notam);
}

/** True iff this NOTAM is the *active* trigger end of the relation:
 *  its Q-code declares activation (QR_CA / QR_GA family,
 *  isActivationQCode) AND its body names at least one concrete
 *  target, either an airspace id (LF-R262) or an AIP SUP number
 *  (AIP SUP 167/25). The body-target gate keeps ambiguous activations
 *  (rare, but real in the corpus) from lighting up the panel badge
 *  with nothing to point at; it's a stable signal that doesn't depend
 *  on which other NOTAMs are loaded. */
export function isActiveTrigger(notam: Notam): boolean {
	if (!isActivationQCode(notam.qCode)) return false;
	if (activatedAirspaceIds(notam).length > 0) return true;
	// extractActivatedSups, not extractAipSups: a NOTAM that only references a
	// SUP it joins / excepts ("PUBLISHED BY AIP SUP 188/25") is not a trigger.
	if (extractActivatedSups(notam.fullContent).length > 0) return true;
	return false;
}

/** For a triggered-framework NOTAM, the loaded activation NOTAMs that
 *  bring it into force. Match rule: any AIP SUP number cited by the
 *  framework's body intersects with any AIP SUP number cited by an
 *  activation NOTAM's body. Returns empty for non-framework NOTAMs.
 *  Reactive on notamState.tick so panels re-evaluate as a briefing is
 *  re-pasted or activation windows shift. */
export function notamTriggeredBy(notam: Notam): IndexedNotam[] {
	void notamState.tick;
	if (!isTriggeredFramework(notam)) return [];
	const sups = extractAipSups(notam.fullContent);
	if (sups.length === 0) return [];
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const keys = new Set(sups.map(supKey));
	const out: IndexedNotam[] = [];
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const seen = new Set<string>();
	for (const it of filteredNotams()) {
		if (it.notam.id === notam.id || seen.has(it.notam.id)) continue;
		if (!isActivationQCode(it.notam.qCode)) continue;
		// Candidate is an activation: pair only on a SUP it genuinely activates,
		// not one it merely references / excepts.
		for (const s of extractActivatedSups(it.notam.fullContent)) {
			if (keys.has(supKey(s))) {
				seen.add(it.notam.id);
				out.push(it);
				break;
			}
		}
	}
	return out;
}

/** For an activation NOTAM, the loaded triggered-framework NOTAMs it
 *  brings into force. Inverse direction of notamTriggeredBy; same
 *  shared-AIP-SUP-number bridge. Returns empty for non-activation
 *  NOTAMs. */
export function notamTriggers(notam: Notam): IndexedNotam[] {
	void notamState.tick;
	if (!isActivationQCode(notam.qCode)) return [];
	// The SUPs this activation genuinely brings into force (references excluded).
	const sups = extractActivatedSups(notam.fullContent);
	if (sups.length === 0) return [];
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const keys = new Set(sups.map(supKey));
	const out: IndexedNotam[] = [];
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const seen = new Set<string>();
	for (const it of filteredNotams()) {
		if (it.notam.id === notam.id || seen.has(it.notam.id)) continue;
		if (!isTriggeredFramework(it.notam)) continue;
		for (const s of extractAipSups(it.notam.fullContent)) {
			if (keys.has(supKey(s))) {
				seen.add(it.notam.id);
				out.push(it);
				break;
			}
		}
	}
	return out;
}

/** Cross-NOTAM relations a detail panel can render: the predecessor this
 *  NOTAM replaces (from NOTAMR), every NOTAM it explicitly references in
 *  its body (REF NOTAM …), and the reverse direction (loaded NOTAMs that
 *  replace or reference this one). Loaded entries linkify; unloaded ones
 *  render as muted text. */
export interface NotamReferenceLinks {
	replaces: { id: string; loaded: IndexedNotam | null } | null;
	references: { id: string; loaded: IndexedNotam | null }[];
	referencedBy: IndexedNotam[];
}

export function notamReferenceLinks(notam: Notam): NotamReferenceLinks {
	const all = filteredNotams();
	// Local index by id; small set, runs in <1 ms even on a busy briefing.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const byId = new Map<string, IndexedNotam>();
	for (const it of all) {
		byId.set(it.notam.id, it);
	}
	const replacesId = notamReplacement(notam);
	const refs = notamReferences(notam);
	const referencedBy: IndexedNotam[] = [];
	// Local, intentionally non-reactive dedup index.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const seen = new Set<string>();
	for (const it of all) {
		if (it.notam.id === notam.id || seen.has(it.notam.id)) {
			continue;
		}
		if (
			notamReplacement(it.notam) === notam.id ||
			notamReferences(it.notam).includes(notam.id)
		) {
			seen.add(it.notam.id);
			referencedBy.push(it);
		}
	}
	return {
		replaces: replacesId
			? { id: replacesId, loaded: byId.get(replacesId) ?? null }
			: null,
		references: refs.map((id) => ({ id, loaded: byId.get(id) ?? null })),
		referencedBy,
	};
}

/** All airspaces activated by at least one visible NOTAM whose validity window
 *  overlaps the active evaluation window: the period condition's range, or now → the
 *  future when the filter is off (see activeEvalWindow), so upcoming activations
 *  hatch by default. Keyed by airspace id, value is the list of NOTAMs activating
 *  it. */
export function activatedAirspaceLinks(): Map<string, IndexedNotam[]> {
	// The window the activation is evaluated against: the period condition's range, or
	// now → the future when the filter is off (see activeEvalWindow). getAirspaces()
	// tracks the lazy airspace load, so this re-runs once the dataset resolves (the
	// map overlay then hatches without waiting for a filter change or the tick).
	const { from, to } = activeEvalWindow();
	const all = getAirspaces();
	// Loaded ids, so an RTBA zone with no matching airspace row isn't recorded.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const loadedIds = new Set(all ? all.map((a) => a.id) : []);
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const out = new Map<string, IndexedNotam[]>();
	const push = (id: string, item: IndexedNotam) => {
		const arr = out.get(id);
		if (arr) {
			arr.push(item);
		} else {
			out.set(id, [item]);
		}
	};
	for (const item of filteredNotams()) {
		const n = item.notam;
		if (!isActivationQCode(n.qCode)) {
			continue;
		}
		// An RTBA NOTAM hatches each zone only while one of its OWN windows
		// overlaps the evaluation window, not for the whole B)-C) span (R45C off
		// at 12:30 while the rest run to 13:30; a zone can also have both a
		// morning and an evening slot). A zone with several overlapping windows
		// comes back more than once, so record each activated id just once (the
		// value list is "NOTAMs activating this airspace"). rtbaActiveDuring is
		// empty for non-RTBA NOTAMs.
		if (isRtbaActivationNotam(n)) {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
			const ids = new Set<string>();
			for (const z of rtbaActiveDuring(n, from, to)) {
				if (loadedIds.has(z.airspaceId)) {
					ids.add(z.airspaceId);
				}
			}
			for (const id of ids) {
				push(id, item);
			}
			continue;
		}
		if (!isActiveDuring(n, from, to)) {
			continue;
		}
		for (const a of activatesAirspaces(n)) {
			push(a.id, item);
		}
	}
	return out;
}

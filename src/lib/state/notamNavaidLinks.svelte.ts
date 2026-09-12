/* Reactive derivations linking NOTAMs to AIXM navaids. Mirrors the
 * obstacle-link pattern in notamObstacleLinks.svelte.ts:
 *
 *   activeNotamsByObstacle() : Map<obstacleId, IndexedNotam[]>
 *   activeNotamsByNavaid()   : Map<navaidId,   IndexedNotam[]>
 *
 * Match rule:
 *
 *   1. Q-code subject is navaid-related. The N-series covers the radio
 *      navaids (NV = VOR, NB = NDB, ND = DME, NN = TACAN, NM = VOR/DME,
 *      NT = VORTAC, NL = locator, NA = all nav facilities, ...); the
 *      I-series covers ILS / MLS landing aids (IC = ILS, ID = ILS DME,
 *      IL = localizer, IM = middle marker, ...). This is the coarse
 *      filter, applied by the caller.
 *   2. The NOTAM text names a navaid ident (quoted, like "'CGN'", or next
 *      to a type word, like "VOR CGN" / "NDB 'RS'"). This is AUTHORITATIVE:
 *      a navaid NOTAM that names its facility is about that facility, so the
 *      named idents win and the proximity sweep below is skipped. Otherwise a
 *      co-located neighbour (a 'CGE' a few hundred metres from the 'CGN' the
 *      NOTAM is about) would be linked too, because the Q-line centre is
 *      rounded to the arc-minute and the proximity window has to be loose.
 *      Idents aren't globally unique across FR / UK / ES, so a dup resolves
 *      to the instance nearest the NOTAM's coords.
 *   3. Fallback, only when step 2 resolves nothing (unusual phrasing, or the
 *      named navaid isn't in our dataset): any navaid within PROXIMITY_M of
 *      any of the NOTAM's coords.
 *
 * The map cue in navaidLayer.ts uses only NOTAMs active within the evaluation
 * window (the period condition's range, or now → the future; see activeEvalWindow);
 * the panel-side navaidsForNotam() applies only tier 1 so a lapsed NOTAM still
 * shows its navaids.
 */

import type { Notam } from '$lib/notam/types';
import type { Navaid } from '$lib/data/navaids';
import { M_PER_DEG, equirectangularDistanceM } from '$lib/notam/geometry';
import { filteredNotams, activeEvalWindow, type IndexedNotam } from './notam.svelte';
import { getNavaids, dataState } from './data.svelte';
import { isActiveDuring } from './notamLinks.svelte';

/** Q-code subjects (2nd + 3rd letters) that mark a NOTAM as navaid-related.
 *  N-series = radio navigation aids; I-series = ILS / MLS landing aids.
 *  From Q_SUBJECTS in src/lib/notam/qcode.ts. */
const NAVAID_Q_SUBJECTS = new Set([
	'NA', 'NB', 'ND', 'NF', 'NL', 'NM', 'NN', 'NO', 'NT', 'NV', 'NX',
]);
const ILS_Q_SUBJECTS = new Set([
	'IC', 'ID', 'IG', 'II', 'IL', 'IM', 'IN', 'IO', 'IS', 'IT', 'IU', 'IW', 'IX', 'IY',
]);

/** Maximum distance (metres) between any NOTAM coord and a navaid to count
 *  as a proximity match. Generous: a navaid NOTAM's Q-line coordinate is
 *  often rounded to the arc-minute (~1.85 km), so a tight window would miss
 *  legitimate matches; the Q-code filter keeps unrelated NOTAMs out. */
const PROXIMITY_M = 1500;

/** True iff this NOTAM's Q-code subject is in the navaid (N) or ILS (I)
 *  family. Q-codes look like Qxxyy (xx = subject, yy = condition). */
export function isNavaidQCode(qCode: string): boolean {
	if (!qCode || qCode.length < 3) return false;
	const subject = qCode.slice(1, 3);
	return NAVAID_Q_SUBJECTS.has(subject) || ILS_Q_SUBJECTS.has(subject);
}

// Type words that, adjacent to a 2-4 letter token, mark it as a navaid
// ident in NOTAM free text. Longest alternatives first so "VOR/DME" wins
// over "VOR".
const TYPE_KEYWORDS = 'VOR\\/?DME|VORTAC|TACAN|VOR|DME|NDB|ILS|LOC|LOCATOR';
// Bare type words that the ident regex can capture by accident.
const TYPE_STOPWORDS = new Set(['VOR', 'DME', 'NDB', 'ILS', 'LOC', 'TACAN']);

/** Extract every plausible navaid ident from a NOTAM's text: quoted tokens
 *  ('CGN') or a 2-4 letter token adjacent to a navaid type word ("VOR CGN",
 *  "NDB 'RS'", "ILS IRW"). The guard keeps short idents from matching random
 *  words; callers resolve the strings against the navaid index. */
export function extractNavaidIdents(text: string): string[] {
	if (!text) return [];
	const t = text.toUpperCase();
	const idents: string[] = [];
	const quoted = /['"`]([A-Z]{2,4})['"`]/g;
	for (let m; (m = quoted.exec(t)); ) idents.push(m[1]);
	const after = new RegExp(
		`\\b(?:${TYPE_KEYWORDS})\\b[\\s:/]*['"\`]?([A-Z]{2,4})['"\`]?`,
		'g',
	);
	for (let m; (m = after.exec(t)); ) idents.push(m[1]);
	const before = new RegExp(
		`\\b['"\`]?([A-Z]{2,4})['"\`]?\\s+(?:${TYPE_KEYWORDS})\\b`,
		'g',
	);
	for (let m; (m = before.exec(t)); ) idents.push(m[1]);
	if (idents.length === 0) return [];
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of idents) {
		if (TYPE_STOPWORDS.has(id)) continue;
		if (!seen.has(id)) {
			seen.add(id);
			out.push(id);
		}
	}
	return out;
}

/** Of several same-ident navaids, the one nearest any of the NOTAM's coords
 *  (or the first when the NOTAM carries no coords). */
function nearestToNotam(list: Navaid[], notam: Notam): Navaid {
	if (list.length === 1 || notam.coordinates.length === 0) {
		return list[0];
	}
	let best = list[0];
	let bestD = Infinity;
	for (const n of list) {
		for (const c of notam.coordinates) {
			const d = equirectangularDistanceM(c.lat, c.lon, n.lat, n.lon);
			if (d < bestD) {
				bestD = d;
				best = n;
			}
		}
	}
	return best;
}

/** The set of navaids this NOTAM affects. Named idents (step 2) are
 *  authoritative and, when any resolve, win outright; only a NOTAM that
 *  names no resolvable navaid falls through to the proximity sweep (step 3).
 *  Caller has already verified the Q-code filter. Exported so the test suite
 *  can exercise it with synthetic navaid lists. */
export function matchNavaidsToNotam(
	notam: Notam,
	navaids: Navaid[],
	byIdent: Map<string, Navaid[]> = indexByIdent(navaids),
): Navaid[] {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const matched = new Map<string, Navaid>();

	// Step 2: ident text-mention (authoritative). Idents aren't globally
	// unique, so a dup resolves to the instance nearest the NOTAM's coords.
	for (const ident of extractNavaidIdents(notam.fullContent)) {
		const list = byIdent.get(ident);
		if (!list || list.length === 0) continue;
		const pick = nearestToNotam(list, notam);
		matched.set(pick.id, pick);
	}
	if (matched.size > 0) {
		// The NOTAM named a navaid we have: trust it, skip proximity (which
		// would otherwise also link co-located neighbours).
		return [...matched.values()];
	}

	// Step 3 (fallback): no ident resolved. Proximity within PROXIMITY_M of
	// any NOTAM coord. Bbox-prefilter per coord, then confirm.
	if (notam.coordinates.length > 0) {
		const dLatDeg = PROXIMITY_M / M_PER_DEG;
		for (const c of notam.coordinates) {
			const cosLat = Math.cos((c.lat * Math.PI) / 180) || 1;
			const dLonDeg = PROXIMITY_M / (M_PER_DEG * cosLat);
			for (const n of navaids) {
				if (Math.abs(n.lat - c.lat) > dLatDeg) continue;
				if (Math.abs(n.lon - c.lon) > dLonDeg) continue;
				if (equirectangularDistanceM(c.lat, c.lon, n.lat, n.lon) > PROXIMITY_M) continue;
				matched.set(n.id, n);
			}
		}
	}
	return [...matched.values()];
}

// The ident index, cached on the navaid array's identity (the merge replaces
// the array whenever a country arrives, so a reference compare is a sound
// invalidation test; the firRowsForIdent idiom). It used to be rebuilt over
// every loaded navaid on each call, and the two selectors below each call it
// once a minute.
let identIndexSrc: Navaid[] | null = null;
let identIndex: Map<string, Navaid[]> | null = null;

/** Build the ident -> navaids index used by the tier-3 text-mention path.
 *  Idents aren't globally unique, so the value is a list. */
function indexByIdent(navaids: Navaid[]): Map<string, Navaid[]> {
	if (navaids === identIndexSrc && identIndex) {
		return identIndex;
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const m = new Map<string, Navaid[]>();
	for (const n of navaids) {
		if (!n.ident) continue;
		const k = n.ident.toUpperCase();
		const arr = m.get(k);
		if (arr) {
			arr.push(n);
		} else {
			m.set(k, [n]);
		}
	}
	identIndexSrc = navaids;
	identIndex = m;
	return m;
}

/** Inverse index built each re-derive: navaid id -> NOTAMs affecting it that
 *  are active within the evaluation window (the period condition's range, or now).
 *  Drives the map cue rings and the NavaidDetail "Affecting NOTAMs" section.
 *  Reactive on filteredNotams, the active evaluation window (the viewing period /
 *  60-second heartbeat, via activeEvalWindow) and dataState.navaidsLoaded. */
export function activeNotamsByNavaid(): Map<string, IndexedNotam[]> {
	void dataState.navaidsLoaded;
	const { from, to } = activeEvalWindow();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const out = new Map<string, IndexedNotam[]>();
	for (const m of navaidMatches()) {
		if (!isActiveDuring(m.item.notam, from, to)) continue;
		for (const n of m.navaids) {
			const arr = out.get(n.id);
			if (arr) arr.push(m.item);
			else out.set(n.id, [m.item]);
		}
	}
	return out;
}

/** One navaid-subject NOTAM and the navaids it resolves to. */
interface NavaidMatch {
	item: IndexedNotam;
	navaids: Navaid[];
}

// The matching stage, cached on the briefing and the loaded navaids. It is
// the expensive half (an ident scan of each NOTAM's text, then a proximity
// sweep for the ones that name nothing) and it does not depend on the
// evaluation window, so the minute tick re-runs only the date test below.
// Shared by both selectors, which used to do this work twice over.
let matchCache: { items: IndexedNotam[]; navaids: Navaid[]; out: NavaidMatch[] } | null = null;

function navaidMatches(): NavaidMatch[] {
	const navaids = getNavaids();
	const items = filteredNotams();
	if (!navaids || navaids.length === 0) return [];
	if (matchCache && matchCache.items === items && matchCache.navaids === navaids) {
		return matchCache.out;
	}
	const byIdent = indexByIdent(navaids);
	const out: NavaidMatch[] = [];
	for (const item of items) {
		if (!isNavaidQCode(item.notam.qCode)) continue;
		const matched = matchNavaidsToNotam(item.notam, navaids, byIdent);
		if (matched.length > 0) out.push({ item, navaids: matched });
	}
	matchCache = { items, navaids, out };
	return out;
}

/** Navaids that an active NOTAM marks unserviceable (out of service) within the
 *  evaluation window. Returns a Set<navaidId> for O(1) membership in the detail
 *  tag, the navaid lists, and the map dim. Reactive on the same signals as
 *  activeNotamsByNavaid; gates on the parsed `serviceStatus` field. */
export function unserviceableNavaids(): Set<string> {
	void dataState.navaidsLoaded;
	const { from, to } = activeEvalWindow();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const out = new Set<string>();
	for (const m of navaidMatches()) {
		if (m.item.notam.serviceStatus !== 'unserviceable') continue;
		if (!isActiveDuring(m.item.notam, from, to)) continue;
		for (const n of m.navaids) {
			out.add(n.id);
		}
	}
	return out;
}

/** Per-NOTAM matcher used by the NotamDetail panel. Applies the Q-code
 *  filter (tier 1) but not the validity window, so a lapsed NOTAM still
 *  shows the navaids it once affected. */
export function navaidsForNotam(notam: Notam): Navaid[] {
	void dataState.navaidsLoaded;
	if (!isNavaidQCode(notam.qCode)) return [];
	const navaids = getNavaids();
	if (!navaids) return [];
	return matchNavaidsToNotam(notam, navaids, indexByIdent(navaids));
}

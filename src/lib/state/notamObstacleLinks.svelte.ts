/* Reactive derivations linking NOTAMs to SIA AIXM obstacles. Mirrors
 * the airspace-activation pattern in notamLinks.svelte.ts:
 *
 *   activatedAirspaceLinks() : Map<airspaceId, IndexedNotam[]>
 *   activeNotamsByObstacle() : Map<obstacleId,  IndexedNotam[]>
 *
 * Match rule (three tiers; the union wins):
 *
 *   1. Q-code subject is obstacle-related (OB / OL / PO). This is the
 *      coarse filter; runway-closure NOTAMs near an obstacle don't
 *      qualify.
 *   2. ANY of the NOTAM's coords (PSN preferred, qualifier-line
 *      fallback) is within PROXIMITY_M of an obstacle.
 *   3. Bonus: the NOTAM text mentions an obstacle reference number
 *      (e.g. "OBST NR 77009", "ASR 1208783") matching an obstacle's
 *      name. SIA obstacle numbers are unique; a text-mention match is
 *      dispositive and doesn't require proximity.
 *
 * The map cue in obstacleLayer.ts only uses NOTAMs active within the
 * evaluation window (the period condition's range, or now → the future when the
 * filter is off; see activeEvalWindow); the panel-side helper
 * obstaclesForNotam() applies only tier 1 (Q-code filter) so the user
 * sees the link even when the validity window has lapsed.
 */

import type { Notam } from '$lib/notam/types';
import type { Obstacle } from '$lib/data/obstacles';
import { M_PER_DEG, equirectangularDistanceM } from '$lib/notam/geometry';
import { filteredNotams, activeEvalWindow, type IndexedNotam } from './notam.svelte';
import { getObstacles, dataState } from './data.svelte';
import { isActiveDuring } from './notamLinks.svelte';

/** Q-code subjects that mark a NOTAM as obstacle-related. From
 *  Q_SUBJECTS in src/lib/notam/qcode.ts:
 *    OB = Obstacle (generic),
 *    OL = Obstacle lights,
 *    PO = Obstacle clearance altitude / height. */
const OBSTACLE_Q_SUBJECTS = new Set(['OB', 'OL', 'PO']);

/** Maximum distance (metres) between any NOTAM coord and an obstacle to
 *  count as a proximity match. Generous enough for PSN drift and Q-line
 *  precision; tight enough to avoid linking unrelated NOTAMs to a
 *  neighbouring obstacle. */
const PROXIMITY_M = 300;

/** True iff this NOTAM's Q-code subject is in the obstacle family.
 *  Q-codes look like Qxxyy (xx = subject, yy = condition). */
export function isObstacleQCode(qCode: string): boolean {
	if (!qCode || qCode.length < 3) return false;
	return OBSTACLE_Q_SUBJECTS.has(qCode.slice(1, 3));
}

/** Extract every plausible obstacle reference number from a NOTAM's
 *  text. Matches FAA-style ASR registry IDs ("ASR 1208783", "ASR# 1234"),
 *  French-style obstacle numbers ("OBST NR 77009", "OBST 77009"), and
 *  the bare "NR 22033" form that French SIA NOTAMs sometimes carry
 *  inside a "OBST MAST NR 22033 LIGHTING U/S" body. Numbers shorter
 *  than 4 digits are rejected to avoid matching runway / frequency
 *  noise like "RWY 27" or "FREQ 121500". */
export function extractObstacleRefs(text: string): string[] {
	if (!text) return [];
	const t = text.toUpperCase();
	const refs: string[] = [];
	// "ASR 1234567" or "ASR# 1234567" or "ASR(1234567)".
	const asrRe = /\bASR\s*#?\s*\(?(\d{4,})\)?/g;
	for (let m; (m = asrRe.exec(t)); ) refs.push(m[1]);
	// "OBST NR 77009" or "OBST 77009" (case-insensitive, with optional
	// "NR" / "NUMBER" between OBST and the digits). Requires OBST as
	// the anchor so we don't pick up unrelated numbers.
	const obstNrRe = /\bOBST\s+(?:NR\s+|NUMBER\s+|N°\s*)?(\d{4,})\b/g;
	for (let m; (m = obstNrRe.exec(t)); ) refs.push(m[1]);
	// "OBST MAST NR 80137" / "OBST TOWER LGT (ASR 1234) 41…": the OBST
	// keyword followed by some structure-type words and then a number.
	const obstStructRe = /\bOBST\s+(?:[A-Z]+\s+){1,3}NR\s+(\d{4,})\b/g;
	for (let m; (m = obstStructRe.exec(t)); ) refs.push(m[1]);
	if (refs.length === 0) return [];
	// Dedup while preserving order.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of refs) {
		if (!seen.has(r)) {
			seen.add(r);
			out.push(r);
		}
	}
	return out;
}

/** The set of obstacles this NOTAM affects: tier 2 (proximity from any
 *  of the NOTAM's coords) ∪ tier 3 (name match from extractObstacleRefs).
 *  Caller has already verified the Q-code filter.
 *
 *  Exported (rather than kept private) so the test suite can exercise it
 *  with synthetic obstacle lists without faking module state. */
export function matchObstaclesToNotam(
	notam: Notam,
	obstacles: Obstacle[],
	obstaclesByName: Map<string, Obstacle> = indexByName(obstacles),
): Obstacle[] {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const matched = new Map<string, Obstacle>();

	// Tier 2: proximity. For each NOTAM coord, bbox-prefilter the
	// obstacle list, then equirectangular-confirm. We don't dedupe coords
	// across the NOTAM; an obstacle that lies near two of them is still
	// one match.
	if (notam.coordinates.length > 0) {
		const dLatDeg = PROXIMITY_M / M_PER_DEG;
		for (const c of notam.coordinates) {
			const cosLat = Math.cos((c.lat * Math.PI) / 180) || 1;
			const dLonDeg = PROXIMITY_M / (M_PER_DEG * cosLat);
			for (const o of obstacles) {
				if (Math.abs(o.lat - c.lat) > dLatDeg) continue;
				if (Math.abs(o.lon - c.lon) > dLonDeg) continue;
				if (equirectangularDistanceM(c.lat, c.lon, o.lat, o.lon) > PROXIMITY_M) continue;
				matched.set(o.id, o);
			}
		}
	}

	// Tier 3: name (= SIA obstacle number) match. SIA numbers are
	// unique; a text-mention is dispositive even with no proximity hit.
	const refs = extractObstacleRefs(notam.fullContent);
	for (const ref of refs) {
		const o = obstaclesByName.get(ref);
		if (o) matched.set(o.id, o);
	}
	return [...matched.values()];
}

/** Build (and cache, via the filteredNotams call) the name → Obstacle
 *  index used by the tier-3 text-mention path. */
function indexByName(obstacles: Obstacle[]): Map<string, Obstacle> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const m = new Map<string, Obstacle>();
	for (const o of obstacles) {
		if (o.name) m.set(o.name.toUpperCase(), o);
	}
	return m;
}

/** Inverse index built each re-derive: obstacle id → NOTAMs affecting it that
 *  are active within the evaluation window (the period condition's range, or now).
 *  Drives the map cue rings and the ObstacleDetail "Affecting NOTAMs" section.
 *  Reactive on filteredNotams, the active evaluation window (the viewing period /
 *  60-second heartbeat, via activeEvalWindow) and dataState.obstaclesLoaded (so
 *  the link emerges the moment the dataset finishes lazy-loading). */
export function activeNotamsByObstacle(): Map<string, IndexedNotam[]> {
	void dataState.obstaclesLoaded;
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const out = new Map<string, IndexedNotam[]>();
	const obstacles = getObstacles();
	if (!obstacles || obstacles.length === 0) return out;
	const byName = indexByName(obstacles);
	const { from, to } = activeEvalWindow();
	for (const item of filteredNotams()) {
		if (!isObstacleQCode(item.notam.qCode)) continue;
		if (!isActiveDuring(item.notam, from, to)) continue;
		const matched = matchObstaclesToNotam(item.notam, obstacles, byName);
		for (const o of matched) {
			const arr = out.get(o.id);
			if (arr) arr.push(item);
			else out.set(o.id, [item]);
		}
	}
	return out;
}

/** Per-NOTAM matcher used by the NotamDetail panel. Applies the Q-code
 *  filter (tier 1) but does NOT filter by the validity window, so a
 *  lapsed NOTAM still shows the obstacles it once affected. */
export function obstaclesForNotam(notam: Notam): Obstacle[] {
	void dataState.obstaclesLoaded;
	if (!isObstacleQCode(notam.qCode)) return [];
	const obstacles = getObstacles();
	if (!obstacles) return [];
	return matchObstaclesToNotam(notam, obstacles, indexByName(obstacles));
}
